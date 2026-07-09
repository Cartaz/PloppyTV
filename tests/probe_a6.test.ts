// Agent A6 probe: stress-test src/lib/shows.ts after bug fixes.
// Covers: refreshShowEpisodes (rating/note preservation, dedup, num=0, empty
// response, non-array response, corrupted seasons), toggleEpisode / markSeason /
// setEpisodeRating / setEpisodeNote (corrupted seasons guards), removeShowTag
// (non-string tag), addShowTag / getAllUserTags (non-array tags), addShowToList
// (invalid list), plus a few extra edge cases.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Show, TvmazeEpisode, TvmazeShow } from '../src/types';
import { makeShow, makeShowWithSeasons, markWatchedFirst } from './helpers';

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
  setEpisodeRating,
  setEpisodeNote,
  addShowTag,
  removeShowTag,
  getAllUserTags,
  getRandomGoldEpisode,
} from '../src/lib/shows';
import { getState, setState, setShows } from '../src/lib/store';
import { getShowEpisodes } from '../src/lib/api';
import { saveData } from '../src/lib/storage';
import { showToast } from '../src/components/toast';
import { showModal } from '../src/components/modal';
import {
  MAX_EPISODE_NOTE_LENGTH,
  MAX_EPISODE_RATING,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_SHOW,
} from '../src/lib/constants';

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
  actions[1].onClick?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveData).mockReturnValue(true);
  vi.mocked(getShowEpisodes).mockResolvedValue(makeTvmazeEpisodes());
  resetState();
});

// ===== Tests =====

describe('BUG-A6-01: refreshShowEpisodes preserves rating and note', () => {
  it('preserves rating and note when episode matched by id', async () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 42, list: 'watching' });
    show.seasons[1][0].watched = true;
    show.seasons[1][0].rating = 5;
    show.seasons[1][0].note = 'Great pilot!';
    show.seasons[1][1].watched = false;
    show.seasons[1][1].rating = 3;
    show.seasons[1][1].note = 'OK episode';
    setShows([show]);

    vi.mocked(getShowEpisodes).mockResolvedValue([
      { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2024-01-01', runtime: 60 },
      { id: 102, season: 1, number: 2, name: 'Ep2', airdate: '2024-01-08', runtime: 60 },
    ]);
    // makeShowWithSeasons uses id = season*1000+num, so override to match TVMaze ids:
    show.seasons[1][0].id = 101;
    show.seasons[1][1].id = 102;

    const result = await refreshShowEpisodes(42);
    expect(result).toBe(true);
    expect(show.seasons[1][0].rating).toBe(5);
    expect(show.seasons[1][0].note).toBe('Great pilot!');
    expect(show.seasons[1][1].rating).toBe(3);
    expect(show.seasons[1][1].note).toBe('OK episode');
  });

  it('preserves rating and note when episode matched by num (fallback)', async () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 42, list: 'watching' });
    show.seasons[1][0].watched = true;
    show.seasons[1][0].rating = 4;
    show.seasons[1][0].note = 'Note via num match';
    // id does NOT match the TVMaze id (forces fallback to num match)
    show.seasons[1][0].id = 999;
    setShows([show]);

    vi.mocked(getShowEpisodes).mockResolvedValue([
      { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2024-01-01', runtime: 60 },
    ]);
    await refreshShowEpisodes(42);
    expect(show.seasons[1][0].rating).toBe(4);
    expect(show.seasons[1][0].note).toBe('Note via num match');
  });

  it('does NOT carry over rating/note from a different episode (id mismatch + num mismatch)', async () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 42, list: 'watching' });
    show.seasons[1][0].id = 999; // won't match TVMaze id 101
    show.seasons[1][0].num = 5; // won't match TVMaze num 1
    show.seasons[1][0].rating = 5;
    show.seasons[1][0].note = 'Should not carry over';
    setShows([show]);

    vi.mocked(getShowEpisodes).mockResolvedValue([
      { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2024-01-01', runtime: 60 },
    ]);
    await refreshShowEpisodes(42);
    expect(show.seasons[1][0].rating).toBeUndefined();
    expect(show.seasons[1][0].note).toBeUndefined();
  });
});

describe('BUG-A6-02: refreshShowEpisodes skips episodes with num=0', () => {
  it('does not add episodes with number=0', async () => {
    setShows([makeShowWithSeasons({ 1: 2 }, { id: 42 })]);
    vi.mocked(getShowEpisodes).mockResolvedValue([
      { id: 101, season: 1, number: 0, name: 'Special', airdate: '2024-01-01', runtime: 60 },
      { id: 102, season: 1, number: 1, name: 'Real', airdate: '2024-01-08', runtime: 60 },
    ]);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(true);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1].length).toBe(1);
    expect(show.seasons[1][0].num).toBe(1);
    expect(show.totalEpisodes).toBe(1);
  });
});

describe('BUG-A6-03: refreshShowEpisodes dedups episodes by num', () => {
  it('keeps only first episode when duplicates exist (same season+num)', async () => {
    setShows([makeShowWithSeasons({ 1: 0 }, { id: 42 })]);
    vi.mocked(getShowEpisodes).mockResolvedValue([
      { id: 101, season: 1, number: 1, name: 'First', airdate: '2024-01-01', runtime: 60 },
      { id: 102, season: 1, number: 1, name: 'Duplicate', airdate: '2024-01-08', runtime: 60 },
      { id: 103, season: 1, number: 2, name: 'Second', airdate: '2024-01-15', runtime: 60 },
    ]);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(true);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1].length).toBe(2);
    expect(show.seasons[1][0].name).toBe('First');
    expect(show.seasons[1][1].name).toBe('Second');
    expect(show.totalEpisodes).toBe(2);
  });
});

describe('BUG-A6-04: refreshShowEpisodes does not wipe on empty API response', () => {
  it('preserves existing episodes when API returns empty array', async () => {
    const show = makeShowWithSeasons({ 1: 3 }, { id: 42, list: 'watching' });
    markWatchedFirst(show, 1, 2);
    setShows([show]);
    const originalSeasons = JSON.parse(JSON.stringify(show.seasons));

    vi.mocked(getShowEpisodes).mockResolvedValue([]);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(false);
    expect(show.seasons).toEqual(originalSeasons);
    expect(show.totalEpisodes).toBe(3);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Nessun episodio ricevuto'),
      'warning',
    );
  });

  it('allows empty response when show had 0 episodes (new show)', async () => {
    const show = makeShow({ id: 42, seasons: {}, totalEpisodes: 0, totalSeasons: 0 });
    setShows([show]);
    vi.mocked(getShowEpisodes).mockResolvedValue([]);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(true);
    expect(show.totalEpisodes).toBe(0);
  });
});

describe('BUG-A6-05: refreshShowEpisodes handles non-array API response', () => {
  it('returns false when API returns null', async () => {
    setShows([makeShowWithSeasons({ 1: 2 }, { id: 42 })]);
    vi.mocked(getShowEpisodes).mockResolvedValue(null as never);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Risposta API non valida', 'error');
  });

  it('returns false when API returns an object', async () => {
    setShows([makeShowWithSeasons({ 1: 2 }, { id: 42 })]);
    vi.mocked(getShowEpisodes).mockResolvedValue({ not: 'array' } as never);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(false);
  });
});

describe('BUG-A6-06: refreshShowEpisodes handles corrupted show.seasons', () => {
  it('returns false when show.seasons is null', async () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { seasons: unknown }).seasons = null;
    setShows([show]);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(false);
  });

  it('returns false when show.seasons is undefined', async () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { seasons?: unknown }).seasons = undefined;
    setShows([show]);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(false);
  });

  it('returns false when show.seasons is an array', async () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { seasons: unknown }).seasons = [{ num: 1 }];
    setShows([show]);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(false);
  });
});

describe('BUG-A6-07: toggle/mark/setRating/setNote guard corrupted show.seasons', () => {
  it('toggleEpisode does not crash when show.seasons is undefined', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { seasons?: unknown }).seasons = undefined;
    setShows([show]);
    expect(() => toggleEpisode(42, 1, 1)).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('toggleEpisode does not crash when seasonArr is not an array (string)', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { seasons: unknown }).seasons = { 1: 'not-an-array' };
    setShows([show]);
    expect(() => toggleEpisode(42, 1, 1)).not.toThrow();
  });

  it('markSeasonWatched does not crash when show.seasons is null', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { seasons: unknown }).seasons = null;
    setShows([show]);
    expect(() => markSeasonWatched(42, 1, true)).not.toThrow();
  });

  it('markSeasonWatched does not crash when seasonArr is not an array', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { seasons: unknown }).seasons = { 1: { not: 'array' } };
    setShows([show]);
    expect(() => markSeasonWatched(42, 1, true)).not.toThrow();
  });

  it('setEpisodeRating does not crash when show.seasons is undefined', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { seasons?: unknown }).seasons = undefined;
    setShows([show]);
    expect(() => setEpisodeRating(42, 1, 1, 5)).not.toThrow();
  });

  it('setEpisodeNote does not crash when show.seasons is null', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { seasons: unknown }).seasons = null;
    setShows([show]);
    expect(() => setEpisodeNote(42, 1, 1, 'hello')).not.toThrow();
  });

  it('setEpisodeRating does not crash when seasonArr is not an array', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { seasons: unknown }).seasons = { 1: 42 };
    setShows([show]);
    expect(() => setEpisodeRating(42, 1, 1, 3)).not.toThrow();
  });
});

describe('BUG-A6-08: removeShowTag handles non-string tag', () => {
  it('does not crash when tag is null', () => {
    setShows([makeShow({ id: 42, tags: ['Summer', 'Rewatch'] })]);
    expect(() => removeShowTag(42, null as never)).not.toThrow();
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.tags!.length).toBe(2); // unchanged
  });

  it('does not crash when tag is undefined', () => {
    setShows([makeShow({ id: 42, tags: ['Summer'] })]);
    expect(() => removeShowTag(42, undefined as never)).not.toThrow();
  });

  it('does not crash when tag is a number', () => {
    setShows([makeShow({ id: 42, tags: ['Summer'] })]);
    expect(() => removeShowTag(42, 42 as never)).not.toThrow();
  });

  it('still removes valid string tags', () => {
    setShows([makeShow({ id: 42, tags: ['Summer', 'Rewatch'] })]);
    removeShowTag(42, 'Summer');
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.tags).toEqual(['Rewatch']);
  });

  it('does not crash when show.tags is not an array', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { tags?: unknown }).tags = 'not-an-array';
    setShows([show]);
    expect(() => removeShowTag(42, 'Summer')).not.toThrow();
  });
});

describe('BUG-A6-09: addShowTag / getAllUserTags handle non-array show.tags', () => {
  it('addShowTag does not crash when show.tags is a string', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { tags?: unknown }).tags = 'not-an-array';
    setShows([show]);
    expect(() => addShowTag(42, 'Summer')).not.toThrow();
    const updated = getState().shows.find((s) => s.id === 42)!;
    expect(Array.isArray(updated.tags)).toBe(true);
    expect(updated.tags).toContain('Summer');
  });

  it('addShowTag does not crash when show.tags is null', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { tags?: unknown }).tags = null;
    setShows([show]);
    expect(() => addShowTag(42, 'Tag1')).not.toThrow();
  });

  it('getAllUserTags does not crash when show.tags is a string', () => {
    const show = makeShow({ id: 42 }) as Show;
    (show as { tags?: unknown }).tags = 'not-an-array';
    setShows([show]);
    expect(() => getAllUserTags()).not.toThrow();
    expect(getAllUserTags()).toEqual([]);
  });

  it('getAllUserTags does not crash when show.tags contains non-string elements', () => {
    const show = makeShow({ id: 42, tags: ['Valid', 42 as never, null as never] });
    setShows([show]);
    expect(() => getAllUserTags()).not.toThrow();
    const tags = getAllUserTags();
    expect(tags).toContain('Valid');
    expect(tags.length).toBe(1);
  });
});

describe('BUG-A6-10: addShowToList validates list parameter', () => {
  it('rejects invalid list name', async () => {
    const result = await addShowToList(makeTvmazeShow(42), 'invalid' as never);
    expect(result).toBeNull();
    expect(showToast).toHaveBeenCalledWith('Lista non valida', 'error');
  });

  it('rejects empty string list', async () => {
    const result = await addShowToList(makeTvmazeShow(42), '' as never);
    expect(result).toBeNull();
    expect(showToast).toHaveBeenCalledWith('Lista non valida', 'error');
  });

  it('accepts valid list names', async () => {
    for (const list of ['towatch', 'watching', 'completed'] as const) {
      resetState();
      vi.clearAllMocks();
      vi.mocked(saveData).mockReturnValue(true);
      vi.mocked(getShowEpisodes).mockResolvedValue(makeTvmazeEpisodes());
      const r = await addShowToList(makeTvmazeShow(42, 'Test ' + list), list);
      expect(r).not.toBeNull();
      expect(showToast).not.toHaveBeenCalledWith('Lista non valida', 'error');
    }
  });
});

// ===== Extra edge cases =====

describe('setEpisodeRating edge cases', () => {
  beforeEach(() => {
    setShows([makeShowWithSeasons({ 1: 3 }, { id: 42, list: 'watching' })]);
  });

  it('rejects NaN rating (no change)', () => {
    const show = getState().shows.find((s) => s.id === 42)!;
    show.seasons[1][0].rating = 3;
    setEpisodeRating(42, 1, 1, NaN);
    expect(show.seasons[1][0].rating).toBeUndefined(); // NaN → undefined (remove)
  });

  it('rejects Infinity rating', () => {
    setEpisodeRating(42, 1, 1, Infinity);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].rating).toBeUndefined();
  });

  it('rejects -1 rating', () => {
    setEpisodeRating(42, 1, 1, -1);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].rating).toBeUndefined();
  });

  it('rejects 6 rating (> MAX)', () => {
    setEpisodeRating(42, 1, 1, 6);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].rating).toBeUndefined();
  });

  it('accepts 0 rating (removes rating)', () => {
    const show = getState().shows.find((s) => s.id === 42)!;
    show.seasons[1][0].rating = 4;
    setEpisodeRating(42, 1, 1, 0);
    expect(show.seasons[1][0].rating).toBeUndefined();
  });

  it('rounds 3.6 → 4', () => {
    setEpisodeRating(42, 1, 1, 3.6);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].rating).toBe(4);
  });

  it('rounds 2.4 → 2', () => {
    setEpisodeRating(42, 1, 1, 2.4);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].rating).toBe(2);
  });

  it('accepts 1 and 5 (boundaries)', () => {
    setEpisodeRating(42, 1, 1, 1);
    expect(getState().shows.find((s) => s.id === 42)!.seasons[1][0].rating).toBe(1);
    setEpisodeRating(42, 1, 2, 5);
    expect(getState().shows.find((s) => s.id === 42)!.seasons[1][1].rating).toBe(5);
  });

  it('silent return when episode not found', () => {
    expect(() => setEpisodeRating(42, 1, 99, 3)).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('silent return when show not found', () => {
    expect(() => setEpisodeRating(999, 1, 1, 3)).not.toThrow();
  });
});

describe('setEpisodeNote edge cases', () => {
  beforeEach(() => {
    setShows([makeShowWithSeasons({ 1: 2 }, { id: 42, list: 'watching' })]);
  });

  it('clamps note to MAX_EPISODE_NOTE_LENGTH', () => {
    const longNote = 'x'.repeat(MAX_EPISODE_NOTE_LENGTH + 100);
    setEpisodeNote(42, 1, 1, longNote);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].note).toHaveLength(MAX_EPISODE_NOTE_LENGTH);
  });

  it('trims whitespace before storing', () => {
    setEpisodeNote(42, 1, 1, '  hello world  ');
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].note).toBe('hello world');
  });

  it('removes note when empty string', () => {
    const show = getState().shows.find((s) => s.id === 42)!;
    show.seasons[1][0].note = 'existing';
    setEpisodeNote(42, 1, 1, '');
    expect(show.seasons[1][0].note).toBeUndefined();
  });

  it('removes note when only whitespace', () => {
    const show = getState().shows.find((s) => s.id === 42)!;
    show.seasons[1][0].note = 'existing';
    setEpisodeNote(42, 1, 1, '   ');
    expect(show.seasons[1][0].note).toBeUndefined();
  });

  it('handles null note (treats as empty)', () => {
    setEpisodeNote(42, 1, 1, null as never);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].note).toBeUndefined();
  });

  it('handles undefined note (treats as empty)', () => {
    setEpisodeNote(42, 1, 1, undefined as never);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].note).toBeUndefined();
  });

  it('preserves HTML characters (not stripped at storage; escaped at render)', () => {
    setEpisodeNote(42, 1, 1, '<script>alert(1)</script>');
    const show = getState().shows.find((s) => s.id === 42)!;
    // Note: stored as-is; the renderer is responsible for escaping.
    expect(show.seasons[1][0].note).toBe('<script>alert(1)</script>');
  });

  it('silent return when episode not found', () => {
    expect(() => setEpisodeNote(42, 1, 99, 'hello')).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('addShowTag edge cases', () => {
  beforeEach(() => {
    setShows([makeShow({ id: 42, tags: [] })]);
  });

  it('rejects empty tag', () => {
    expect(addShowTag(42, '')).toBe(false);
  });

  it('rejects whitespace-only tag', () => {
    expect(addShowTag(42, '   ')).toBe(false);
  });

  it('trims tag before storing', () => {
    expect(addShowTag(42, '  Summer  ')).toBe(true);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.tags).toContain('Summer');
  });

  it('clamps tag to MAX_TAG_LENGTH', () => {
    const longTag = 'x'.repeat(MAX_TAG_LENGTH + 50);
    expect(addShowTag(42, longTag)).toBe(true);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.tags![0]).toHaveLength(MAX_TAG_LENGTH);
  });

  it('dedupes case-insensitive', () => {
    expect(addShowTag(42, 'Summer')).toBe(true);
    expect(addShowTag(42, 'summer')).toBe(false);
    expect(addShowTag(42, 'SUMMER')).toBe(false);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.tags!.length).toBe(1);
  });

  it('enforces MAX_TAGS_PER_SHOW limit', () => {
    for (let i = 0; i < MAX_TAGS_PER_SHOW; i++) {
      expect(addShowTag(42, 'tag' + i)).toBe(true);
    }
    expect(addShowTag(42, 'overflow')).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      'Massimo ' + MAX_TAGS_PER_SHOW + ' tag per serie',
      'warning',
    );
  });

  it('rejects non-string tag', () => {
    expect(addShowTag(42, null as never)).toBe(false);
    expect(addShowTag(42, undefined as never)).toBe(false);
    expect(addShowTag(42, 42 as never)).toBe(false);
  });

  it('silent return when show not found', () => {
    expect(addShowTag(999, 'Summer')).toBe(false);
  });
});

describe('removeShowTag edge cases', () => {
  it('case-insensitive removal', () => {
    setShows([makeShow({ id: 42, tags: ['Summer', 'Rewatch'] })]);
    removeShowTag(42, 'SUMMER');
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.tags).toEqual(['Rewatch']);
  });

  it('no-op when tag not found', () => {
    setShows([makeShow({ id: 42, tags: ['Summer'] })]);
    removeShowTag(42, 'Nonexistent');
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.tags).toEqual(['Summer']);
    // No save, no emit when nothing changed
    expect(saveData).not.toHaveBeenCalled();
  });

  it('no-op when show has no tags', () => {
    setShows([makeShow({ id: 42 })]); // tags undefined
    expect(() => removeShowTag(42, 'Summer')).not.toThrow();
  });

  it('no-op when show not found', () => {
    expect(() => removeShowTag(999, 'Summer')).not.toThrow();
  });
});

describe('toggleEpisode edge cases', () => {
  it('idempotent: toggle twice returns to original state', () => {
    setShows([makeShowWithSeasons({ 1: 2 }, { id: 42, list: 'towatch', manualList: false })]);
    toggleEpisode(42, 1, 1); // watched → true, list → watching
    toggleEpisode(42, 1, 1); // watched → false, list → towatch
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].watched).toBe(false);
    expect(show.list).toBe('towatch');
  });

  it('toggle last unwatched → completed + manualList=false', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 42, list: 'watching', manualList: true });
    show.seasons[1][0].watched = true;
    setShows([show]);
    toggleEpisode(42, 1, 2);
    expect(show.seasons[1][1].watched).toBe(true);
    expect(show.list).toBe('completed');
    expect(show.manualList).toBe(false);
  });

  it('toggle on season 0 (specials) silently returns', () => {
    setShows([makeShowWithSeasons({ 1: 2 }, { id: 42 })]);
    expect(() => toggleEpisode(42, 0, 1)).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('toggle with NaN epNum silently returns', () => {
    setShows([makeShowWithSeasons({ 1: 2 }, { id: 42 })]);
    expect(() => toggleEpisode(42, 1, NaN)).not.toThrow();
  });

  it('rollback on saveData fail restores watched, list, manualList', () => {
    vi.mocked(saveData).mockReturnValue(false);
    setShows([makeShowWithSeasons({ 1: 2 }, { id: 42, list: 'towatch', manualList: false })]);
    toggleEpisode(42, 1, 1);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1][0].watched).toBe(false);
    expect(show.list).toBe('towatch');
    expect(show.manualList).toBe(false);
  });
});

describe('markSeasonWatched edge cases', () => {
  it('mark all watched → completed', () => {
    setShows([makeShowWithSeasons({ 1: 3 }, { id: 42, list: 'watching', manualList: false })]);
    markSeasonWatched(42, 1, true);
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.seasons[1].every((e) => e.watched)).toBe(true);
    expect(show.list).toBe('completed');
    expect(show.manualList).toBe(false);
  });

  it('mark all unwatched → towatch (no manualList)', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { id: 42, list: 'watching', manualList: false });
    markWatchedFirst(show, 1, 2);
    setShows([show]);
    markSeasonWatched(42, 1, false);
    expect(show.seasons[1].every((e) => !e.watched)).toBe(true);
    expect(show.list).toBe('towatch');
  });

  it('rollback restores episodes on saveData fail', () => {
    vi.mocked(saveData).mockReturnValue(false);
    const show = makeShowWithSeasons({ 1: 3 }, { id: 42, list: 'watching', manualList: false });
    show.seasons[1][0].watched = true;
    setShows([show]);
    markSeasonWatched(42, 1, true);
    expect(show.seasons[1][0].watched).toBe(true);
    expect(show.seasons[1][1].watched).toBe(false);
    expect(show.seasons[1][2].watched).toBe(false);
    expect(show.list).toBe('watching');
  });
});

describe('moveShowToList edge cases', () => {
  it('no-op when moving to same list', () => {
    setShows([makeShow({ id: 42, list: 'watching', manualList: false })]);
    moveShowToList(42, 'watching');
    expect(showToast).not.toHaveBeenCalledWith('Serie spostata', 'success');
    expect(saveData).not.toHaveBeenCalled();
  });

  it('returns silently when show not found', () => {
    expect(() => moveShowToList(999, 'towatch')).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('returns silently for invalid list', () => {
    setShows([makeShow({ id: 42 })]);
    expect(() => moveShowToList(42, 'invalid' as never)).not.toThrow();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('rollback restores on saveData fail', () => {
    vi.mocked(saveData).mockReturnValue(false);
    setShows([makeShow({ id: 42, list: 'watching', manualList: false })]);
    moveShowToList(42, 'towatch');
    const show = getState().shows.find((s) => s.id === 42)!;
    expect(show.list).toBe('watching');
    expect(show.manualList).toBe(false);
  });
});

describe('removeShow edge cases', () => {
  it('removes show and jumps to dashboard', () => {
    setShows([makeShow({ id: 42, list: 'watching' })]);
    setState({ currentView: 'watching', currentShowId: 42 });
    removeShow(42, 'Test');
    invokeRemoveConfirm();
    expect(getState().shows.find((s) => s.id === 42)).toBeUndefined();
    expect(getState().currentView).toBe('dashboard');
    expect(getState().currentShowId).toBeNull();
  });

  it('rollback restores show on saveData fail', () => {
    vi.mocked(saveData).mockReturnValue(false);
    setShows([makeShow({ id: 42, list: 'watching' })]);
    removeShow(42, 'Test');
    invokeRemoveConfirm();
    expect(getState().shows.find((s) => s.id === 42)).toBeDefined();
  });
});

describe('getRandomGoldEpisode edge cases', () => {
  it('returns null when no shows', () => {
    expect(getRandomGoldEpisode()).toBeNull();
  });

  it('returns null when no 5★ watched episodes', () => {
    setShows([makeShowWithSeasons({ 1: 2 }, { id: 42, list: 'watching' })]);
    expect(getRandomGoldEpisode()).toBeNull();
  });

  it('returns a 5★ watched episode', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 42, list: 'watching' });
    show.seasons[1][0].watched = true;
    show.seasons[1][0].rating = MAX_EPISODE_RATING;
    setShows([show]);
    const result = getRandomGoldEpisode();
    expect(result).not.toBeNull();
    expect(result!.ep.rating).toBe(MAX_EPISODE_RATING);
    expect(result!.ep.watched).toBe(true);
  });

  it('does not return 5★ unwatched episodes', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 42, list: 'watching' });
    show.seasons[1][0].watched = false;
    show.seasons[1][0].rating = MAX_EPISODE_RATING;
    setShows([show]);
    expect(getRandomGoldEpisode()).toBeNull();
  });
});

describe('refreshShowEpisodes rollback edge cases', () => {
  it('rollback restores rating and note on saveData fail', async () => {
    vi.mocked(saveData).mockReturnValue(false);
    const show = makeShowWithSeasons({ 1: 1 }, { id: 42, list: 'watching' });
    show.seasons[1][0].id = 101;
    show.seasons[1][0].watched = true;
    show.seasons[1][0].rating = 5;
    show.seasons[1][0].note = 'My note';
    setShows([show]);

    vi.mocked(getShowEpisodes).mockResolvedValue([
      { id: 101, season: 1, number: 1, name: 'Updated', airdate: '2024-01-01', runtime: 60 },
    ]);
    const result = await refreshShowEpisodes(42);
    expect(result).toBe(false);
    // After rollback, original rating and note should be restored
    expect(show.seasons[1][0].rating).toBe(5);
    expect(show.seasons[1][0].note).toBe('My note');
  });
});
