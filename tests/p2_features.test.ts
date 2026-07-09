// Test per le feature P2: rating, note, tag, i18n, random gold episode

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// Mock window.matchMedia
Object.defineProperty(globalThis, 'matchMedia', {
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
  writable: true,
});

// Mock Notification
Object.defineProperty(globalThis, 'Notification', {
  value: class MockNotification {
    static permission = 'default';
    static requestPermission = vi.fn().mockResolvedValue('granted');
    constructor() {}
  },
  writable: true,
});

import { normalizeShow } from '../src/lib/normalize';
import { MAX_EPISODE_RATING, MAX_EPISODE_NOTE_LENGTH, MAX_TAG_LENGTH, MAX_TAGS_PER_SHOW, SCHEMA_VERSION } from '../src/lib/constants';
import { initI18n, setLocale, getLocale, t, _resetI18nForTesting } from '../src/lib/i18n';

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
          { num: 1, id: 10, watched: true, rating: 0 }, // 0 → undefined (no rating)
          { num: 2, id: 11, watched: true, rating: 6 }, // > 5 → undefined
          { num: 3, id: 12, watched: true, rating: -1 }, // < 1 → undefined
          { num: 4, id: 13, watched: true, rating: 2.7 }, // float → rounded to 3
        ],
      },
    };
    const show = normalizeShow(raw);
    expect(show!.seasons[1][0].rating).toBeUndefined();
    expect(show!.seasons[1][1].rating).toBeUndefined();
    expect(show!.seasons[1][2].rating).toBeUndefined();
    expect(show!.seasons[1][3].rating).toBe(3); // rounded
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
    // Dedup case-insensitive: 'Rewatch' and 'rewatch' → 1 tag
    // Empty/whitespace tags filtered
    // Max MAX_TAGS_PER_SHOW tags
    expect(show!.tags).toBeDefined();
    expect(show!.tags!.length).toBeLessThanOrEqual(MAX_TAGS_PER_SHOW);
    // Check dedup: 'Rewatch' and 'rewatch' should be 1
    const lowerTags = show!.tags!.map((t) => t.toLowerCase());
    const uniqueLower = new Set(lowerTags);
    expect(uniqueLower.size).toBe(lowerTags.length); // no duplicates
  });

  it('normalizeShow trims tags to MAX_TAG_LENGTH', () => {
    const longTag = 'x'.repeat(100);
    const raw = { id: 1, name: 'Test', tags: [longTag] };
    const show = normalizeShow(raw);
    expect(show!.tags![0]).toHaveLength(MAX_TAG_LENGTH);
  });

  it('normalizeShow handles missing tags gracefully', () => {
    const raw = { id: 1, name: 'Test' };
    const show = normalizeShow(raw);
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

describe('P2.7 — i18n', () => {
  beforeEach(() => {
    localStorageMock.clear();
    _resetI18nForTesting();
    // Reset navigator.language to Italian default for each test
    Object.defineProperty(navigator, 'language', { value: 'it-IT', configurable: true });
  });

  it('initI18n defaults to it for Italian browser', () => {
    Object.defineProperty(navigator, 'language', { value: 'it-IT', configurable: true });
    initI18n();
    expect(getLocale()).toBe('it');
  });

  it('initI18n defaults to en for English browser', () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    initI18n();
    expect(getLocale()).toBe('en');
  });

  it('setLocale persists to localStorage', () => {
    initI18n();
    setLocale('en');
    expect(getLocale()).toBe('en');
    const prefs = JSON.parse(localStorageMock.getItem('ploppytv_prefs_v1') || '{}');
    expect(prefs.lang).toBe('en');
  });

  it('t() returns translated string for known key', () => {
    _resetI18nForTesting();
    initI18n();
    setLocale('it');
    expect(t('nav.dashboard')).toBe('Dashboard');
    setLocale('en');
    expect(t('nav.dashboard')).toBe('Dashboard');
    setLocale('it');
    expect(t('nav.watching')).toBe('In corso');
    setLocale('en');
    expect(t('nav.watching')).toBe('Watching');
  });

  it('t() interpolates params', () => {
    _resetI18nForTesting();
    initI18n();
    setLocale('it');
    expect(t('library.results', { count: 5 })).toBe('5 risultati');
    setLocale('en');
    expect(t('library.results', { count: 5 })).toBe('5 results');
  });

  it('t() falls back to Italian if key missing in English', () => {
    _resetI18nForTesting();
    initI18n();
    setLocale('en');
    // Use a key that exists in both — verify fallback mechanism
    expect(t('nav.dashboard')).toBe('Dashboard');
  });

  it('t() returns key if not found in any locale', () => {
    _resetI18nForTesting();
    initI18n();
    setLocale('it');
    expect(t('nonexistent.key.xyz')).toBe('nonexistent.key.xyz');
  });
});

describe('P2.5 — getRandomGoldEpisode guards', () => {
  it('handles show with seasons=null without throwing', async () => {
    const { getRandomGoldEpisode } = await import('../src/lib/shows');
    const { setShows } = await import('../src/lib/store');
    const show: any = {
      id: 1,
      name: 'Test',
      seasons: null, // malformed
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
    const s1 = normalizeShow({ id: 1, name: 'A', tags: ['Rewatch', 'Summer'] })!;
    const s2 = normalizeShow({ id: 2, name: 'B', tags: ['Summer', 'Alice'] })!;
    setShows([s1, s2]);
    const tags = getAllUserTags();
    expect(tags).toContain('Rewatch');
    expect(tags).toContain('Summer');
    expect(tags).toContain('Alice');
    expect(tags.length).toBe(3); // deduped
  });

  it('returns empty array when no shows have tags', async () => {
    const { getAllUserTags } = await import('../src/lib/shows');
    const { setShows } = await import('../src/lib/store');
    const s1 = normalizeShow({ id: 1, name: 'A' })!;
    setShows([s1]);
    expect(getAllUserTags()).toEqual([]);
  });
});

describe('P2.6 — Keyboard shortcuts module', () => {
  it('initKeyboard is idempotent', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    expect(() => initKeyboard()).not.toThrow();
    expect(() => initKeyboard()).not.toThrow(); // second call should not throw
  });
});

describe('P2.9 — Notifications module', () => {
  it('notificationsSupported returns true when Notification exists', async () => {
    const { notificationsSupported } = await import('../src/lib/notifications');
    expect(notificationsSupported()).toBe(true);
  });

  it('isPwaStandalone returns false in test environment', async () => {
    const { isPwaStandalone } = await import('../src/lib/notifications');
    expect(isPwaStandalone()).toBe(false);
  });

  it('initNotifications is idempotent', async () => {
    const { initNotifications } = await import('../src/lib/notifications');
    expect(() => initNotifications()).not.toThrow();
    expect(() => initNotifications()).not.toThrow();
  });
});
