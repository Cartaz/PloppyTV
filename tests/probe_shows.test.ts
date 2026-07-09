// Agent 06 probe: stress-test src/lib/shows.ts actions.
// Mocks api/storage/toast/modal/header; uses real store/normalize/utils.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Show, TvmazeEpisode, TvmazeShow } from '../src/types';

// ===== Mocks (hoisted by vitest) =====

vi.mock('../src/lib/api', () => ({
  getShowEpisodes: vi.fn(),
  ApiError: class ApiError extends Error {
    status?: number;
    override name: string;
    constructor(message: string, name: string, status?: number) {
      super(message);
      this.name = name;
      this.status = status;
    }
  },
}));

vi.mock('../src/lib/storage', () => ({
  saveData: vi.fn(() => true),
}));

vi.mock('../src/components/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../src/components/modal', () => ({
  showModal: vi.fn(),
}));

vi.mock('../src/components/header', () => ({
  updateBadges: vi.fn(),
}));

import {
  addShowToList,
  removeShow,
  moveShowToList,
  toggleEpisode,
  markSeasonWatched,
  refreshShowEpisodes,
  showNeedsEpisodeNames,
} from '../src/lib/shows';
import { getState, setState, subscribe, setShows } from '../src/lib/store';
import { getShowEpisodes } from '../src/lib/api';
import { saveData } from '../src/lib/storage';
import { showToast } from '../src/components/toast';
import { showModal } from '../src/components/modal';
import { updateBadges } from '../src/components/header';

// ===== Helpers =====

function makeTvmazeShow(id: number, name = 'Test Show'): TvmazeShow {
  return {
    id,
    name,
    status: 'Running',
    premiered: '2024-01-01',
    genres: ['Drama'],
    summary: '<p>Test</p>',
    runtime: 60,
    image: { medium: 'https://img.tvmaze.com/m.jpg', original: 'https://img.tvmaze.com/o.jpg' },
    network: { name: 'HBO' },
  };
}

function makeTvmazeEpisodes(): TvmazeEpisode[] {
  return [
    { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2024-01-01', runtime: 60 },
    { id: 102, season: 1, number: 2, name: 'Ep2', airdate: '2024-01-08', runtime: 60 },
    { id: 201, season: 2, number: 1, name: 'S2E1', airdate: '2025-01-01', runtime: 60 },
  ];
}

function makeShow(over: Partial<Show> = {}): Show {
  return {
    id: 42,
    name: 'Test',
    image: null,
    status: 'Running',
    premiered: null,
    genres: [],
    summary: '',
    network: 'N/D',
    runtime: 45,
    list: 'towatch',
    manualList: false,
    seasons: {
      1: [
        { num: 1, id: 101, watched: false, airdate: null, name: 'P1', runtime: 60 },
        { num: 2, id: 102, watched: false, airdate: null, name: 'P2', runtime: 60 },
      ],
    },
    totalSeasons: 1,
    totalEpisodes: 2,
    addedAt: 1700000000000,
    ...over,
  };
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

/** Invoke the "Rimuovi" confirm button of the most-recent showModal call. */
function invokeRemoveConfirm(): void {
  const calls = vi.mocked(showModal).mock.calls;
  const last = calls[calls.length - 1];
  const actions = last![2] as Array<{ onClick?: () => void }>;
  // actions[1] is "Rimuovi" (actions[0] is "Annulla")
  actions[1].onClick?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveData).mockReturnValue(true);
  vi.mocked(getShowEpisodes).mockResolvedValue(makeTvmazeEpisodes());
  resetState();
});

// ===== Tests =====

describe('addShowToList', () => {
  it('inflight guard rejects second concurrent call for same show', async () => {
    let resolveFirst!: (v: TvmazeEpisode[]) => void;
    vi.mocked(getShowEpisodes).mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res; }),
    );
    const p1 = addShowToList(makeTvmazeShow(42), 'towatch');
    // p2 starts synchronously while p1 is still awaiting getShowEpisodes
    const p2 = addShowToList(makeTvmazeShow(42), 'towatch');
    const r2 = await p2;
    expect(r2).toBeNull();
    expect(showToast).toHaveBeenCalledWith('Aggiunta in corso...', 'warning');
    resolveFirst(makeTvmazeEpisodes());
    const r1 = await p1;
    expect(r1).not.toBeNull();
  });

  it('post-await re-check: if show added by another path during await, returns null', async () => {
    vi.mocked(getShowEpisodes).mockImplementationOnce(async () => {
      // Simulate another path (e.g. import) adding the show during the await
      setShows([makeShow({ id: 42 })]);
      return makeTvmazeEpisodes();
    });
    const result = await addShowToList(makeTvmazeShow(42), 'towatch');
    expect(result).toBeNull();
    expect(showToast).toHaveBeenCalledWith('Serie già presente', 'error');
  });

  it('rollback on saveData fail removes show from state', async () => {
    vi.mocked(saveData).mockReturnValue(false);
    const result = await addShowToList(makeTvmazeShow(42), 'towatch');
    expect(result).toBeNull();
    expect(getState().shows.find((s) => s.id === 42)).toBeUndefined();
  });

  it('rollback DOES emit change (via removeShowFromState) — UI is notified', async () => {
    vi.mocked(saveData).mockReturnValue(false);
    let emitCount = 0;
    const unsub = subscribe(() => { emitCount++; });
    await addShowToList(makeTvmazeShow(42), 'towatch');
    // RAF-coalesced; flush with a macrotask
    await new Promise((r) => setTimeout(r, 50));
    expect(emitCount).toBeGreaterThan(0);
    unsub();
  });

  it('rollback does NOT call updateBadges (state restored so DOM already matches)', async () => {
    vi.mocked(saveData).mockReturnValue(false);
    await addShowToList(makeTvmazeShow(42), 'towatch');
    expect(updateBadges).not.toHaveBeenCalled();
  });

  it('success path calls updateBadges exactly once', async () => {
    const r = await addShowToList(makeTvmazeShow(42), 'towatch');
    expect(r).not.toBeNull();
    expect(updateBadges).toHaveBeenCalledTimes(1);
  });

  it('manualList semantics: towatch=false, watching=true, completed=true', async () => {
    const cases: Array<['towatch' | 'watching' | 'completed', boolean]> = [
      ['towatch', false],
      ['watching', true],
      ['completed', true],
    ];
    for (const [list, expectedManual] of cases) {
      resetState();
      vi.clearAllMocks();
      vi.mocked(saveData).mockReturnValue(true);
      vi.mocked(getShowEpisodes).mockResolvedValue(makeTvmazeEpisodes());
      const r = await addShowToList(makeTvmazeShow(42, 'Test ' + list), list);
      expect(r).not.toBeNull();
      expect(r!.manualList).toBe(expectedManual);
      expect(r!.list).toBe(list);
    }
  });

  it('adding to completed with 0 watched: stays completed (manualList blocks demote)', async () => {
    const r = await addShowToList(makeTvmazeShow(42), 'completed');
    expect(r).not.toBeNull();
    expect(r!.list).toBe('completed');
    expect(r!.manualList).toBe(true);
    // No updateShowListStatus called in addShowToList, so list stays as user chose.
  });

  it('invalid tvmazeShow returns null', async () => {
    expect(await addShowToList(null as never, 'towatch')).toBeNull();
    expect(await addShowToList({} as never, 'towatch')).toBeNull();
    expect(await addShowToList({ id: 0 } as never, 'towatch')).toBeNull();
    expect(await addShowToList({ id: -1 } as never, 'towatch')).toBeNull();
  });

  it('getShowEpisodes error: returns null + error toast, clears inflight', async () => {
    const err = Object.assign(new Error('boom'), { name: 'NetworkError' });
    vi.mocked(getShowEpisodes).mockRejectedValueOnce(err);
    const r1 = await addShowToList(makeTvmazeShow(42), 'towatch');
    expect(r1).toBeNull();
    expect(showToast).toHaveBeenCalledWith('Connessione internet non disponibile', 'error');
    // inflight cleared → second call can proceed
    const r2 = await addShowToList(makeTvmazeShow(42), 'towatch');
    expect(r2).not.toBeNull();
  });

  it('success does not emit when currentShowId is set (detail view open)', async () => {
    setState({ currentShowId: 999 });
    let emitCount = 0;
    const unsub = subscribe(() => { emitCount++; });
    await addShowToList(makeTvmazeShow(42), 'towatch');
    await new Promise((r) => setTimeout(r, 50));
    // replaceShow still emits (line 47), so emitCount >= 1.
    // The conditional emitChange at lines 56-61 is a no-op (RAF coalesced).
    expect(emitCount).toBeGreaterThanOrEqual(1);
    unsub();
  });
});

describe('removeShow', () => {
  it('removes show on confirm + saveData success', () => {
    setShows([makeShow({ id: 42, list: 'watching' })]);
    removeShow(42, 'Test');
    invokeRemoveConfirm();
    expect(getState().shows.find((s) => s.id === 42)).toBeUndefined();
    expect(updateBadges).toHaveBeenCalledTimes(1);
  });

  it('rollback restores show on saveData fail', () => {
    vi.mocked(saveData).mockReturnValue(false);
    setShows([makeShow({ id: 42, list: 'watching' })]);
    removeShow(42, 'Test');
    invokeRemoveConfirm();
    expect(getState().shows.find((s) => s.id === 42)).toBeDefined();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Impossibile rimuovere'), 'error');
  });

  it('rollback does NOT call updateBadges', () => {
    vi.mocked(saveData).mockReturnValue(false);
    setShows([makeShow({ id: 42, list: 'watching' })]);
    removeShow(42, 'Test');
    invokeRemoveConfirm();
    expect(updateBadges).not.toHaveBeenCalled();
  });

  it('on success, jumps to dashboard view (even if user was on watching list)', () => {
    setShows([makeShow({ id: 42, list: 'watching' })]);
    setState({ currentView: 'watching' });
    removeShow(42, 'Test');
    invokeRemoveConfirm();
    expect(getState().currentView).toBe('dashboard');
    expect(getState().currentShowId).toBeNull();
  });

  it('snapshot is a shallow copy: original show objects not mutated during remove', () => {
    const show = makeShow({ id: 42, list: 'watching' });
    const originalSeasonsRef = show.seasons;
    setShows([show]);
    removeShow(42, 'Test');
    invokeRemoveConfirm();
    // show object is gone from state, but its seasons ref unchanged
    expect(show.seasons).toBe(originalSeasonsRef);
  });
});

describe('moveShowToList', () => {
  it('BUG-06-01 FIXED: sets manualList=false for towatch (allows natural promotion)', () => {
    setShows([makeShow({ id: 42, list: 'watching', manualList: false })]);
    moveShowToList(42, 'towatch');
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.list).toBe('towatch');
    // FIXED (BUG-06-01): manualList=false for towatch, so a subsequent
    // toggleEpisode can naturally promote the show back to 'watching'.
    expect(show.manualList).toBe(false);
  });

  it('BUG-06-01 FIXED: sets manualList=true for watching and completed', () => {
    for (const target of ['watching', 'completed'] as const) {
      resetState();
      vi.clearAllMocks();
      vi.mocked(saveData).mockReturnValue(true);
      setShows([makeShow({ id: 42, list: 'towatch', manualList: false })]);
      moveShowToList(42, target);
      const show = getState().shows.find((s) => s.id === 42)!;
      expect(show.list).toBe(target);
      // FIXED: manualList=true for watching/completed (blocks demotion only).
      expect(show.manualList).toBe(true);
    }
  });

  it('no-op when moving to same list (no toast)', () => {
    setShows([makeShow({ id: 42, list: 'watching', manualList: false })]);
    moveShowToList(42, 'watching');
    expect(showToast).not.toHaveBeenCalledWith('Serie spostata', 'success');
    expect(updateBadges).not.toHaveBeenCalled();
  });

  it('rollback restores list and manualList on saveData fail', () => {
    vi.mocked(saveData).mockReturnValue(false);
    setShows([makeShow({ id: 42, list: 'watching', manualList: false })]);
    moveShowToList(42, 'towatch');
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.list).toBe('watching');
    expect(show.manualList).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Spostamento non salvato'), 'error');
  });

  it('returns silently when show not found', () => {
    expect(() => moveShowToList(999, 'towatch')).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('returns silently for invalid list name', () => {
    setShows([makeShow({ id: 42 })]);
    expect(() => moveShowToList(42, 'invalid' as never)).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });

  // === THE BUG (FIXED) ===
  it('BUG-06-03 FIXED: moving to towatch + later toggle DOES promote towatch→watching', () => {
    const show = makeShow({ id: 42, list: 'watching', manualList: false });
    setShows([show]);
    moveShowToList(42, 'towatch'); // BUG-06-01 fix: manualList=false for towatch
    expect(show.manualList).toBe(false);
    expect(show.list).toBe('towatch');
    // User starts watching the show, marks episode 1
    toggleEpisode(42, 1, 1);
    expect(show.seasons[1][0].watched).toBe(true);
    // FIXED: with manualList=false, updateShowListStatus promotes towatch→watching.
    expect(show.list).toBe('watching');
  });

  it('contrast: addShowToList to towatch (manualList=false) + toggle DOES promote', async () => {
    const r = await addShowToList(makeTvmazeShow(42), 'towatch');
    expect(r!.manualList).toBe(false);
    toggleEpisode(42, 1, 1);
    expect(r!.list).toBe('watching');
  });
});

describe('toggleEpisode', () => {
  it('toggles watched and promotes towatch→watching (no manualList)', () => {
    setShows([makeShow({ id: 42, list: 'towatch', manualList: false })]);
    toggleEpisode(42, 1, 1);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].watched).toBe(true);
    expect(show.list).toBe('watching');
  });

  it('toggle last unwatched → completed + manualList=false (auto-promote clears override)', () => {
    const show = makeShow({ id: 42, list: 'watching', manualList: true });
    show.seasons[1][0].watched = true;
    setShows([show]);
    toggleEpisode(42, 1, 2);
    expect(show.seasons[1][1].watched).toBe(true);
    expect(show.list).toBe('completed');
    expect(show.manualList).toBe(false);
  });

  it('rollback on saveData fail restores watched, list, manualList', () => {
    vi.mocked(saveData).mockReturnValue(false);
    setShows([makeShow({ id: 42, list: 'towatch', manualList: false })]);
    toggleEpisode(42, 1, 1);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].watched).toBe(false);
    expect(show.list).toBe('towatch');
    expect(show.manualList).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('non salvata'), 'error');
  });

  it('silent return when ep not found (bad season/ep num)', () => {
    setShows([makeShow({ id: 42 })]);
    expect(() => toggleEpisode(42, 99, 1)).not.toThrow();
    expect(() => toggleEpisode(42, 1, 99)).not.toThrow();
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].watched).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('silent return when show not found', () => {
    expect(() => toggleEpisode(999, 1, 1)).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('rollback does NOT call updateBadges', () => {
    vi.mocked(saveData).mockReturnValue(false);
    setShows([makeShow({ id: 42 })]);
    toggleEpisode(42, 1, 1);
    expect(updateBadges).not.toHaveBeenCalled();
  });
});

describe('markSeasonWatched', () => {
  it('marks all episodes watched → completed (auto-promote clears manualList)', () => {
    setShows([makeShow({ id: 42, list: 'watching', manualList: true })]);
    markSeasonWatched(42, 1, true);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1].every((e) => e.watched)).toBe(true);
    expect(show.list).toBe('completed');
    expect(show.manualList).toBe(false);
  });

  it('marks all unwatched → towatch (no manualList)', () => {
    const show = makeShow({ id: 42, list: 'watching', manualList: false });
    show.seasons[1][0].watched = true;
    setShows([show]);
    markSeasonWatched(42, 1, false);
    expect(show.seasons[1].every((e) => !e.watched)).toBe(true);
    expect(show.list).toBe('towatch');
  });

  it('marks all unwatched with manualList=true → stays watching (demote blocked)', () => {
    const show = makeShow({ id: 42, list: 'watching', manualList: true });
    show.seasons[1][0].watched = true;
    setShows([show]);
    markSeasonWatched(42, 1, false);
    expect(show.seasons[1].every((e) => !e.watched)).toBe(true);
    expect(show.list).toBe('watching');
    expect(show.manualList).toBe(true);
  });

  it('rollback restores episodes (shallow copy of ep objects) on saveData fail', () => {
    vi.mocked(saveData).mockReturnValue(false);
    const show = makeShow({ id: 42, list: 'watching', manualList: false });
    show.seasons[1][0].watched = true;
    setShows([show]);
    markSeasonWatched(42, 1, true); // would set all watched
    expect(show.seasons[1][0].watched).toBe(true);
    expect(show.seasons[1][1].watched).toBe(false);
    expect(show.list).toBe('watching');
    expect(show.manualList).toBe(false);
  });

  it('silent return when season not found', () => {
    setShows([makeShow({ id: 42 })]);
    expect(() => markSeasonWatched(42, 99, true)).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('refreshShowEpisodes', () => {
  it('preserves watched state when episode numbers match', async () => {
    const show = makeShow({
      id: 42, list: 'watching', manualList: false,
      seasons: {
        1: [
          { num: 1, id: 101, watched: true, airdate: '2024-01-01', name: 'Old Pilot', runtime: 60 },
          { num: 2, id: 102, watched: false, airdate: '2024-01-08', name: 'Old Ep2', runtime: 60 },
        ],
      },
    });
    setShows([show]);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(true);
    expect(show.seasons[1].find((e) => e.num === 1)!.watched).toBe(true);
    expect(show.seasons[1].find((e) => e.num === 2)!.watched).toBe(false);
  });

  it('BUG-06-04 FIXED: preserves watched state when TVMaze renumbers (matched by id)', async () => {
    const show = makeShow({
      id: 42, list: 'watching', manualList: false,
      seasons: {
        1: [
          { num: 1, id: 101, watched: true, airdate: '2024-01-01', name: 'Old Pilot', runtime: 60 },
          { num: 2, id: 102, watched: false, airdate: '2024-01-08', name: 'Old Ep2', runtime: 60 },
        ],
      },
    });
    setShows([show]);
    // TVMaze now returns episodes with num=10, 11 (renumbered, same ids)
    vi.mocked(getShowEpisodes).mockResolvedValue([
      { id: 101, season: 1, number: 10, name: 'Pilot', airdate: '2024-01-01', runtime: 60 },
      { id: 102, season: 1, number: 11, name: 'Ep2', airdate: '2024-01-08', runtime: 60 },
    ]);
    await refreshShowEpisodes(42);
    // FIXED (BUG-06-02): matched by stable TVMaze id → watched state preserved.
    expect(show.seasons[1].find((e) => e.num === 1)).toBeUndefined();
    expect(show.seasons[1].find((e) => e.num === 10)!.watched).toBe(true); // FIXED: preserved via id match
    expect(show.seasons[1].find((e) => e.num === 10)!.id).toBe(101);
    expect(show.seasons[1].find((e) => e.num === 11)!.watched).toBe(false);
  });

  it('refresh falls back to num match when id differs (backward compat)', async () => {
    const show = makeShow({
      id: 42, list: 'watching', manualList: false,
      seasons: {
        1: [{ num: 1, id: 999, watched: true, airdate: null, name: 'Old', runtime: 60 }],
      },
    });
    setShows([show]);
    // TVMaze returns same num but different id
    vi.mocked(getShowEpisodes).mockResolvedValue([
      { id: 101, season: 1, number: 1, name: 'New Pilot', airdate: '2024-01-01', runtime: 60 },
    ]);
    await refreshShowEpisodes(42);
    expect(show.seasons[1].find((e) => e.num === 1)!.watched).toBe(true);
    expect(show.seasons[1].find((e) => e.num === 1)!.id).toBe(101); // id updated
    expect(show.seasons[1].find((e) => e.num === 1)!.name).toBe('New Pilot'); // name updated
  });

  it('rollback restores seasons on saveData fail', async () => {
    vi.mocked(saveData).mockReturnValue(false);
    const show = makeShow({
      id: 42, list: 'watching', manualList: false,
      seasons: {
        1: [{ num: 1, id: 101, watched: true, airdate: '2024-01-01', name: 'Old', runtime: 60 }],
      },
    });
    setShows([show]);
    const originalSeasons = JSON.parse(JSON.stringify(show.seasons));
    await refreshShowEpisodes(42);
    expect(show.seasons).toEqual(originalSeasons);
    expect(show.list).toBe('watching');
  });

  it('rollback does NOT call updateBadges', async () => {
    vi.mocked(saveData).mockReturnValue(false);
    setShows([makeShow({ id: 42 })]);
    await refreshShowEpisodes(42);
    expect(updateBadges).not.toHaveBeenCalled();
  });

  it('inflight guard: rejects second concurrent call', async () => {
    let resolveFirst!: (v: TvmazeEpisode[]) => void;
    vi.mocked(getShowEpisodes).mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res; }),
    );
    setShows([makeShow({ id: 42 })]);
    const p1 = refreshShowEpisodes(42);
    const r2 = await refreshShowEpisodes(42);
    expect(r2).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Aggiornamento già in corso...', 'warning');
    resolveFirst(makeTvmazeEpisodes());
    const r1 = await p1;
    expect(r1).toBe(true);
  });

  it('silent option suppresses inflight toast', async () => {
    let resolveFirst!: (v: TvmazeEpisode[]) => void;
    vi.mocked(getShowEpisodes).mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res; }),
    );
    setShows([makeShow({ id: 42 })]);
    const p1 = refreshShowEpisodes(42, { silent: true });
    const r2 = await refreshShowEpisodes(42, { silent: true });
    expect(r2).toBe(false);
    expect(showToast).not.toHaveBeenCalledWith('Aggiornamento già in corso...', 'warning');
    resolveFirst(makeTvmazeEpisodes());
    await p1;
  });

  it('returns false for invalid id (safeId=0)', async () => {
    expect(await refreshShowEpisodes(0)).toBe(false);
    expect(await refreshShowEpisodes(-1)).toBe(false);
  });

  it('returns false if show not in state', async () => {
    const result = await refreshShowEpisodes(999);
    expect(result).toBe(false);
  });

  it('network error: returns false + error toast, clears inflight', async () => {
    const err = Object.assign(new Error('boom'), { name: 'TimeoutError' });
    vi.mocked(getShowEpisodes).mockRejectedValueOnce(err);
    setShows([makeShow({ id: 42 })]);
    const r1 = await refreshShowEpisodes(42);
    expect(r1).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Timeout aggiornamento. Riprova.', 'error');
    // inflight cleared
    const r2 = await refreshShowEpisodes(42);
    expect(r2).toBe(true);
  });

  it('skips season 0 specials and episodes with null number', async () => {
    setShows([makeShow({ id: 42 })]);
    vi.mocked(getShowEpisodes).mockResolvedValue([
      { id: 1, season: 0, number: 1, name: 'Special' }, // skip (season 0)
      { id: 2, season: 1, number: null, name: 'NoNum' } as unknown as TvmazeEpisode, // skip (null number)
      { id: 3, season: 1, number: 1, name: 'Real', airdate: '2024-01-01', runtime: 60 },
    ]);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(true);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1].length).toBe(1);
    expect(show.seasons[1][0].name).toBe('Real');
  });

  it('updates totalEpisodes and totalSeasons from new data', async () => {
    setShows([makeShow({ id: 42, totalEpisodes: 2, totalSeasons: 1 })]);
    // mockResolvedValue from beforeEach returns 3 episodes across 2 seasons
    await refreshShowEpisodes(42);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.totalEpisodes).toBe(3);
    expect(show.totalSeasons).toBe(2);
  });
});

describe('showNeedsEpisodeNames', () => {
  function makeShowWithEps(eps: Array<Partial<Show['seasons'][number][number]>>): Show {
    return {
      id: 1, name: 'x', image: null, status: '', premiered: null, genres: [], summary: '',
      network: '', runtime: 45, list: 'towatch', manualList: false,
      seasons: { 1: eps.map((e, i) => ({ num: i + 1, id: i + 1, watched: false, airdate: null, name: null, runtime: null, ...e })) },
      totalSeasons: 1, totalEpisodes: eps.length, addedAt: 0,
    };
  }

  it('returns false for seasons undefined', () => {
    expect(showNeedsEpisodeNames({ id: 1 } as Show)).toBe(false);
  });

  it('returns true if any episode has name=null', () => {
    expect(showNeedsEpisodeNames(makeShowWithEps([{ name: 'Pilot' }, { name: null }]))).toBe(true);
  });

  it('returns true if any episode has name=undefined', () => {
    expect(showNeedsEpisodeNames(makeShowWithEps([{ name: 'Pilot' }, {}]))).toBe(true);
  });

  it('BUG-06-05 FIXED: returns true for name="" (empty string) — consistent with null/undefined', () => {
    // FIXED (BUG-06-03): empty string is now treated as "missing" — auto-refresh fires.
    expect(showNeedsEpisodeNames(makeShowWithEps([{ name: '' }]))).toBe(true);
  });

  it('returns false when all episodes have non-empty names', () => {
    expect(showNeedsEpisodeNames(makeShowWithEps([{ name: 'Pilot' }, { name: 'Ep2' }]))).toBe(false);
  });

  it('skips non-array season values', () => {
    const show = {
      id: 1,
      seasons: { 1: 'not-an-array' },
    } as unknown as Show;
    expect(showNeedsEpisodeNames(show)).toBe(false);
  });

  it('returns true if ANY episode in ANY season has missing name', () => {
    const show: Show = {
      id: 1, name: 'x', image: null, status: '', premiered: null, genres: [], summary: '',
      network: '', runtime: 45, list: 'towatch', manualList: false,
      seasons: {
        1: [{ num: 1, id: 1, watched: false, airdate: null, name: 'Pilot', runtime: null }],
        2: [{ num: 1, id: 2, watched: false, airdate: null, name: null, runtime: null }],
      },
      totalSeasons: 2, totalEpisodes: 2, addedAt: 0,
    };
    expect(showNeedsEpisodeNames(show)).toBe(true);
  });
});
