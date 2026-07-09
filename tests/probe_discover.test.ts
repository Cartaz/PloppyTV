// Agent 07 — probe tests for src/lib/discover.ts
// Verifies: FASE2 overfill, weight=0 exclusion, writeCache skip on failedPages,
// readCache future-date non-expiry, malformed cache shape, findShowInDiscoverGroups
// robustness, recentOnly date filter (incl. Mar 31 setMonth rollover).
// Mocks getShowsPage; uses real localStorage (jsdom) and fake timers for date tests.

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
  findShowInDiscoverGroups,
  invalidateDiscoverCache,
} from '../src/lib/discover';
import {
  DISCOVER_TARGET_PER_GENRE,
  DISCOVER_TARGET_OTHER,
  DISCOVER_TOTAL_TARGET,
  DISCOVER_CACHE_KEY,
  DISCOVER_RECENT_CACHE_KEY,
  DISCOVER_POPULAR_PAGES,
  DISCOVER_RECENT_PAGES,
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

describe('Agent-07 probe: discover.ts', () => {
  it('FASE2 respects DISCOVER_TARGET_PER_GENRE cap (BUG-07-01 fixed)', async () => {
    // 40 Sci-Fi shows, no other genres. FASE1 caps Sci-Fi at 20.
    // FASE2 deficit = 150 - 20 = 130; the remaining 20 Sci-Fi candidates
    // must NOT be pushed to groups['Science-Fiction'] (cap reached).
    // Instead they should be redirected to _other (capped at 30).
    const sciFiShows: TvmazeShow[] = [];
    for (let i = 1; i <= 40; i++) {
      sciFiShows.push(makeShow(i, { genres: ['Science-Fiction'], weight: 100 - i }));
    }
    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 0) return sciFiShows;
      return [];
    });

    const groups = await getPopularShows();

    const sciFiCount = groups['Science-Fiction']?.length ?? 0;
    const otherCount = groups._other?.length ?? 0;

    // eslint-disable-next-line no-console
    console.log('FASE2 cap test:', {
      sciFiCount,
      otherCount,
      cap: DISCOVER_TARGET_PER_GENRE,
      totalTarget: DISCOVER_TOTAL_TARGET,
    });

    // BUG-07-01 fixed: Sci-Fi must not exceed the per-genre cap.
    expect(sciFiCount).toBeLessThanOrEqual(DISCOVER_TARGET_PER_GENRE);
    expect(sciFiCount).toBe(DISCOVER_TARGET_PER_GENRE); // FASE1 fills to cap, FASE2 doesn't add
    // Spillover redirected to _other (BUG-07-02 cap also enforced).
    expect(otherCount).toBeLessThanOrEqual(DISCOVER_TARGET_OTHER);
    expect(otherCount).toBe(20); // remaining 20 Sci-Fi shows
  });

  it('FASE2 respects DISCOVER_TARGET_OTHER cap (BUG-07-02 fixed)', async () => {
    // 50 shows with genre 'Western' (not in GENRE_CAROUSELS) → all go to _other.
    // FASE1 caps _other at 30. FASE2 must NOT push the remaining 20.
    const otherShows: TvmazeShow[] = [];
    for (let i = 1; i <= 50; i++) {
      otherShows.push(makeShow(i, { genres: ['Western'], weight: 100 - i }));
    }
    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 0) return otherShows;
      return [];
    });

    const groups = await getPopularShows();
    const otherCount = groups._other?.length ?? 0;

    // eslint-disable-next-line no-console
    console.log('FASE2 _other cap test:', { otherCount, cap: DISCOVER_TARGET_OTHER });

    expect(otherCount).toBeLessThanOrEqual(DISCOVER_TARGET_OTHER);
    expect(otherCount).toBe(DISCOVER_TARGET_OTHER); // FASE1 fills to cap, FASE2 doesn't add
  });

  it('weight=0 is included; missing/negative weight excluded (BUG-07-03 fixed)', async () => {
    const zeroWeight = makeShow(1, { weight: 0 });
    const missingWeight = makeShow(2, { weight: undefined });
    const negativeWeight = makeShow(3, { weight: -5 });
    const positiveWeight = makeShow(4, { weight: 50 });
    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 0) return [zeroWeight, missingWeight, negativeWeight, positiveWeight];
      return [];
    });

    const groups = await getPopularShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // eslint-disable-next-line no-console
    console.log('weight filter test: ids returned =', ids);

    expect(ids).toContain(1); // weight=0 now INCLUDED (valid TVMaze value)
    expect(ids).not.toContain(2); // weight=undefined excluded
    expect(ids).not.toContain(3); // weight=-5 excluded
    expect(ids).toContain(4); // weight=50 included
  });

  it('writeCache is skipped when any page fails (failedPages.length > 0)', async () => {
    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === 3) throw new Error('Network error');
      return [makeShow(page * 1000 + 1)];
    });

    await getPopularShows();

    const cached = localStorage.getItem(DISCOVER_CACHE_KEY);
    // eslint-disable-next-line no-console
    console.log('writeCache skip test: cached =', cached);

    // Correct behavior: cache NOT written when a page failed.
    expect(cached).toBeNull();
  });

  it('writeCache IS written when all pages succeed', async () => {
    mockedGetShowsPage.mockImplementation(async (page: number) => [makeShow(page * 1000 + 1)]);

    await getPopularShows();

    const cached = localStorage.getItem(DISCOVER_CACHE_KEY);
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached as string) as { cachedAt: number; groups: unknown };
    expect(parsed.cachedAt).toBeGreaterThan(0);
    expect(parsed.groups).toBeDefined();
  });

  it('readCache: future cachedAt rejected → fresh fetch (BUG-07-04 fixed)', async () => {
    const futureTime = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year in the future
    const cachedGroups = {
      _other: [],
      'Science-Fiction': [makeShow(999, { genres: ['Science-Fiction'] })],
    };
    localStorage.setItem(
      DISCOVER_CACHE_KEY,
      JSON.stringify({ cachedAt: futureTime, groups: cachedGroups }),
    );

    // Fixed: future cachedAt is invalid → cache rejected → fresh fetch happens.
    mockedGetShowsPage.mockImplementation(async () => [makeShow(1, { genres: ['Science-Fiction'] })]);

    const groups = await getPopularShows();

    // eslint-disable-next-line no-console
    console.log('readCache future-date test (fixed):', {
      apiCalls: mockedGetShowsPage.mock.calls.length,
      sciFiCount: groups['Science-Fiction']?.length ?? 0,
    });

    // Fixed: cache rejected, api called, fresh data returned.
    expect(mockedGetShowsPage).toHaveBeenCalled();
    // The cached show 999 must NOT be present (cache was bypassed).
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);
    expect(ids).not.toContain(999);
    expect(ids).toContain(1); // fresh fetch produced id 1
  });

  it('readCache: malformed groups rejected → fresh fetch (BUG-07-05 fixed)', async () => {
    // cached.groups is a string, not an object. readCache now validates shape.
    localStorage.setItem(
      DISCOVER_CACHE_KEY,
      JSON.stringify({ cachedAt: Date.now(), groups: 'not-an-object' }),
    );

    // Fixed: malformed cache rejected → fresh fetch happens.
    mockedGetShowsPage.mockImplementation(async () => [makeShow(1)]);

    const groups = await getPopularShows();

    // eslint-disable-next-line no-console
    console.log('malformed cache test (fixed): groups =', JSON.stringify(groups));

    // Fixed: cache rejected, api called, real DiscoverGroups returned.
    expect(mockedGetShowsPage).toHaveBeenCalled();
    expect(groups).not.toBe('not-an-object');
    expect(flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id)).toContain(1);
  });

  it('readCache: malformed cachedAt (string) → treated as NaN, cache invalid → fetch', async () => {
    localStorage.setItem(
      DISCOVER_CACHE_KEY,
      JSON.stringify({ cachedAt: 'abc', groups: { _other: [] } }),
    );

    mockedGetShowsPage.mockImplementation(async () => [makeShow(1)]);

    const groups = await getPopularShows();

    // Date.now() - 'abc' === NaN; NaN < TTL === false → cache invalid → fetch.
    expect(mockedGetShowsPage).toHaveBeenCalled();
    expect(flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id)).toContain(1);
  });

  it('findShowInDiscoverGroups handles malformed groups (non-array values)', () => {
    const malformed = {
      _other: 'not an array',
      Drama: [makeShow(5)],
      'Science-Fiction': null,
    } as unknown as Parameters<typeof findShowInDiscoverGroups>[1][0];

    const found = findShowInDiscoverGroups(5, [malformed, null]);
    expect(found?.id).toBe(5);

    const notFound = findShowInDiscoverGroups(999, [malformed]);
    expect(notFound).toBeNull();
  });

  it('recentOnly excludes shows premiered > 6 months ago (basic)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00'));

    // 6 months before Jun 15 = Dec 15, 2023.
    const recentShow = makeShow(1, { premiered: '2024-04-01' });
    const oldShow = makeShow(2, { premiered: '2023-01-01' });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === DISCOVER_RECENT_PAGES[0]) return [recentShow, oldShow];
      return [];
    });

    const groups = await getRecentShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // eslint-disable-next-line no-console
    console.log('recentOnly basic test: ids =', ids);

    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
  });

  it('recentOnly Mar 31 setMonth clamps to Sep 30 (BUG-07-06 fixed)', async () => {
    // On March 31, "6 months ago" should be Sep 30 (Sep has 30 days).
    // Old code: new Date(2024,2,31).setMonth(2-6) → Sep 31 → rolls to Oct 1.
    // Fixed code: anchor to day 1, then clamp day to last day of target month → Sep 30.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-03-31T12:00:00'));

    // Verify the clamp directly.
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const dayOfMonth = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() - 6);
    const lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
    // eslint-disable-next-line no-console
    console.log('Mar 31 clamp (fixed): sixMonthsAgo =', d.toISOString(), '(expected Sep 30)');

    const sep30Show = makeShow(1, { premiered: '2023-09-30' });
    const oct1Show = makeShow(2, { premiered: '2023-10-01' });

    mockedGetShowsPage.mockImplementation(async (page: number) => {
      if (page === DISCOVER_RECENT_PAGES[0]) return [sep30Show, oct1Show];
      return [];
    });

    const groups = await getRecentShows();
    const ids = flattenGroups(groups as unknown as Record<string, unknown>).map((s) => s.id);

    // eslint-disable-next-line no-console
    console.log('Mar 31 clamp test (fixed): ids returned =', ids);

    // Fixed: Sep 30 (exactly 6 months before Mar 31) is now INCLUDED.
    expect(ids).toContain(1); // Sep 30 show now included
    expect(ids).toContain(2); // Oct 1 show still included
  });

  it('invalidateDiscoverCache removes localStorage key for the tab', () => {
    localStorage.setItem(DISCOVER_CACHE_KEY, JSON.stringify({ cachedAt: 1, groups: { _other: [] } }));
    localStorage.setItem(DISCOVER_RECENT_CACHE_KEY, JSON.stringify({ cachedAt: 1, groups: { _other: [] } }));

    invalidateDiscoverCache('popular');
    expect(localStorage.getItem(DISCOVER_CACHE_KEY)).toBeNull();
    // Recent cache should be untouched.
    expect(localStorage.getItem(DISCOVER_RECENT_CACHE_KEY)).not.toBeNull();

    invalidateDiscoverCache('recent');
    expect(localStorage.getItem(DISCOVER_RECENT_CACHE_KEY)).toBeNull();
  });

  it('fetchAllCandidates: all page indices are assigned (BUG-07-07 shared-array fill removed)', async () => {
    // The old `new Array(n).fill([])` shared one [] across indices — a footgun.
    // The fix uses Array.from with per-index fresh []. The for-loop assigns
    // results[r.idx] = r.shows for EVERY batch item, so all pages appear.
    mockedGetShowsPage.mockImplementation(async (page: number) => [makeShow(page * 1000 + 1)]);

    const groups = await getPopularShows();
    const allShows = flattenGroups(groups as unknown as Record<string, unknown>);
    const ids = allShows.map((s) => s.id).sort((a, b) => a - b);

    // eslint-disable-next-line no-console
    console.log('shared-array test: ids =', ids, '(expected', DISCOVER_POPULAR_PAGES.length, 'shows)');

    // Every page produced exactly 1 valid show → all should appear.
    expect(allShows).toHaveLength(DISCOVER_POPULAR_PAGES.length);
  });

  it('concurrency: all pages fetched in batches of 3 (smoke test, no crash)', async () => {
    const calledPages: number[] = [];
    mockedGetShowsPage.mockImplementation(async (page: number) => {
      calledPages.push(page);
      return [makeShow(page * 1000 + 1)];
    });

    await getPopularShows();

    // eslint-disable-next-line no-console
    console.log('concurrency test: pages called =', calledPages);

    expect(calledPages.sort((a, b) => a - b)).toEqual([...DISCOVER_POPULAR_PAGES]);
  });
});
