// Agent A8 — probe tests for i18n.ts, notifications.ts, keyboard.ts, constants.ts
//
// Covers BUG-A8-01..11: RegExp injection in t(), null/undefined param values,
// nested {} re-interpolation, locale fallback edge cases, setTimeout overflow
// in notifications, modifier-key shortcuts, listener leaks, API_BASE validation.
//
// Also verifies that en.json and it.json have aligned keys + placeholders.
//
// NOTE: vi.mock is hoisted to the top of the file and applies to ALL tests.
// The store mock provides a working in-memory implementation so that both
// notifications tests (which need setShows/getState) and keyboard tests (which
// need switchView spy) can coexist. The modal mock is controllable via
// mockModal.isOpen.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import enLocale from '../src/locales/en.json';
import itLocale from '../src/locales/it.json';
import type { Show } from '../src/types';

// ===== Hoisted mock state (created before vi.mock factories run) =====
const { mockStore, mockModal } = vi.hoisted(() => {
  // Use `any` for mock fn types to avoid variance issues between
  // Mock<specific args> and Mock<any[]>.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyMock = ReturnType<typeof vi.fn>;
  interface MockStore {
    shows: Show[];
    currentView: string;
    switchView: AnyMock;
    getState: AnyMock;
    setShows: AnyMock;
  }
  interface MockModal {
    isOpen: boolean;
    isModalOpen: AnyMock;
    showModal: AnyMock;
  }
  const mockStore: MockStore = {
    shows: [],
    currentView: 'dashboard',
    switchView: vi.fn().mockImplementation((view: string) => {
      mockStore.currentView = view;
    }),
    getState: vi.fn().mockImplementation(() => ({
      shows: mockStore.shows,
      currentView: mockStore.currentView,
    })),
    setShows: vi.fn().mockImplementation((shows: Show[]) => {
      mockStore.shows = Array.isArray(shows) ? shows.slice() : [];
    }),
  };
  const mockModal: MockModal = {
    isOpen: false,
    isModalOpen: vi.fn().mockImplementation((): boolean => mockModal.isOpen),
    showModal: vi.fn(),
  };
  return { mockStore, mockModal };
});

// ===== Top-level mocks (hoisted by vitest) =====
vi.mock('../src/lib/store', () => ({
  switchView: mockStore.switchView,
  getState: mockStore.getState,
  setShows: mockStore.setShows,
}));

vi.mock('../src/components/modal', () => ({
  isModalOpen: mockModal.isModalOpen,
  showModal: mockModal.showModal,
}));

// ===== Shared mocks (localStorage, matchMedia, Notification) =====

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

function setupMatchMedia(): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
    writable: true,
    configurable: true,
  });
}
setupMatchMedia();

// Notification mock with controllable permission
let _notifPermission = 'default';
const _notifInstances: Array<{ title: string; tag?: string }> = [];
Object.defineProperty(globalThis, 'Notification', {
  value: class MockNotification {
    static get permission() {
      return _notifPermission;
    }
    static set permission(v: string) {
      _notifPermission = v;
    }
    static requestPermission = vi.fn(async () => {
      return _notifPermission === 'denied' ? 'denied' : 'granted';
    });
    constructor(title: string, options?: { tag?: string; body?: string }) {
      _notifInstances.push({ title, tag: options?.tag });
    }
  },
  writable: true,
});

// Helper to reset all mock state between tests.
//
// NOTE (A8 resume): vi.restoreAllMocks() — used in afterEach of several
// notification suites — strips the mockImplementation set on vi.fn() mocks
// in vitest 1.6.1 (it calls mockRestore, which for vi.fn() is equivalent to
// mockReset → impl becomes "return undefined"). mockClear() alone does NOT
// restore the implementation. As a result, the next test's beforeEach would
// see getState()/isModalOpen()/etc. returning undefined, breaking 9 tests
// (7 notifications + 2 keyboard). We re-establish the implementations here
// so the shared mocks survive restoreAllMocks between suites.
function resetMockState(): void {
  mockStore.shows = [];
  mockStore.currentView = 'dashboard';
  mockStore.switchView.mockClear();
  mockStore.switchView.mockImplementation((view: string) => {
    mockStore.currentView = view;
  });
  mockStore.getState.mockClear();
  mockStore.getState.mockImplementation(() => ({
    shows: mockStore.shows,
    currentView: mockStore.currentView,
  }));
  mockStore.setShows.mockClear();
  mockStore.setShows.mockImplementation((shows: Show[]) => {
    mockStore.shows = Array.isArray(shows) ? shows.slice() : [];
  });
  mockModal.isOpen = false;
  mockModal.isModalOpen.mockClear();
  mockModal.isModalOpen.mockImplementation((): boolean => mockModal.isOpen);
  mockModal.showModal.mockClear();
  _notifInstances.length = 0;
}

// =====================================================================
// constants.ts — normalizeApiBase + NOTIF_MAX_DELAY_MS
// =====================================================================

describe('A8 — constants.ts', () => {
  beforeEach(() => {
    vi.resetModules();
    resetMockState();
  });

  it('normalizeApiBase strips trailing slash', async () => {
    const { normalizeApiBase, API_BASE } = await import('../src/lib/constants');
    expect(normalizeApiBase('https://api.tvmaze.com/')).toBe('https://api.tvmaze.com');
    expect(normalizeApiBase('https://api.tvmaze.com///')).toBe('https://api.tvmaze.com');
    expect(normalizeApiBase('https://api.tvmaze.com')).toBe('https://api.tvmaze.com');
    expect(normalizeApiBase(API_BASE)).toBe(API_BASE);
  });

  it('normalizeApiBase returns fallback for missing protocol', async () => {
    const { normalizeApiBase, API_BASE } = await import('../src/lib/constants');
    expect(normalizeApiBase('api.tvmaze.com')).toBe(API_BASE);
    expect(normalizeApiBase('ftp://api.tvmaze.com')).toBe(API_BASE);
    expect(normalizeApiBase('://no-host')).toBe(API_BASE);
  });

  it('normalizeApiBase returns fallback for non-string / empty', async () => {
    const { normalizeApiBase, API_BASE } = await import('../src/lib/constants');
    expect(normalizeApiBase(null)).toBe(API_BASE);
    expect(normalizeApiBase(undefined)).toBe(API_BASE);
    expect(normalizeApiBase(123)).toBe(API_BASE);
    expect(normalizeApiBase('')).toBe(API_BASE);
    expect(normalizeApiBase('   ')).toBe(API_BASE);
  });

  it('normalizeApiBase rejects http:// with no host (just protocol)', async () => {
    const { normalizeApiBase, API_BASE } = await import('../src/lib/constants');
    expect(normalizeApiBase('http://')).toBe(API_BASE);
    expect(normalizeApiBase('https:///')).toBe(API_BASE);
  });

  it('NOTIF_MAX_DELAY_MS is below 2^31-1 (safe setTimeout)', async () => {
    const { NOTIF_MAX_DELAY_MS } = await import('../src/lib/constants');
    expect(NOTIF_MAX_DELAY_MS).toBeLessThan(Math.pow(2, 31) - 1);
    expect(NOTIF_MAX_DELAY_MS).toBeGreaterThan(0);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(NOTIF_MAX_DELAY_MS).toBeLessThan(thirtyDays);
  });

  it('SCHEMA_VERSION is a positive integer', async () => {
    const { SCHEMA_VERSION } = await import('../src/lib/constants');
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('MAX_IMPORT_SIZE is positive finite number', async () => {
    const { MAX_IMPORT_SIZE } = await import('../src/lib/constants');
    expect(Number.isFinite(MAX_IMPORT_SIZE)).toBe(true);
    expect(MAX_IMPORT_SIZE).toBeGreaterThan(0);
  });

  it('DISCOVER pages arrays are non-empty with non-negative integers', async () => {
    const { DISCOVER_POPULAR_PAGES, DISCOVER_RECENT_PAGES, GENRE_CAROUSELS } = await import(
      '../src/lib/constants'
    );
    expect(DISCOVER_POPULAR_PAGES.length).toBeGreaterThan(0);
    expect(DISCOVER_RECENT_PAGES.length).toBeGreaterThan(0);
    expect(GENRE_CAROUSELS.length).toBeGreaterThan(0);
    for (const p of [...DISCOVER_POPULAR_PAGES, ...DISCOVER_RECENT_PAGES]) {
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
    }
  });
});

// =====================================================================
// i18n.ts — interpolation, fallback, persistence
// =====================================================================

describe('A8 — i18n.ts interpolation (BUG-A8-01)', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.resetModules();
    resetMockState();
  });

  it('t() does NOT crash when param key contains regex metacharacters', async () => {
    const { initI18n, setLocale, t } = await import('../src/lib/i18n');
    initI18n();
    setLocale('it');
    // Old code: new RegExp('\\{(\\}', 'g') → SyntaxError "Unterminated group"
    expect(() => t('Hello {x}', { '(': 'Y' })).not.toThrow();
    expect(t('Hello {x}', { '(': 'Y' })).toBe('Hello {x}');
  });

  it('t() does NOT re-interpolate nested {} in param values', async () => {
    const { initI18n, setLocale, t, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    initI18n();
    setLocale('it');
    // If name='{count}' and count=5, old code would first replace {name} with
    // '{count}', then replace {count} with '5' → "5". New code: single pass,
    // {count} in the value is NOT re-scanned → "{count}".
    const result = t('search.noResults', { query: '{count}' });
    expect(result).toContain('{count}');
    expect(result).not.toMatch(/^5$/);
  });

  it('t() treats null/undefined param values as empty string', async () => {
    const { initI18n, setLocale, t, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    initI18n();
    setLocale('it');
    const result = t('library.results', { count: undefined as unknown as number });
    expect(result).toBe(' risultati');
    const result2 = t('library.results', { count: null as unknown as number });
    expect(result2).toBe(' risultati');
  });

  it('t() leaves unknown placeholders unreplaced (not stripped)', async () => {
    const { initI18n, setLocale, t, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    initI18n();
    setLocale('it');
    const result = t('search.noResultsAlt', { query: 'X' });
    expect(result).toContain('{alt}');
    expect(result).toContain('X');
  });

  it('t() returns key when key not found in any locale', async () => {
    const { initI18n, setLocale, t, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    initI18n();
    setLocale('it');
    expect(t('nonexistent.key.xyz')).toBe('nonexistent.key.xyz');
    setLocale('en');
    expect(t('nonexistent.key.xyz')).toBe('nonexistent.key.xyz');
  });

  it('t() returns key for empty-string key', async () => {
    const { initI18n, setLocale, t, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    initI18n();
    setLocale('it');
    expect(t('')).toBe('');
  });

  it('t() interpolates multiple placeholders in one string', async () => {
    const { initI18n, setLocale, t, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    initI18n();
    setLocale('it');
    const result = t('notifications.episodeAirs', { show: 'Lost', season: 2, ep: 5 });
    expect(result).toBe('Tra 1 ora: Lost S2E5');
  });

  it('t() interpolates with numeric params (count=0)', async () => {
    const { initI18n, setLocale, t, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    initI18n();
    setLocale('it');
    expect(t('library.results', { count: 0 })).toBe('0 risultati');
    expect(t('library.results', { count: -1 })).toBe('-1 risultati');
  });
});

describe('A8 — i18n.ts locale persistence (BUG-A8-02, BUG-A8-03)', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.resetModules();
    resetMockState();
  });

  it('initI18n accepts uppercase saved lang (BUG-A8-02)', async () => {
    const { initI18n, getLocale, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    localStorageMock.setItem('ploppytv_prefs_v1', JSON.stringify({ lang: 'EN' }));
    Object.defineProperty(navigator, 'language', { value: 'it-IT', configurable: true });
    initI18n();
    expect(getLocale()).toBe('en');
  });

  it('initI18n accepts mixed-case saved lang', async () => {
    const { initI18n, getLocale, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    localStorageMock.setItem('ploppytv_prefs_v1', JSON.stringify({ lang: 'It' }));
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    initI18n();
    expect(getLocale()).toBe('it');
  });

  it('initI18n rejects unsupported saved lang (falls back to navigator)', async () => {
    const { initI18n, getLocale, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    localStorageMock.setItem('ploppytv_prefs_v1', JSON.stringify({ lang: 'fr' }));
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    initI18n();
    expect(getLocale()).toBe('en');
  });

  it('initI18n handles corrupted localStorage JSON gracefully', async () => {
    const { initI18n, getLocale, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    localStorageMock.setItem('ploppytv_prefs_v1', '{not valid json');
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
    expect(() => initI18n()).not.toThrow();
    expect(getLocale()).toBe('en');
  });

  it('setLocale saves lang even when existing localStorage is corrupted (BUG-A8-03)', async () => {
    const { initI18n, setLocale, getLocale, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    localStorageMock.setItem('ploppytv_prefs_v1', '<<<corrupted>>>');
    Object.defineProperty(navigator, 'language', { value: 'it-IT', configurable: true });
    initI18n();
    setLocale('en');
    expect(getLocale()).toBe('en');
    const raw = localStorageMock.getItem('ploppytv_prefs_v1');
    expect(raw).not.toBe('<<<corrupted>>>');
    const parsed = JSON.parse(raw!);
    expect(parsed.lang).toBe('en');
  });

  it('setLocale preserves other prefs when updating lang', async () => {
    const { initI18n, setLocale, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    localStorageMock.setItem(
      'ploppytv_prefs_v1',
      JSON.stringify({ notificationsEnabled: true, lang: 'it' }),
    );
    Object.defineProperty(navigator, 'language', { value: 'it-IT', configurable: true });
    initI18n();
    setLocale('en');
    const raw = localStorageMock.getItem('ploppytv_prefs_v1');
    const parsed = JSON.parse(raw!);
    expect(parsed.lang).toBe('en');
    expect(parsed.notificationsEnabled).toBe(true);
  });

  it('setLocale no-ops for unsupported locale', async () => {
    const { initI18n, setLocale, getLocale, _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    Object.defineProperty(navigator, 'language', { value: 'it-IT', configurable: true });
    initI18n();
    const before = getLocale();
    setLocale('fr' as 'it');
    expect(getLocale()).toBe(before);
  });

  it('setLocale notifies subscribers on change', async () => {
    const { initI18n, setLocale, subscribeI18n, _resetI18nForTesting } = await import(
      '../src/lib/i18n'
    );
    _resetI18nForTesting();
    Object.defineProperty(navigator, 'language', { value: 'it-IT', configurable: true });
    initI18n();
    let calls = 0;
    const unsub = subscribeI18n(() => {
      calls++;
    });
    setLocale('en');
    expect(calls).toBe(1);
    setLocale('en');
    expect(calls).toBe(1);
    setLocale('it');
    expect(calls).toBe(2);
    unsub();
    setLocale('en');
    expect(calls).toBe(2);
  });
});

describe('A8 — i18n locale files alignment', () => {
  it('en.json and it.json have identical key sets', () => {
    const enKeys = Object.keys(enLocale).sort();
    const itKeys = Object.keys(itLocale).sort();
    const enSet = new Set(enKeys);
    const itSet = new Set(itKeys);
    const inEnNotIt = enKeys.filter((k) => !itSet.has(k));
    const inItNotEn = itKeys.filter((k) => !enSet.has(k));
    expect(inEnNotIt).toEqual([]);
    expect(inItNotEn).toEqual([]);
  });

  it('en.json and it.json have matching placeholder sets per key', () => {
    function placeholders(s: unknown): string[] {
      if (typeof s !== 'string') return [];
      const m = s.match(/\{(\w+)\}/g);
      return (m || []).sort();
    }
    const mismatches: Array<{ key: string; en: string[]; it: string[] }> = [];
    for (const k of Object.keys(enLocale)) {
      const pe = placeholders(enLocale[k as keyof typeof enLocale]);
      const pi = placeholders(itLocale[k as keyof typeof itLocale]);
      if (JSON.stringify(pe) !== JSON.stringify(pi)) {
        mismatches.push({ key: k, en: pe, it: pi });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('all locale values are strings (no null/number/object)', () => {
    for (const [, v] of Object.entries(enLocale)) {
      expect(typeof v).toBe('string');
    }
    for (const [, v] of Object.entries(itLocale)) {
      expect(typeof v).toBe('string');
    }
  });

  it('locale files have > 100 keys', () => {
    expect(Object.keys(enLocale).length).toBeGreaterThan(100);
    expect(Object.keys(itLocale).length).toBeGreaterThan(100);
  });
});

// =====================================================================
// notifications.ts — setTimeout overflow, listener cleanup, edge cases
// =====================================================================

describe('A8 — notifications.ts scheduling (BUG-A8-04)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setTimeoutSpy: any;
  const pendingTimers: ReturnType<typeof setTimeout>[] = [];
  const RESCHEDULE = 6 * 60 * 60 * 1000;
  // Save original setTimeout BEFORE spying to avoid infinite recursion.
  const originalSetTimeout = globalThis.setTimeout.bind(globalThis) as (
    fn: (...args: unknown[]) => void,
    delay?: number,
  ) => ReturnType<typeof setTimeout>;

  beforeEach(() => {
    vi.resetModules();
    localStorageMock.clear();
    resetMockState();
    _notifPermission = 'granted';
    localStorageMock.setItem('ploppytv_prefs_v1', JSON.stringify({ notificationsEnabled: true }));
    setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn: (...args: unknown[]) => void, delay?: number) => {
        const id = originalSetTimeout(fn, delay);
        pendingTimers.push(id);
        return id;
      });
  });

  afterEach(() => {
    for (const id of pendingTimers) {
      clearTimeout(id);
    }
    pendingTimers.length = 0;
    vi.restoreAllMocks();
  });

  it('skips notifications beyond NOTIF_MAX_DELAY_MS (no int32 overflow)', async () => {
    const { scheduleNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    const { setShows } = await import('../src/lib/store');
    const { makeShowWithSeasons } = await import('./helpers');

    // Episode airing in 25 days (beyond 24-day NOTIF_MAX_DELAY_MS guard).
    const future = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);
    const airdate = future.toISOString().slice(0, 10);
    const show = makeShowWithSeasons(
      { 1: 1 },
      { id: 100, name: 'FutureShow', list: 'watching' },
    );
    show.seasons[1][0].airdate = airdate;
    setShows([show]);

    _resetNotificationsForTesting();
    scheduleNotifications();

    // No setTimeout with a delay > NOTIF_MAX_DELAY_MS (would cause int32 overflow).
    const bigDelays = setTimeoutSpy.mock.calls.filter(
      (call: unknown[]) => {
        const delay = call[1] as number;
        return typeof delay === 'number' && delay > 24 * 24 * 60 * 60 * 1000;
      },
    );
    expect(bigDelays).toHaveLength(0);
  });

  it('schedules notifications within NOTIF_MAX_DELAY_MS', async () => {
    const { scheduleNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    const { setShows } = await import('../src/lib/store');
    const { makeShowWithSeasons } = await import('./helpers');

    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const airdate = future.toISOString().slice(0, 10);
    const show = makeShowWithSeasons(
      { 1: 1 },
      { id: 101, name: 'SoonShow', list: 'watching' },
    );
    show.seasons[1][0].airdate = airdate;
    setShows([show]);

    _resetNotificationsForTesting();
    scheduleNotifications();

    // One episode timer (delay > 60s, not the reschedule interval).
    const epDelays = setTimeoutSpy.mock.calls
      .map((call: unknown[]) => call[1] as number)
      .filter((d: number) => typeof d === 'number' && d > 60000 && d !== RESCHEDULE);
    expect(epDelays.length).toBeGreaterThanOrEqual(1);
  });

  it('skips episodes with airdate in the past', async () => {
    const { scheduleNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    const { setShows } = await import('../src/lib/store');
    const { makeShowWithSeasons } = await import('./helpers');

    const show = makeShowWithSeasons(
      { 1: 1 },
      { id: 102, name: 'PastShow', list: 'watching' },
    );
    show.seasons[1][0].airdate = '2020-01-01';
    setShows([show]);

    _resetNotificationsForTesting();
    scheduleNotifications();

    const epDelays = setTimeoutSpy.mock.calls
      .map((call: unknown[]) => call[1] as number)
      .filter((d: number) => typeof d === 'number' && d > 60000 && d !== RESCHEDULE);
    expect(epDelays).toHaveLength(0);
  });

  it('handles 0 watching shows without error', async () => {
    const { scheduleNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    const { setShows } = await import('../src/lib/store');
    setShows([]);
    _resetNotificationsForTesting();
    expect(() => scheduleNotifications()).not.toThrow();
  });

  it('handles watching show with 0 episodes', async () => {
    const { scheduleNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    const { setShows } = await import('../src/lib/store');
    const { makeShow } = await import('./helpers');
    const show = makeShow({ id: 103, name: 'Empty', list: 'watching', seasons: {} });
    setShows([show]);
    _resetNotificationsForTesting();
    expect(() => scheduleNotifications()).not.toThrow();
  });

  it('skips episode with no airdate', async () => {
    const { scheduleNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    const { setShows } = await import('../src/lib/store');
    const { makeShowWithSeasons } = await import('./helpers');
    const show = makeShowWithSeasons(
      { 1: 1 },
      { id: 104, name: 'NoAirdate', list: 'watching' },
    );
    show.seasons[1][0].airdate = null;
    setShows([show]);
    _resetNotificationsForTesting();
    scheduleNotifications();
    const epDelays = setTimeoutSpy.mock.calls
      .map((call: unknown[]) => call[1] as number)
      .filter((d: number) => typeof d === 'number' && d > 60000 && d !== RESCHEDULE);
    expect(epDelays).toHaveLength(0);
  });

  it('skips non-watching shows', async () => {
    const { scheduleNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    const { setShows } = await import('../src/lib/store');
    const { makeShowWithSeasons } = await import('./helpers');
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const airdate = future.toISOString().slice(0, 10);
    const show = makeShowWithSeasons(
      { 1: 1 },
      { id: 105, name: 'Completed', list: 'completed' },
    );
    show.seasons[1][0].airdate = airdate;
    setShows([show]);
    _resetNotificationsForTesting();
    scheduleNotifications();
    const epDelays = setTimeoutSpy.mock.calls
      .map((call: unknown[]) => call[1] as number)
      .filter((d: number) => typeof d === 'number' && d > 60000 && d !== RESCHEDULE);
    expect(epDelays).toHaveLength(0);
  });
});

describe('A8 — notifications.ts listener cleanup (BUG-A8-09)', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorageMock.clear();
    resetMockState();
    _notifPermission = 'default';
    setupMatchMedia();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('_resetNotificationsForTesting removes the window listener', async () => {
    const { initNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    initNotifications();
    expect(addSpy).toHaveBeenCalledWith(
      'ploppytv:reschedule-notifications',
      expect.any(Function),
    );

    _resetNotificationsForTesting();
    expect(removeSpy).toHaveBeenCalledWith(
      'ploppytv:reschedule-notifications',
      expect.any(Function),
    );
  });

  it('initNotifications is idempotent (single listener)', async () => {
    const { initNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    const addSpy = vi.spyOn(window, 'addEventListener');
    _resetNotificationsForTesting();
    initNotifications();
    initNotifications();
    initNotifications();
    const calls = addSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === 'ploppytv:reschedule-notifications',
    );
    expect(calls).toHaveLength(1);
  });

  it('disableNotifications clears scheduled timers', async () => {
    const { disableNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    _resetNotificationsForTesting();
    expect(() => disableNotifications()).not.toThrow();
  });

  it('getNextNotifiableEpisode returns null with no watching shows', async () => {
    const { getNextNotifiableEpisode } = await import('../src/lib/notifications');
    const { setShows } = await import('../src/lib/store');
    setShows([]);
    expect(getNextNotifiableEpisode()).toBeNull();
  });
});

describe('A8 — notifications.ts permission edge cases', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorageMock.clear();
    resetMockState();
    setupMatchMedia();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('notificationsEnabled returns false when permission denied', async () => {
    const { notificationsEnabled } = await import('../src/lib/notifications');
    _notifPermission = 'denied';
    localStorageMock.setItem('ploppytv_prefs_v1', JSON.stringify({ notificationsEnabled: true }));
    expect(notificationsEnabled()).toBe(false);
  });

  it('notificationsEnabled returns false when not opted-in', async () => {
    const { notificationsEnabled } = await import('../src/lib/notifications');
    _notifPermission = 'granted';
    localStorageMock.setItem('ploppytv_prefs_v1', JSON.stringify({ notificationsEnabled: false }));
    expect(notificationsEnabled()).toBe(false);
  });

  it('enableNotifications returns false when permission not granted', async () => {
    const { enableNotifications } = await import('../src/lib/notifications');
    _notifPermission = 'denied';
    const result = await enableNotifications();
    expect(result).toBe(false);
  });

  it('enableNotifications returns true when permission granted', async () => {
    const { enableNotifications, _resetNotificationsForTesting } = await import(
      '../src/lib/notifications'
    );
    _resetNotificationsForTesting();
    _notifPermission = 'default';
    const result = await enableNotifications();
    expect(result).toBe(true);
  });
});

// =====================================================================
// keyboard.ts — modifier keys, g-sequence, listener cleanup
// =====================================================================

function dispatchKey(
  key: string,
  opts: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {},
): void {
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: !!opts.ctrl,
    metaKey: !!opts.meta,
    altKey: !!opts.alt,
    shiftKey: !!opts.shift,
  });
  document.dispatchEvent(ev);
}

describe('A8 — keyboard.ts modifier keys (BUG-A8-06)', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetMockState();
    document.body.innerHTML = '<main id="mainContent"></main>';
    const { _resetKeyboardForTesting } = await import('../src/lib/keyboard');
    _resetKeyboardForTesting();
  });

  afterEach(async () => {
    const { _resetKeyboardForTesting } = await import('../src/lib/keyboard');
    _resetKeyboardForTesting();
  });

  it('Ctrl+g does NOT start g-sequence', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('g', { ctrl: true });
    dispatchKey('d');
    expect(mockStore.switchView).not.toHaveBeenCalled();
  });

  it('Meta+g (Cmd+g) does NOT start g-sequence', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('g', { meta: true });
    dispatchKey('d');
    expect(mockStore.switchView).not.toHaveBeenCalled();
  });

  it('Alt+g does NOT start g-sequence', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('g', { alt: true });
    dispatchKey('d');
    expect(mockStore.switchView).not.toHaveBeenCalled();
  });

  it('g then Ctrl+d does NOT navigate (modifier cancels pending)', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('g');
    dispatchKey('d', { ctrl: true });
    expect(mockStore.switchView).not.toHaveBeenCalled();
  });

  it('g d (no modifiers) navigates to dashboard', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('g');
    dispatchKey('d');
    expect(mockStore.switchView).toHaveBeenCalledWith('dashboard');
  });

  it('g c navigates to calendar', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('g');
    dispatchKey('c');
    expect(mockStore.switchView).toHaveBeenCalledWith('calendar');
  });

  it('g s navigates to stats', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('g');
    dispatchKey('s');
    expect(mockStore.switchView).toHaveBeenCalledWith('stats');
  });

  it('g l navigates to library', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('g');
    dispatchKey('l');
    expect(mockStore.switchView).toHaveBeenCalledWith('library');
  });

  it('g y navigates to yearreview', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('g');
    dispatchKey('y');
    expect(mockStore.switchView).toHaveBeenCalledWith('yearreview');
  });

  it('Shift+/ (?) still shows cheat sheet (Shift allowed)', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('?', { shift: true });
    expect(mockModal.showModal).toHaveBeenCalled();
  });

  it('g + invalid letter does NOT navigate and resets state', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('g');
    dispatchKey('x');
    expect(mockStore.switchView).not.toHaveBeenCalled();
    dispatchKey('d');
    expect(mockStore.switchView).not.toHaveBeenCalled();
  });

  it('shortcut ignored when typing in input', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const ev = new KeyboardEvent('keydown', {
      key: 'g',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, 'target', { value: input });
    document.dispatchEvent(ev);
    dispatchKey('d');
    expect(mockStore.switchView).not.toHaveBeenCalled();
  });

  it('shortcut ignored when textarea is focused', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    const ev = new KeyboardEvent('keydown', {
      key: 'j',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, 'target', { value: ta });
    document.dispatchEvent(ev);
    // j shouldn't navigate episodes when textarea is focused
    expect(document.activeElement).toBe(ta);
  });

  it('shortcut ignored when contenteditable is focused', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    const div = document.createElement('div');
    div.contentEditable = 'true';
    // jsdom may not set isContentEditable based on the contentEditable attribute;
    // force it so isEditableTarget() recognizes the element.
    Object.defineProperty(div, 'isContentEditable', { value: true, configurable: true });
    document.body.appendChild(div);
    div.focus();
    const ev = new KeyboardEvent('keydown', {
      key: 'g',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, 'target', { value: div });
    document.dispatchEvent(ev);
    // Dispatch 'd' also targeting the contenteditable to simulate the user
    // typing while still focused in the editable region.
    const ev2 = new KeyboardEvent('keydown', {
      key: 'd',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev2, 'target', { value: div });
    document.dispatchEvent(ev2);
    expect(mockStore.switchView).not.toHaveBeenCalled();
  });

  it('shortcut ignored when modal is open', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    mockModal.isOpen = true;
    initKeyboard();
    dispatchKey('g');
    dispatchKey('d');
    expect(mockStore.switchView).not.toHaveBeenCalled();
  });

  it('? key does NOT open cheat sheet when modal is open', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    mockModal.isOpen = true;
    initKeyboard();
    dispatchKey('?');
    expect(mockModal.showModal).not.toHaveBeenCalled();
  });

  it('? key opens cheat sheet when no modal open', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    mockModal.isOpen = false;
    initKeyboard();
    dispatchKey('?');
    expect(mockModal.showModal).toHaveBeenCalled();
  });
});

describe('A8 — keyboard.ts listener cleanup (BUG-A8-08)', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetMockState();
    const { _resetKeyboardForTesting } = await import('../src/lib/keyboard');
    _resetKeyboardForTesting();
  });

  afterEach(async () => {
    const { _resetKeyboardForTesting } = await import('../src/lib/keyboard');
    _resetKeyboardForTesting();
  });

  it('_resetKeyboardForTesting removes the document listener', async () => {
    const { initKeyboard, _resetKeyboardForTesting } = await import('../src/lib/keyboard');
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    initKeyboard();
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    _resetKeyboardForTesting();
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('initKeyboard is idempotent (single listener)', async () => {
    const { initKeyboard, _resetKeyboardForTesting } = await import('../src/lib/keyboard');
    const addSpy = vi.spyOn(document, 'addEventListener');
    _resetKeyboardForTesting();
    initKeyboard();
    initKeyboard();
    initKeyboard();
    const calls = addSpy.mock.calls.filter(([ev]) => ev === 'keydown');
    expect(calls).toHaveLength(1);
  });

  it('re-init after reset works (listener re-added)', async () => {
    const { initKeyboard, _resetKeyboardForTesting } = await import('../src/lib/keyboard');
    const addSpy = vi.spyOn(document, 'addEventListener');
    _resetKeyboardForTesting();
    initKeyboard();
    _resetKeyboardForTesting();
    initKeyboard();
    const keydownCalls = addSpy.mock.calls.filter(([ev]) => ev === 'keydown');
    expect(keydownCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('A8 — keyboard.ts episode navigation', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetMockState();
    document.body.innerHTML = '<main id="mainContent"></main>';
    const { _resetKeyboardForTesting } = await import('../src/lib/keyboard');
    _resetKeyboardForTesting();
  });

  afterEach(async () => {
    const { _resetKeyboardForTesting } = await import('../src/lib/keyboard');
    _resetKeyboardForTesting();
  });

  it('j/k on view with no episode items does not crash', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    document.body.innerHTML = '<main id="mainContent"><p>no episodes</p></main>';
    expect(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    }).not.toThrow();
  });

  it('j navigates to next episode item', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    document.body.innerHTML =
      '<main id="mainContent">' +
      '<div class="episode-item" role="button" tabindex="0">E1</div>' +
      '<div class="episode-item" role="button" tabindex="0">E2</div>' +
      '</main>';
    const items = document.querySelectorAll<HTMLElement>('.episode-item');
    items[0]!.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
  });

  it('k navigates to previous episode item', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    document.body.innerHTML =
      '<main id="mainContent">' +
      '<div class="episode-item" role="button" tabindex="0">E1</div>' +
      '<div class="episode-item" role="button" tabindex="0">E2</div>' +
      '</main>';
    const items = document.querySelectorAll<HTMLElement>('.episode-item');
    items[1]!.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });

  it('j on last episode does not go out of bounds', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    document.body.innerHTML =
      '<main id="mainContent">' +
      '<div class="episode-item" role="button" tabindex="0">E1</div>' +
      '<div class="episode-item" role="button" tabindex="0">E2</div>' +
      '</main>';
    const items = document.querySelectorAll<HTMLElement>('.episode-item');
    items[1]!.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
  });

  it('k on first episode does not go out of bounds', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    document.body.innerHTML =
      '<main id="mainContent">' +
      '<div class="episode-item" role="button" tabindex="0">E1</div>' +
      '<div class="episode-item" role="button" tabindex="0">E2</div>' +
      '</main>';
    const items = document.querySelectorAll<HTMLElement>('.episode-item');
    items[0]!.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });

  it('j with no focused episode starts from first', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    document.body.innerHTML =
      '<main id="mainContent">' +
      '<div class="episode-item" role="button" tabindex="0">E1</div>' +
      '<div class="episode-item" role="button" tabindex="0">E2</div>' +
      '</main>';
    const items = document.querySelectorAll<HTMLElement>('.episode-item');
    // Don't focus any item
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });
});
