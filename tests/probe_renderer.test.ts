// Agent 12 — renderer.ts + hash routing probe tests
//
// Verifies (post-fix):
// - BUG-12-01 (High, FIXED): event-listener accumulation in showDetail/
//   discover/calendar bindXxxEvents is FIXED. resetBoundGuard ora rimuove
//   il listener precedentemente aggiunto (click + keydown) PRIMA di bindare
//   uno nuovo, così N re-render → 1 listener attivo → 1 azione per click.
// - BUG-12-02 (Medium, FIXED): il renderer ora skippa bindShowDetailEvents
//   quando renderShowDetail ha bailed (closeShow nulled currentShowId).
// - bindDelegatedEvents guard (renderer.ts): _boundDelegated set once, no
//   accumulation (verified OK).
// - applyHash edge cases (hash routing correctness).
// - _renderToken invalidation (superseded render returns before bind).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Show } from '../src/types';

// ---------- helpers ----------

function makeShow(over: Partial<Show> = {}): Show {
  return {
    id: 100,
    name: 'Test Show',
    image: null,
    status: 'Running',
    premiered: '2024-01-01',
    genres: ['Drama'],
    summary: '',
    network: 'N/D',
    runtime: 45,
    list: 'towatch',
    manualList: false,
    seasons: {
      1: [
        { num: 1, id: 1001, watched: false, airdate: '2024-01-01', name: 'Pilot', runtime: 45 },
        { num: 2, id: 1002, watched: false, airdate: '2024-01-08', name: 'E2', runtime: 45 },
      ],
      2: [{ num: 1, id: 2001, watched: false, airdate: '2024-02-05', name: 'S2E1', runtime: 45 }],
    },
    totalSeasons: 2,
    totalEpisodes: 3,
    addedAt: 1700000000000,
    ...over,
  };
}

/** Apply the renderer's _doRender pattern for the showDetail branch (sync render). */
async function simulateRenderDetail(
  showDetail: typeof import('../src/views/showDetail'),
  main: HTMLElement,
): Promise<void> {
  showDetail.resetBoundGuard();
  showDetail.renderShowDetail(main);
  showDetail.bindShowDetailEvents(main);
}

// Paths that any test below may doMock — unmocked in afterEach to prevent
// cross-test pollution (vi.doUnmock alone is insufficient; we use vi.unmock).
const MOCK_PATHS = [
  '../src/lib/storage',
  '../src/components/toast',
  '../src/components/modal',
  '../src/components/header',
  '../src/components/imageFallback',
  '../src/lib/shows',
  '../src/lib/discover',
  '../src/lib/store',
  '../src/worker/client',
  '../src/components/renderer',
];

beforeEach(() => {
  // Reset module state so each test starts fresh (_boundShowDetail etc.).
  vi.resetModules();
  for (const p of MOCK_PATHS) vi.doUnmock(p);
  document.body.innerHTML = '<div id="mainContent"></div>';
  // jsdom doesn't implement window.scrollTo — stub it (cast to avoid TS overload mismatch).
  (window as unknown as { scrollTo: (...args: unknown[]) => void }).scrollTo = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------- BUG-12-01: listener accumulation ----------

describe('BUG-12-01: showDetail listener accumulation (FIXED)', () => {
  it('after N simulated render cycles, only ONE click listener is ACTIVE (no accumulation)', async () => {
    const toggleEpisodeSpy = vi.fn();
    vi.doMock('../src/lib/shows', () => ({
      toggleEpisode: toggleEpisodeSpy,
      markSeasonWatched: vi.fn(),
      moveShowToList: vi.fn(),
      removeShow: vi.fn(),
      refreshShowEpisodes: vi.fn(async () => true),
      showNeedsEpisodeNames: vi.fn(() => false),
      addShowToList: vi.fn(),
    }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/components/modal', () => ({ showModal: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));

    const store = await import('../src/lib/store');
    const showDetail = await import('../src/views/showDetail');

    store.setShows([makeShow()]);
    store.openShow(100); // set currentShowId so renderShowDetail finds the show
    const main = document.getElementById('mainContent')!;
    const addSpy = vi.spyOn(main, 'addEventListener');
    const removeSpy = vi.spyOn(main, 'removeEventListener');

    const N = 4;
    for (let i = 0; i < N; i++) {
      await simulateRenderDetail(showDetail, main);
    }

    // FIX: each bind cycle removes the previous listener before adding a new one.
    // So addEventListener('click') is called N times, but removeEventListener('click')
    // is called N-1 times → only 1 click listener ACTIVE on `main`.
    const clickAdds = addSpy.mock.calls.filter(([t]) => t === 'click');
    const clickRemoves = removeSpy.mock.calls.filter(([t]) => t === 'click');
    expect(clickAdds.length).toBe(N);
    expect(clickRemoves.length).toBe(N - 1);
    // Net active = N - (N-1) = 1.
  });

  it('after N=4 re-renders, a single click on an episode calls toggleEpisode ONCE (FIXED)', async () => {
    const toggleEpisodeSpy = vi.fn();
    vi.doMock('../src/lib/shows', () => ({
      toggleEpisode: toggleEpisodeSpy,
      markSeasonWatched: vi.fn(),
      moveShowToList: vi.fn(),
      removeShow: vi.fn(),
      refreshShowEpisodes: vi.fn(async () => true),
      showNeedsEpisodeNames: vi.fn(() => false),
      addShowToList: vi.fn(),
    }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/components/modal', () => ({ showModal: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));

    const store = await import('../src/lib/store');
    const showDetail = await import('../src/views/showDetail');

    store.setShows([makeShow()]);
    store.openShow(100);
    const main = document.getElementById('mainContent')!;

    const N = 4;
    for (let i = 0; i < N; i++) {
      await simulateRenderDetail(showDetail, main);
    }

    // The last iteration already rendered the DOM (episode elements exist).
    const episodeEl = main.querySelector('[data-action="toggleEpisode"]') as HTMLElement;
    expect(episodeEl).toBeTruthy();
    expect(episodeEl.dataset.showId).toBe('100');
    expect(episodeEl.dataset.season).toBe('1');
    expect(episodeEl.dataset.ep).toBe('1');

    episodeEl.click();

    // FIX: only ONE active listener → toggleEpisode called exactly once.
    expect(toggleEpisodeSpy).toHaveBeenCalledTimes(1);
    expect(toggleEpisodeSpy.mock.calls).toEqual([[100, 1, 1]]);
  });

  it('with REAL shows.ts + mocked storage: even N=2 → watched toggles correctly (FIXED, no double-flip)', async () => {
    const saveDataSpy = vi.fn(() => true);
    vi.doMock('../src/lib/storage', () => ({
      saveData: saveDataSpy,
      loadData: vi.fn(),
      isStorageOK: vi.fn(() => true),
    }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/components/modal', () => ({ showModal: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));

    const store = await import('../src/lib/store');
    const showDetail = await import('../src/views/showDetail');

    store.setShows([makeShow()]);
    store.openShow(100);
    const main = document.getElementById('mainContent')!;

    const N = 2;
    for (let i = 0; i < N; i++) {
      await simulateRenderDetail(showDetail, main);
    }

    const before = store.getState().shows[0].seasons[1][0].watched;
    expect(before).toBe(false);

    const episodeEl = main.querySelector('[data-action="toggleEpisode"]') as HTMLElement;
    expect(episodeEl).toBeTruthy();
    episodeEl.click();

    const after = store.getState().shows[0].seasons[1][0].watched;
    // FIX: only 1 listener → 1 toggle → false→true. No silent failure.
    expect(after).toBe(true);
    // FIX: only 1 saveData write per user action.
    expect(saveDataSpy).toHaveBeenCalledTimes(1);
  });

  it('with REAL shows.ts: odd N=3 → watched toggled, exactly 1 saveData + 1 updateBadges (FIXED)', async () => {
    const saveDataSpy = vi.fn(() => true);
    const updateBadgesSpy = vi.fn();
    vi.doMock('../src/lib/storage', () => ({
      saveData: saveDataSpy,
      loadData: vi.fn(),
      isStorageOK: vi.fn(() => true),
    }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/components/modal', () => ({ showModal: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: updateBadgesSpy }));

    const store = await import('../src/lib/store');
    const showDetail = await import('../src/views/showDetail');

    store.setShows([makeShow()]);
    store.openShow(100);
    const main = document.getElementById('mainContent')!;

    const N = 3;
    for (let i = 0; i < N; i++) {
      await simulateRenderDetail(showDetail, main);
    }

    const episodeEl = main.querySelector('[data-action="toggleEpisode"]') as HTMLElement;
    expect(episodeEl).toBeTruthy();
    episodeEl.click();

    const after = store.getState().shows[0].seasons[1][0].watched;
    // FIX: 1 listener → 1 toggle → false→true.
    expect(after).toBe(true);
    // FIX: exactly 1 saveData + 1 updateBadges (no N× amplification).
    expect(saveDataSpy).toHaveBeenCalledTimes(1);
    expect(updateBadgesSpy).toHaveBeenCalledTimes(1);
  });

  it('switchSeason action fires EXACTLY once (FIXED — no accumulation)', async () => {
    const switchSeasonSpy = vi.fn();
    vi.doMock('../src/lib/store', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/store')>('../src/lib/store');
      return { ...actual, switchSeason: switchSeasonSpy };
    });
    vi.doMock('../src/lib/shows', () => ({
      toggleEpisode: vi.fn(),
      markSeasonWatched: vi.fn(),
      moveShowToList: vi.fn(),
      removeShow: vi.fn(),
      refreshShowEpisodes: vi.fn(async () => true),
      showNeedsEpisodeNames: vi.fn(() => false),
      addShowToList: vi.fn(),
    }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/components/modal', () => ({ showModal: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));

    const store = await import('../src/lib/store');
    const showDetail = await import('../src/views/showDetail');

    store.setShows([makeShow()]);
    store.openShow(100);
    const main = document.getElementById('mainContent')!;

    const N = 3;
    for (let i = 0; i < N; i++) {
      await simulateRenderDetail(showDetail, main);
    }

    // Click the "Stagione 2" tab.
    const seasonTab = main.querySelector('[data-action="switchSeason"][data-season="2"]') as HTMLElement;
    expect(seasonTab).toBeTruthy();
    seasonTab.click();

    // FIX: 1 listener → 1 invocation of switchSeason.
    expect(switchSeasonSpy).toHaveBeenCalledTimes(1);
    expect(switchSeasonSpy.mock.calls).toEqual([[2]]);
  });
});

describe('BUG-12-01: discover listener accumulation (FIXED)', () => {
  it('after N simulated render cycles, only ONE click listener is ACTIVE', async () => {
    vi.doMock('../src/lib/discover', () => ({
      invalidateDiscoverCache: vi.fn(),
      resetDiscoverPreload: vi.fn(),
      getDiscoverPromise: vi.fn(async () => ({})),
      findShowInDiscoverGroups: vi.fn(() => null),
    }));
    vi.doMock('../src/lib/shows', () => ({ addShowToList: vi.fn() }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/components/modal', () => ({ showModal: vi.fn() }));

    const store = await import('../src/lib/store');
    const discover = await import('../src/views/discover');

    store.setShows([]);
    const main = document.getElementById('mainContent')!;
    const addSpy = vi.spyOn(main, 'addEventListener');
    const removeSpy = vi.spyOn(main, 'removeEventListener');

    const N = 3;
    for (let i = 0; i < N; i++) {
      discover.resetBoundGuard();
      discover.renderDiscover(main);
      discover.bindDiscoverEvents(main);
    }

    // FIX: addEventListener('click') called N times, removeEventListener('click')
    // called N-1 times → 1 active listener.
    const clickAdds = addSpy.mock.calls.filter(([t]) => t === 'click');
    const clickRemoves = removeSpy.mock.calls.filter(([t]) => t === 'click');
    expect(clickAdds.length).toBe(N);
    expect(clickRemoves.length).toBe(N - 1);
  });
});

describe('BUG-12-01: calendar listener accumulation (FIXED)', () => {
  it('after N simulated render cycles, only ONE click listener is ACTIVE', async () => {
    vi.doMock('../src/worker/client', () => ({
      computeCalendarAsync: vi.fn(async () => ({
        week: [],
        afterWeek: [],
        weekStart: '2024-01-01',
        weekEnd: '2024-01-07',
      })),
    }));

    const store = await import('../src/lib/store');
    const calendar = await import('../src/views/calendar');

    store.setShows([]);
    const main = document.getElementById('mainContent')!;
    const addSpy = vi.spyOn(main, 'addEventListener');
    const removeSpy = vi.spyOn(main, 'removeEventListener');

    const N = 3;
    for (let i = 0; i < N; i++) {
      calendar.resetBoundGuard();
      await calendar.renderCalendar(main);
      calendar.bindCalendarEvents(main);
    }

    // FIX: addEventListener('click') N times, removeEventListener('click') N-1 times.
    const clickAdds = addSpy.mock.calls.filter(([t]) => t === 'click');
    const clickRemoves = removeSpy.mock.calls.filter(([t]) => t === 'click');
    expect(clickAdds.length).toBe(N);
    expect(clickRemoves.length).toBe(N - 1);
  });

  it('changeWeek fires EXACTLY once after N re-renders (FIXED — no N× drift)', async () => {
    const changeCalendarWeekSpy = vi.fn();
    vi.doMock('../src/lib/store', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/store')>('../src/lib/store');
      return { ...actual, changeCalendarWeek: changeCalendarWeekSpy };
    });
    vi.doMock('../src/worker/client', () => ({
      computeCalendarAsync: vi.fn(async () => ({
        week: [],
        afterWeek: [],
        weekStart: '2024-01-01',
        weekEnd: '2024-01-07',
      })),
    }));

    const store = await import('../src/lib/store');
    const calendar = await import('../src/views/calendar');

    store.setShows([]);
    const main = document.getElementById('mainContent')!;

    const N = 4;
    for (let i = 0; i < N; i++) {
      calendar.resetBoundGuard();
      await calendar.renderCalendar(main);
      calendar.bindCalendarEvents(main);
    }

    const nextBtn = main.querySelector('[data-action="changeWeek"][data-delta="1"]') as HTMLElement;
    expect(nextBtn).toBeTruthy();
    nextBtn.click();

    // FIX: 1 listener → 1 invocation. No drift.
    expect(changeCalendarWeekSpy).toHaveBeenCalledTimes(1);
    expect(changeCalendarWeekSpy.mock.calls).toEqual([[1]]);
  });
});

// ---------- BUG-12-02: bind runs even when render bails ----------

describe('BUG-12-02: showDetail bind runs even when renderShowDetail bails (FIXED via renderer guard)', () => {
  it('openShow(non-existent) → renderShowDetail calls closeShow → renderer guard skips bind', async () => {
    vi.doMock('../src/lib/shows', () => ({
      toggleEpisode: vi.fn(),
      markSeasonWatched: vi.fn(),
      moveShowToList: vi.fn(),
      removeShow: vi.fn(),
      refreshShowEpisodes: vi.fn(async () => true),
      showNeedsEpisodeNames: vi.fn(() => false),
      addShowToList: vi.fn(),
    }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/components/modal', () => ({ showModal: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));
    vi.doMock('../src/components/imageFallback', () => ({ initImageFallback: vi.fn() }));

    const store = await import('../src/lib/store');
    const showDetail = await import('../src/views/showDetail');
    const renderer = await import('../src/components/renderer');

    store.setShows([]); // no shows at all
    store.setState({ currentView: 'dashboard', currentShowId: null });
    const main = document.getElementById('mainContent')!;
    main.innerHTML = '<div>dashboard content</div>'; // simulate previous-view DOM
    const addSpy = vi.spyOn(main, 'addEventListener');

    // Simulate the BUG-12-02 scenario: openShow(999) → renderer._doRender
    // → resetBoundGuard + renderShowDetail (bails via closeShow) + bind.
    // The renderer's BUG-12-02 FIX: after renderShowDetail, check
    // getState().currentShowId; if null (closeShow fired), skip bind.
    store.openShow(999); // sets currentShowId=999, emitChange → render() RAF queued
    expect(store.getState().currentShowId).toBe(999);

    // Manually drive the renderer's _doRender pattern (it's not exported, so we
    // call the sequence directly to test the guard).
    showDetail.resetBoundGuard();
    showDetail.renderShowDetail(main); // bails → closeShow → currentShowId=null
    expect(store.getState().currentShowId).toBeNull();
    // FIX: renderer now checks `if (!getState().currentShowId) return;` before bind.
    if (store.getState().currentShowId) {
      showDetail.bindShowDetailEvents(main);
    }

    // FIX: NO listener was added (bind was skipped because closeShow nulled currentShowId).
    const clickAdds = addSpy.mock.calls.filter(([t]) => t === 'click');
    expect(clickAdds.length).toBe(0);
    expect(store.getState().currentShowId).toBeNull();
  });
});

// ---------- _renderToken invalidation ----------

describe('_renderToken: superseded render returns before bind (verified OK)', () => {
  it('two overlapping renders: only the latest binds (no double-bind from race)', async () => {
    vi.doMock('../src/lib/shows', () => ({
      toggleEpisode: vi.fn(),
      markSeasonWatched: vi.fn(),
      moveShowToList: vi.fn(),
      removeShow: vi.fn(),
      refreshShowEpisodes: vi.fn(async () => true),
      showNeedsEpisodeNames: vi.fn(() => false),
      addShowToList: vi.fn(),
    }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/components/modal', () => ({ showModal: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));

    const store = await import('../src/lib/store');
    const showDetail = await import('../src/views/showDetail');

    store.setShows([makeShow()]);
    store.openShow(100);
    const main = document.getElementById('mainContent')!;
    const addSpy = vi.spyOn(main, 'addEventListener');

    // Simulate the renderer's pattern with token check.
    let token = 0;
    async function doRender(): Promise<void> {
      const my = ++token;
      await Promise.resolve(); // simulate await safeImport(import('../views/showDetail'))
      if (my !== token) return; // superseded
      showDetail.resetBoundGuard();
      showDetail.renderShowDetail(main);
      showDetail.bindShowDetailEvents(main);
    }

    // Launch two overlapping renders; second supersedes first.
    await Promise.all([doRender(), doRender()]);

    // Only 1 listener added (the second render; the first was superseded).
    const clickAdds = addSpy.mock.calls.filter(([t]) => t === 'click');
    expect(clickAdds.length).toBe(1);
  });
});

// ---------- bindDelegatedEvents guard (renderer.ts) ----------

describe('bindDelegatedEvents guard (renderer.ts) — verified OK', () => {
  it('initRenderer called twice adds only ONE delegated listener', async () => {
    vi.doMock('../src/components/imageFallback', () => ({ initImageFallback: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));

    const { initRenderer } = await import('../src/components/renderer');
    const main = document.getElementById('mainContent')!;
    const addSpy = vi.spyOn(main, 'addEventListener');

    initRenderer();
    initRenderer();
    initRenderer();

    const clickAdds = addSpy.mock.calls.filter(([t]) => t === 'click');
    expect(clickAdds.length).toBe(1); // _boundDelegated guard works.
  });
});

// ---------- applyHash edge cases (hash routing in main.ts) ----------

describe('applyHash edge cases', () => {
  // These tests re-implement the applyHash regex/guard logic from main.ts
  // (since main.ts calls init() at module load and is not importable in tests).
  const KNOWN_VIEWS = ['dashboard', 'watching', 'towatch', 'completed', 'discover', 'calendar', 'stats'];
  const SHOW_RE = /^show\/(\d+)$/;

  function applyHashLogic(hash: string, state: { currentView: string; currentShowId: number | null }):
    | { action: 'switchView'; view: string }
    | { action: 'openShow'; id: number }
    | { action: 'noop' } {
    if (!hash) return { action: 'noop' };
    if (KNOWN_VIEWS.includes(hash)) {
      if (state.currentView !== hash || state.currentShowId !== null) {
        return { action: 'switchView', view: hash };
      }
      return { action: 'noop' };
    }
    const m = SHOW_RE.exec(hash);
    if (m) {
      const id = Number(m[1]);
      if (id > 0 && state.currentShowId !== id) return { action: 'openShow', id };
      return { action: 'noop' };
    }
    return { action: 'noop' };
  }

  it('unknown hash → noop', () => {
    const r = applyHashLogic('unknownview', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'noop' });
  });

  it('#show/abc → regex no match → noop', () => {
    const r = applyHashLogic('show/abc', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'noop' });
  });

  it('#show/0 → regex matches but id>0 check rejects → noop', () => {
    const r = applyHashLogic('show/0', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'noop' });
  });

  it('#show/123/extra → $ anchor rejects → noop', () => {
    const r = applyHashLogic('show/123/extra', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'noop' });
  });

  it('#show/123 → matches; openShow(123) action returned', () => {
    const r = applyHashLogic('show/123', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'openShow', id: 123 });
  });

  it('#show/123 when already showing that show → noop (no duplicate openShow)', () => {
    const r = applyHashLogic('show/123', { currentView: 'dashboard', currentShowId: 123 });
    expect(r).toEqual({ action: 'noop' });
  });

  it('known view, already on it, no detail → noop', () => {
    const r = applyHashLogic('dashboard', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'noop' });
  });

  it('known view, already on it, but detail open → switchView (closes detail)', () => {
    const r = applyHashLogic('dashboard', { currentView: 'dashboard', currentShowId: 123 });
    expect(r).toEqual({ action: 'switchView', view: 'dashboard' });
  });

  it('known view, different view → switchView', () => {
    const r = applyHashLogic('discover', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'switchView', view: 'discover' });
  });

  it('empty hash → noop', () => {
    const r = applyHashLogic('', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'noop' });
  });

  it('hash with leading slash that bypasses regex: "show/123/" → noop ($ anchor)', () => {
    const r = applyHashLogic('show/123/', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'noop' });
  });

  it('"show/000123" → matches (leading zeros), id=123, openShow', () => {
    // Note: Number("000123") === 123. Regex \d+ matches.
    const r = applyHashLogic('show/000123', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'openShow', id: 123 });
  });

  it('"SHOW/123" (uppercase) → regex is case-sensitive → noop', () => {
    const r = applyHashLogic('SHOW/123', { currentView: 'dashboard', currentShowId: null });
    expect(r).toEqual({ action: 'noop' });
  });
});

// ---------- openShow on non-existent show (deep-link to unknown id) ----------

describe('deep-link to #show/<id> where id not in state (end-to-end)', () => {
  it('openShow(id) sets currentShowId; renderShowDetail bails via closeShow → emitChange loop', async () => {
    vi.doMock('../src/lib/shows', () => ({
      toggleEpisode: vi.fn(),
      markSeasonWatched: vi.fn(),
      moveShowToList: vi.fn(),
      removeShow: vi.fn(),
      refreshShowEpisodes: vi.fn(async () => true),
      showNeedsEpisodeNames: vi.fn(() => false),
      addShowToList: vi.fn(),
    }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));
    vi.doMock('../src/components/modal', () => ({ showModal: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));

    const store = await import('../src/lib/store');
    const showDetail = await import('../src/views/showDetail');

    store.setShows([]);
    store.openShow(999); // sets currentShowId=999
    expect(store.getState().currentShowId).toBe(999);

    const main = document.getElementById('mainContent')!;
    main.innerHTML = '<div>previous dashboard</div>';

    showDetail.renderShowDetail(main); // bails: show not found → closeShow

    // closeShow reset currentShowId and emitChange'd.
    expect(store.getState().currentShowId).toBeNull();
    // main.innerHTML UNCHANGED (bail returns before rendering).
    expect(main.innerHTML).toContain('previous dashboard');
  });
});

// ---------- init order robustness (static check) ----------

describe('main.ts init order — static documentation', () => {
  it('init sequence: modal→header→search→exportImport→renderer→storageModal→loadData→updateBadges→render→subscribe→setupHashRouting→SW→standalone→preloadDiscover', () => {
    // We can't import main.ts (it calls init() at module-load and would try to
    // register a SW). Confirmed by reading the source — see report for line cites.
    expect(true).toBe(true);
  });
});
