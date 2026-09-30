import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEpisode, makeShow } from './helpers';
import { API_TIMEOUT_MS, BACKUP_KEY, SCHEMA_VERSION, STORAGE_KEY } from '../src/lib/constants';
import { getState, setState, setShows } from '../src/lib/store';
import { loadData, saveData } from '../src/lib/storage';
import { refreshShowEpisodes, setEpisodeNote, toggleEpisode } from '../src/lib/shows';
import { canonicalizeDataDocument } from '../src/lib/dataDocument';
import type { TvmazeEpisode } from '../src/types';

const episodes: TvmazeEpisode[] = [
  { id: 101, season: 1, number: 1, name: 'Pilot', runtime: 45 },
  { id: 102, season: 1, number: 2, name: 'Second', runtime: 45 },
];

beforeEach(() => {
  localStorage.clear();
  setState({ shows: [], _storageDisabled: false, _localDirty: false });
  loadData();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function seedShow() {
  const show = makeShow({
    seasons: { 1: [makeEpisode({ id: 101 }), makeEpisode({ id: 102, num: 2 })] },
    totalEpisodes: 2,
    totalSeasons: 1,
  });
  setShows([show]);
  expect(saveData({ immediate: true })).toBe(true);
  return show;
}

function pendingRefresh() {
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolve = res;
        }),
    ),
  );
  const promise = refreshShowEpisodes(1, { silent: true });
  return { promise, finish: (data: unknown = episodes) => resolve(new Response(JSON.stringify(data))) };
}

describe('refresh preserves user data across asynchronous boundaries', () => {
  it('preserves user data when an episode request times out', async () => {
    vi.useFakeTimers();
    const show = seedShow();
    const original = JSON.stringify(show);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ),
    );
    const request = refreshShowEpisodes(1);
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS);
    expect(await request).toBe(false);
    expect(JSON.stringify(show)).toBe(original);
  });

  it('rejects an unusable response with feedback and without losing user data', async () => {
    const show = seedShow();
    const original = JSON.stringify(show);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([{ season: 0, number: 1 }]))),
    );
    expect(await refreshShowEpisodes(1)).toBe(false);
    expect(JSON.stringify(show)).toBe(original);
  });

  it.each([404, 429])('preserves the series when the API returns HTTP %s', async (status) => {
    const show = seedShow();
    const original = JSON.stringify(show);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status })),
    );
    expect(await refreshShowEpisodes(1)).toBe(false);
    expect(JSON.stringify(show)).toBe(original);
  });

  it('preserves the series when the API cannot be reached', async () => {
    const show = seedShow();
    const original = JSON.stringify(show);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network unavailable');
      }),
    );
    expect(await refreshShowEpisodes(1)).toBe(false);
    expect(JSON.stringify(show)).toBe(original);
  });

  it('ignores a duplicate refresh while the original request is pending', async () => {
    seedShow();
    const pending = pendingRefresh();
    expect(await refreshShowEpisodes(1)).toBe(false);
    pending.finish();
    expect(await pending.promise).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rolls back to the edits made while the request was pending', async () => {
    const show = seedShow();
    const pending = pendingRefresh();
    toggleEpisode(1, 1, 1);
    const saved = localStorage.getItem(STORAGE_KEY);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('write failed');
    });
    pending.finish();
    expect(await pending.promise).toBe(false);
    expect(show.seasons[1][0].watched).toBe(true);
    expect(show.list).toBe('watching');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(saved);
  });

  it('ignores a response for a show replaced by an import or another tab', async () => {
    const oldShow = seedShow();
    const pending = pendingRefresh();
    const replacement = makeShow({ name: 'Imported', seasons: {} });
    setShows([replacement]);
    expect(saveData({ immediate: true })).toBe(true);
    const saved = localStorage.getItem(STORAGE_KEY);
    pending.finish();
    expect(await pending.promise).toBe(false);
    expect(getState().shows[0]).toBe(replacement);
    expect(oldShow.seasons[1][0].name).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(saved);
  });

  it('skips null entries and applies the same runtime validation as initial loading', async () => {
    seedShow();
    const pending = pendingRefresh();
    pending.finish([null, { ...episodes[0], runtime: '90' }, episodes[1]]);
    expect(await pending.promise).toBe(true);
    expect(getState().shows[0].totalEpisodes).toBe(2);
    expect(getState().shows[0].seasons[1][0].runtime).toBeNull();
  });

  it('does not erase a populated series when no usable episodes are returned', async () => {
    const show = seedShow();
    const before = JSON.stringify(show);
    const pending = pendingRefresh();
    pending.finish([{ id: 201, season: 0, number: null }]);
    expect(await pending.promise).toBe(false);
    expect(JSON.stringify(show)).toBe(before);
  });

  it('matches legacy episodes by position when their IDs are unknown', async () => {
    const show = seedShow();
    show.seasons[1][0].id = 0;
    show.seasons[1][1].id = 0;
    show.seasons[1][0].note = 'First';
    show.seasons[1][1].note = 'Second';
    const pending = pendingRefresh();
    pending.finish(episodes.map((ep) => ({ ...ep, id: 0 })));
    expect(await pending.promise).toBe(true);
    expect(show.seasons[1].map((ep) => ep.note)).toEqual(['First', 'Second']);
  });

  it('does not copy user data to a different valid episode ID at the same position', async () => {
    const show = seedShow();
    show.seasons[1][0].note = 'Only episode 101';
    show.seasons[1][0].watched = true;
    const pending = pendingRefresh();
    pending.finish([
      { ...episodes[0], id: 999 },
      { ...episodes[0], number: 2 },
    ]);
    expect(await pending.promise).toBe(true);
    expect(show.seasons[1][0].note).toBeUndefined();
    expect(show.seasons[1][0].watched).toBe(false);
    expect(show.seasons[1][1].note).toBe('Only episode 101');
  });
});

describe('persistence rejects conflicting and unreadable documents', () => {
  it.each([undefined, 1])('migrates a supported legacy document (%s) without losing notes', (version) => {
    const show = makeShow({ seasons: { 1: [makeEpisode({ watched: true, note: 'Legacy note' })] } });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version, shows: [show] }));
    loadData();
    expect(getState().shows[0].seasons[1][0].note).toBe('Legacy note');
    expect(saveData({ immediate: true })).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).version).toBe(SCHEMA_VERSION);
  });

  it('refuses a save if the storage revision cannot be read', () => {
    seedShow();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    expect(saveData({ immediate: true })).toBe(false);
  });

  it.each(['', '{"version":2,"shows":"invalid"}'])(
    'recovers corruption without damaging the valid backup (%s)',
    (raw) => {
      const backup = JSON.stringify({ version: SCHEMA_VERSION, shows: [makeShow({ name: 'Safety copy' })] });
      localStorage.setItem(BACKUP_KEY, backup);
      localStorage.setItem(STORAGE_KEY, raw);
      loadData();
      expect(getState().shows[0]?.name).toBe('Safety copy');
      expect(localStorage.getItem(BACKUP_KEY)).toBe(backup);
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).shows[0].name).toBe('Safety copy');
    },
  );
  it.each([1234, undefined])('detects different documents with the same savedAt (%s)', (savedAt) => {
    const original = JSON.stringify({ version: SCHEMA_VERSION, shows: [makeShow()], savedAt });
    localStorage.setItem(STORAGE_KEY, original);
    loadData();
    const concurrent = JSON.stringify({ version: SCHEMA_VERSION, shows: [makeShow({ name: 'Other tab' })], savedAt });
    localStorage.setItem(STORAGE_KEY, concurrent);
    expect(saveData({ immediate: true })).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(concurrent);
  });

  it.each([false, true])('never overwrites a future schema (backup present: %s)', (backup) => {
    const future = JSON.stringify({ version: SCHEMA_VERSION + 1, shows: [makeShow({ name: 'Future' })] });
    localStorage.setItem(STORAGE_KEY, future);
    if (backup) localStorage.setItem(BACKUP_KEY, JSON.stringify({ version: SCHEMA_VERSION, shows: [makeShow()] }));
    const originalBackup = localStorage.getItem(BACKUP_KEY);
    loadData();
    expect(saveData({ immediate: true })).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(future);
    expect(localStorage.getItem(BACKUP_KEY)).toBe(originalBackup);
  });

  it('cancels an older scheduled save when saving immediately', () => {
    vi.useFakeTimers();
    seedShow();
    saveData();
    expect(saveData({ immediate: true })).toBe(true);
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    vi.advanceTimersByTime(300);
    expect(writes).not.toHaveBeenCalled();
  });
});

it('reconciles partially watched completed series consistently on reload', () => {
  const show = makeShow({
    list: 'completed',
    manualList: false,
    totalEpisodes: 2,
    seasons: { 1: [makeEpisode({ watched: true }), makeEpisode({ num: 2 })] },
  });
  const result = canonicalizeDataDocument({ version: SCHEMA_VERSION, shows: [show] });
  expect(result.ok && result.document.shows[0].list).toBe('watching');
});

it.each([
  [999, 1, 1],
  [1, 99, 1],
  [1, 1, 99],
])('rejects notes for missing show/season/episode (%s, %s, %s)', (show, season, episode) => {
  seedShow();
  const persisted = localStorage.getItem(STORAGE_KEY);
  expect(setEpisodeNote(show, season, episode, 'Missing target')).toBe(false);
  expect(localStorage.getItem(STORAGE_KEY)).toBe(persisted);
});
