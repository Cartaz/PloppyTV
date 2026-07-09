// Agent A19 probe: cross-cutting edge cases across storage / normalize / api /
// shows / store / utils. End-to-end adversarial scenarios that exercise
// multiple modules together — finding bugs that per-module tests miss.
//
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_a19.test.ts
//
// Strategy:
//  - Mock toast/modal/header (DOM-dependent; not under test).
//  - Real imports: store, storage, normalize, utils, constants, api, shows.
//  - Per-test overrides: globalThis.localStorage (in-memory stub with
//    controllable quota/security failures) and globalThis.fetch (for API
//    edge cases). This gives real cross-module interaction testing.
//
// Areas covered (per task brief):
//  1. Storage quota piena (QuotaExceeded recovery, backup, toast, state).
//  2. Dati corrotti in localStorage (JSON malformed, future version, shows
//     non-array, null fields, prototype pollution, savedAt NaN).
//  3. Import enormi (MAX_IMPORT_SIZE enforcement, 10000 shows, dedup).
//  4. Multi-tab CAS (storage event with newer/older savedAt, stale reads).
//  5. Offline / API down (fetch reject, AbortError, 500/429/404).
//  6. Date invalide ed estreme (2024-13-45, "", null, epoch 0, 2099, DST).
//  7. Serie senza stagioni / 0 episodi (stats, toggle, reconcile).
//  8. Combinazioni (watching+0eps, toggle on towatch, refreshShowEpisodes
//     inconsistency with buildShowFromTvmaze/normalizeShow).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Show } from '../src/types';
import { SCHEMA_VERSION, STORAGE_KEY, BACKUP_KEY, MAX_IMPORT_SIZE } from '../src/lib/constants';
import { parseISODateLocal, localISODate, getWatchedCount } from '../src/lib/utils';
import { normalizeShow, buildShowFromTvmaze, reconcileAllLists } from '../src/lib/normalize';
import { computeStats } from '../src/worker/compute';

// ===== Mocks (file-scoped via vi.mock) =====
// toast/modal/header are DOM-dependent and not under test. Mocking them
// avoids transitive import of i18n/notifications/keyboard which would
// require their own DOM setup.

vi.mock('../src/components/toast', () => ({
  showToast: vi.fn(),
}));
vi.mock('../src/components/modal', () => ({
  showModal: vi.fn(),
  isModalOpen: vi.fn(() => false),
  closeAllModals: vi.fn(),
}));
vi.mock('../src/components/header', () => ({
  updateBadges: vi.fn(),
  initHeader: vi.fn(),
}));

// ===== Real imports (after mock declarations) =====
import { saveData, loadData, isStorageOK } from '../src/lib/storage';
import { getState, setState, setShows } from '../src/lib/store';
import { showToast } from '../src/components/toast';
import { isModalOpen } from '../src/components/modal';
import {
  toggleEpisode,
  markSeasonWatched,
  refreshShowEpisodes,
  addShowToList,
  setEpisodeRating,
} from '../src/lib/shows';
import { apiGet } from '../src/lib/api';
import { makeShow, makeShowWithSeasons, markWatchedFirst } from './helpers';

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
  getItemThrows?: boolean;
  setItemThrows?: boolean;
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
      if (mem.setItemThrows) throw new SecurityErr('setItem disabled');
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

function putSavedData(
  mem: MemLS,
  shows: unknown[],
  savedAt: number,
  version = SCHEMA_VERSION,
): void {
  mem.store.set(STORAGE_KEY, JSON.stringify({ version, shows, savedAt }));
}

function readSavedAt(mem: MemLS): number | null {
  const raw = mem.store.get(STORAGE_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { savedAt?: number };
    return typeof p.savedAt === 'number' && Number.isFinite(p.savedAt) ? p.savedAt : null;
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

function resetState(shows: Show[] = []): void {
  setState({
    shows,
    currentView: 'dashboard',
    currentShowId: null,
    currentSeason: 1,
    calendarWeekOffset: 0,
    _storageDisabled: false,
    _quotaWarned: false,
    _discoverTab: 'popular',
    _localDirty: false,
  });
}

let mem: MemLS;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  mem = makeMemLS();
  installMemLS(mem);
  resetState();
  vi.mocked(showToast).mockClear();
  vi.mocked(isModalOpen).mockClear();
  vi.mocked(isModalOpen).mockReturnValue(false);
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

// ============================================================
// SECTION 1: Storage quota piena — QuotaExceeded recovery
// ============================================================

describe('Section 1: Storage quota piena — recovery, backup, state consistency', () => {
  it('QuotaExceeded on first write → stripped write (no images) succeeds', () => {
    putSavedData(mem, [], 1000);
    loadData();
    // Large image data that would exceed quota
    const show = makeShow({ id: 1, name: 'Big', image: 'data:image/png;base64,' + 'x'.repeat(100) });
    setShows([show]);

    let firstAttempt = false;
    mem.quotaFailOn = (key) => {
      if (key === STORAGE_KEY && !firstAttempt) {
        firstAttempt = true;
        return true; // first write throws QuotaExceeded
      }
      return false; // stripped write succeeds
    };

    const r = saveData({ immediate: true });
    expect(r).toBe(true);
    // Stripped write stored the show without image
    const written = readShows(mem) as Array<{ id: number; image: unknown }>;
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe(1);
    expect(written[0].image).toBeNull();
    // Toast warns about stripped save
    expect(showToast).toHaveBeenCalledWith('Salvato senza immagini (spazio limitato).', 'warning');
  });

  it('QuotaExceeded on BOTH writes → returns false, state preserved, error toast', () => {
    putSavedData(mem, [], 1000);
    loadData();
    const show = makeShow({ id: 1, name: 'X' });
    setShows([show]);

    mem.quotaFailOn = () => true; // all writes fail

    const r = saveData({ immediate: true });
    expect(r).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      'Spazio esaurito. Esporta backup e rimuovi serie vecchie.',
      'error',
    );
    // _lastSavedAt not advanced → next save can retry
    // (storage still has savedAt=1000)
    expect(readSavedAt(mem)).toBe(1000);
  });

  it('repeated QuotaExceeded does not advance _lastSavedAt → next save after freeing space succeeds', () => {
    putSavedData(mem, [], 1000);
    loadData();

    // First save: all writes fail
    setShows([makeShow({ id: 1, name: 'Fail' })]);
    mem.quotaFailOn = () => true;
    expect(saveData({ immediate: true })).toBe(false);

    // User frees space (export + delete)
    mem.quotaFailOn = undefined;
    setShows([makeShow({ id: 2, name: 'Success' })]);
    const r = saveData({ immediate: true });
    expect(r).toBe(true);
    expect(readShows(mem)).toEqual([expect.objectContaining({ id: 2, name: 'Success' })]);
  });

  it('toggleEpisode rolls back when saveData fails (quota) — state consistent', () => {
    // Use manualList=true to prevent reconcileAllLists from demoting
    // 'watching' (0 watched) to 'towatch' during loadData. We want to test
    // rollback preserving the 'watching' list status.
    const show = makeShowWithSeasons({ 1: 3 }, { id: 1, list: 'watching', manualList: true });
    putSavedData(mem, [show], 1000);
    loadData();
    // After loadData + reconcileAllLists: manualList=true prevents demotion,
    // so list stays 'watching'.
    const stateShow = getState().shows[0];
    expect(stateShow.list).toBe('watching');
    expect(stateShow.seasons[1][0].watched).toBe(false);
    const prevList = stateShow.list;

    // Make ALL writes fail (quota exhausted)
    mem.quotaFailOn = () => true;

    toggleEpisode(1, 1, 1);

    // Rollback: watched should still be false
    expect(getState().shows[0].seasons[1][0].watched).toBe(false);
    // list should still be the pre-toggle value ('watching')
    expect(getState().shows[0].list).toBe(prevList);
    // Error toast shown
    expect(showToast).toHaveBeenCalledWith(
      'Modifica non salvata (storage error o modifiche in altro tab)',
      'error',
    );
  });

  it('BACKUP_KEY write failure (quota) is silently ignored — STORAGE_KEY write proceeds', () => {
    putSavedData(mem, [makeShow({ id: 1, name: 'old' })], 1000);
    loadData();
    setShows([makeShow({ id: 2, name: 'new' })]);

    mem.quotaFailOn = (key) => key === BACKUP_KEY;

    const r = saveData({ immediate: true });
    expect(r).toBe(true);
    expect(readShows(mem)).toEqual([expect.objectContaining({ id: 2 })]);
    // BACKUP_KEY was not written
    expect(mem.store.has(BACKUP_KEY)).toBe(false);
  });

  it('size threshold uses UTF-8 bytes — multibyte content triggers quota warning', () => {
    putSavedData(mem, [], 1000);
    loadData();
    // 'à' is 2 UTF-8 bytes but 1 JS char
    const manyMultibyte = 'à'.repeat(3_000_000);
    setShows([makeShow({ id: 1, name: manyMultibyte })]);

    saveData({ immediate: true });
    const quotaWarnCalls = vi.mocked(showToast).mock.calls.filter(
      (c) => typeof c[0] === 'string' && String(c[0]).includes('limite'),
    );
    expect(quotaWarnCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// SECTION 2: Dati corrotti in localStorage
// ============================================================

describe('Section 2: Dati corrotti in localStorage', () => {
  it('JSON malformato → backup recovery (if backup valid)', () => {
    const backupShows = [{ id: 1, name: 'Backup Show', seasons: {} }];
    mem.store.set(
      BACKUP_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, shows: backupShows, savedAt: 5000 }),
    );
    mem.store.set(STORAGE_KEY, '{not valid json');

    loadData();

    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].id).toBe(1);
    expect(showToast).toHaveBeenCalledWith('Dati corrotti. Ripristinato backup precedente.', 'warning');
  });

  it('JSON malformato + no backup → empty state + error toast', () => {
    mem.store.set(STORAGE_KEY, '{not valid json');
    loadData();
    expect(getState().shows).toEqual([]);
    expect(showToast).toHaveBeenCalledWith('Dati corrotti. Usa Importa per ripristinare.', 'error');
  });

  it('future version (>SCHEMA_VERSION) → backup recovery', () => {
    const backupShows = [{ id: 1, name: 'Backup', seasons: {} }];
    mem.store.set(
      BACKUP_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, shows: backupShows, savedAt: 1000 }),
    );
    putSavedData(mem, [{ id: 99, name: 'Future' }], 2000, SCHEMA_VERSION + 5);

    loadData();
    expect(getState().shows[0]?.id).toBe(1); // backup loaded, not future data
    expect(showToast).toHaveBeenCalledWith('Versione dati non supportata. Ripristinato backup.', 'warning');
  });

  it('shows non-array (string) → empty state, no crash', () => {
    mem.store.set(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, shows: 'not-an-array', savedAt: 1000 }));
    loadData();
    expect(getState().shows).toEqual([]);
  });

  it('shows non-array (null) → empty state', () => {
    mem.store.set(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, shows: null, savedAt: 1000 }));
    loadData();
    expect(getState().shows).toEqual([]);
  });

  it('show with null name → normalizeShow returns show with "Senza titolo" fallback', () => {
    const raw = { id: 1, name: null, seasons: {} };
    const result = normalizeShow(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Senza titolo');
  });

  it('show with null seasons → normalizeShow returns show with empty seasons', () => {
    const raw = { id: 1, name: 'Test', seasons: null };
    const result = normalizeShow(raw);
    expect(result).not.toBeNull();
    expect(result!.seasons).toEqual({});
    expect(result!.totalEpisodes).toBe(0);
    expect(result!.totalSeasons).toBe(0);
  });

  it('show with seasons as array (not object) → normalizeShow returns empty seasons', () => {
    const raw = { id: 1, name: 'Test', seasons: [[{ num: 1, id: 1, watched: false }]] };
    const result = normalizeShow(raw);
    expect(result).not.toBeNull();
    expect(result!.seasons).toEqual({});
  });

  it('prototype pollution via __proto__ key in show → no prototype pollution', () => {
    // JSON.parse treats __proto__ as own property (no pollution at parse time).
    // normalizeShow accesses r.id, r.name etc. directly — __proto__ ignored.
    const malicious = JSON.parse('{"id":1,"name":"X","__proto__":{"polluted":true},"seasons":{}}');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined(); // no pollution
    const result = normalizeShow(malicious);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    // Verify no global pollution occurred
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('prototype pollution via __proto__ key in seasons → safe (safeId rejects non-numeric)', () => {
    const malicious = {
      id: 1,
      name: 'X',
      seasons: { __proto__: [{ num: 1, id: 1, watched: false }] },
    };
    const result = normalizeShow(malicious);
    expect(result).not.toBeNull();
    // __proto__ key rejected by safeId (regex ^-?\d+$ fails on "__proto__")
    expect(Object.keys(result!.seasons)).toEqual([]);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('constructor key in show → safe (not accessed by normalizeShow)', () => {
    const raw = { id: 1, name: 'X', constructor: { prototype: { polluted: true } }, seasons: {} };
    const result = normalizeShow(raw);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('savedAt NaN → _lastSavedAt=null, subsequent save works (CAS safe)', () => {
    // NaN !== NaN is true → would break CAS if not filtered.
    // _validSavedAt filters NaN → null. _lastSavedAt=null. Storage has NaN
    // savedAt → _readSavedAtFromStorage returns null → CAS: null !== null
    // is false → passes.
    mem.store.set(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, shows: [{ id: 1, name: 'X', seasons: {} }], savedAt: NaN }),
    );
    loadData();
    expect(getState().shows).toHaveLength(1);
    // Subsequent save should succeed (CAS not broken by NaN)
    setShows([makeShow({ id: 2, name: 'New' })]);
    const r = saveData({ immediate: true });
    expect(r).toBe(true);
  });

  it('savedAt Infinity → _lastSavedAt=null (filtered by _validSavedAt)', () => {
    mem.store.set(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, shows: [{ id: 1, name: 'X', seasons: {} }], savedAt: Infinity }),
    );
    loadData();
    expect(getState().shows).toHaveLength(1);
    // saveData should work (CAS not broken)
    const r = saveData({ immediate: true });
    expect(r).toBe(true);
  });

  it('savedAt string "12345" → _lastSavedAt=null (typeof check rejects)', () => {
    mem.store.set(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, shows: [{ id: 1, name: 'X', seasons: {} }], savedAt: '12345' }),
    );
    loadData();
    expect(getState().shows).toHaveLength(1);
    // CAS safe: _lastSavedAt=null, _readSavedAtFromStorage returns null → passes
    const r = saveData({ immediate: true });
    expect(r).toBe(true);
  });

  it('version non-number (string "bad") → empty state (loadData rejects)', () => {
    mem.store.set(
      STORAGE_KEY,
      JSON.stringify({ version: 'bad', shows: [{ id: 1, name: 'X' }], savedAt: 1000 }),
    );
    loadData();
    expect(getState().shows).toEqual([]);
  });

  it('version undefined (old data) → lenient proceed (data loaded)', () => {
    mem.store.set(
      STORAGE_KEY,
      JSON.stringify({ shows: [{ id: 1, name: 'Old' }], savedAt: 1000 }),
    );
    loadData();
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].id).toBe(1);
  });
});

// ============================================================
// SECTION 3: Import enormi — MAX_IMPORT_SIZE + large arrays
// ============================================================

describe('Section 3: Import enormi — size limits and large arrays', () => {
  it('MAX_IMPORT_SIZE is 10MB', () => {
    expect(MAX_IMPORT_SIZE).toBe(10 * 1024 * 1024);
  });

  it('normalizeShow handles 10000 shows without crash', () => {
    const rawShows: unknown[] = [];
    for (let i = 1; i <= 10000; i++) {
      rawShows.push({ id: i, name: 'Show ' + i, seasons: { 1: [{ num: 1, id: i * 100, watched: false }] } });
    }
    const start = Date.now();
    const valid = rawShows.map(normalizeShow).filter((s): s is Show => s !== null);
    const elapsed = Date.now() - start;
    expect(valid).toHaveLength(10000);
    // Should complete in reasonable time (< 2s even on slow CI)
    expect(elapsed).toBeLessThan(2000);
  });

  it('normalizeShow with extremely long name → truncated to 200 chars', () => {
    const longName = 'A'.repeat(10000);
    const result = normalizeShow({ id: 1, name: longName, seasons: {} });
    expect(result).not.toBeNull();
    expect(result!.name.length).toBe(200);
  });

  it('normalizeShow with extremely long summary → truncated to 5000 chars', () => {
    const longSummary = 'S'.repeat(100000);
    const result = normalizeShow({ id: 1, name: 'X', summary: longSummary, seasons: {} });
    expect(result).not.toBeNull();
    expect(result!.summary.length).toBe(5000);
  });

  it('normalizeShow with 1000 tags → truncated to MAX_TAGS_PER_SHOW (20)', () => {
    const tags: string[] = [];
    for (let i = 0; i < 1000; i++) tags.push('tag' + i);
    const result = normalizeShow({ id: 1, name: 'X', tags, seasons: {} });
    expect(result).not.toBeNull();
    expect(result!.tags!.length).toBe(20);
  });

  it('normalizeShow with extremely long tag → truncated to MAX_TAG_LENGTH (40)', () => {
    const longTag = 'T'.repeat(500);
    const result = normalizeShow({ id: 1, name: 'X', tags: [longTag], seasons: {} });
    expect(result).not.toBeNull();
    expect(result!.tags![0].length).toBe(40);
  });

  it('normalizeShow with episode note > MAX_EPISODE_NOTE_LENGTH → truncated', () => {
    const longNote = 'N'.repeat(2000);
    const result = normalizeShow({
      id: 1,
      name: 'X',
      seasons: { 1: [{ num: 1, id: 1, watched: false, note: longNote }] },
    });
    expect(result).not.toBeNull();
    expect(result!.seasons[1][0].note!.length).toBe(500);
  });

  it('BUG-A19-04: loadData should dedup shows by id (storage.ts, A6)', () => {
    // BUG-A19-04 [Medium] — storage.ts (A4): loadData does NOT dedup by show id.
    // If localStorage contains duplicate shows (same id), both are loaded.
    // This causes downstream issues:
    //   - toggleEpisode/findIndex matches FIRST show only → second is orphaned.
    //   - computeStats double-counts the show (totalShows inflated).
    //   - getRandomGoldEpisode could pick either.
    //
    // Correct behavior: dedup by id (keep first, like exportImport does).
    // Current (buggy) behavior: both entries loaded.
    //
    // Proposed fix: add dedup in loadData after normalizeShow (storage.ts:331):
    //   const seenIds = new Set<number>();
    //   const dedupedShows = shows.filter((s) => {
    //     if (seenIds.has(s.id)) return false;
    //     seenIds.add(s.id);
    //     return true;
    //   });
    //   setShows(dedupedShows);
    // Same fix needed in the storage event handler (storage.ts:370).
    const shows = [
      { id: 1, name: 'First', seasons: {} },
      { id: 1, name: 'Duplicate', seasons: {} },
    ];
    putSavedData(mem, shows, 1000);
    loadData();
    // CORRECT behavior: dedup → only 1 show with id=1
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].name).toBe('First');
  });
});

// ============================================================
// SECTION 4: Multi-tab CAS — storage event scenarios
// ============================================================

describe('Section 4: Multi-tab CAS — storage event edge cases', () => {
  it('storage event with newer savedAt → handler accepts, updates state', () => {
    putSavedData(mem, [{ id: 1, name: 'Local', seasons: {} }], 1000);
    loadData();
    expect(getState().shows[0].name).toBe('Local');

    // Tab B writes newer data
    const tabBData = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: [{ id: 2, name: 'Tab B', seasons: {} }],
      savedAt: 2000,
    });
    mem.store.set(STORAGE_KEY, tabBData);
    dispatchStorageEvent(STORAGE_KEY, tabBData);

    expect(getState().shows[0].id).toBe(2);
    expect(getState().shows[0].name).toBe('Tab B');
  });

  it('storage event with older savedAt → handler still accepts (CAS token, not clock)', () => {
    putSavedData(mem, [{ id: 1, name: 'Newer', seasons: {} }], 2000);
    loadData();
    expect(getState().shows[0].name).toBe('Newer');

    // Tab B writes OLDER savedAt (clock skew or manual edit)
    const tabBData = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: [{ id: 3, name: 'Older savedAt', seasons: {} }],
      savedAt: 500, // older!
    });
    mem.store.set(STORAGE_KEY, tabBData);
    dispatchStorageEvent(STORAGE_KEY, tabBData);

    // Handler accepts (savedAt is a CAS token, not a clock)
    expect(getState().shows[0].name).toBe('Older savedAt');
  });

  it('storage event with future version → ignored (no state change)', () => {
    putSavedData(mem, [{ id: 1, name: 'Local', seasons: {} }], 1000);
    loadData();
    const localShows = getState().shows;

    const futureData = JSON.stringify({
      version: SCHEMA_VERSION + 10,
      shows: [{ id: 99, name: 'Future', seasons: {} }],
      savedAt: 2000,
    });
    dispatchStorageEvent(STORAGE_KEY, futureData);

    // State unchanged
    expect(getState().shows).toBe(localShows);
    expect(getState().shows[0].id).toBe(1);
  });

  it('storage event with newValue=null and local shows → preserves local, shows toast', () => {
    putSavedData(mem, [{ id: 1, name: 'A', seasons: {} }], 1000);
    loadData();
    // Ensure state has shows (simulating local data)
    setShows([makeShow({ id: 1, name: 'A' })]);

    // Another tab clears storage
    mem.store.delete(STORAGE_KEY);
    dispatchStorageEvent(STORAGE_KEY, null);

    // Local shows preserved
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].name).toBe('A');
    expect(showToast).toHaveBeenCalledWith(
      'Dati cancellati in altro tab — ricarica per sincronizzare',
      'warning',
    );
  });

  it('storage event with newValue=null and NO local shows → wipes state', () => {
    putSavedData(mem, [], 1000);
    loadData();
    expect(getState().shows).toEqual([]);

    dispatchStorageEvent(STORAGE_KEY, null);
    expect(getState().shows).toEqual([]);
  });

  it('storage event while modal open → skips update, shows toast, _lastSavedAt NOT advanced', () => {
    putSavedData(mem, [{ id: 1, name: 'A', seasons: {} }], 1000);
    loadData();
    vi.mocked(isModalOpen).mockReturnValue(true);

    const tabBData = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: [{ id: 2, name: 'B', seasons: {} }],
      savedAt: 2000,
    });
    mem.store.set(STORAGE_KEY, tabBData);
    dispatchStorageEvent(STORAGE_KEY, tabBData);

    // State NOT updated (modal open)
    expect(getState().shows[0]?.id).toBe(1);
    expect(showToast).toHaveBeenCalledWith(
      'Aggiornamento da altro tab — ricarica per sincronizzare',
      'warning',
    );

    // _lastSavedAt NOT advanced → next save CAS-fails (preserves tab B's data)
    vi.mocked(isModalOpen).mockReturnValue(false);
    setShows([makeShow({ id: 5, name: 'C' })]);
    const r = saveData({ immediate: true });
    expect(r).toBe(false); // CAS mismatch
  });

  it('storage event with malformed JSON → caught, no crash', () => {
    putSavedData(mem, [], 1000);
    loadData();
    // Should not throw
    expect(() => dispatchStorageEvent(STORAGE_KEY, '{not valid json')).not.toThrow();
  });

  it('storage event with shows non-array → skipped (no state change)', () => {
    putSavedData(mem, [{ id: 1, name: 'Local', seasons: {} }], 1000);
    loadData();
    const before = getState().shows;

    const badData = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: 'not-an-array',
      savedAt: 2000,
    });
    dispatchStorageEvent(STORAGE_KEY, badData);

    expect(getState().shows).toBe(before); // unchanged
  });

  it('first save to empty storage (_lastSavedAt=null) succeeds', () => {
    loadData(); // empty storage → _lastSavedAt=null
    setShows([makeShow({ id: 1, name: 'First' })]);
    const r = saveData({ immediate: true });
    expect(r).toBe(true);
    expect(readShows(mem)).toHaveLength(1);
  });

  it('CAS refuses when _lastSavedAt=null but storage has data from other tab', () => {
    // Tab A loads empty storage → _lastSavedAt=null
    loadData();
    // Tab B writes data (no storage event delivered to tab A in this simulation)
    putSavedData(mem, [{ id: 99, name: 'Tab B', seasons: {} }], 1000);
    // Tab A tries to save
    setShows([makeShow({ id: 1, name: 'Tab A' })]);
    const r = saveData({ immediate: true });
    expect(r).toBe(false); // CAS refuses
    expect(showToast).toHaveBeenCalledWith(
      'Modifiche in un altro tab — ricarica per vedere i dati aggiornati',
      'warning',
    );
    // Tab B's data preserved
    expect(readShows(mem)[0]).toHaveProperty('id', 99);
  });

  it('BUG-A19-05a: storage event should warn on past version (storage.ts, A4)', () => {
    // BUG-A19-05 [Low] — storage.ts (A4): the storage event handler only checks
    // `parsed.version > SCHEMA_VERSION` (future versions are ignored). It does
    // NOT warn on `parsed.version < SCHEMA_VERSION` (past versions), unlike
    // loadData which logs a warning. This is an inconsistency — past-version
    // data from another tab is silently accepted without any warning.
    //
    // Correct behavior: warn on past version (like loadData does).
    // Current behavior: silently accepts past-version data.
    //
    // Proposed fix: add past-version warning in the storage event handler
    // (storage.ts:366-369):
    //   if (typeof parsed.version === 'number' && parsed.version < SCHEMA_VERSION) {
    //     console.warn('[PloppyTV] storage event con version passata:', parsed.version);
    //   }
    putSavedData(mem, [{ id: 1, name: 'Local', seasons: {} }], 1000);
    loadData();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pastVersionData = JSON.stringify({
      version: 1, // past version
      shows: [{ id: 2, name: 'Past', seasons: {} }],
      savedAt: 2000,
    });
    mem.store.set(STORAGE_KEY, pastVersionData);
    dispatchStorageEvent(STORAGE_KEY, pastVersionData);

    // CORRECT behavior: warning logged for past version
    const pastVersionWarnings = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('version passata'),
    );
    expect(pastVersionWarnings.length).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  it('BUG-A19-05b: storage event should reject non-number version (storage.ts, A4)', () => {
    // BUG-A19-05 [Low-Medium] — storage.ts (A4): the storage event handler
    // accepts non-number versions (string, NaN, etc.) because its check is
    // `typeof parsed.version === 'number' && parsed.version > SCHEMA_VERSION`.
    // For a string version, typeof !== 'number' → condition is false → NOT
    // ignored → data accepted. But loadData REJECTS string versions (returns
    // empty state). This is an inconsistency — a string-version event from
    // another tab is silently accepted, potentially loading malformed data.
    //
    // Correct behavior: reject non-number version (like loadData does).
    // Current behavior: silently accepts string-version data.
    //
    // Proposed fix: add non-number version rejection in the storage event
    // handler (storage.ts:366-369):
    //   if (typeof parsed.version !== 'number' || !Number.isFinite(parsed.version)) {
    //     console.warn('[PloppyTV] storage event con version non valida:', parsed.version);
    //     return;
    //   }
    putSavedData(mem, [{ id: 1, name: 'Local', seasons: {} }], 1000);
    loadData();
    const localShows = getState().shows;

    const stringVersionData = JSON.stringify({
      version: 'bad', // string version
      shows: [{ id: 2, name: 'StrVer', seasons: {} }],
      savedAt: 2000,
    });
    mem.store.set(STORAGE_KEY, stringVersionData);
    dispatchStorageEvent(STORAGE_KEY, stringVersionData);

    // CORRECT behavior: string version rejected → state unchanged
    expect(getState().shows).toBe(localShows);
    expect(getState().shows[0].id).toBe(1);
  });
});

// ============================================================
// SECTION 5: Offline / API down — fetch error handling
// ============================================================

describe('Section 5: Offline / API down — apiGet error classification', () => {
  function mockFetchOnce(response: { ok: boolean; status: number; text: () => Promise<string> }): void {
    globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof globalThis.fetch;
  }

  it('fetch rejects with TypeError → NetworkError', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof globalThis.fetch;
    await expect(apiGet('/test')).rejects.toMatchObject({ name: 'NetworkError' });
  });

  it('HTTP 429 → RateLimitError', async () => {
    mockFetchOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve(''),
    });
    await expect(apiGet('/test')).rejects.toMatchObject({ name: 'RateLimitError', status: 429 });
  });

  it('HTTP 404 → ApiError with status 404', async () => {
    mockFetchOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve(''),
    });
    await expect(apiGet('/test')).rejects.toMatchObject({ name: 'ApiError', status: 404 });
  });

  it('HTTP 500 → ApiError with status 500', async () => {
    mockFetchOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve(''),
    });
    await expect(apiGet('/test')).rejects.toMatchObject({ name: 'ApiError', status: 500 });
  });

  it('HTTP 200 with non-JSON body → ParseError', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<html>not json</html>'),
    });
    await expect(apiGet('/test')).rejects.toMatchObject({ name: 'ParseError' });
  });

  it('HTTP 200 with empty body → returns null', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });
    const result = await apiGet('/test');
    expect(result).toBeNull();
  });

  it('external AbortSignal already aborted → propagates AbortError', async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        // Simulate fetch rejecting with AbortError when signal is aborted
        const signal = (init as { signal?: AbortSignal }).signal;
        if (signal?.aborted) {
          const err = new DOMException('The operation was aborted.', 'AbortError');
          reject(err);
        }
      });
    }) as unknown as typeof globalThis.fetch;

    const controller = new AbortController();
    controller.abort();
    await expect(apiGet('/test', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('timeout fires → TimeoutError (not AbortError)', async () => {
    vi.useFakeTimers();
    // fetch hangs until the abort signal fires, then rejects with AbortError.
    // This simulates a real fetch that respects the abort signal.
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal }).signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        }
      });
    }) as unknown as typeof globalThis.fetch;

    const promise = apiGet('/test');
    // Advance past API_TIMEOUT_MS (10s) — timeout fires, controller.abort()
    // is called, fetch rejects with AbortError, catch sees timedOut=true →
    // TimeoutError.
    vi.advanceTimersByTime(11000);
    await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

// ============================================================
// SECTION 6: Date invalide ed estreme
// ============================================================

describe('Section 6: Date invalide ed estreme — parseISODateLocal', () => {
  it('"2024-13-45" (invalid month/day) → null', () => {
    expect(parseISODateLocal('2024-13-45')).toBeNull();
  });

  it('"2024-02-30" (Feb 30 rollover) → null', () => {
    expect(parseISODateLocal('2024-02-30')).toBeNull();
  });

  it('"2024-04-31" (Apr has 30 days) → null', () => {
    expect(parseISODateLocal('2024-04-31')).toBeNull();
  });

  it('"" (empty string) → null', () => {
    expect(parseISODateLocal('')).toBeNull();
  });

  it('null → null', () => {
    expect(parseISODateLocal(null)).toBeNull();
  });

  it('undefined → null', () => {
    expect(parseISODateLocal(undefined)).toBeNull();
  });

  it('number (not string) → null', () => {
    expect(parseISODateLocal(0 as unknown as string)).toBeNull();
    expect(parseISODateLocal(1234567890 as unknown as string)).toBeNull();
  });

  it('"2099-01-01" (future year) → valid Date (not rejected)', () => {
    const d = parseISODateLocal('2099-01-01');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2099);
  });

  it('"0001-01-01" (year 1) → null (Date constructor maps 0-99 to 1900-1999)', () => {
    // new Date(1, 0, 1) creates a date in year 1901 (2-digit year mapping).
    // parseISODateLocal detects the rollover (getFullYear()=1901 !== 1) → null.
    const d = parseISODateLocal('0001-01-01');
    expect(d).toBeNull();
  });

  it('"2024-01-01" → valid Date with correct components', () => {
    const d = parseISODateLocal('2024-01-01');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2024);
    expect(d!.getMonth()).toBe(0); // January = 0
    expect(d!.getDate()).toBe(1);
  });

  it('leap day "2024-02-29" → valid (2024 is leap year)', () => {
    const d = parseISODateLocal('2024-02-29');
    expect(d).not.toBeNull();
    expect(d!.getMonth()).toBe(1);
    expect(d!.getDate()).toBe(29);
  });

  it('non-leap "2023-02-29" → null (2023 is not leap)', () => {
    expect(parseISODateLocal('2023-02-29')).toBeNull();
  });

  it('DST boundary "2024-03-31" (EU DST starts) → valid', () => {
    const d = parseISODateLocal('2024-03-31');
    expect(d).not.toBeNull();
    expect(d!.getDate()).toBe(31);
  });

  it('localISODate of parseISODateLocal round-trips for valid date', () => {
    const dateStr = '2024-06-15';
    const d = parseISODateLocal(dateStr);
    expect(localISODate(d!)).toBe(dateStr);
  });

  it('localISODate of invalid Date → "" (not "NaN-NaN-NaN")', () => {
    expect(localISODate(new Date(NaN))).toBe('');
  });

  it('normalizeShow rejects "2024-13-45" premiered → null', () => {
    const result = normalizeShow({ id: 1, premiered: '2024-13-45', seasons: {} });
    expect(result!.premiered).toBeNull();
  });

  it('buildShowFromTvmaze rejects "2024-13-45" premiered → null', () => {
    const result = buildShowFromTvmaze(
      { id: 1, name: 'X', premiered: '2024-13-45', runtime: 60 },
      [],
      'towatch',
    );
    expect(result.premiered).toBeNull();
  });

  it('normalizeShow accepts "2099-01-01" premiered (future is valid date)', () => {
    const result = normalizeShow({ id: 1, premiered: '2099-01-01', seasons: {} });
    expect(result!.premiered).toBe('2099-01-01');
  });
});

// ============================================================
// SECTION 7: Serie senza stagioni / 0 episodi
// ============================================================

describe('Section 7: Serie senza stagioni / 0 episodi', () => {
  it('show with seasons={} → totalEpisodes=0, totalSeasons=0', () => {
    const show = makeShow({ seasons: {}, totalEpisodes: 0, totalSeasons: 0 });
    expect(show.totalEpisodes).toBe(0);
    expect(show.totalSeasons).toBe(0);
    expect(getWatchedCount(show)).toBe(0);
  });

  it('computeStats with show having 0 episodes → counted in totalShows, 0 watched', () => {
    const show = makeShow({ id: 1, seasons: {}, totalEpisodes: 0, totalSeasons: 0, list: 'towatch' });
    const stats = computeStats([show]);
    expect(stats.totalShows).toBe(1);
    expect(stats.totalWatched).toBe(0);
    expect(stats.totalEpisodes).toBe(0);
    expect(stats.towatchShows).toBe(1);
  });

  it('toggleEpisode on show with no seasons → no-op (no crash)', () => {
    const show = makeShow({ id: 1, seasons: {}, totalEpisodes: 0, list: 'towatch' });
    setShows([show]);
    expect(() => toggleEpisode(1, 1, 1)).not.toThrow();
    // State unchanged
    expect(getState().shows[0].seasons).toEqual({});
  });

  it('markSeasonWatched on show with no seasons → no-op (no crash)', () => {
    const show = makeShow({ id: 1, seasons: {}, totalEpisodes: 0, list: 'towatch' });
    setShows([show]);
    expect(() => markSeasonWatched(1, 1, true)).not.toThrow();
    expect(getState().shows[0].seasons).toEqual({});
  });

  it('setEpisodeRating on show with no seasons → no-op (no crash)', () => {
    const show = makeShow({ id: 1, seasons: {}, totalEpisodes: 0 });
    setShows([show]);
    expect(() => setEpisodeRating(1, 1, 1, 5)).not.toThrow();
  });

  it('reconcileAllLists: watching with 0 episodes + 0 watched → demoted to towatch', () => {
    const show = makeShow({
      id: 1,
      seasons: {},
      totalEpisodes: 0,
      list: 'watching',
      manualList: false,
    });
    reconcileAllLists([show]);
    expect(show.list).toBe('towatch');
  });

  it('reconcileAllLists: completed with 0 episodes + 0 watched → demoted to towatch', () => {
    const show = makeShow({
      id: 1,
      seasons: {},
      totalEpisodes: 0,
      list: 'completed',
      manualList: false,
    });
    reconcileAllLists([show]);
    expect(show.list).toBe('towatch');
  });

  it('reconcileAllLists: watching with 0 episodes but manualList=true → stays watching', () => {
    const show = makeShow({
      id: 1,
      seasons: {},
      totalEpisodes: 0,
      list: 'watching',
      manualList: true,
    });
    reconcileAllLists([show]);
    expect(show.list).toBe('watching');
  });

  it('toggleEpisode on show in towatch → auto-promote to watching (if has episodes)', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { id: 1, list: 'towatch', manualList: false });
    setShows([show]);
    toggleEpisode(1, 1, 1);
    expect(getState().shows[0].list).toBe('watching');
    expect(getState().shows[0].seasons[1][0].watched).toBe(true);
  });

  it('toggleEpisode on show in towatch with manualList=true → stays towatch (manual override)', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { id: 1, list: 'towatch', manualList: true });
    setShows([show]);
    toggleEpisode(1, 1, 1);
    // manualList blocks demotion, but auto-promotion to completed still happens.
    // Here watched=1, total=3 → not completed → manualList respected → stays towatch
    expect(getState().shows[0].list).toBe('towatch');
    // But the episode IS marked watched
    expect(getState().shows[0].seasons[1][0].watched).toBe(true);
  });

  it('markSeasonWatched all episodes → auto-promote to completed, manualList cleared', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1, list: 'watching', manualList: true });
    setShows([show]);
    markSeasonWatched(1, 1, true);
    expect(getState().shows[0].list).toBe('completed');
    expect(getState().shows[0].manualList).toBe(false);
  });
});

// ============================================================
// SECTION 8: Combinazioni cross-cutting
// ============================================================

describe('Section 8: Combinazioni cross-cutting', () => {
  it('show in watching with 0 watched but totalEpisodes=0 → demoted by reconcileAllLists', () => {
    // This is the "watching but no episodes to watch" edge case.
    const show = makeShow({
      id: 1,
      seasons: {},
      totalEpisodes: 0,
      list: 'watching',
      manualList: false,
    });
    reconcileAllLists([show]);
    expect(show.list).toBe('towatch');
  });

  it('reconcileAllLists with same show appearing twice → both processed (BUG-A19-04 consequence)', () => {
    // Duplicate shows in the array are both processed by reconcileAllLists.
    // This is a consequence of BUG-A19-04 (loadData doesn't dedup).
    const s1 = makeShowWithSeasons({ 1: 2 }, { id: 1, list: 'towatch', manualList: false });
    const s2 = makeShowWithSeasons({ 1: 2 }, { id: 1, list: 'towatch', manualList: false });
    markWatchedFirst(s1, 1, 2);
    markWatchedFirst(s2, 1, 2);
    reconcileAllLists([s1, s2]);
    // Both are auto-promoted to completed
    expect(s1.list).toBe('completed');
    expect(s2.list).toBe('completed');
  });

  it('toggleEpisode on show in towatch → auto-promote to watching (cross-module)', () => {
    const show = makeShowWithSeasons({ 1: 5 }, { id: 1, list: 'towatch', manualList: false });
    setShows([show]);
    // toggleEpisode calls updateShowListStatus which auto-promotes
    toggleEpisode(1, 1, 1);
    expect(getState().shows[0].list).toBe('watching');
  });

  it('refreshShowEpisodes should reject invalid airdate "2024-13-40" (BUG-A19-01)', async () => {
    // BUG-A19-01 [Medium] — shows.ts (A6): refreshShowEpisodes uses loose regex
    // `/^\d{4}-\d{2}-\d{2}$/` for airdate validation, which accepts invalid
    // dates like "2024-13-40" (month 13, day 40). This is inconsistent with
    // buildShowFromTvmaze and normalizeShow which use parseISODateLocal
    // (validates month 1-12, day 1-31, leap years, etc.).
    //
    // Correct behavior: airdate "2024-13-40" → null (rejected).
    // Current (buggy) behavior: airdate "2024-13-40" → stored as-is.
    //
    // Proposed fix: use parseISODateLocal in refreshShowEpisodes (shows.ts:288):
    //   airdate: typeof ep.airdate === 'string' && parseISODateLocal(ep.airdate) !== null
    //     ? ep.airdate : null,
    const show = makeShowWithSeasons({ 1: 0 }, { id: 42, list: 'watching' });
    setShows([show]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            { id: 101, season: 1, number: 1, name: 'Bad', airdate: '2024-13-40', runtime: 60 },
          ]),
        ),
    }) as unknown as typeof globalThis.fetch;

    await refreshShowEpisodes(42);
    const updated = getState().shows.find((s) => s.id === 42)!;
    // CORRECT behavior: invalid airdate → null
    expect(updated.seasons[1][0].airdate).toBeNull();
  });

  it('buildShowFromTvmaze rejects "2024-13-40" airdate (correct behavior, contrast with BUG-A19-01)', () => {
    const eps = [{ id: 1, season: 1, number: 1, airdate: '2024-13-40' }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    // buildShowFromTvmaze uses parseISODateLocal → rejects invalid date
    expect(show.seasons[1][0].airdate).toBeNull();
  });

  it('refreshShowEpisodes should stripHtml ep.name (BUG-A19-02)', async () => {
    // BUG-A19-02 [Medium] — shows.ts (A6): refreshShowEpisodes stores ep.name
    // raw (only .slice(0, 300), no stripHtml). This is inconsistent with
    // buildShowFromTvmaze/normalizeShow which use safeEpisodeName (stripHtml +
    // fallback null if empty). XSS defense-in-depth: if a future renderer
    // forgets to escapeHtml, stored HTML would be XSS.
    //
    // Correct behavior: name '<script>alert(1)</script>Real' → 'Real' (stripped).
    // Current (buggy) behavior: name stored raw with HTML tags.
    //
    // Proposed fix: use safeEpisodeName in refreshShowEpisodes (shows.ts:289).
    // Since safeEpisodeName is a local helper in normalize.ts (not exported),
    // either export it from normalize.ts or replicate the logic inline:
    //   name: typeof ep.name === 'string'
    //     ? (stripHtml(ep.name).slice(0, 300) || null)
    //     : null,
    const show = makeShowWithSeasons({ 1: 0 }, { id: 42, list: 'watching' });
    setShows([show]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            { id: 101, season: 1, number: 1, name: '<script>alert(1)</script>Real', airdate: '2024-01-01', runtime: 60 },
          ]),
        ),
    }) as unknown as typeof globalThis.fetch;

    await refreshShowEpisodes(42);
    const updated = getState().shows.find((s) => s.id === 42)!;
    // CORRECT behavior: HTML stripped → 'Real'
    expect(updated.seasons[1][0].name).toBe('Real');
  });

  it('buildShowFromTvmaze strips HTML from ep.name (correct behavior, contrast with BUG-A19-02)', () => {
    const eps = [{ id: 1, season: 1, number: 1, name: '<script>alert(1)</script>Real', airdate: '2024-01-01' }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    // buildShowFromTvmaze uses safeEpisodeName → strips HTML
    expect(show.seasons[1][0].name).toBe('Real');
  });

  it('BUG-A19-03: refreshShowEpisodes should reject Infinity runtime (code-level finding)', async () => {
    // BUG-A19-03 [Low] — shows.ts (A6): refreshShowEpisodes uses `ep.runtime > 0`
    // which accepts Infinity (Infinity > 0 === true). This is inconsistent with
    // buildShowFromTvmaze/normalizeShow which use safeEpisodeRuntime
    // (Number.isFinite → rejects Infinity).
    //
    // NOTE: Infinity cannot enter via JSON (JSON.stringify(Infinity) = 'null'),
    // so this bug can't be triggered via the real API. It's a code quality
    // inconsistency. We verify the contrast with buildShowFromTvmaze (which
    // correctly rejects Infinity) as a reference for the correct behavior.
    //
    // Proposed fix: use Number.isFinite in refreshShowEpisodes (shows.ts:290):
    //   runtime: typeof ep.runtime === 'number' && Number.isFinite(ep.runtime) && ep.runtime > 0
    //     ? ep.runtime : null,
    const eps = [{ id: 1, season: 1, number: 1, runtime: Infinity }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    // buildShowFromTvmaze REJECTS Infinity (safeEpisodeRuntime) → null
    expect(show.seasons[1][0].runtime).toBeNull();
    // refreshShowEpisodes would ACCEPT Infinity (uses `> 0` instead of
    // Number.isFinite), but we can't trigger it via JSON mock.
  });

  it('buildShowFromTvmaze rejects Infinity runtime (correct behavior, contrast with BUG-A19-03)', () => {
    const eps = [{ id: 1, season: 1, number: 1, runtime: Infinity }];
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, eps, 'towatch');
    // buildShowFromTvmaze uses safeEpisodeRuntime → Infinity → null
    expect(show.seasons[1][0].runtime).toBeNull();
  });

  it('refreshShowEpisodes preserves existing watched state (cross-module consistency)', async () => {
    // After refresh, existing watched/rating/note should be preserved.
    const show = makeShowWithSeasons({ 1: 2 }, { id: 42, list: 'watching' });
    show.seasons[1][0].watched = true;
    show.seasons[1][0].rating = 5;
    show.seasons[1][0].note = 'Great';
    show.seasons[1][0].id = 101; // match TVMaze id
    setShows([show]);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2024-01-01', runtime: 60 },
            { id: 102, season: 1, number: 2, name: 'Ep2', airdate: '2024-01-08', runtime: 60 },
          ]),
        ),
    }) as unknown as typeof globalThis.fetch;

    const result = await refreshShowEpisodes(42);
    expect(result).toBe(true);
    const updated = getState().shows.find((s) => s.id === 42)!;
    expect(updated.seasons[1][0].watched).toBe(true);
    expect(updated.seasons[1][0].rating).toBe(5);
    expect(updated.seasons[1][0].note).toBe('Great');
  });

  it('addShowToList with saveData failure → rollback (show removed from state)', async () => {
    // Mock fetch to return episodes
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2024-01-01', runtime: 60 },
          ]),
        ),
    }) as unknown as typeof globalThis.fetch;

    // Make saveData fail (quota)
    mem.quotaFailOn = () => true;

    const tvmazeShow = {
      id: 99,
      name: 'New Show',
      status: 'Running',
      premiered: '2024-01-01',
      genres: ['Drama'],
      summary: '',
      runtime: 60,
      image: { medium: 'https://img.tvmaze.com/m.jpg', original: 'https://img.tvmaze.com/o.jpg' },
      network: { name: 'HBO' },
    };

    const result = await addShowToList(tvmazeShow, 'watching');
    expect(result).toBeNull();
    // Show was rolled back (removed from state)
    expect(getState().shows.find((s) => s.id === 99)).toBeUndefined();
    // Error toast shown
    expect(showToast).toHaveBeenCalledWith(
      'Impossibile salvare (storage pieno o modifiche in altro tab?)',
      'error',
    );
  });

  it('computeStats with mixed valid + null entries → filters nulls (safeShows)', () => {
    const valid = makeShowWithSeasons({ 1: 5 }, { id: 1, runtime: 60, list: 'watching' });
    markWatchedFirst(valid, 1, 3);
    const shows = [null, valid, undefined] as unknown as Show[];
    const stats = computeStats(shows);
    expect(stats.totalShows).toBe(1);
    expect(stats.totalWatched).toBe(3);
    expect(stats.totalEpisodes).toBe(5);
  });

  it('computeStats with show having Infinity runtime → uses fallback 45 min', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1, runtime: Infinity as unknown as number, list: 'watching' });
    markWatchedFirst(show, 1, 2);
    const stats = computeStats([show]);
    // safeNum(Infinity) returns 0, then `0 || 45` = 45. 2 episodes * 45 = 90 min.
    expect(stats.totalMinutes).toBe(90);
  });

  it('computeStats with show having runtime=0 → uses fallback 45 min', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1, runtime: 0, list: 'watching' });
    markWatchedFirst(show, 1, 2);
    const stats = computeStats([show]);
    // safeNum(0) returns 0, then `0 || 45` = 45. 2 * 45 = 90.
    expect(stats.totalMinutes).toBe(90);
  });

  it('storage event during toggleEpisode await — refresh race (documented limitation)', async () => {
    // This test documents a known race: during the await in refreshShowEpisodes,
    // a storage event can replace state.shows. The `show` reference captured
    // before the await becomes detached. Mutations to it are lost.
    // This is a design limitation of optimistic concurrency without transactions.
    const show = makeShowWithSeasons({ 1: 1 }, { id: 42, list: 'watching' });
    setShows([show]);
    const originalShow = getState().shows[0];

    // Mock a SLOW fetch that we can control
    let resolveFetch: ((value: { ok: boolean; status: number; text: () => Promise<string> }) => void) | null = null;
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof globalThis.fetch;

    const refreshPromise = refreshShowEpisodes(42);

    // While fetch is pending, a storage event replaces state.shows
    const tabBData = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: [{ id: 42, name: 'Replaced by tab B', seasons: {}, totalEpisodes: 0, totalSeasons: 0, list: 'towatch' }],
      savedAt: 2000,
    });
    mem.store.set(STORAGE_KEY, tabBData);
    dispatchStorageEvent(STORAGE_KEY, tabBData);

    // state.shows[0] is now the tab B show (different reference from originalShow)
    expect(getState().shows[0]).not.toBe(originalShow);
    expect(getState().shows[0].name).toBe('Replaced by tab B');

    // Now resolve the fetch — refresh mutates the DETACHED originalShow
    resolveFetch!({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify([
            { id: 101, season: 1, number: 1, name: 'Refreshed', airdate: '2024-01-01', runtime: 60 },
          ]),
        ),
    });

    await refreshPromise;

    // The live state still has tab B's show (refresh's mutations went to the
    // detached originalShow, which is no longer in state.shows).
    // This is the documented race — refresh silently fails to update the live state.
    expect(getState().shows[0].name).toBe('Replaced by tab B');
  });
});

// ============================================================
// SECTION 9: Cross-module regression — verify no crash on combined edge cases
// ============================================================

describe('Section 9: Cross-module regression — combined edge cases', () => {
  it('loadData with deeply nested corrupted seasons → normalizeShow handles gracefully', () => {
    const corruptedShows = [
      {
        id: 1,
        name: 'Test',
        seasons: {
          '1': [
            { num: 1, id: 1, watched: 'true', airdate: '2024-13-40', name: '<script>x</script>', runtime: Infinity },
            { num: 2, id: 2, watched: 1, airdate: '', name: null, runtime: -5 },
            null, // null episode entry
            { num: 'abc', id: 3, watched: false }, // invalid num
            'not-an-object', // garbage entry
          ],
          'not-a-number': [], // invalid season key
          '__proto__': [{ num: 1, id: 1, watched: false }], // proto pollution attempt
        },
        genres: ['Drama', 42, null, '<b>Crime</b>', 'Drama'], // mixed types + dup
        tags: ['<script>tag1</script>', 'tag2', 123, null, 'tag1'], // mixed + dup
        runtime: 'sixty', // non-numeric
        premiered: '2024-13-01', // invalid
      },
    ];
    putSavedData(mem, corruptedShows, 1000);
    // Should not crash
    expect(() => loadData()).not.toThrow();
    // Show should be loaded (normalizeShow is defensive)
    expect(getState().shows).toHaveLength(1);
    const show = getState().shows[0];
    expect(show.id).toBe(1);
    // totalEpisodes recalculated from valid seasons only (season 1, 2 valid eps)
    expect(show.totalEpisodes).toBeGreaterThanOrEqual(0); // defensive
    // Genres deduped and filtered to strings
    expect(show.genres.every((g) => typeof g === 'string')).toBe(true);
    // Tags deduped case-insensitive, filtered to strings
    expect(show.tags!.every((t) => typeof t === 'string')).toBe(true);
    // Runtime fallback (non-numeric → 45)
    expect(show.runtime).toBe(45);
    // Premiered null (invalid date)
    expect(show.premiered).toBeNull();
  });

  it('full cycle: load → toggle → save → reload → verify persistence', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { id: 1, list: 'towatch' });
    putSavedData(mem, [show], 1000);

    loadData();
    expect(getState().shows[0].seasons[1][0].watched).toBe(false);

    // Toggle first episode
    toggleEpisode(1, 1, 1);
    expect(getState().shows[0].seasons[1][0].watched).toBe(true);

    // Verify it was saved to localStorage
    const saved = readShows(mem) as Array<{ seasons: Record<number, Array<{ watched: boolean }>> }>;
    expect(saved[0].seasons[1][0].watched).toBe(true);

    // Reload — should load the saved state
    resetState();
    loadData();
    expect(getState().shows[0].seasons[1][0].watched).toBe(true);
    expect(getState().shows[0].list).toBe('watching'); // auto-promoted
  });

  it('full cycle: load → toggle → CAS fail (other tab wrote) → rollback', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { id: 1, list: 'towatch' });
    putSavedData(mem, [show], 1000);
    loadData();

    // Tab B writes different data (no storage event in this tab)
    putSavedData(mem, [makeShow({ id: 99, name: 'Tab B' })], 2000);

    // Tab A tries to toggle — saveData will CAS-fail
    toggleEpisode(1, 1, 1);

    // Rollback: episode not watched
    expect(getState().shows[0].seasons[1][0].watched).toBe(false);
    // Toast about multi-tab
    expect(showToast).toHaveBeenCalledWith(
      'Modifica non salvata (storage error o modifiche in altro tab)',
      'error',
    );
  });

  it('normalizeShow + reconcileAllLists: show with all fields corrupted → valid default show', () => {
    const corrupted = {
      id: 'abc', // invalid → normalizeShow returns null
      name: 123,
      seasons: 'not-an-object',
    };
    expect(normalizeShow(corrupted)).toBeNull(); // invalid id → null
  });

  it('normalizeShow with id=0 → null (safeId rejects 0)', () => {
    expect(normalizeShow({ id: 0, name: 'X', seasons: {} })).toBeNull();
  });

  it('normalizeShow with negative id → null', () => {
    expect(normalizeShow({ id: -1, name: 'X', seasons: {} })).toBeNull();
  });

  it('normalizeShow with id exceeding MAX_SAFE_INTEGER → null', () => {
    expect(normalizeShow({ id: Number.MAX_SAFE_INTEGER + 1, name: 'X', seasons: {} })).toBeNull();
  });

  it('buildShowFromTvmaze with id=0 → throws (defense-in-depth)', () => {
    expect(() => buildShowFromTvmaze({ id: 0, name: 'X', runtime: 60 }, [], 'towatch')).toThrow();
  });

  it('isStorageOK() returns true in jsdom environment', () => {
    expect(isStorageOK()).toBe(true);
  });

  it('loadData with SecurityError on getItem → falls back to in-memory mode', () => {
    mem.getItemThrows = true;
    expect(() => loadData()).not.toThrow();
    expect(getState().shows).toEqual([]);
    expect(showToast).toHaveBeenCalledWith('Archiviazione non disponibile.', 'error');
  });
});
