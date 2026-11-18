// Data di visione (schema v3): registrata quando si segna un episodio, usata
// dal Year-in-Review; gli episodi legacy senza data usano l'airdate come stima.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as Api from '../src/lib/api';

vi.mock('../src/lib/storage', () => ({ saveData: vi.fn(() => true), isStorageOK: vi.fn(() => true) }));
vi.mock('../src/components/toast', () => ({ showToast: vi.fn() }));
const getShowEpisodes = vi.fn();
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  getShowEpisodes: (...a: unknown[]) => getShowEpisodes(...a),
}));

import { getState, setShows } from '../src/lib/store';
import { toggleEpisode, markSeasonWatched, refreshShowEpisodes } from '../src/lib/shows';
import { normalizeShow } from '../src/lib/normalize';
import { mergeImportedShow } from '../src/lib/merge';
import { canonicalizeDataDocument } from '../src/lib/dataDocument';
import { computeYearStats, renderYearReview } from '../src/views/yearReview';
import { makeShowWithSeasons } from './helpers';

const WATCHED_AT = new Date(2026, 2, 10, 21, 0, 0).getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(WATCHED_AT);
  setShows([makeShowWithSeasons({ 1: 3 }, { id: 1, name: 'Serie' })]);
});
afterEach(() => vi.useRealTimers());

const ep = (n: number) => getState().shows[0].seasons[1][n - 1];

describe('recording the watch date', () => {
  it('sets watchedAt when an episode is marked watched and clears it when unmarked', () => {
    toggleEpisode(1, 1, 1);
    expect(ep(1)).toMatchObject({ watched: true, watchedAt: WATCHED_AT });
    toggleEpisode(1, 1, 1);
    expect(ep(1).watched).toBe(false);
    expect(ep(1).watchedAt).toBeUndefined();
  });

  it('marking a season keeps the original date of episodes already watched', () => {
    toggleEpisode(1, 1, 1);
    vi.setSystemTime(WATCHED_AT + 86_400_000);
    markSeasonWatched(1, 1, true);
    expect(ep(1).watchedAt).toBe(WATCHED_AT);
    expect(ep(2).watchedAt).toBe(WATCHED_AT + 86_400_000);
    markSeasonWatched(1, 1, false);
    expect(ep(1).watchedAt).toBeUndefined();
  });

  it('survives normalization (reload) only for watched episodes with a plausible timestamp', () => {
    const show = normalizeShow({
      id: 1,
      seasons: {
        1: [
          { num: 1, id: 1, watched: true, watchedAt: WATCHED_AT },
          { num: 2, id: 2, watched: false, watchedAt: WATCHED_AT },
          { num: 3, id: 3, watched: true, watchedAt: WATCHED_AT + 10 * 86_400_000 },
          { num: 4, id: 4, watched: true, watchedAt: 'ieri' },
        ],
      },
    })!;
    expect(show.seasons[1].map((e) => e.watchedAt)).toEqual([WATCHED_AT, undefined, undefined, undefined]);
  });

  it('merge keeps the local date and adopts the backup one when missing', () => {
    const local = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    local.seasons[1][0] = { ...local.seasons[1][0], watched: true, watchedAt: 111 };
    const backup = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    backup.seasons[1][0] = { ...backup.seasons[1][0], watched: true, watchedAt: 222 };
    backup.seasons[1][1] = { ...backup.seasons[1][1], watched: true, watchedAt: 333 };
    mergeImportedShow(local, backup);
    expect(local.seasons[1].map((e) => e.watchedAt)).toEqual([111, 333]);
  });

  it('a TVMaze refresh keeps the watch date', async () => {
    toggleEpisode(1, 1, 1);
    const show = getState().shows[0];
    getShowEpisodes.mockResolvedValue(
      show.seasons[1].map((e) => ({ id: e.id, season: 1, number: e.num, name: 'Nuovo nome', airdate: '2024-01-01' })),
    );
    expect(await refreshShowEpisodes(1, { silent: true })).toBe(true);
    expect(ep(1)).toMatchObject({ watched: true, watchedAt: WATCHED_AT, name: 'Nuovo nome' });
  });

  it('documents from schema v2 are still accepted', () => {
    const doc = canonicalizeDataDocument({ version: 2, shows: [{ id: 1, name: 'Legacy', seasons: {} }] });
    expect(doc.ok).toBe(true);
  });
});

describe('Year in Review by watch date', () => {
  function showWith(eps: Array<{ airdate: string; watchedAt?: number }>) {
    const s = makeShowWithSeasons({ 1: eps.length }, { id: 5, name: 'Recupero', runtime: 40 });
    eps.forEach((e, i) => Object.assign(s.seasons[1][i], { watched: true, ...e }));
    return s;
  }

  it('counts an old show binge-watched this year in this year, not in its release year', () => {
    const s = showWith([
      { airdate: '2010-01-01', watchedAt: WATCHED_AT },
      { airdate: '2010-01-08', watchedAt: WATCHED_AT },
    ]);
    expect(computeYearStats([s], 2026)).toMatchObject({ totalEpisodes: 2, totalMinutes: 80, estimatedEpisodes: 0 });
    expect(computeYearStats([s], 2010).totalEpisodes).toBe(0);
  });

  it('falls back to the release year for legacy episodes and says so in the view', () => {
    const s = showWith([{ airdate: '2024-05-01' }, { airdate: '2024-05-08', watchedAt: WATCHED_AT }]);
    expect(computeYearStats([s], 2024)).toMatchObject({ totalEpisodes: 1, estimatedEpisodes: 1 });

    setShows([s]);
    document.body.innerHTML = '<main id="m"></main>';
    const main = document.getElementById('m')!;
    renderYearReview(main);
    const years = Array.from(main.querySelectorAll<HTMLElement>('.year-btn')).map((b) => b.dataset.year);
    expect(years).toEqual(['2026', '2024']);
    (main.querySelector('.year-btn[data-year="2024"]') as HTMLElement).click();
    renderYearReview(main);
    expect(main.querySelector('.year-estimated-hint')?.textContent).toContain('1 episodio');
  });
});
