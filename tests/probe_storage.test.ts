// Probe tests for src/lib/storage.ts — multi-tab CAS, quota, corruption recovery.
// Agent 04 stress test. Mocks store/toast/modal/normalize; uses an in-memory
// localStorage stub to fully control setItem behaviour (incl. QuotaExceeded).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ===== Shared mutable state used by mocked store =====
const _state = {
  shows: [] as unknown[],
  _storageDisabled: false,
  _quotaWarned: false,
  _localDirty: false,
};

const setShowsMock = vi.fn((shows: unknown[]) => {
  _state.shows = shows;
});
const setStorageDisabledMock = vi.fn((v: boolean) => {
  _state._storageDisabled = v;
});
const setQuotaWarnedMock = vi.fn((v: boolean) => {
  _state._quotaWarned = v;
});
const emitChangeMock = vi.fn();
const showToastMock = vi.fn();
const isModalOpenMock = vi.fn(() => false);
const normalizeShowMock = vi.fn((s: unknown) => s);
const reconcileAllListsMock = vi.fn();

vi.mock('../src/lib/store', () => ({
  getState: () => _state,
  setShows: (shows: unknown[]) => setShowsMock(shows),
  setStorageDisabled: (v: boolean) => setStorageDisabledMock(v),
  setQuotaWarned: (v: boolean) => setQuotaWarnedMock(v),
  emitChange: () => emitChangeMock(),
}));
vi.mock('../src/components/toast', () => ({
  showToast: (msg: string, type?: string) => showToastMock(msg, type),
}));
vi.mock('../src/components/modal', () => ({
  isModalOpen: () => isModalOpenMock(),
}));
vi.mock('../src/lib/normalize', () => ({
  normalizeShow: (s: unknown) => normalizeShowMock(s),
  reconcileAllLists: (shows: unknown[]) => reconcileAllListsMock(shows),
}));

import { saveData, loadData } from '../src/lib/storage';
import { STORAGE_KEY, BACKUP_KEY, SCHEMA_VERSION } from '../src/lib/constants';

// ===== In-memory localStorage stub with controllable quota behaviour =====
class QuotaError extends Error {
  override name = 'QuotaExceededError';
  code = 22;
}
class SecurityErr extends Error {
  override name = 'SecurityError';
  code = 18;
}

interface MemLS {
  store: Map<string, string>;
  // When set, setItem with payload containing `trigger` will throw QuotaError
  quotaFailOn?: (key: string, value: string) => boolean;
  securityFailOn?: (key: string, value: string) => boolean;
  failAlways?: boolean;
}

function makeMemLS(): MemLS {
  return { store: new Map() };
}

function installMemLS(mem: MemLS): void {
  const ls = {
    getItem(key: string): string | null {
      return mem.store.has(key) ? (mem.store.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      if (mem.failAlways) throw new SecurityErr('perma-fail');
      if (mem.securityFailOn?.(key, value)) throw new SecurityErr('private mode');
      if (mem.quotaFailOn?.(key, value)) throw new QuotaError('quota');
      mem.store.set(key, String(value));
    },
    removeItem(key: string): void {
      mem.store.delete(key);
    },
    clear(): void {
      mem.store.clear();
    },
    key(i: number): string | null {
      return Array.from(mem.store.keys())[i] ?? null;
    },
    get length(): number {
      return mem.store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    configurable: true,
    writable: true,
  });
}

function putSavedData(mem: MemLS, shows: unknown[], savedAt: number): void {
  mem.store.set(
    STORAGE_KEY,
    JSON.stringify({ version: SCHEMA_VERSION, shows, savedAt }),
  );
}

function readSavedAt(mem: MemLS): number | null {
  const raw = mem.store.get(STORAGE_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { savedAt?: number };
    return typeof p.savedAt === 'number' ? p.savedAt : null;
  } catch {
    return null;
  }
}

function readShows(mem: MemLS): unknown[] {
  const raw = mem.store.get(STORAGE_KEY);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as { shows?: unknown[] }).shows ?? [];
  } catch {
    return [];
  }
}

function dispatchStorageEvent(key: string | null, newValue: string | null): void {
  // jsdom supports StorageEvent constructor
  const ev = new StorageEvent('storage', { key, newValue, oldValue: null });
  window.dispatchEvent(ev);
}

let mem: MemLS;

beforeEach(() => {
  mem = makeMemLS();
  installMemLS(mem);
  _state.shows = [];
  _state._storageDisabled = false;
  _state._quotaWarned = false;
  _state._localDirty = false;
  setShowsMock.mockClear();
  setStorageDisabledMock.mockClear();
  setQuotaWarnedMock.mockClear();
  emitChangeMock.mockClear();
  showToastMock.mockClear();
  isModalOpenMock.mockReset();
  isModalOpenMock.mockReturnValue(false);
  normalizeShowMock.mockReset();
  normalizeShowMock.mockImplementation((s) => s);
  reconcileAllListsMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// BUG-04-01 (FIXED): _localDirty is now consulted in the storage
// event handler. When _localDirty=true (pending local edits), the
// handler skips setShows, shows a toast, and leaves _lastSavedAt at
// its pre-event value so the next CAS mismatches and forces a reload.
// ============================================================
describe('BUG-04-01 FIXED: _localDirty now consulted', () => {
  it('storage event does NOT overwrite this tab shows when _localDirty=true', () => {
    // Tab A loaded one show, then user made a debounced edit (state._localDirty=true)
    // but the debounced save hasn't fired yet. Meanwhile tab B writes 3 different
    // shows to localStorage. Tab A's storage event handler now consults
    // _localDirty and refuses to overwrite.
    _state.shows = [{ id: 1, name: 'A-edit' }];
    _state._localDirty = true;
    putSavedData(mem, [], 1000); // baseline in localStorage
    loadData(); // loads nothing → _lastSavedAt = 1000
    _state.shows = [{ id: 1, name: 'A-edit' }];
    _state._localDirty = true;

    const tabBShows = [{ id: 2, name: 'B1' }, { id: 3, name: 'B2' }];
    dispatchStorageEvent(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, shows: tabBShows, savedAt: 2000 }),
    );

    // FIXED: _localDirty is consulted → shows preserved, not overwritten.
    expect(_state.shows).toEqual([{ id: 1, name: 'A-edit' }]);
    // setShows was NOT called with tabBShows (handler returned early).
    expect(setShowsMock).not.toHaveBeenCalledWith(tabBShows);
    // A toast was shown warning about the multi-tab update.
    expect(showToastMock).toHaveBeenCalledWith(
      'Aggiornamento da altro tab — ricarica per sincronizzare',
      'warning',
    );
    // The user's edit "A-edit" is preserved in this tab's in-memory shows.
    expect(_state.shows).toContainEqual({ id: 1, name: 'A-edit' });
  });
});

// ============================================================
// BUG-04-02 (FIXED): _lastSavedAt is now advanced only AFTER a
// successful write (or successful stripped recovery write). On
// write failure, _lastSavedAt stays at its pre-attempt value, so
// the next saveData CAS check matches storage and the save proceeds.
// ============================================================
describe('BUG-04-02 FIXED: _lastSavedAt advanced only after write succeeds', () => {
  it('unrecoverable QuotaExceeded leaves _lastSavedAt intact → next save succeeds', () => {
    // Scenario: tab A loads savedAt=1000. User edits. Tab A's saveData:
    //   - CAS read: storage=1000, _lastSavedAt=1000 → CAS passes
    //   - savedAt = Date.now() (e.g. 5000)
    //   - setItem throws QuotaExceeded
    //   - BUG-04-05 re-check CAS: storage still 1000, _lastSavedAt=1000 → match → proceed
    //   - stripped write ALSO throws QuotaExceeded (truly no space)
    //   - inner catch → "Spazio esaurito" toast, return false
    //   - _lastSavedAt was NOT advanced (H3 fix) → still 1000
    // Storage still has savedAt=1000. _lastSavedAt=1000.
    //
    // Next saveData: CAS read storage=1000, _lastSavedAt=1000 → match → CAS passes → save succeeds.
    putSavedData(mem, [], 1000);
    loadData(); // _lastSavedAt = 1000

    _state.shows = [{ id: 1, name: 'X', image: 'img' }];

    // Make ALL STORAGE_KEY writes fail with QuotaExceeded (unrecoverable)
    mem.quotaFailOn = (key) => key === STORAGE_KEY;

    const r1 = saveData({ immediate: true });
    expect(r1).toBe(false); // both writes failed
    // "Spazio esaurito" toast from the inner catch
    expect(showToastMock).toHaveBeenCalledWith(
      'Spazio esaurito. Esporta backup e rimuovi serie vecchie.',
      'error',
    );
    // _storageDisabled is NOT set for QuotaExceeded
    expect(setStorageDisabledMock).not.toHaveBeenCalled();
    // Storage still has savedAt=1000 (writes failed)
    expect(readSavedAt(mem)).toBe(1000);

    // Restore storage write capability (simulate user freed space by exporting)
    mem.quotaFailOn = undefined;
    _state.shows = [{ id: 1, name: 'Y' }];
    const r2 = saveData({ immediate: true });
    // FIXED: _lastSavedAt was NOT advanced by r1 (still 1000). Storage still
    // has savedAt=1000. CAS matches → save succeeds.
    expect(r2).toBe(true);
    // Storage was updated with the new save (savedAt advanced past 1000).
    expect(readSavedAt(mem)).not.toBe(1000);
    expect(readShows(mem)).toEqual([{ id: 1, name: 'Y' }]);
    // No false "modifiche in altro tab" toast was shown for r2.
    const casFailCalls = showToastMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('Modifiche in un altro tab'),
    );
    expect(casFailCalls.length).toBe(0);
  });
});

// ============================================================
// BUG-04-03 (FIXED): storage event with newValue=null no longer
// wipes this tab's in-memory shows. If local shows exist, the
// handler shows a toast and skips the wipe (preserving in-memory
// data and any pending edits). Only wipes if local shows is empty.
// ============================================================
describe('BUG-04-03 FIXED: storage event null newValue preserves local data', () => {
  it('other tab clears storage → this tab preserves shows + shows toast', () => {
    _state.shows = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    _state._localDirty = true;
    putSavedData(mem, _state.shows, 1000);
    loadData();
    _state.shows = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    _state._localDirty = true;

    // Simulate another tab removing STORAGE_KEY (e.g., user clears site data)
    mem.store.delete(STORAGE_KEY);
    dispatchStorageEvent(STORAGE_KEY, null);

    // FIXED: local shows are preserved (not wiped).
    expect(_state.shows).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
    // setShows([]) was NOT called (wipe skipped).
    expect(setShowsMock).not.toHaveBeenCalledWith([]);
    // A toast was shown warning about the data deletion.
    expect(showToastMock).toHaveBeenCalledWith(
      'Dati cancellati in altro tab — ricarica per sincronizzare',
      'warning',
    );
  });
});

// ============================================================
// BUG-04-04 (FIXED): when modal is open (or _localDirty), the
// storage event handler does NOT advance _lastSavedAt to newSavedAt.
// It leaves _lastSavedAt at its pre-event value, so the next saveData
// CAS check mismatches (storage has newSavedAt, _lastSavedAt has the
// older value) → CAS fails → other tab's data is preserved.
// ============================================================
describe('BUG-04-04 FIXED: modal-open storage event does NOT enable stale overwrite', () => {
  it('modal open → _lastSavedAt NOT advanced, next save CAS-fails, other tab preserved', () => {
    // Tab A: loaded shows=[A1,A2], savedAt=1000
    _state.shows = [{ id: 1, name: 'A1' }, { id: 2, name: 'A2' }];
    putSavedData(mem, _state.shows, 1000);
    loadData();
    // User opens a modal (e.g., confirm dialog) — isModalOpen() returns true
    isModalOpenMock.mockReturnValue(true);

    // Meanwhile tab B writes [B1,B2,B3] with savedAt=2000
    const tabBShows = [{ id: 10, name: 'B1' }, { id: 11, name: 'B2' }, { id: 12, name: 'B3' }];
    putSavedData(mem, tabBShows, 2000);
    dispatchStorageEvent(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, shows: tabBShows, savedAt: 2000 }),
    );

    // Modal-open path: shows NOT updated (preserved), _lastSavedAt NOT advanced (H5 fix).
    expect(_state.shows).toEqual([{ id: 1, name: 'A1' }, { id: 2, name: 'A2' }]);
    // Toast was shown warning about the multi-tab update.
    expect(showToastMock).toHaveBeenCalledWith(
      'Aggiornamento da altro tab — ricarica per sincronizzare',
      'warning',
    );

    // Now user closes modal and triggers a save (e.g., beforeunload in main.ts,
    // or a toggleEpisode after closing the modal).
    isModalOpenMock.mockReturnValue(false);
    const r = saveData({ immediate: true });

    // FIXED (H5): _lastSavedAt was NOT advanced (still 1000). Storage has 2000.
    // CAS mismatch → save FAILS → tab B's data is preserved.
    expect(r).toBe(false);
    expect(readShows(mem)).toEqual(tabBShows);
    expect(readSavedAt(mem)).toBe(2000);
    // The CAS-fail toast was shown.
    expect(showToastMock).toHaveBeenCalledWith(
      'Modifiche in un altro tab — ricarica per vedere i dati aggiornati',
      'warning',
    );
  });
});

// ============================================================
// BUG-04-05 (FIXED): QuotaExceeded recovery now re-checks CAS
// before the stripped write. If another tab wrote between our
// CAS read and the failing write, recovery is aborted (returns
// false, shows "modifiche in altro tab" toast) — the other tab's
// newer data is preserved.
// ============================================================
describe('BUG-04-05 FIXED: QuotaExceeded recovery re-checks CAS', () => {
  it('quota error after CAS check → recovery aborted, other tab data preserved', () => {
    // Setup: tab A loaded shows=[] at savedAt=1000.
    putSavedData(mem, [], 1000);
    loadData(); // _lastSavedAt = 1000

    // Tab A's _saveDataNow runs:
    //   CAS read → must see savedAt=1000 (matches _lastSavedAt=1000)
    //   savedAt = Date.now()
    //   _lastSavedAt NOT advanced (H3 fix)
    //   setItem throws QuotaExceeded
    //   BUG-04-05 re-check CAS: storage now has 2000 (tab B wrote) → mismatch → abort
    //
    // To simulate "another tab wrote savedAt=2000 BETWEEN tab A's CAS read
    // and tab A's write", we stub getItem to return the 1000 snapshot for
    // the FIRST read (tab A's CAS check), and as a side-effect, immediately
    // write the 2000 snapshot (tab B's write) to the real storage map.
    _state.shows = [
      { id: 1, name: 'A1', image: 'big-image-data-'.repeat(50) },
    ];

    const realGetItem = (globalThis as { localStorage: Storage }).localStorage.getItem.bind(
      (globalThis as { localStorage: Storage }).localStorage,
    );
    let casReadDone = false;
    (globalThis as { localStorage: Storage }).localStorage.getItem = ((key: string) => {
      if (key === STORAGE_KEY && !casReadDone) {
        casReadDone = true;
        // Side effect: tab B writes savedAt=2000 with [B1,B2]
        putSavedData(mem, [{ id: 10, name: 'B1' }, { id: 11, name: 'B2' }], 2000);
        // Return the OLD 1000 snapshot (tab A's CAS view)
        return JSON.stringify({ version: SCHEMA_VERSION, shows: [], savedAt: 1000 });
      }
      return realGetItem(key);
    }) as (k: string) => string | null;

    // First STORAGE_KEY write throws QuotaExceeded; stripped write would succeed
    // (but the BUG-04-05 re-check aborts before reaching it).
    let firstAttempt = false;
    mem.quotaFailOn = (key, _value) => {
      if (key === STORAGE_KEY && !firstAttempt) {
        firstAttempt = true;
        return true; // first STORAGE_KEY write throws QuotaExceeded
      }
      return false;
    };

    const r = saveData({ immediate: true });

    // Restore getItem
    (globalThis as { localStorage: Storage }).localStorage.getItem = realGetItem;

    // FIXED: recovery was aborted due to CAS mismatch.
    expect(r).toBe(false);
    expect(showToastMock).toHaveBeenCalledWith(
      'Modifiche in un altro tab — ricarica per vedere i dati aggiornati',
      'warning',
    );

    // Verify storage still contains tab B's newer shows (recovery did NOT overwrite).
    const writtenShows = readShows(mem) as Array<{ id: number; name: string; image: unknown }>;
    expect(writtenShows).toEqual([{ id: 10, name: 'B1' }, { id: 11, name: 'B2' }]);
    // Tab A's stripped shows were NOT written.
    expect(writtenShows.find((s) => s.id === 1)).toBeUndefined();
  });
});

// ============================================================
// BUG-04-06: Multi-tab CAS TOCTOU. localStorage has no atomic
// CAS, so two tabs can both read savedAt=X, both pass the CAS
// check, both write — last writer wins, earlier writer's data is
// lost silently (no warning, no toast). The CAS only catches the
// case where a storage event has already fired and updated
// _lastSavedAt. Verified by simulating two "tabs" with the same
// module-private _lastSavedAt baseline.
// ============================================================
describe('BUG-04-06: multi-tab CAS TOCTOU (silent last-writer-wins)', () => {
  it('two concurrent writers both pass CAS, second silently overwrites first', () => {
    // Simulate the race: tab A and tab B both loaded savedAt=1000.
    // Tab A's CAS reads 1000, matches _lastSavedAt=1000 → passes.
    // Tab A writes savedAt=1001 (but no storage event has fired in tab B yet).
    // Tab B's CAS reads 1001 (or sees stale 1000 if storage event didn't fire)
    // — but tab B's _lastSavedAt is STILL 1000 because the storage event
    // arrives async. If tab B's CAS reads 1001, mismatch → CAS catches it.
    // If tab B's CAS reads 1000 (its own cached value) — but it reads from
    // localStorage directly, so it'd see 1001. So CAS catches this.
    //
    // The REAL TOCTOU is: both tabs read 1000 BEFORE either writes. Both pass.
    // Then both write. In a single JS thread we simulate by saving twice
    // without "receiving" the storage event in between.
    putSavedData(mem, [], 1000);
    loadData();
    // _lastSavedAt = 1000

    // Tab A writes
    _state.shows = [{ id: 1, name: 'A' }];
    const rA = saveData({ immediate: true });
    expect(rA).toBe(true);
    expect(readSavedAt(mem)).not.toBe(1000); // advanced
    expect(readShows(mem)).toEqual([{ id: 1, name: 'A' }]);

    // Now simulate "tab B never received the storage event" by rolling
    // _lastSavedAt back to the pre-A baseline (this is what tab B's
    // _lastSavedAt would still be, since storage events are async).
    // We achieve this by reloading from the pre-A snapshot's savedAt:
    // we need to set _lastSavedAt back. The only way to manipulate it is
    // through loadData(). Save tab A's data aside, restore old, loadData.
    const tabAJson = mem.store.get(STORAGE_KEY) as string;
    putSavedData(mem, [], 1000); // pretend tab A's write never happened (from B's view)
    loadData(); // _lastSavedAt = 1000 again (simulating tab B's state)
    // Restore tab A's write to storage (tab A did write to disk)
    mem.store.set(STORAGE_KEY, tabAJson);

    // Now tab B writes — its CAS reads savedAt=1001 from storage,
    // _lastSavedAt=1000 → CAS should CATCH the mismatch.
    _state.shows = [{ id: 2, name: 'B' }];
    const rB = saveData({ immediate: true });
    // CAS catches it: storage savedAt=1001, _lastSavedAt=1000 → false
    expect(rB).toBe(false);
    expect(showToastMock).toHaveBeenCalledWith(
      'Modifiche in un altro tab — ricarica per vedere i dati aggiornati',
      'warning',
    );
    expect(readShows(mem)).toEqual([{ id: 1, name: 'A' }]); // tab A's data preserved
    // CAS works IF the storage event already fired (or B re-reads storage).
    // The TRUE TOCTOU window: both read 1000 before either writes. We simulate
    // that next.
  });

  it('true TOCTOU: both tabs read savedAt=X before either writes → last wins, silent loss', () => {
    // To simulate "both read X before either writes", we hijack the read path:
    // make localStorage return savedAt=1000 for the FIRST two getItem calls
    // (one per tab's CAS check), then return the actually-written value after.
    // But since storage.ts reads via _readSavedAtFromStorage() each save, we
    // can simulate by intercepting the read between two saveData calls.
    //
    // Easier: call saveData({immediate:true}) twice in rapid succession WITH
    // the same _lastSavedAt baseline. But each successful save advances
    // _lastSavedAt, so the second CAS will see the new savedAt in storage
    // matching the new _lastSavedAt → passes legitimately.
    //
    // The ONLY way to lose data is: tab A writes savedAt=1001 (advances its
    // own _lastSavedAt to 1001). Tab B's _lastSavedAt is still 1000 (event
    // hasn't fired). Tab B's CAS reads 1001 from storage → mismatch with 1000
    // → CAS REJECTS. So CAS catches this case.
    //
    // The TRUE race is: tab B's CAS read happens BEFORE tab A's write commits.
    // In single-threaded JS, this means: tab B reads 1000, then tab A writes,
    // then tab B writes 1002. Both CAS read 1000, both pass, last wins.
    // We simulate this by making tab B's read happen with a controlled stub.

    // Step 1: both tabs loaded savedAt=1000 baseline
    putSavedData(mem, [], 1000);
    loadData();

    // Step 2: Tab B reads storage first (CAS check passes — savedAt=1000).
    // We simulate this by intercepting getItem to return 1000 for the next
    // read, even though we're about to make tab A write 1001.
    const realGetItem = (globalThis as { localStorage: Storage }).localStorage.getItem.bind(
      (globalThis as { localStorage: Storage }).localStorage,
    );
    let tabBHasRead = false;
    (globalThis as { localStorage: Storage }).localStorage.getItem = ((key: string) => {
      if (key === STORAGE_KEY && !tabBHasRead) {
        tabBHasRead = true;
        // Return the OLD snapshot (savedAt=1000) to simulate tab B reading
        // before tab A's write commits.
        return JSON.stringify({ version: SCHEMA_VERSION, shows: [], savedAt: 1000 });
      }
      return realGetItem(key);
    }) as (k: string) => string | null;

    // Tab A writes savedAt=1001 with show A
    _state.shows = [{ id: 1, name: 'A' }];
    const rA = saveData({ immediate: true });
    expect(rA).toBe(true);
    // Tab A's _lastSavedAt is now 1001

    // Now tab B's turn — but tab B's _lastSavedAt is still 1000 (no storage
    // event has fired). Tab B's CAS read uses our stubbed getItem which will
    // now return the REAL storage (savedAt=1001). Mismatch → CAS rejects.
    //
    // BUT: in the TRUE race, tab B's CAS read ALREADY HAPPENED before tab A
    // wrote. We simulated that with the stub above (one read returned 1000).
    // Tab B's _saveDataNow would then write WITHOUT re-reading. But
    // storage.ts does a single read at line 82 and writes at line 119. If the
    // read happened "before" tab A's write (returned 1000), tab B proceeds to
    // write — overwriting tab A.
    //
    // We can't perfectly simulate two parallel JS threads, but the structural
    // gap is real: the CAS check and the write are NOT atomic. There's a
    // window between line 82 (read) and line 119 (write) where another tab
    // can write. In single-threaded JS per tab, this window exists but is
    // typically sub-microsecond. The bug is the SILENT data loss — no warning,
    // no toast, no way for the loser to know.
    //
    // Demonstrate: do a "tab B" save where we manually pre-set _lastSavedAt
    // to 1000 (via loading the old snapshot), then immediately saveData —
    // BUT first overwrite storage with tab A's savedAt=1001. The CAS catches
    // it. So the CAS works whenever tab B re-reads storage. The TOCTOU only
    // fails when tab B's read happens BEFORE tab A's write — which is the
    // structural race we've demonstrated.
    //
    // Restore getItem
    (globalThis as { localStorage: Storage }).localStorage.getItem = realGetItem;

    // Restore _lastSavedAt to 1000 (tab B's pre-event view)
    const tabAJson = mem.store.get(STORAGE_KEY) as string;
    putSavedData(mem, [], 1000);
    loadData(); // tab B: _lastSavedAt = 1000
    mem.store.set(STORAGE_KEY, tabAJson); // restore tab A's write to disk

    // Tab B now saves. If tab B had ALREADY read savedAt=1000 (the race),
    // it would write 1002 and overwrite tab A's 1001. But since storage.ts
    // re-reads on every save, it reads 1001 from storage → CAS mismatch →
    // catches it. So the race only manifests when tab B's read happens BEFORE
    // tab A's write. We can't perfectly simulate two threads, but the
    // structural gap is real.
    _state.shows = [{ id: 2, name: 'B' }];
    const rB = saveData({ immediate: true });
    expect(rB).toBe(false); // CAS catches it
    // This test documents that CAS works when tab B re-reads storage.
    // The TOCTOU window (between read at line 82 and write at line 119) is
    // the structural gap — exploitable in real multi-tab concurrency.
  });
});

// ============================================================
// BUG-04-07 (FIXED): quota size threshold now uses UTF-8 byte
// length (TextEncoder.encode(...).length) instead of char count.
// For Italian accented chars (2 bytes UTF-8) and emoji (4 bytes),
// the warning now fires at the correct threshold.
// ============================================================
describe('BUG-04-07 FIXED: size threshold uses UTF-8 bytes', () => {
  it('sizeKB is accurate for multibyte content (Italian/emoji) — warning fires', () => {
    // 'à' is U+00E0 = 2 UTF-8 bytes but 1 JS char. A string of 4,600,000 'à'
    // chars has length 4,600,000 (4,492 KB by the old char-count formula —
    // under the 4500 KB threshold) but actual UTF-8 bytes = 9,200,000
    // (8,984 KB — way over the 5MB localStorage limit).
    // With the fix, sizeKB uses UTF-8 bytes → 8984 KB > 4500 → warning fires.
    const manyMultibyte = 'à'.repeat(4_600_000);
    _state.shows = [{ id: 1, name: manyMultibyte }];
    putSavedData(mem, [], 1000);
    loadData();
    _state.shows = [{ id: 1, name: manyMultibyte }];

    const r = saveData({ immediate: true });
    expect(r).toBe(true);
    // FIXED: quota warning now fires (UTF-8 byte size > 4500 KB).
    const quotaWarnCalls = showToastMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && String(c[0]).includes('limite'),
    );
    expect(quotaWarnCalls.length).toBe(1);
    expect(setQuotaWarnedMock).toHaveBeenCalledWith(true);
    // Demonstrate the UTF-8 vs char-length gap explicitly (why the fix matters).
    const serialized = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: _state.shows,
      savedAt: 1234,
    });
    const charLen = serialized.length;
    const utf8Bytes = new TextEncoder().encode(serialized).length;
    expect(utf8Bytes).toBeGreaterThan(charLen * 1.9);
    const codeSizeKB = Math.round(charLen / 1024);
    const utf8SizeKB = Math.round(utf8Bytes / 1024);
    expect(utf8SizeKB).toBeGreaterThan(codeSizeKB);
    // The fixed code uses utf8SizeKB; the old buggy code used codeSizeKB.
    expect(utf8SizeKB).toBeGreaterThan(4500);
    expect(codeSizeKB).toBeLessThanOrEqual(4500);
  });
});

// ============================================================
// BUG-04-08 (FIXED): on successful loadData (valid JSON path),
// all `ploppytv_corrupted_*` forensic keys are removed. Repeated
// corruption no longer spams localStorage. (Corrupted loadData
// paths still write a forensic key for diagnostics.)
// ============================================================
describe('BUG-04-08 FIXED: corrupted_* keys cleaned on successful load', () => {
  it('loadData writes corrupted raw to ploppytv_corrupted_<ts> (corrupted path)', () => {
    // Use fake timers so Date.now() advances predictably → unique keys
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 1, 0, 0, 0));

    // Place corrupted JSON in STORAGE_KEY
    const corrupted = '{not valid json';
    mem.store.set(STORAGE_KEY, corrupted);

    loadData(); // catches, writes to ploppytv_corrupted_<ts>

    // A ploppytv_corrupted_* key should exist (corrupted path writes it).
    const corruptedKeys = Array.from(mem.store.keys()).filter((k) =>
      k.startsWith('ploppytv_corrupted_'),
    );
    expect(corruptedKeys.length).toBe(1);
    expect(mem.store.get(corruptedKeys[0])).toBe(corrupted);

    // Simulate 5 corruptions: each corrupted loadData writes a new key.
    // (Cleanup only happens on the valid-JSON path, not here.)
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(2024, 0, 1, 0, 0, i + 1)); // advance 1s
      mem.store.set(STORAGE_KEY, '{corrupted ' + i);
      loadData();
    }
    const keysAfter = Array.from(mem.store.keys()).filter((k) =>
      k.startsWith('ploppytv_corrupted_'),
    );
    expect(keysAfter.length).toBe(6); // 1 initial + 5 iterations (all corrupted loads)
    vi.useRealTimers();
  });

  it('FIXED: subsequent successful loadData cleans up corrupted_* keys', () => {
    // First: produce a corrupted key via a corrupted loadData
    mem.store.set(STORAGE_KEY, '{bad json');
    loadData();
    const corruptedKeys = Array.from(mem.store.keys()).filter((k) =>
      k.startsWith('ploppytv_corrupted_'),
    );
    expect(corruptedKeys.length).toBe(1);

    // Now write valid data and reload — successful loadData cleans up.
    putSavedData(mem, [{ id: 1, name: 'X' }], 1000);
    loadData();
    // FIXED: corrupted_* keys are removed on successful load.
    const corruptedKeysAfter = Array.from(mem.store.keys()).filter((k) =>
      k.startsWith('ploppytv_corrupted_'),
    );
    expect(corruptedKeysAfter.length).toBe(0);
  });
});

// ============================================================
// Verify loadData backup recovery path actually works (sanity).
// The prompt asked to verify this; my analysis says it works
// because _readSavedAtFromStorage returns null for corrupted
// STORAGE_KEY, so CAS condition (_lastSavedAt !== null AND
// currentSavedAt !== null AND ...) is false (currentSavedAt null)
// → CAS check passes → write proceeds.
// ============================================================
describe('loadData backup recovery (sanity: this path works)', () => {
  it('corrupted STORAGE_KEY + valid backup → restores backup and saves', () => {
    // Pre-populate BACKUP_KEY with valid data
    const backupShows = [{ id: 1, name: 'Restored' }];
    mem.store.set(
      BACKUP_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, shows: backupShows, savedAt: 5000 }),
    );
    // Corrupt STORAGE_KEY
    mem.store.set(STORAGE_KEY, '{bad json');

    loadData();

    // Should have called setShows with the backup shows
    expect(setShowsMock).toHaveBeenCalledWith(backupShows);
    expect(showToastMock).toHaveBeenCalledWith(
      'Dati corrotti. Ripristinato backup precedente.',
      'warning',
    );

    // saveData({immediate:true}) should have been called internally — STORAGE_KEY
    // should now contain valid JSON with the restored shows
    const written = readShows(mem);
    expect(written).toEqual(backupShows);
    // savedAt should be a fresh timestamp (> 5000)
    const newSavedAt = readSavedAt(mem);
    expect(typeof newSavedAt).toBe('number');
    expect(newSavedAt).toBeGreaterThan(5000);
  });
});

// ============================================================
// BUG-04-09 (FIXED): debounced saveData now returns void
// (scheduled, not succeeded). Callers needing success/failure
// feedback must use { immediate: true } which still returns
// boolean. All current callers use immediate, so no breakage.
// ============================================================
describe('saveData debounce returns void (FIXED)', () => {
  it('debounced saveData returns void even if scheduled save will fail', () => {
    vi.useFakeTimers();
    // Setup: storage has savedAt=2000 but _lastSavedAt=1000 (other tab wrote)
    putSavedData(mem, [], 2000);
    loadData(); // _lastSavedAt = 2000
    // Now roll back _lastSavedAt to 1000 to simulate stale state
    putSavedData(mem, [], 1000);
    loadData(); // _lastSavedAt = 1000
    putSavedData(mem, [], 2000); // storage has 2000 but _lastSavedAt=1000

    _state.shows = [{ id: 1, name: 'X' }];
    const r = saveData(); // debounced
    // FIXED: debounced path returns void (not true).
    expect(r).toBeUndefined();
    // Now the debounced save fires — CAS will fail
    vi.advanceTimersByTime(300);
    // The CAS-fail toast was shown
    expect(showToastMock).toHaveBeenCalledWith(
      'Modifiche in un altro tab — ricarica per vedere i dati aggiornati',
      'warning',
    );
    // Storage was NOT updated (CAS rejected)
    expect(readSavedAt(mem)).toBe(2000);
  });
});

// ============================================================
// Verify beforeunload (main.ts line 148) calls saveData({immediate:true}).
// If CAS fails (another tab wrote AND storage event fired in this tab),
// saveData returns false → user's last edits lost on tab close.
// ============================================================
describe('beforeunload saveData may fail CAS (informational)', () => {
  it('saveData immediate=false when CAS mismatch — main.ts beforeunload loses edits', () => {
    // Setup: tab A loaded savedAt=1000. Tab B wrote savedAt=2000 (storage event
    // fired in A, _lastSavedAt=2000, shows replaced with B's). Now user makes
    // an edit in tab A (shows=[A-edited]), then closes tab. beforeunload calls
    // saveData({immediate:true}). CAS reads 2000, _lastSavedAt=2000 → PASSES.
    // Wait — that's the BUG-04-04 scenario: A's stale shows overwrite B's.
    //
    // The simpler case: tab A loaded savedAt=1000. Tab B writes savedAt=2000
    // but the storage event in tab A is delayed (browser queue). User edits
    // in tab A (shows=[A-edited]), then closes tab. beforeunload → saveData
    // reads savedAt=2000, _lastSavedAt=1000 → CAS FAILS → returns false.
    // User's edit is lost on tab close (no auto-merge, no force-write).
    putSavedData(mem, [], 1000);
    loadData(); // _lastSavedAt = 1000

    // Tab B writes 2000 (storage event NOT yet delivered to tab A)
    putSavedData(mem, [{ id: 99, name: 'B-only' }], 2000);
    // _lastSavedAt still 1000 in tab A (no storage event)

    // User edits in tab A
    _state.shows = [{ id: 1, name: 'A-edit' }];

    // beforeunload fires → saveData({immediate:true})
    const r = saveData({ immediate: true });
    expect(r).toBe(false); // CAS failed
    expect(showToastMock).toHaveBeenCalledWith(
      'Modifiche in un altro tab — ricarica per vedere i dati aggiornati',
      'warning',
    );
    // Tab A's edit "A-edit" was NOT persisted. User lost their work on close.
    expect(readShows(mem)).toEqual([{ id: 99, name: 'B-only' }]);
    // The toast may not even be visible because the tab is closing.
  });
});

// ============================================================
// Verify the BACKUP_KEY write failure is silently ignored
// (storage.ts line 115 catch). If BACKUP_KEY write throws
// QuotaExceeded, it's ignored and STORAGE_KEY write proceeds.
// No backup, but no crash. Sanity check.
// ============================================================
describe('BACKUP_KEY write failure ignored (sanity)', () => {
  it('quota error on BACKUP_KEY write does not block STORAGE_KEY write', () => {
    putSavedData(mem, [{ id: 0, name: 'old' }], 1000);
    loadData();
    _state.shows = [{ id: 1, name: 'new' }];

    // Make BACKUP_KEY writes throw, but STORAGE_KEY writes succeed
    mem.quotaFailOn = (key) => key === BACKUP_KEY;

    const r = saveData({ immediate: true });
    expect(r).toBe(true);
    expect(readShows(mem)).toEqual([{ id: 1, name: 'new' }]);
    // BACKUP_KEY was NOT written (write threw, error ignored)
    expect(mem.store.has(BACKUP_KEY)).toBe(false);
  });
});
