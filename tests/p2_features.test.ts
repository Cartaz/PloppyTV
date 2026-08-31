// Test per le feature P2: rating, note, tag e random gold episode.
// i18n, keyboard e notifiche hanno suite di contratto dedicate.

import { describe, expect, it } from 'vitest';
import { normalizeShow } from '../src/lib/normalize';
import {
  MAX_EPISODE_RATING,
  MAX_EPISODE_NOTE_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_SHOW,
  SCHEMA_VERSION,
} from '../src/lib/constants';

describe('P2 — Schema v2: rating, note, tags', () => {
  it('SCHEMA_VERSION is 2', () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('normalizeShow preserves episode rating 1-5', () => {
    const raw = {
      id: 1,
      name: 'Test',
      seasons: {
        1: [
          { num: 1, id: 10, watched: true, rating: 5 },
          { num: 2, id: 11, watched: false, rating: 3 },
        ],
      },
    };
    const show = normalizeShow(raw);
    expect(show).not.toBeNull();
    expect(show!.seasons[1][0].rating).toBe(5);
    expect(show!.seasons[1][1].rating).toBe(3);
  });

  it('normalizeShow rejects rating outside 1-5', () => {
    const raw = {
      id: 1,
      name: 'Test',
      seasons: {
        1: [
          { num: 1, id: 10, watched: true, rating: 0 },
          { num: 2, id: 11, watched: true, rating: 6 },
          { num: 3, id: 12, watched: true, rating: -1 },
          { num: 4, id: 13, watched: true, rating: 2.7 },
        ],
      },
    };
    const show = normalizeShow(raw);
    expect(show!.seasons[1][0].rating).toBeUndefined();
    expect(show!.seasons[1][1].rating).toBeUndefined();
    expect(show!.seasons[1][2].rating).toBeUndefined();
    expect(show!.seasons[1][3].rating).toBe(3);
  });

  it('normalizeShow preserves episode note (max 500 char)', () => {
    const longNote = 'a'.repeat(600);
    const raw = {
      id: 1,
      name: 'Test',
      seasons: {
        1: [{ num: 1, id: 10, watched: true, note: longNote }],
      },
    };
    const show = normalizeShow(raw);
    expect(show!.seasons[1][0].note).toHaveLength(MAX_EPISODE_NOTE_LENGTH);
  });

  it('normalizeShow removes empty notes', () => {
    const raw = {
      id: 1,
      name: 'Test',
      seasons: {
        1: [{ num: 1, id: 10, watched: true, note: '   ' }],
      },
    };
    const show = normalizeShow(raw);
    expect(show!.seasons[1][0].note).toBeUndefined();
  });

  it('normalizeShow preserves tags with dedup and max', () => {
    const tags = ['Rewatch', 'rewatch', 'Con Alice', '', '   ', ...Array.from({ length: 25 }, (_, i) => 'tag' + i)];
    const raw = { id: 1, name: 'Test', tags };
    const show = normalizeShow(raw);
    expect(show!.tags).toBeDefined();
    expect(show!.tags!.length).toBeLessThanOrEqual(MAX_TAGS_PER_SHOW);
    const lowerTags = show!.tags!.map((tag) => tag.toLowerCase());
    expect(new Set(lowerTags).size).toBe(lowerTags.length);
  });

  it('normalizeShow trims tags to MAX_TAG_LENGTH', () => {
    const longTag = 'x'.repeat(100);
    const show = normalizeShow({ id: 1, name: 'Test', tags: [longTag] });
    expect(show!.tags![0]).toHaveLength(MAX_TAG_LENGTH);
  });

  it('normalizeShow handles missing tags gracefully', () => {
    const show = normalizeShow({ id: 1, name: 'Test' });
    expect(show!.tags).toEqual([]);
  });

  it('buildShowFromTvmaze includes empty tags array', async () => {
    const { buildShowFromTvmaze } = await import('../src/lib/normalize');
    const show = buildShowFromTvmaze(
      { id: 1, name: 'Test' },
      [{ id: 100, season: 1, number: 1 }],
      'towatch',
    );
    expect(show.tags).toEqual([]);
  });
});

describe('P2.5 — getRandomGoldEpisode guards', () => {
  it('handles show with seasons=null without throwing', async () => {
    const { getRandomGoldEpisode } = await import('../src/lib/shows');
    const { setShows } = await import('../src/lib/store');
    const show: any = {
      id: 1,
      name: 'Test',
      seasons: null,
      list: 'watching',
      totalEpisodes: 0,
      totalSeasons: 0,
    };
    setShows([show]);
    expect(() => getRandomGoldEpisode()).not.toThrow();
    expect(getRandomGoldEpisode()).toBeNull();
  });

  it('handles show with seasons=undefined without throwing', async () => {
    const { getRandomGoldEpisode } = await import('../src/lib/shows');
    const { setShows } = await import('../src/lib/store');
    const show: any = {
      id: 1,
      name: 'Test',
      list: 'watching',
      totalEpisodes: 0,
      totalSeasons: 0,
    };
    setShows([show]);
    expect(() => getRandomGoldEpisode()).not.toThrow();
  });

  it('returns null when no 5★ episodes exist', async () => {
    const { getRandomGoldEpisode } = await import('../src/lib/shows');
    const { setShows } = await import('../src/lib/store');
    const show = normalizeShow({
      id: 1,
      name: 'Test',
      seasons: {
        1: [
          { num: 1, id: 10, watched: true, rating: 4 },
          { num: 2, id: 11, watched: true, rating: 3 },
        ],
      },
    })!;
    show.list = 'watching';
    setShows([show]);
    expect(getRandomGoldEpisode()).toBeNull();
  });

  it('returns a 5★ episode when one exists', async () => {
    const { getRandomGoldEpisode } = await import('../src/lib/shows');
    const { setShows } = await import('../src/lib/store');
    const show = normalizeShow({
      id: 1,
      name: 'Test',
      seasons: {
        1: [
          { num: 1, id: 10, watched: true, rating: 5 },
          { num: 2, id: 11, watched: true, rating: 3 },
        ],
      },
    })!;
    show.list = 'watching';
    setShows([show]);
    const result = getRandomGoldEpisode();
    expect(result).not.toBeNull();
    expect(result!.ep.rating).toBe(MAX_EPISODE_RATING);
    expect(result!.ep.num).toBe(1);
  });
});

describe('P2.3 — getAllUserTags', () => {
  it('collects unique tags from all shows', async () => {
    const { getAllUserTags } = await import('../src/lib/shows');
    const { setShows } = await import('../src/lib/store');
    const first = normalizeShow({ id: 1, name: 'A', tags: ['Rewatch', 'Summer'] })!;
    const second = normalizeShow({ id: 2, name: 'B', tags: ['Summer', 'Alice'] })!;
    setShows([first, second]);
    const tags = getAllUserTags();
    expect(tags).toContain('Rewatch');
    expect(tags).toContain('Summer');
    expect(tags).toContain('Alice');
    expect(tags).toHaveLength(3);
  });

  it('returns empty array when no shows have tags', async () => {
    const { getAllUserTags } = await import('../src/lib/shows');
    const { setShows } = await import('../src/lib/store');
    setShows([normalizeShow({ id: 1, name: 'A' })!]);
    expect(getAllUserTags()).toEqual([]);
  });
});
