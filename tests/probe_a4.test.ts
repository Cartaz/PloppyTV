// Probe tests for BUG-A4-01..07 in src/lib/storage.ts (Agent A4 round).
// Mocks store/toast/modal/normalize; uses an in-memory localStorage stub
// with controllable quota / security-throw behaviour.
//
// NOTE: _storageOK is a module-level variable that persists across tests
// in the same file. Tests that set _storageOK=false (BUG-A4-01) are placed
// LAST to avoid poisoning other tests.

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

import { saveData, loadData, isStorageOK } from '../src/lib/storage';
import { STORAGE_KEY, BACKUP_KEY, SCHEMA_VERSION } from '../src/lib/constants';

// ===== In-memory localStorage stub =====
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
  quotaFailOn?: (key: string, value: string) => boolean;
  securityFailOn?: (key: string, value: string) => boolean;
  failAlways?: boolean;
  // When set, getItem throws SecurityError (simulates private mode mid-session)
  getItemThrows?: boolean;
}

function makeMemLS(): MemLS {
  return { store: new Map() };
}

function installMemLS(mem: MemLS): void {
  const ls = {
    getItem(key: string): string | null {
      if (mem.getItemThrows) throw new SecurityErr('private mode mid-session');
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

function putSavedData(mem: MemLS, shows: unknown[], savedAt: number, version = SCHEMA_VERSION): void {
  mem.store.set(STORAGE_KEY, JSON.stringify({ version, shows, savedAt }));
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
// BUG-A4-02 (FIXED): When loadData recovers from corrupted
// STORAGE_KEY via backup, it calls saveData({immediate:true}).
// Previously, _saveDataNow would read `prev = localStorage.getItem
// (STORAGE_KEY)` (still the corrupted raw) and write it to BACKUP_KEY
// — destroying the valid backup with corrupted JSON. The next
// corruption event would have no backup to recover from.
// FIX: _saveDataNow validates `prev` is valid JSON before backing up.
// ============================================================
describe('BUG-A4-02 FIXED: backup not clobbered with corrupted JSON', () => {
  it('corruption recovery preserves valid BACKUP_KEY (does not overwrite with corrupted raw)', () => {
    // Step 1: BACKUP_KEY has valid data.
    const backupShows = [{ id: 1, name: 'Backup Show' }];
    mem.store.set(
      BACKUP_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, shows: backupShows, savedAt: 5000 }),
    );

    // Step 2: STORAGE_KEY has corrupted JSON.
    const corrupted = '{not valid json';
    mem.store.set(STORAGE_KEY, corrupted);

    // Step 3: loadData detects corruption, recovers from backup.
    loadData();

    // Backup shows were loaded.
    expect(setShowsMock).toHaveBeenCalledWith(backupShows);

    // Step 4 (CRITICAL): BACKUP_KEY must still contain valid JSON (not corrupted raw).
    const backupRaw = mem.store.get(BACKUP_KEY) as string;
    expect(() => JSON.parse(backupRaw)).not.toThrow();
    const backupParsed = JSON.parse(backupRaw) as { shows?: unknown[] };
    expect(backupParsed.shows).toEqual(backupShows);

    // STORAGE_KEY was overwritten with valid recovered data.
    const storageRaw = mem.store.get(STORAGE_KEY) as string;
    expect(() => JSON.parse(storageRaw)).not.toThrow();
    const storageParsed = JSON.parse(storageRaw) as { shows?: unknown[] };
    expect(storageParsed.shows).toEqual(backupShows);

    // Step 5: Simulate a SECOND corruption. The backup is still valid → recovery works.
    mem.store.set(STORAGE_KEY, '{another corruption');
    setShowsMock.mockClear();
    showToastMock.mockClear();
    loadData();
    // Backup recovery works again — BACKUP_KEY was not destroyed by the first recovery.
    expect(setShowsMock).toHaveBeenCalledWith(backupShows);
    expect(showToastMock).toHaveBeenCalledWith(
      'Dati corrotti. Ripristinato backup precedente.',
      'warning',
    );
  });
});

// ============================================================
// BUG-A4-03 (FIXED): loadData now validates parsed.version.
// - Future version (> SCHEMA_VERSION): treated as unknown format →
//   try backup → fallback empty (no silent misinterpretation).
// - Past version (< SCHEMA_VERSION): warning + proceed (normalizeShow
//   is defensive).
// - Non-number version (string/NaN): treated as invalid → empty.
// Storage event handler also ignores future-version events.
// ============================================================
describe('BUG-A4-03 FIXED: schema version validation', () => {
  it('future version → backup recovery (if backup available)', () => {
    const backupShows = [{ id: 1, name: 'Backup' }];
    mem.store.set(
      BACKUP_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, shows: backupShows, savedAt: 1000 }),
    );
    // STORAGE_KEY has future version
    putSavedData(mem, [{ id: 99, name: 'Future' }], 2000, SCHEMA_VERSION + 5);

    loadData();

    // Future version data NOT loaded — backup used instead.
    expect(setShowsMock).toHaveBeenCalledWith(backupShows);
    expect(showToastMock).toHaveBeenCalledWith(
      'Versione dati non supportata. Ripristinato backup.',
      'warning',
    );
  });

  it('future version, no backup → empty + toast', () => {
    putSavedData(mem, [{ id: 99, name: 'Future' }], 2000, SCHEMA_VERSION + 1);
    // No backup in BACKUP_KEY

    loadData();

    expect(setShowsMock).toHaveBeenCalledWith([]);
    expect(showToastMock).toHaveBeenCalledWith(
      'Versione dati non supportata. Usa Importa per ripristinare.',
      'error',
    );
  });

  it('past version → warning + proceed (data loaded)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    putSavedData(mem, [{ id: 1, name: 'Old' }], 1000, SCHEMA_VERSION - 1);

    loadData();

    // Data loaded despite version mismatch.
    expect(setShowsMock).toHaveBeenCalledWith([{ id: 1, name: 'Old' }]);
    // Warning logged.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Schema version passata'),
      SCHEMA_VERSION - 1,
      '— atteso',
      SCHEMA_VERSION,
    );
    warnSpy.mockRestore();
  });

  it('non-number version (string) → treated as invalid → empty', () => {
    mem.store.set(
      STORAGE_KEY,
      JSON.stringify({ version: 'bad', shows: [{ id: 1 }], savedAt: 1000 }),
    );

    loadData();

    expect(setShowsMock).toHaveBeenCalledWith([]);
    // No backup toast (we didn't hit the corruption path — we hit the
    // version-validation path which discards silently).
    const backupToasts = showToastMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('Ripristinato backup'),
    );
    expect(backupToasts.length).toBe(0);
  });

  it('missing version (undefined) → lenient proceed (old data)', () => {
    // Some very old data might not have a version field.
    mem.store.set(
      STORAGE_KEY,
      JSON.stringify({ shows: [{ id: 1, name: 'NoVersion' }], savedAt: 1000 }),
    );

    loadData();

    // Loaded leniently (no version → don't reject).
    expect(setShowsMock).toHaveBeenCalledWith([{ id: 1, name: 'NoVersion' }]);
  });

  it('storage event with future version → ignored (no setShows)', () => {
    _state.shows = [{ id: 1, name: 'Local' }];
    putSavedData(mem, _state.shows, 1000);
    loadData();
    setShowsMock.mockClear();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Another tab writes future-version data.
    dispatchStorageEvent(
      STORAGE_KEY,
      JSON.stringify({
        version: SCHEMA_VERSION + 10,
        shows: [{ id: 99, name: 'Future' }],
        savedAt: 2000,
      }),
    );

    // setShows was NOT called with the future-version shows.
    expect(setShowsMock).not.toHaveBeenCalled();
    // Warning logged.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('version futura'),
      SCHEMA_VERSION + 10,
    );
    // Local shows preserved.
    expect(_state.shows).toEqual([{ id: 1, name: 'Local' }]);
    warnSpy.mockRestore();
  });
});

// ============================================================
// BUG-A4-04 (FIXED): CAS check now refuses when _lastSavedAt is
// null but storage has data. Previously, if this tab loaded empty
// storage (_lastSavedAt=null) and another tab then wrote data,
// this tab's save would silently overwrite the other tab's data.
// FIX: condition changed from
//   `_lastSavedAt !== null && currentSavedAt !== null && diff`
// to
//   `currentSavedAt !== null && currentSavedAt !== _lastSavedAt`
// ============================================================
describe('BUG-A4-04 FIXED: CAS refuses when _lastSavedAt=null but storage has data', () => {
  it('tab A loads empty storage, tab B writes, tab A save → CAS refuses', () => {
    // Tab A loads empty storage → _lastSavedAt = null
    loadData();
    expect(_state.shows).toEqual([]);

    // Tab B writes data (savedAt=1000) — storage event NOT delivered to tab A.
    putSavedData(mem, [{ id: 99, name: 'Tab B show' }], 1000);

    // Tab A user adds a show and saves.
    _state.shows = [{ id: 1, name: 'Tab A show' }];
    const r = saveData({ immediate: true });

    // FIXED: CAS refuses — tab B's data preserved.
    expect(r).toBe(false);
    expect(showToastMock).toHaveBeenCalledWith(
      'Modifiche in un altro tab — ricarica per vedere i dati aggiornati',
      'warning',
    );
    // Storage still has tab B's data.
    expect(readShows(mem)).toEqual([{ id: 99, name: 'Tab B show' }]);
    expect(readSavedAt(mem)).toBe(1000);
  });

  it('first save to truly empty storage still works (_lastSavedAt=null, storage=null)', () => {
    // Tab A loads empty storage → _lastSavedAt = null, storage empty.
    loadData();
    // No other tab wrote. Storage is still empty.
    _state.shows = [{ id: 1, name: 'First' }];
    const r = saveData({ immediate: true });

    // Save succeeds — no false CAS rejection.
    expect(r).toBe(true);
    expect(readShows(mem)).toEqual([{ id: 1, name: 'First' }]);
    // No "modifiche in altro tab" toast.
    const casToasts = showToastMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('Modifiche in un altro tab'),
    );
    expect(casToasts.length).toBe(0);
  });
});

// ============================================================
// BUG-A4-05 (FIXED): QuotaExceeded recovery CAS re-check aligned
// with BUG-A4-04. Previously, if _lastSavedAt was null (tab loaded
// empty storage) and another tab wrote data, the recovery CAS
// condition `prevLastSavedAt !== null && ...` would be false →
// recovery proceeds → stripped write overwrites other tab's data.
// FIX: condition changed to `recoverSavedAt !== null && recoverSavedAt
// !== prevLastSavedAt`.
// ============================================================
describe('BUG-A4-05 FIXED: QuotaExceeded recovery CAS aligned', () => {
  it('recovery aborts when _lastSavedAt=null but storage has data from other tab', () => {
    // Tab A loads empty storage → _lastSavedAt = null
    loadData();

    // Tab B writes data (savedAt=1000)
    putSavedData(mem, [{ id: 99, name: 'Tab B' }], 1000);

    // Tab A tries to save large data → first write throws QuotaExceeded.
    _state.shows = [{ id: 1, name: 'A', image: 'x'.repeat(100) }];
    // First STORAGE_KEY write throws Quota; stripped write would succeed
    // but recovery CAS should abort first.
    let firstAttempt = false;
    mem.quotaFailOn = (key) => {
      if (key === STORAGE_KEY && !firstAttempt) {
        firstAttempt = true;
        return true;
      }
      return false;
    };

    const r = saveData({ immediate: true });

    // FIXED: recovery aborted due to CAS mismatch (prevLastSavedAt=null,
    // recoverSavedAt=1000).
    expect(r).toBe(false);
    expect(showToastMock).toHaveBeenCalledWith(
      'Modifiche in un altro tab — ricarica per vedere i dati aggiornati',
      'warning',
    );
    // Tab B's data preserved (stripped write NOT executed).
    expect(readShows(mem)).toEqual([{ id: 99, name: 'Tab B' }]);
    expect(readSavedAt(mem)).toBe(1000);
  });
});

// ============================================================
// BUG-A4-06 (FIXED): Backup recovery now validates backup.savedAt
// type. Previously, `backup.savedAt ?? null` would assign whatever
// value was in the backup — including strings or other non-numbers.
// A non-number _lastSavedAt causes type confusion in CAS comparisons.
// FIX: use _validSavedAt (typeof number && Number.isFinite).
//
// BUG-A4-07 (FIXED): All savedAt reads now use _validSavedAt helper
// which adds Number.isFinite on top of typeof === 'number'. While
// NaN/Infinity can't enter via standard JSON.parse (they serialize
// as null), this is defense-in-depth against custom parsers or
// future code changes. The helper also consolidates the validation
// logic in one place.
// ============================================================
describe('BUG-A4-06/A4-07 FIXED: savedAt type validation via _validSavedAt', () => {
  it('backup with string savedAt → _lastSavedAt=null (not string), recovery save succeeds', () => {
    // Corrupted STORAGE_KEY to trigger backup path.
    mem.store.set(STORAGE_KEY, '{bad json');
    // Backup has string savedAt (malevolo/vecchio).
    mem.store.set(
      BACKUP_KEY,
      JSON.stringify({
        version: SCHEMA_VERSION,
        shows: [{ id: 1, name: 'B' }],
        savedAt: 'not-a-number',
      }),
    );

    loadData();

    // Backup shows loaded.
    expect(setShowsMock).toHaveBeenCalledWith([{ id: 1, name: 'B' }]);
    // The internal saveData({immediate:true}) should have succeeded:
    // _lastSavedAt=null (string rejected), currentSavedAt=null (storage
    // corrupted → _readSavedAtFromStorage returns null) → CAS passes.
    // STORAGE_KEY should now have valid JSON.
    const storageRaw = mem.store.get(STORAGE_KEY) as string;
    expect(() => JSON.parse(storageRaw)).not.toThrow();
  });

  it('main load path with string savedAt → _lastSavedAt=null (typeof check via _validSavedAt)', () => {
    // STORAGE_KEY has valid JSON but savedAt is a string.
    mem.store.set(
      STORAGE_KEY,
      JSON.stringify({
        version: SCHEMA_VERSION,
        shows: [{ id: 1, name: 'X' }],
        savedAt: '12345',
      }),
    );

    loadData();

    // Shows loaded.
    expect(setShowsMock).toHaveBeenCalledWith([{ id: 1, name: 'X' }]);
    // _lastSavedAt is null (string rejected). Verify: a subsequent save
    // to the same storage (which has string savedAt → _readSavedAtFromStorage
    // returns null) should NOT be CAS-rejected.
    _state.shows = [{ id: 1, name: 'Updated' }];
    const r = saveData({ immediate: true });
    expect(r).toBe(true);
    // No CAS-fail toast.
    const casToasts = showToastMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('Modifiche in un altro tab'),
    );
    expect(casToasts.length).toBe(0);
  });

  it('storage event with string savedAt → _lastSavedAt=null, subsequent save works', () => {
    _state.shows = [];
    putSavedData(mem, [], 1000);
    loadData();
    setShowsMock.mockClear();

    // Another tab writes string savedAt — MUST also update localStorage
    // (the event is fired BY the write, not instead of it).
    const newData = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: [{ id: 5, name: 'Str' }],
      savedAt: '9999',
    });
    mem.store.set(STORAGE_KEY, newData);
    dispatchStorageEvent(STORAGE_KEY, newData);

    // Shows were applied (event handler doesn't reject based on savedAt alone).
    expect(setShowsMock).toHaveBeenCalledWith([{ id: 5, name: 'Str' }]);
    // _lastSavedAt is null (string rejected by _validSavedAt). Verify by
    // saving: currentSavedAt from storage = null (string '9999' rejected by
    // _readSavedAtFromStorage → _validSavedAt) → CAS: `null !== null` = false → proceed.
    _state.shows = [{ id: 5, name: 'Str' }];
    const r = saveData({ immediate: true });
    expect(r).toBe(true);
  });
});

// ============================================================
// Sanity: isStorageOK() is true at module load (detectStorage IIFE
// succeeded in jsdom). This test MUST run before BUG-A4-01 tests
// (which set _storageOK=false).
// ============================================================
describe('isStorageOK initial state', () => {
  it('isStorageOK() is true before any mid-session fallback', () => {
    expect(isStorageOK()).toBe(true);
  });
});

// ============================================================
// BUG-A4-01 (FIXED): loadData() wraps localStorage.getItem in
// try/catch. Previously, if getItem threw SecurityError (Safari
// private mode mid-session, or after storage permission revocation),
// loadData would crash with an unhandled exception, propagating to
// the caller (main.ts) and breaking app startup. Now it falls back
// to in-memory mode gracefully.
//
// NOTE: These tests set _storageOK=false (module-level, persists).
// They MUST be last in the file to avoid poisoning other tests.
// ============================================================
describe('BUG-A4-01 FIXED: loadData catches SecurityError on getItem', () => {
  it('localStorage.getItem throws → loadData falls back to in-memory, no crash', () => {
    // Storage is OK at module-load time (detectStorage passed), but later
    // getItem starts throwing (simulates Safari private mode revocation).
    mem.getItemThrows = true;

    // Should NOT throw — loadData catches the SecurityError.
    expect(() => loadData()).not.toThrow();

    // Falls back to in-memory mode: shows cleared, storage disabled.
    expect(setShowsMock).toHaveBeenCalledWith([]);
    expect(setStorageDisabledMock).toHaveBeenCalledWith(true);
    // Shows the "Archiviazione non disponibile" toast.
    expect(showToastMock).toHaveBeenCalledWith('Archiviazione non disponibile.', 'error');
    // _storageOK is now false.
    expect(isStorageOK()).toBe(false);
  });

  it('after getItem-throws fallback, saveData returns false (storage disabled)', () => {
    // _storageOK is false (set by previous test in this describe block).
    // Verify loadData short-circuits (in-memory mode).
    mem.getItemThrows = true;
    loadData();
    _state.shows = [{ id: 1, name: 'X' }];
    const r = saveData({ immediate: true });
    expect(r).toBe(false);
    // Storage was NOT written.
    expect(mem.store.has(STORAGE_KEY)).toBe(false);
  });
});
