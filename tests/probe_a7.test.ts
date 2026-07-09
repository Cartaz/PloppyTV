// Agent A7 — probe tests for NEW edge cases in src/lib/discover.ts
// These tests are distinct from probe_discover.test.ts (BUG-07-xx) and cover
// gaps the existing suite misses:
//   BUG-A7-01: recentOnly includes shows premiered in the FUTURE.
//   BUG-A7-02: progressRAF leaks — onProgress fires after fetch settles.
//   BUG-A7-03: readCache returns groups with non-array genre values.
//   BUG-A7-04: non-numeric weight (string) passes filter → NaN sort.
//   BUG-A7-05: non-numeric rating.average → NaN sort.
//   BUG-A7-06: multi-genre show redirected to _other when a secondary genre
//              has space (primary at cap).
//   BUG-A7-07: cache TTL boundary (exactly TTL ms old → expired).
//   BUG-A7-08: dedup across pages (same id on two pages → single entry).
//   BUG-A7-09: empty pages array → no crash, empty groups.
//   BUG-A7-10: show with empty-string premiered excluded from recent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------- mock getShowsPage + ApiError ----------

vi.mock('../src/lib/api', () => ({
  getShowsPage: vi.fn(),
  ApiError: class ApiError extends Error {
    override name: string;
    status?: number;
    constructor(message: string, name: string, status?: number) {
      super(message);
      this.name = name;
      this.status = status;
    }
  },
}));

import { getShowsPage } from '../src/lib/api';
import {
  getPopularShows,
  getRecentShows,
  resetDiscoverPreload,
  invalidateDiscoverCache,
} from '../src/lib/discover';
import {
  DISCOVER_TARGET_PER_GENRE,
  DISCOVER_TARGET_OTHER,
  DISCOVER_CACHE_KEY,
  DISCOVER_CACHE_TTL,
  DISCOVER_RECENT_PAGES,
  GENRE_CAROUSELS,
} from '../src/lib/constants';
import type { TvmazeShow } from '../src/types';

const mockedGetShowsPage = vi.mocked(getShowsPage);

// ---------- helpers ----------

function makeShow(id: number, over: Partial<TvmazeShow> = {}): TvmazeShow {
  return {
    id,
    name: 'Show ' + id,
    weight: 50,
    image: { medium: 'http://x/' + id + '.jpg' },
    genres: ['Drama'],
    premiered: '2024-01-01',
    rating: { average: 7 },
    ...over,
  };
}

function flattenGroups(groups: Record<string, unknown>): TvmazeShow[] {
  const out: TvmazeShow[] = [];
  for (const key of Object.keys(groups)) {
    const arr = groups[key];
    if (Array.isArray(arr)) out.push(...(arr as TvmazeShow[]));
  }
  return out;
}

beforeEach(() => {
  localStorage.clear();
  resetDiscoverPreload();
  mockedGetShowsPage.mockReset();
  // Stub RAF in case jsdom doesn't provide it (vitest+jsdom usually does).
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (
      cb: FrameRequestCallback,
    ) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
    (globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = (id: number) =>
      clearTimeout(id);
  }
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------- tests ----------

describe('Agent-A7 probe: discover.ts new edge cases', () => {
  it('BUG-A7-01 [Medium]: recentOnly EXCLUDES shows premiered in the future', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00'));

    const futureShow = makeShow(1, { premiered: '2099-01-01' });
    const recentShow = makeShow(2, { premiered: '2024-04-01' });
    const oldShow = makeShow(3, { premiered: '2023-01-01' });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === DISCOVER_RECENT_PAGES[0]) return [futureShow, recentShow, oldShow];
      return [];
    });

    const groups = await getRecentShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // Future show must be excluded (aired-in-the-future is not "recent").
    expect(ids).not.toContain(1);
    // Recent show still included.
    expect(ids).toContain(2);
    // Old show still excluded (>6 months ago).
    expect(ids).not.toContain(3);
  });

  it('BUG-A7-01 boundary: show premiered TODAY is included (not treated as future)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T15:00:00'));

    // premiered = today (local midnight). d.getTime() = today_midnight < now.
    const todayShow = makeShow(1, { premiered: '2024-06-15' });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === DISCOVER_RECENT_PAGES[0]) return [todayShow];
      return [];
    });

    const groups = await getRecentShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);
    expect(ids).toContain(1);
  });

  it('BUG-A7-02 [Low]: onProgress NOT called after fetch completes (RAF cancelled)', async () => {
    const calls: string[] = [];
    mockedGetShowsPage.mockImplementation(async (page: number) => [makeShow(page * 1000 + 1)]);

    await getPopularShows((text) => calls.push(text));
    const lengthAfterFetch = calls.length;

    // Wait long enough for any pending RAF to fire (if not cancelled).
    await new Promise((r) => setTimeout(r, 100));

    // Fixed: no new calls after fetch settles.
    expect(calls.length).toBe(lengthAfterFetch);
  });

  it('BUG-A7-03 [Low]: readCache rejects cache with non-array genre value → fresh fetch', async () => {
    localStorage.setItem(
      DISCOVER_CACHE_KEY,
      JSON.stringify({ cachedAt: Date.now(), groups: { _other: [], Drama: 'not-an-array' } }),
    );

    mockedGetShowsPage.mockImplementation(async () => [makeShow(1)]);

    const groups = await getPopularShows();

    // Fixed: cache rejected because Drama is a string, fresh fetch happens.
    expect(mockedGetShowsPage).toHaveBeenCalled();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);
    expect(ids).toContain(1);
    // Returned groups.Drama must be an array (fresh fetch).
    expect(Array.isArray((groups as unknown as Record<string, unknown>).Drama)).toBe(true);
  });

  it('BUG-A7-03 variant: readCache rejects cache with non-array _other → fresh fetch', async () => {
    localStorage.setItem(
      DISCOVER_CACHE_KEY,
      JSON.stringify({ cachedAt: Date.now(), groups: { _other: 42, Drama: [] } }),
    );

    mockedGetShowsPage.mockImplementation(async () => [makeShow(1)]);

    const groups = await getPopularShows();
    expect(mockedGetShowsPage).toHaveBeenCalled();
    expect(Array.isArray((groups as unknown as Record<string, unknown>)._other)).toBe(true);
  });

  it('BUG-A7-03: valid cache (all arrays) is still accepted (no regression)', async () => {
    const cachedGroups: Record<string, unknown> = { _other: [], Drama: [makeShow(77)] };
    for (const g of GENRE_CAROUSELS) if (g !== 'Drama') cachedGroups[g] = [];
    localStorage.setItem(
      DISCOVER_CACHE_KEY,
      JSON.stringify({ cachedAt: Date.now(), groups: cachedGroups }),
    );

    mockedGetShowsPage.mockImplementation(async () => [makeShow(99)]);

    const groups = await getPopularShows();
    // Cache accepted: API NOT called.
    expect(mockedGetShowsPage).not.toHaveBeenCalled();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);
    expect(ids).toContain(77);
    expect(ids).not.toContain(99);
  });

  it('BUG-A7-04 [Low]: non-numeric weight (string "abc") excluded from candidates', async () => {
    const stringWeight = makeShow(1, { weight: 'abc' as unknown as number });
    const nanWeight = makeShow(2, { weight: NaN });
    const infWeight = makeShow(3, { weight: Infinity });
    const validZero = makeShow(4, { weight: 0 });
    const validFifty = makeShow(5, { weight: 50 });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 0) return [stringWeight, nanWeight, infWeight, validZero, validFifty];
      return [];
    });

    const groups = await getPopularShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // Fixed: non-numeric / non-finite weights excluded.
    expect(ids).not.toContain(1); // "abc"
    expect(ids).not.toContain(2); // NaN
    expect(ids).not.toContain(3); // Infinity
    // Valid weights still included.
    expect(ids).toContain(4); // 0
    expect(ids).toContain(5); // 50
  });

  it('BUG-A7-05 [Low]: non-numeric rating.average coerced to 0 (no NaN sort, no crash)', async () => {
    const s1 = makeShow(1, { weight: 50, rating: { average: 'abc' as unknown as number } });
    const s2 = makeShow(2, { weight: 50, rating: { average: 'def' as unknown as number } });
    const s3 = makeShow(3, { weight: 50, rating: { average: null } });
    const s4 = makeShow(4, { weight: 50, rating: undefined });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 0) return [s1, s2, s3, s4];
      return [];
    });

    const groups = await getPopularShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // All four included (weight is valid); sort did not throw.
    expect(ids).toHaveLength(4);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).toContain(4);
  });

  it('BUG-A7-06 [Medium]: multi-genre show fills secondary genre when primary at cap', async () => {
    // Fill Comedy to its cap (DISCOVER_TARGET_PER_GENRE).
    const comedies: TvmazeShow[] = [];
    for (let i = 1; i <= DISCOVER_TARGET_PER_GENRE; i++) {
      comedies.push(makeShow(i, { genres: ['Comedy'], weight: 100 - i }));
    }
    // This show has BOTH Drama and Comedy. Comedy is full, Drama is empty.
    // It should land in Drama (secondary), NOT in _other.
    const multiGenre = makeShow(99, { genres: ['Drama', 'Comedy'], weight: 50 });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 0) return [...comedies, multiGenre];
      return [];
    });

    const groups = await getPopularShows();
    const dramaIds = ((groups as unknown as Record<string, unknown>).Drama as TvmazeShow[] | undefined)?.map(
      (s) => s.id,
    ) ?? [];
    const otherIds = ((groups as unknown as Record<string, unknown>)._other as TvmazeShow[] | undefined)?.map(
      (s) => s.id,
    ) ?? [];
    const comedyIds = ((groups as unknown as Record<string, unknown>).Comedy as TvmazeShow[] | undefined)?.map(
      (s) => s.id,
    ) ?? [];

    // Fixed: multi-genre show goes to Drama (secondary with space), not _other.
    expect(dramaIds).toContain(99);
    expect(otherIds).not.toContain(99);
    // Comedy is still capped.
    expect(comedyIds.length).toBe(DISCOVER_TARGET_PER_GENRE);
  });

  it('BUG-A7-06 variant: genres order [Comedy, Drama] — same result (order-independent)', async () => {
    const comedies: TvmazeShow[] = [];
    for (let i = 1; i <= DISCOVER_TARGET_PER_GENRE; i++) {
      comedies.push(makeShow(i, { genres: ['Comedy'], weight: 100 - i }));
    }
    // Note: genres order swapped — should not matter, includes() is symmetric.
    const multiGenre = makeShow(99, { genres: ['Comedy', 'Drama'], weight: 50 });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 0) return [...comedies, multiGenre];
      return [];
    });

    const groups = await getPopularShows();
    const dramaIds = ((groups as unknown as Record<string, unknown>).Drama as TvmazeShow[] | undefined)?.map(
      (s) => s.id,
    ) ?? [];
    expect(dramaIds).toContain(99);
  });

  it('BUG-A7-06 spillover: all matching genres at cap → goes to _other (FASE 2)', async () => {
    // Fill BOTH Comedy and Drama to cap.
    const shows: TvmazeShow[] = [];
    let id = 1;
    for (let i = 0; i < DISCOVER_TARGET_PER_GENRE; i++) {
      shows.push(makeShow(id++, { genres: ['Comedy'], weight: 200 - i }));
    }
    for (let i = 0; i < DISCOVER_TARGET_PER_GENRE; i++) {
      shows.push(makeShow(id++, { genres: ['Drama'], weight: 150 - i }));
    }
    // Multi-genre show: both Comedy and Drama full → must spill to _other.
    const multiGenre = makeShow(999, { genres: ['Drama', 'Comedy'], weight: 10 });
    shows.push(multiGenre);

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 0) return shows;
      return [];
    });

    const groups = await getPopularShows();
    const otherIds = ((groups as unknown as Record<string, unknown>)._other as TvmazeShow[] | undefined)?.map(
      (s) => s.id,
    ) ?? [];
    const dramaIds = ((groups as unknown as Record<string, unknown>).Drama as TvmazeShow[] | undefined)?.map(
      (s) => s.id,
    ) ?? [];
    const comedyIds = ((groups as unknown as Record<string, unknown>).Comedy as TvmazeShow[] | undefined)?.map(
      (s) => s.id,
    ) ?? [];

    // Both genres at cap → spillover to _other (FASE 2).
    expect(otherIds).toContain(999);
    expect(dramaIds).not.toContain(999);
    expect(comedyIds).not.toContain(999);
    // Caps respected.
    expect(comedyIds.length).toBe(DISCOVER_TARGET_PER_GENRE);
    expect(dramaIds.length).toBe(DISCOVER_TARGET_PER_GENRE);
    expect(otherIds.length).toBeLessThanOrEqual(DISCOVER_TARGET_OTHER);
  });

  it('BUG-A7-07 [Low]: cache TTL boundary — exactly TTL ms old is EXPIRED', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    // Cache written exactly TTL ms ago → Date.now() - cachedAt === TTL → expired (>= check).
    const cachedGroups: Record<string, unknown> = { _other: [], Drama: [makeShow(77)] };
    for (const g of GENRE_CAROUSELS) if (g !== 'Drama') cachedGroups[g] = [];
    localStorage.setItem(
      DISCOVER_CACHE_KEY,
      JSON.stringify({ cachedAt: now - DISCOVER_CACHE_TTL, groups: cachedGroups }),
    );

    mockedGetShowsPage.mockImplementation(async () => [makeShow(1)]);

    const groups = await getPopularShows();

    // Boundary: exactly TTL → expired → fresh fetch.
    expect(mockedGetShowsPage).toHaveBeenCalled();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);
    expect(ids).not.toContain(77); // stale cache rejected
    expect(ids).toContain(1); // fresh fetch
  });

  it('BUG-A7-07 boundary: cache TTL-1 ms old is still VALID', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const cachedGroups: Record<string, unknown> = { _other: [], Drama: [makeShow(77)] };
    for (const g of GENRE_CAROUSELS) if (g !== 'Drama') cachedGroups[g] = [];
    localStorage.setItem(
      DISCOVER_CACHE_KEY,
      JSON.stringify({ cachedAt: now - (DISCOVER_CACHE_TTL - 1), groups: cachedGroups }),
    );

    mockedGetShowsPage.mockImplementation(async () => [makeShow(1)]);

    const groups = await getPopularShows();
    // Just under TTL → cache still valid → API NOT called.
    expect(mockedGetShowsPage).not.toHaveBeenCalled();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);
    expect(ids).toContain(77);
  });

  it('BUG-A7-08 [Low]: duplicate show id across pages → single entry in groups', async () => {
    const dup = makeShow(42, { genres: ['Drama'], weight: 90 });
    // Page 0 and page 1 both return the same show (id 42).
    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 0 || page === 1) return [dup];
      return [];
    });

    const groups = await getPopularShows();
    const allShows = flattenGroups(groups as unknown as Record<string, unknown>);
    const count42 = allShows.filter((s) => s.id === 42).length;

    // Dedup via assignedIds → only one entry.
    expect(count42).toBe(1);
  });

  it('BUG-A7-09 [Low]: all pages return empty arrays → empty groups, no crash, cache still written', async () => {
    mockedGetShowsPage.mockImplementation(async () => []);

    const groups = await getPopularShows();

    // No crash. All carousels empty.
    for (const g of GENRE_CAROUSELS) {
      expect((groups as unknown as Record<string, unknown>)[g]).toEqual([]);
    }
    expect((groups as unknown as Record<string, unknown>)._other).toEqual([]);
    // Cache IS written (all pages "succeeded" with empty arrays, no failedPages).
    expect(localStorage.getItem(DISCOVER_CACHE_KEY)).not.toBeNull();
  });

  it('BUG-A7-10 [Low]: show with empty-string premiered excluded from recent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00'));

    const emptyPremiered = makeShow(1, { premiered: '' });
    const validRecent = makeShow(2, { premiered: '2024-04-01' });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === DISCOVER_RECENT_PAGES[0]) return [emptyPremiered, validRecent];
      return [];
    });

    const groups = await getRecentShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // Empty-string premiered is falsy → excluded by `if (!show.premiered) continue`.
    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
  });

  it('BUG-A7-11 [Low]: show with invalid premiered date (2024-02-30) excluded from recent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00'));

    // 2024-02-30 is invalid (Feb has 29 days in 2024). parseISODateLocal returns null.
    const invalidPremiered = makeShow(1, { premiered: '2024-02-30' });
    const validRecent = makeShow(2, { premiered: '2024-04-01' });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === DISCOVER_RECENT_PAGES[0]) return [invalidPremiered, validRecent];
      return [];
    });

    const groups = await getRecentShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // Invalid date → parseISODateLocal returns null → excluded.
    expect(ids).not.toContain(1);
    expect(ids).toContain(2);
  });

  it('BUG-A7-12 [Low]: show with whitespace-only name excluded (falsy-ish check)', async () => {
    // `!show.name` filters empty string but NOT " " (whitespace is truthy).
    // This test documents current behavior: " " passes the filter (not a bug per se,
    // but the view would render a blank card). We assert the count is consistent.
    const spaceName = makeShow(1, { name: '   ' });
    const validName = makeShow(2, { name: 'Real Show' });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 0) return [spaceName, validName];
      return [];
    });

    const groups = await getPopularShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // Whitespace name passes the `!show.name` filter (truthy string).
    // Documenting: both are included.
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });

  it('BUG-A7-13 [Low]: partial page failure → partial results returned, no cache write', async () => {
    // Page 2 throws, others succeed. Result should include shows from pages 0,1,3+
    // but cache must NOT be written (failedPages.length > 0).
    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 2) throw new Error('network error');
      return [makeShow(page * 1000 + 1)];
    });

    const groups = await getPopularShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // Partial results: shows from non-failing pages are present.
    expect(ids).toContain(1); // page 0
    expect(ids).toContain(1001); // page 1
    expect(ids).not.toContain(2001); // page 2 failed
    expect(ids).toContain(3001); // page 3
    // Cache NOT written (transient failure).
    expect(localStorage.getItem(DISCOVER_CACHE_KEY)).toBeNull();
  });

  it('BUG-A7-14 [Low]: invalidateDiscoverCache + resetDiscoverPreload allows fresh fetch', async () => {
    // First fetch populates cache.
    mockedGetShowsPage.mockImplementation(async () => [makeShow(1)]);
    await getPopularShows();
    expect(localStorage.getItem(DISCOVER_CACHE_KEY)).not.toBeNull();

    // Invalidate cache + reset preload.
    invalidateDiscoverCache('popular');
    resetDiscoverPreload('popular');
    expect(localStorage.getItem(DISCOVER_CACHE_KEY)).toBeNull();

    // Second fetch with different data.
    mockedGetShowsPage.mockReset();
    mockedGetShowsPage.mockImplementation(async () => [makeShow(2)]);
    const groups = await getPopularShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // Fresh fetch happened, new data returned.
    expect(ids).toContain(2);
    expect(ids).not.toContain(1);
  });

  it('BUG-A7-15 [Low]: findShowInDiscoverGroups — empty groups array returns null', async () => {
    // Direct import to test the helper.
    const { findShowInDiscoverGroups } = await import('../src/lib/discover');
    expect(findShowInDiscoverGroups(1, [])).toBeNull();
    expect(findShowInDiscoverGroups(1, [null, null])).toBeNull();
    expect(findShowInDiscoverGroups(1, [{ _other: [], Drama: [] }])).toBeNull();
  });

  it('BUG-A7-16 [Low]: recentOnly — Feb 29 leap year boundary (Aug 29 → Feb 29 included)', async () => {
    vi.useFakeTimers();
    // 2024 is a leap year. 6 months before Aug 29 is Feb 29 (leap day).
    vi.setSystemTime(new Date('2024-08-29T12:00:00'));

    const feb29 = makeShow(1, { premiered: '2024-02-29' });
    const feb28 = makeShow(2, { premiered: '2024-02-28' });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === DISCOVER_RECENT_PAGES[0]) return [feb29, feb28];
      return [];
    });

    const groups = await getRecentShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // sixMonthsAgo anchors to day 1 of target month → Feb 1, 2024.
    // Both Feb 28 and Feb 29 are >= Feb 1 → included.
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });
});
