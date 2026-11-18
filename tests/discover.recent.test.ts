import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as Api from '../src/lib/api';

const getUpdatedShowIds = vi.fn<(since: string) => Promise<number[]>>();
const getShowsPage = vi.fn<(page: number) => Promise<unknown[]>>();

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof Api>();
  return {
    ...actual,
    getUpdatedShowIds: (since: string) => getUpdatedShowIds(since),
    getShowsPage: (page: number) => getShowsPage(page),
  };
});

import { getRecentPages, getRecentShows } from '../src/lib/discover';
import { ApiError } from '../src/lib/api';
import { DISCOVER_RECENT_FALLBACK_PAGES, DISCOVER_RECENT_CACHE_KEY } from '../src/lib/constants';

beforeEach(() => {
  getUpdatedShowIds.mockReset();
  getShowsPage.mockReset();
  localStorage.clear();
});

describe('Discover "Ultimi arrivi" pages', () => {
  it('derives the last /shows pages from the highest recently updated show id', async () => {
    getUpdatedShowIds.mockResolvedValue([12, 95752, 40000]);
    // floor(95752 / 250) = 383 → le ultime 8 pagine
    expect(await getRecentPages()).toEqual([376, 377, 378, 379, 380, 381, 382, 383]);
    expect(getUpdatedShowIds).toHaveBeenCalledWith('week');
  });

  it('falls back to the static pages when /updates/shows fails or is empty', async () => {
    getUpdatedShowIds.mockRejectedValueOnce(new ApiError('down', 'NetworkError'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await getRecentPages()).toEqual(DISCOVER_RECENT_FALLBACK_PAGES);
    getUpdatedShowIds.mockResolvedValueOnce([]);
    expect(await getRecentPages()).toEqual(DISCOVER_RECENT_FALLBACK_PAGES);
  });

  it('treats a 404 on the newest page as empty (index lag), so the result is still cached', async () => {
    getUpdatedShowIds.mockResolvedValue([95752]);
    const recent = new Date();
    recent.setDate(recent.getDate() - 10);
    const premiered = recent.toISOString().slice(0, 10);
    getShowsPage.mockImplementation(async (page: number) => {
      if (page === 383) throw new ApiError('API error 404', 'ApiError', 404);
      return [{ id: page, name: 'S' + page, premiered, weight: 50, genres: ['Drama'], image: { medium: 'x' } }];
    });

    const groups = await getRecentShows();
    expect(groups.Drama.length).toBe(7);
    expect(localStorage.getItem(DISCOVER_RECENT_CACHE_KEY)).not.toBeNull();
  });
});
