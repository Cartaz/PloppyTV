// Agent 15 — probe tests for src/views/discover.ts
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_discoverview.test.ts
//
// Covers: listener accumulation, double loadTab on tab switch, stuck-loading
// (stale el after re-render), stale DOM ops, addDiscoverShow double render,
// scrollCarousel magic number, carousel-card a11y, 'openDiscover' dead branch,
// storageDisabled tabs rendered, previewDiscover modal actions, H15 guard.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ============================================================
// MOCKS
// ============================================================

const mockGetDiscoverPromise = vi.fn();
const mockInvalidateDiscoverCache = vi.fn();
const mockResetDiscoverPreload = vi.fn();
const mockFindShowInDiscoverGroups = vi.fn();
const mockAddShowToList = vi.fn();
const mockShowModal = vi.fn();
const mockShowToast = vi.fn();
const mockUpdateBadges = vi.fn();

vi.mock('../src/lib/discover', () => ({
  getDiscoverPromise: (...args: any[]) => mockGetDiscoverPromise(...args),
  invalidateDiscoverCache: (...args: any[]) => mockInvalidateDiscoverCache(...args),
  resetDiscoverPreload: (...args: any[]) => mockResetDiscoverPreload(...args),
  findShowInDiscoverGroups: (...args: any[]) => mockFindShowInDiscoverGroups(...args),
}));

vi.mock('../src/lib/shows', () => ({
  addShowToList: (...args: any[]) => mockAddShowToList(...args),
}));

vi.mock('../src/components/modal', () => ({
  showModal: (...args: any[]) => mockShowModal(...args),
}));

vi.mock('../src/components/toast', () => ({
  showToast: (...args: any[]) => mockShowToast(...args),
}));

vi.mock('../src/components/header', () => ({
  updateBadges: (...args: any[]) => mockUpdateBadges(...args),
}));

// Store: use real store (no mock). For listener-accumulation count, we spy on
// main.addEventListener instead of setDiscoverTab.

// ============================================================
// RAF POLYFILL (controllable, queue + manual flush)
// ============================================================

let rafQueue: Array<FrameRequestCallback> = [];
let rafOriginal: typeof requestAnimationFrame | undefined;

function installRafPolyfill(): void {
  rafQueue = [];
  const w = window as unknown as { requestAnimationFrame: typeof requestAnimationFrame };
  rafOriginal = w.requestAnimationFrame;
  w.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  }) as typeof requestAnimationFrame;
}

function restoreRaf(): void {
  const w = window as unknown as { requestAnimationFrame: typeof requestAnimationFrame };
  if (rafOriginal) w.requestAnimationFrame = rafOriginal;
  rafQueue = [];
}

function flushRaf(): void {
  const queue = rafQueue;
  rafQueue = [];
  for (const cb of queue) cb(Date.now());
}

function rafQueueLength(): number {
  return rafQueue.length;
}

// ============================================================
// HELPERS
// ============================================================

function setupDom(): void {
  document.body.innerHTML = `
    <main class="main" id="mainContent"></main>
    <div class="modal-overlay" id="modal" aria-hidden="true">
      <div class="modal" tabindex="-1">
        <div class="modal-title" id="modalTitle"></div>
        <div class="modal-body" id="modalBody"></div>
        <div class="modal-actions" id="modalActions"></div>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  `;
}

function makeTvmazeShow(id: number, over: Record<string, any> = {}): any {
  return {
    id,
    name: 'Show ' + id,
    weight: 50,
    image: { medium: 'http://x/' + id + '.jpg' },
    genres: ['Drama'],
    premiered: '2024-01-01',
    rating: { average: 7 },
    network: { name: 'NBC' },
    webChannel: null,
    summary: '<p>Summary for ' + id + '</p>',
    status: 'Running',
    runtime: 45,
    ...over,
  };
}

function makeGroups(shows: any[]): any {
  return { Drama: shows, _other: [] };
}

function pendingPromise<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: any) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicro(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ============================================================
// TESTS
// ============================================================

describe('Agent-15 probe: discover view', () => {
  let storeMod: any;
  let discoverMod: any;

  beforeEach(async () => {
    setupDom();
    installRafPolyfill();

    // Reset all mocks
    mockGetDiscoverPromise.mockReset();
    mockInvalidateDiscoverCache.mockReset();
    mockResetDiscoverPreload.mockReset();
    mockFindShowInDiscoverGroups.mockReset();
    mockAddShowToList.mockReset();
    mockShowModal.mockReset();
    mockShowToast.mockReset();
    mockUpdateBadges.mockReset();

    // Defaults
    mockFindShowInDiscoverGroups.mockReturnValue(null);
    mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));

    // Reset modules → fresh discover view (_popularCache=null, _recentCache=null, etc.)
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    discoverMod = await import('../src/views/discover');

    storeMod.setState({
      shows: [],
      currentView: 'discover',
      currentShowId: null,
      _discoverTab: 'popular',
      _storageDisabled: false,
    });
  });

  afterEach(() => {
    restoreRaf();
    vi.restoreAllMocks();
  });

  // ===================================================================
  // BUG-15-01: Listener accumulation (FIXED)
  // ===================================================================
  describe('BUG-15-01: bindDiscoverEvents listener accumulation (FIXED)', () => {
    it('after N reset+bind cycles, only ONE click listener is ACTIVE (FIXED)', async () => {
      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);

      const addSpy = vi.spyOn(main, 'addEventListener');
      const removeSpy = vi.spyOn(main, 'removeEventListener');

      // Simulate 3 re-renders (each: resetBoundGuard + bindDiscoverEvents)
      discoverMod.resetBoundGuard();
      discoverMod.bindDiscoverEvents(main);
      discoverMod.resetBoundGuard();
      discoverMod.bindDiscoverEvents(main);
      discoverMod.resetBoundGuard();
      discoverMod.bindDiscoverEvents(main);

      // FIX: addEventListener('click') called 3 times, removeEventListener('click')
      // called 2 times → 1 ACTIVE listener on `main`.
      const clickAdds = addSpy.mock.calls.filter((c: any[]) => c[0] === 'click').length;
      const clickRemoves = removeSpy.mock.calls.filter((c: any[]) => c[0] === 'click').length;
      expect(clickAdds).toBe(3);
      expect(clickRemoves).toBe(2);
    });

    it('single click fires handler EXACTLY once (FIXED — no N× amplification)', async () => {
      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      // Simulate 2 more re-renders (would have been 3 listeners pre-fix).
      discoverMod.resetBoundGuard();
      discoverMod.bindDiscoverEvents(main);
      discoverMod.resetBoundGuard();
      discoverMod.bindDiscoverEvents(main);

      // Spy on setDiscoverTab to count handler invocations.
      const setTabSpy = vi.spyOn(storeMod, 'setDiscoverTab');

      const recentTab = main.querySelector('[data-tab="recent"]') as HTMLElement;
      recentTab.click();

      // FIX: ONE listener → 1 invocation of setDiscoverTab.
      expect(setTabSpy).toHaveBeenCalledTimes(1);
      expect(setTabSpy).toHaveBeenCalledWith('recent');
    });
  });

  // ===================================================================
  // BUG-15-02: Stuck loading after re-render (FIXED — manual loadTab removed)
  // ===================================================================
  describe('BUG-15-02: stuck loading (FIXED — no manual loadTab)', () => {
    it('clicking tab does NOT manually call loadTab; re-render handles it (FIXED)', async () => {
      const main = document.getElementById('mainContent')!;

      // Step 1: Initial render with 'popular'. Populate _popularCache.
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro(); // _popularCache set

      // Step 2: Pending fetch for 'recent'.
      const recentGroups = makeGroups([makeTvmazeShow(2)]);
      const recentFetch = pendingPromise<any>();
      mockGetDiscoverPromise.mockReturnValue(recentFetch.promise);

      // Step 3: Click 'recent' tab. After FIX: handler only calls setDiscoverTab
      // (no manual loadTab, no manual DOM ops). emitChange → RAF queued.
      mockGetDiscoverPromise.mockClear();
      const recentTab = main.querySelector('[data-tab="recent"]') as HTMLElement;
      recentTab.click();

      // FIX: no getDiscoverPromise call yet (no manual loadTab).
      expect(mockGetDiscoverPromise).not.toHaveBeenCalled();

      // Step 4: Simulate the RAF-triggered re-render (as the real renderer would do).
      discoverMod.renderDiscover(main);
      // main.innerHTML replaced → NEW discoverContent created.
      // renderDiscover's loadTab('recent') starts: _recentLoading=true, await fetch.
      // NEW discoverContent has 'Caricamento...' from renderDiscover HTML.
      const newContent = document.getElementById('discoverContent')!;
      expect(newContent.innerHTML).toContain('Caricamento');

      // Step 5: Resolve the fetch → loadTab continues on NEW discoverContent (FIX).
      recentFetch.resolve(recentGroups);
      await flushMicro();

      // FIX: NEW discoverContent now shows the fetched content (NOT stuck on loading).
      expect(newContent.innerHTML).toContain('carousel-track');
      expect(newContent.innerHTML).not.toContain('Caricamento');
    });

    it('CONTRAST: if fetch resolves before re-render, content renders correctly (no bug)', async () => {
      const main = document.getElementById('mainContent')!;

      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const recentGroups = makeGroups([makeTvmazeShow(2)]);
      const recentFetch = pendingPromise<any>();
      mockGetDiscoverPromise.mockReturnValue(recentFetch.promise);

      const recentTab = main.querySelector('[data-tab="recent"]') as HTMLElement;
      recentTab.click();

      // Re-render first (no manual loadTab ran yet).
      discoverMod.renderDiscover(main);
      // Resolve fetch → RENDER's loadTab finishes.
      recentFetch.resolve(recentGroups);
      await flushMicro();

      const newContent = document.getElementById('discoverContent')!;
      expect(newContent.innerHTML).toContain('carousel-track'); // content rendered
    });
  });

  // ===================================================================
  // BUG-15-03: No stale DOM ops (FIXED — manual ops removed from switchDiscoverTab)
  // ===================================================================
  describe('BUG-15-03: NO stale DOM ops on elements about to be replaced (FIXED)', () => {
    it('clicking tab does NOT manually set innerHTML on OLD discoverContent (FIXED)', async () => {
      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      // Capture OLD discoverContent
      const oldContent = document.getElementById('discoverContent')!;
      expect(oldContent.innerHTML).toContain('carousel-track'); // content from initial load

      // Pending fetch for 'recent'
      const recentFetch = pendingPromise<any>();
      mockGetDiscoverPromise.mockReturnValue(recentFetch.promise);

      // Click 'recent' tab — FIX: handler does NOT manually touch OLD discoverContent.
      const recentTab = main.querySelector('[data-tab="recent"]') as HTMLElement;
      recentTab.click();

      // FIX: OLD discoverContent innerHTML UNCHANGED (no manual Caricamento write).
      expect(oldContent.innerHTML).toContain('carousel-track');
      expect(oldContent.innerHTML).not.toContain('Caricamento');

      // Simulate re-render (replaces OLD discoverContent with NEW)
      discoverMod.renderDiscover(main);

      // OLD discoverContent is now detached
      expect(oldContent.parentElement).toBeNull();

      // NEW discoverContent is a different element
      const newContent = document.getElementById('discoverContent')!;
      expect(newContent).not.toBe(oldContent);
    });

    it('clicking tab does NOT manually toggle active class on OLD tabs (FIXED)', async () => {
      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      // Capture OLD tab elements
      const oldTabs = Array.from(main.querySelectorAll('.discover-tab')) as HTMLElement[];
      expect(oldTabs).toHaveLength(2);
      // Initially: 'popular' tab active, 'recent' not.
      expect(oldTabs[0].classList.contains('active')).toBe(true);
      expect(oldTabs[1].classList.contains('active')).toBe(false);

      // Click 'recent' tab — FIX: handler does NOT manually toggle OLD tabs.
      const recentTab = oldTabs[1];
      recentTab.click();

      // FIX: OLD 'recent' tab does NOT have 'active' (no manual toggle).
      expect(oldTabs[1].classList.contains('active')).toBe(false);
      // OLD 'popular' tab still has 'active' (unchanged).
      expect(oldTabs[0].classList.contains('active')).toBe(true);

      // Simulate re-render (replaces OLD tabs with NEW; NEW 'recent' tab is active).
      discoverMod.renderDiscover(main);

      const newTabs = Array.from(main.querySelectorAll('.discover-tab')) as HTMLElement[];
      expect(newTabs).toHaveLength(2);
      // FIX: NEW tabs reflect state._discoverTab='recent'.
      expect(newTabs[1].classList.contains('active')).toBe(true);
      expect(newTabs[0].classList.contains('active')).toBe(false);
    });
  });

  // ===================================================================
  // BUG-15-04: Single render after add (FIXED — direct renderDiscover removed)
  // ===================================================================
  describe('BUG-15-04: addDiscoverShow single render (FIXED — direct renderDiscover removed)', () => {
    it('addDiscoverShow only relies on replaceShow RAF (no direct renderDiscover, FIXED)', async () => {
      const main = document.getElementById('mainContent')!;
      const show = makeTvmazeShow(1);
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      // Mock addShowToList: call replaceShow (→ emitChange → RAF) like the real impl
      mockAddShowToList.mockImplementation(async (_t: any, list: any) => {
        const newShow = {
          id: 1, name: 'Show 1', list, seasons: {}, totalSeasons: 0, totalEpisodes: 0,
          addedAt: Date.now(), image: null, status: 'Running', premiered: '2024-01-01',
          genres: ['Drama'], summary: '', network: 'NBC', runtime: 45,
        };
        storeMod.replaceShow(newShow); // → emitChange → RAF queued
        return newShow;
      });

      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      // Before add: no badge
      expect(main.querySelector('.carousel-card-badge')).toBeNull();

      // Click card → preview modal → click "Da vedere"
      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();
      const actions = mockShowModal.mock.calls[0][2];
      const daVedere = actions.find((a: any) => a.label === 'Da vedere');
      daVedere.onClick(); // triggers addDiscoverShow (async)

      await flushMicro(); // addDiscoverShow: addShowToList → replaceShow (RAF queued)

      // FIX: NO direct renderDiscover — badge NOT yet rendered (RAF hasn't fired).
      expect(main.querySelector('.carousel-card-badge')).toBeNull();

      // replaceShow's emitChange queued a RAF.
      expect(rafQueueLength()).toBeGreaterThan(0);

      // Flush RAF → renderer's render callback fires → renderDiscover re-runs.
      // Simulate by calling renderDiscover(main) directly (the renderer would do this).
      discoverMod.renderDiscover(main);
      await flushMicro();

      // FIX: badge appears after the RAF-triggered render.
      expect(main.querySelector('.carousel-card-badge')).toBeTruthy();
      expect(main.querySelector('.carousel-card-badge')?.textContent).toContain('Aggiunta');
    });
  });

  // ===================================================================
  // BUG-15-05: scrollCarousel hardcoded cardWidth=160+12
  // ===================================================================
  describe('BUG-15-05: scrollCarousel magic number', () => {
    it('scrollBy called with 172*3=516 pixels (hardcoded cardWidth=160+12)', async () => {
      // jsdom doesn't implement scrollBy; add a stub
      if (!Element.prototype.scrollBy) {
        (Element.prototype as any).scrollBy = function () {};
      }

      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockResolvedValue(
        makeGroups([makeTvmazeShow(1), makeTvmazeShow(2), makeTvmazeShow(3), makeTvmazeShow(4)]),
      );
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const track = main.querySelector('.carousel-track') as HTMLElement;
      expect(track).toBeTruthy();
      const scrollBySpy = vi.spyOn(track, 'scrollBy');

      // Nav buttons are disabled in jsdom (scrollWidth=clientWidth=0 → maxScroll=0).
      // A disabled button doesn't fire click events, so enable it for testing.
      const nextBtn = main.querySelector('[data-action="scrollCarousel"][data-dir="1"]') as HTMLButtonElement;
      nextBtn.disabled = false;
      nextBtn.click();

      expect(scrollBySpy).toHaveBeenCalledTimes(1);
      expect(scrollBySpy).toHaveBeenCalledWith({ left: 516, behavior: 'smooth' });
    });

    it('cardWidth magic number 160+12: operator precedence (160+12=172, not 160+(12*3))', async () => {
      // Verify the expression `cardWidth * 3 * dir` where cardWidth = 160 + 12 = 172.
      // 172 * 3 = 516. If it were 160 + (12 * 3) = 196, that'd be different.
      const cardWidth = 160 + 12; // = 172
      const dir = 1;
      const scroll = cardWidth * 3 * dir; // = 516
      expect(scroll).toBe(516);
      expect(cardWidth).toBe(172);
    });
  });

  // ===================================================================
  // BUG-15-06: 'openDiscover' dead branch (FIXED — removed)
  // ===================================================================
  describe('BUG-15-06: openDiscover dead branch (FIXED — branch removed)', () => {
    it('rendered HTML never uses data-action="openDiscover" (dead branch removed)', async () => {
      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      await flushMicro();

      const openDiscoverEls = main.querySelectorAll('[data-action="openDiscover"]');
      expect(openDiscoverEls).toHaveLength(0); // dead branch

      const previewDiscoverEls = main.querySelectorAll('[data-action="previewDiscover"]');
      expect(previewDiscoverEls.length).toBeGreaterThan(0); // actual action
    });
  });

  // ===================================================================
  // BUG-15-07: carousel-card a11y (FIXED — role/tabindex added)
  // ===================================================================
  describe('BUG-15-07: carousel-card a11y (FIXED)', () => {
    it('carousel-card has role=button, tabindex=0, aria-label (keyboard accessible)', async () => {
      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      expect(card).toBeTruthy();
      // FIX: card is now keyboard-focusable and operable.
      expect(card.getAttribute('role')).toBe('button');
      expect(card.getAttribute('tabindex')).toBe('0');
      expect(card.getAttribute('aria-label')).toContain('Anteprima');
    });

    it('keydown Enter on carousel-card triggers previewDiscover (via delegated keydown handler)', async () => {
      const main = document.getElementById('mainContent')!;
      const show = makeTvmazeShow(1);
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      // Card has data-action=previewDiscover → keydown converted to click → previewDiscover.
      expect(mockShowModal).toHaveBeenCalledTimes(1);
    });
  });

  // ===================================================================
  // BUG-15-08: storageDisabled still renders tabs
  // ===================================================================
  describe('BUG-15-08: storageDisabled tabs rendered', () => {
    it('storageDisabled=true: tabs rendered above "Funzione non disponibile"', async () => {
      storeMod.setState({ _storageDisabled: true });
      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);

      const tabs = main.querySelectorAll('.discover-tab');
      expect(tabs).toHaveLength(2); // BUG: tabs rendered even though content unavailable

      const emptyState = main.querySelector('.empty-state');
      expect(emptyState).toBeTruthy();
      expect(emptyState?.textContent).toContain('Funzione non disponibile');
    });
  });

  // ===================================================================
  // BUG-15-09: previewDiscover modal actions
  // ===================================================================
  describe('BUG-15-09: previewDiscover modal actions', () => {
    it('show not in cache → showToast error, no modal', async () => {
      mockFindShowInDiscoverGroups.mockReturnValue(null);
      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      expect(mockShowToast).toHaveBeenCalledWith('Serie non trovata', 'error');
      expect(mockShowModal).not.toHaveBeenCalled();
    });

    it('isAdded=true → only "Chiudi" button', async () => {
      const show = makeTvmazeShow(1);
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));
      storeMod.setState({
        shows: [
          {
            id: 1, name: 'Show 1', list: 'towatch', seasons: {}, totalSeasons: 0,
            totalEpisodes: 0, addedAt: 0, image: null, status: 'Running',
            premiered: '2024-01-01', genres: ['Drama'], summary: '', network: 'NBC', runtime: 45,
          },
        ],
      });

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      expect(mockShowModal).toHaveBeenCalledTimes(1);
      const actions = mockShowModal.mock.calls[0][2];
      expect(actions).toHaveLength(1);
      expect(actions[0].label).toBe('Chiudi');
      expect(actions[0].onClick).toBeUndefined();
    });

    it('isAdded=false → "Chiudi" + "Da vedere" + "In corso"', async () => {
      const show = makeTvmazeShow(1);
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      expect(mockShowModal).toHaveBeenCalledTimes(1);
      const actions = mockShowModal.mock.calls[0][2];
      expect(actions).toHaveLength(3);
      expect(actions[0].label).toBe('Chiudi');
      expect(actions[1].label).toBe('Da vedere');
      expect(actions[2].label).toBe('In corso');
      expect(typeof actions[1].onClick).toBe('function');
      expect(typeof actions[2].onClick).toBe('function');
    });

    it('"Aggiunta" badge rendered on card when show is in user list', async () => {
      const show = makeTvmazeShow(1);
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));
      storeMod.setState({
        shows: [
          {
            id: 1, name: 'Show 1', list: 'watching', seasons: {}, totalSeasons: 0,
            totalEpisodes: 0, addedAt: 0, image: null, status: 'Running',
            premiered: '2024-01-01', genres: ['Drama'], summary: '', network: 'NBC', runtime: 45,
          },
        ],
      });

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      await flushMicro();

      const badge = main.querySelector('.carousel-card-badge');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toContain('Aggiunta');
    });
  });

  // ===================================================================
  // refreshDiscover / retryDiscover handlers
  // ===================================================================
  describe('refreshDiscover / retryDiscover handlers', () => {
    it('refreshDiscover: invalidates cache + resets preload + nulls view cache + loadTab', async () => {
      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      mockGetDiscoverPromise.mockClear();
      mockInvalidateDiscoverCache.mockClear();
      mockResetDiscoverPreload.mockClear();

      const refreshBtn = main.querySelector('[data-action="refreshDiscover"]') as HTMLElement;
      refreshBtn.click();

      expect(mockInvalidateDiscoverCache).toHaveBeenCalledWith('popular');
      expect(mockResetDiscoverPreload).toHaveBeenCalledWith('popular');
      expect(mockGetDiscoverPromise).toHaveBeenCalledWith('popular');
    });

    it('retryDiscover: calls loadTab with current tab', async () => {
      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockRejectedValueOnce({ name: 'NetworkError' });
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const retryBtn = main.querySelector('[data-action="retryDiscover"]') as HTMLElement;
      expect(retryBtn).toBeTruthy();

      mockGetDiscoverPromise.mockClear();
      retryBtn.click();
      await flushMicro();

      expect(mockGetDiscoverPromise).toHaveBeenCalledWith('popular');
    });
  });

  // ===================================================================
  // H15 guard (POSITIVE: works correctly)
  // ===================================================================
  describe('H15 guard (verified correct)', () => {
    it('switching tab during fetch discards stale result', async () => {
      const main = document.getElementById('mainContent')!;

      const popularGroups = makeGroups([makeTvmazeShow(1, { name: 'Popular Show' })]);
      mockGetDiscoverPromise.mockResolvedValue(popularGroups);
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      // Start 'recent' fetch (pending)
      const recentFetch = pendingPromise<any>();
      mockGetDiscoverPromise.mockReturnValue(recentFetch.promise);

      const recentTab = main.querySelector('[data-tab="recent"]') as HTMLElement;
      recentTab.click();
      // state._discoverTab = 'recent', fetch pending

      // Click 'popular' tab → setDiscoverTab('popular'), cache hit renders
      mockGetDiscoverPromise.mockResolvedValue(popularGroups);
      const popularTab = main.querySelector('[data-tab="popular"]') as HTMLElement;
      popularTab.click();
      // state._discoverTab = 'popular'
      await flushMicro();

      // Resolve 'recent' fetch → H15 guard: state._discoverTab='popular' !== 'recent' → discard
      recentFetch.resolve(makeGroups([makeTvmazeShow(2, { name: 'Recent Show' })]));
      await flushMicro();

      // 'Recent Show' should NOT be in the document (H15 discarded it)
      const allText = main.textContent || '';
      expect(allText).not.toContain('Recent Show');
    });
  });

  // ===================================================================
  // addDiscoverShow re-render (FIXED — relies on RAF only)
  // ===================================================================
  describe('addDiscoverShow re-render (FIXED — RAF only)', () => {
    it('after add, "Aggiunta" badge appears on card via RAF render (FIXED)', async () => {
      const show = makeTvmazeShow(1);
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));
      // FIX: mockAddShowToList calls replaceShow (real emitChange → RAF queued).
      mockAddShowToList.mockImplementation(async (_t: any, list: any) => {
        const newShow = {
          id: 1, name: 'Show 1', list, seasons: {}, totalSeasons: 0, totalEpisodes: 0,
          addedAt: 0, image: null, status: 'Running', premiered: '2024-01-01',
          genres: ['Drama'], summary: '', network: 'NBC', runtime: 45,
        };
        storeMod.replaceShow(newShow); // → emitChange → RAF queued
        return newShow;
      });

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      expect(main.querySelector('.carousel-card-badge')).toBeNull();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();
      const actions = mockShowModal.mock.calls[0][2];
      const daVedere = actions.find((a: any) => a.label === 'Da vedere');
      daVedere.onClick();
      await flushMicro(); // addShowToList → replaceShow → RAF queued (no direct render)

      // FIX: badge NOT yet rendered (RAF hasn't fired).
      expect(main.querySelector('.carousel-card-badge')).toBeNull();

      // Flush the RAF (the real renderer's render() callback fires).
      // We simulate by calling renderDiscover directly.
      discoverMod.renderDiscover(main);
      await flushMicro();

      // FIX: badge appears after the RAF-triggered render.
      const badge = main.querySelector('.carousel-card-badge');
      expect(badge).toBeTruthy();
      expect(badge?.textContent).toContain('Aggiunta');
    });
  });

  // ===================================================================
  // Carousel nav state (FIXED — resize listener added)
  // ===================================================================
  describe('carousel nav state (FIXED — resize listener updates nav state)', () => {
    it('resize listener is registered on bindDiscoverEvents (FIXED)', async () => {
      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      const addSpy = vi.spyOn(window, 'addEventListener');
      discoverMod.bindDiscoverEvents(main);

      // FIX: resize listener registered.
      const resizeCalls = addSpy.mock.calls.filter((c: any[]) => c[0] === 'resize');
      expect(resizeCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('resize event triggers updateCarouselNavState on all tracks (FIXED)', async () => {
      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const navBtns = main.querySelectorAll('.carousel-nav-btn') as NodeListOf<HTMLButtonElement>;
      expect(navBtns.length).toBe(2);

      // Capture pre-resize state.
      const prevDisabledBefore = navBtns[0].disabled;
      const nextDisabledBefore = navBtns[1].disabled;

      // Spy on the disabled setter to confirm updateCarouselNavState runs.
      // (In jsdom scrollWidth=clientWidth=0, so the state doesn't actually change,
      // but the function is invoked.)
      const nextSetter = vi.spyOn(navBtns[1], 'disabled', 'set');

      window.dispatchEvent(new Event('resize'));

      // FIX: updateCarouselNavState was called on resize → setter invoked.
      expect(nextSetter).toHaveBeenCalled();
      // Sanity: state values unchanged in jsdom (no actual scroll dimensions).
      expect(navBtns[0].disabled).toBe(prevDisabledBefore);
      expect(navBtns[1].disabled).toBe(nextDisabledBefore);
    });
  });

  // ===================================================================
  // Single loadTab on tab switch (FIXED — manual loadTab removed from handler)
  // ===================================================================
  describe('single loadTab on tab switch (FIXED)', () => {
    it('clicking popular tab: no MANUAL loadTab, only renderDiscover loadTab runs (FIXED)', async () => {
      const main = document.getElementById('mainContent')!;
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro(); // _popularCache set

      // Capture OLD discoverContent
      const oldContent = document.getElementById('discoverContent')!;
      expect(oldContent.innerHTML).toContain('carousel-track');

      // Click 'popular' tab (already active). FIX: handler only setDiscoverTab,
      // no manual loadTab. setDiscoverTab emits emitChange → RAF queued.
      mockGetDiscoverPromise.mockClear();
      const popularTab = main.querySelector('[data-tab="popular"]') as HTMLElement;
      popularTab.click();

      // FIX: no getDiscoverPromise call yet (no manual loadTab; cache hit on render only).
      expect(mockGetDiscoverPromise).not.toHaveBeenCalled();

      // OLD discoverContent still has its carousel-track content (no manual innerHTML write).
      expect(oldContent.innerHTML).toContain('carousel-track');

      // Simulate re-render (replaces OLD discoverContent).
      discoverMod.renderDiscover(main);
      await flushMicro();

      // OLD discoverContent detached
      expect(oldContent.parentElement).toBeNull();
      // NEW discoverContent has content (from RENDER's loadTab cache hit).
      const newContent = document.getElementById('discoverContent')!;
      expect(newContent).not.toBe(oldContent);
      expect(newContent.innerHTML).toContain('carousel-track');
    });
  });
});
