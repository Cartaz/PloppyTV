// Agent 18 — probe tests for src/main.ts
// Stress test: init order, hash routing, SW registration + onNeedRefresh,
// beforeunload, preloadDiscover, standalone detection, double-init.
//
// Mocks all dependencies (store, storage, components) so we can capture call
// order, inject failures, and exercise edge cases without touching real
// DOM/storage/network.
//
// The 'virtual:pwa-register' module is provided by a Vite plugin declared in
// vitest.config.main.ts. The plugin delegates to a runtime hook installed on
// globalThis by this test file:
//   (globalThis).__mainProbeRegisterSWHook = (opts) => { ...; return updateSW; }
//
// NOTE: main.ts calls init() at module top-level (line 151). To exercise
// init() repeatedly, we use vi.resetModules() + dynamic import per test.
//
// Run with: npx vitest run --config vitest.config.main.ts tests/probe_main.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Self-skip when not running under vitest.config.main.ts (where the
// 'virtual:pwa-register' module is provided by a Vite plugin). Without this
// guard, every dynamic import of main.ts would fail with "Failed to resolve
// import 'virtual:pwa-register'" when run via the default `vitest.config.ts`.
const isMainConfig = process.env.VITEST_MAIN_CONFIG === '1';

// =====================================================================
// Window-listener tracking — vi.resetModules() does NOT remove listeners
// attached to `window`, so they accumulate across tests. We patch
// window.addEventListener to track and clean up every listener added during
// a test, so each test starts with a clean window.
// =====================================================================
const _tracked: Array<{ type: string; listener: any; options?: any }> = [];
let _origAdd: typeof window.addEventListener | null = null;

beforeEach(() => {
  _tracked.length = 0;
  _origAdd = window.addEventListener.bind(window);
  (window as any).addEventListener = function (
    type: string,
    listener: any,
    options?: any,
  ) {
    _tracked.push({ type, listener, options });
    return (_origAdd as any)(type, listener, options);
  };
});

afterEach(() => {
  // Restore first so removal uses the real removeEventListener
  if (_origAdd) {
    (window as any).addEventListener = _origAdd;
    _origAdd = null;
  }
  for (const { type, listener, options } of _tracked) {
    try {
      window.removeEventListener(type, listener, options);
    } catch {
      // ignore
    }
  }
  _tracked.length = 0;
});

// =====================================================================
// Mocks (vi.mock is hoisted; `mock*`-prefixed vars are allowed in factories)
// =====================================================================

const mockInitModal = vi.fn();
const mockShowModal = vi.fn((_title: any, _body: any, _actions: any) => undefined);
const mockInitHeader = vi.fn();
const mockUpdateBadges = vi.fn();
const mockInitSearch = vi.fn();
const mockInitExportImport = vi.fn();
const mockInitRenderer = vi.fn();
const mockRender = vi.fn();
const mockPreloadDiscover = vi.fn();
const mockShowToast = vi.fn((_msg: any, _type?: any) => undefined);
const mockIsStorageOK = vi.fn(() => true as boolean);
const mockLoadData = vi.fn();
const mockSaveData = vi.fn((_opts?: any) => true as boolean);
const mockSubscribe = vi.fn((_fn: any) => vi.fn() as () => void);
const mockSwitchView = vi.fn((_view: any) => undefined);
const mockOpenShow = vi.fn((_id: any) => undefined);
const mockRegisterSW = vi.fn((_opts: any) => (mockUpdateSW as (reloadPage?: boolean) => Promise<void>));
const mockUpdateSW = vi.fn((_reloadPage?: any) => Promise.resolve());

// Mutable state used by mockGetState — tests can patch via __setState
let _state: any = {
  shows: [],
  currentView: 'dashboard',
  currentShowId: null,
  currentSeason: 1,
  calendarWeekOffset: 0,
  _storageDisabled: false,
  _quotaWarned: false,
  _discoverTab: 'popular' as const,
  _localDirty: false,
};
function __setState(patch: Partial<typeof _state>): void {
  _state = { ..._state, ...patch };
}
const mockGetState = vi.fn(() => _state as any);

// Install the runtime hook BEFORE any dynamic import of main.ts. The Vite
// plugin in vitest.config.main.ts reads this hook when 'virtual:pwa-register'
// is imported.
(globalThis as any).__mainProbeRegisterSWHook = (opts: any) => {
  mockRegisterSW(opts);
  return mockUpdateSW;
};

vi.mock('../src/lib/store', () => ({
  getState: () => mockGetState(),
  subscribe: (fn: any) => mockSubscribe(fn),
  switchView: (v: string) => mockSwitchView(v),
  openShow: (id: number) => mockOpenShow(id),
}));

vi.mock('../src/lib/storage', () => ({
  isStorageOK: () => mockIsStorageOK(),
  loadData: () => mockLoadData(),
  saveData: (opts?: any) => mockSaveData(opts),
}));

vi.mock('../src/lib/discover', () => ({
  preloadDiscover: () => mockPreloadDiscover(),
}));

vi.mock('../src/components/modal', () => ({
  initModal: () => mockInitModal(),
  showModal: (t: any, b: any, a: any) => mockShowModal(t, b, a),
}));

vi.mock('../src/components/header', () => ({
  initHeader: () => mockInitHeader(),
  updateBadges: () => mockUpdateBadges(),
}));

vi.mock('../src/components/search', () => ({
  initSearch: () => mockInitSearch(),
}));

vi.mock('../src/components/exportImport', () => ({
  initExportImport: () => mockInitExportImport(),
}));

vi.mock('../src/components/renderer', () => ({
  initRenderer: () => mockInitRenderer(),
  render: () => mockRender(),
}));

vi.mock('../src/components/toast', () => ({
  showToast: (m: any, t?: any) => mockShowToast(m, t),
}));

// =====================================================================
// Helpers
// =====================================================================

function resetMocks(): void {
  mockInitModal.mockReset();
  mockShowModal.mockReset();
  mockInitHeader.mockReset();
  mockUpdateBadges.mockReset();
  mockInitSearch.mockReset();
  mockInitExportImport.mockReset();
  mockInitRenderer.mockReset();
  mockRender.mockReset();
  mockPreloadDiscover.mockReset();
  mockShowToast.mockReset();
  mockIsStorageOK.mockReset();
  mockIsStorageOK.mockReturnValue(true);
  mockLoadData.mockReset();
  mockSaveData.mockReset();
  mockSaveData.mockReturnValue(true);
  mockSubscribe.mockReset();
  mockSubscribe.mockReturnValue(vi.fn() as () => void);
  mockSwitchView.mockReset();
  mockOpenShow.mockReset();
  mockRegisterSW.mockReset();
  mockUpdateSW.mockReset();
  mockUpdateSW.mockReturnValue(Promise.resolve());
  mockGetState.mockReset();
  __setState({
    shows: [],
    currentView: 'dashboard',
    currentShowId: null,
    currentSeason: 1,
    calendarWeekOffset: 0,
    _storageDisabled: false,
    _quotaWarned: false,
    _discoverTab: 'popular',
    _localDirty: false,
  });
  mockGetState.mockImplementation(() => _state);
  // FIX-18-08: init() now guards against double-init via a flag on window.
  // Clear it so each test starts fresh.
  delete (window as any).__ploppytvInit;
}

function setHash(h: string): void {
  const url = new URL(window.location.href);
  url.hash = h;
  window.history.replaceState({}, '', url);
}

function fireHashchange(): void {
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function fireBeforeunload(): void {
  const ev = new Event('beforeunload', { cancelable: true });
  Object.defineProperty(ev, 'returnValue', { value: '', writable: true });
  window.dispatchEvent(ev);
}

function reloadButtons(): NodeListOf<HTMLButtonElement> {
  return document.querySelectorAll<HTMLButtonElement>(
    'body > button.btn-primary.btn-sm',
  );
}

// =====================================================================
// Tests
// =====================================================================

describe.skipIf(!isMainConfig)('main.ts — init order', () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove('pwa-standalone');
    reloadButtons().forEach((b) => b.remove());
  });

  it('calls initX functions in the expected order then loadData/render/subscribe', async () => {
    await import('../src/main');
    expect(mockInitModal).toHaveBeenCalledTimes(1);
    expect(mockInitHeader).toHaveBeenCalledTimes(1);
    expect(mockInitSearch).toHaveBeenCalledTimes(1);
    expect(mockInitExportImport).toHaveBeenCalledTimes(1);
    expect(mockInitRenderer).toHaveBeenCalledTimes(1);
    expect(mockLoadData).toHaveBeenCalledTimes(1);
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    // Order assertions
    expect(mockInitModal.mock.invocationCallOrder[0]).toBeLessThan(
      mockInitHeader.mock.invocationCallOrder[0],
    );
    expect(mockInitHeader.mock.invocationCallOrder[0]).toBeLessThan(
      mockInitSearch.mock.invocationCallOrder[0],
    );
    expect(mockInitSearch.mock.invocationCallOrder[0]).toBeLessThan(
      mockInitExportImport.mock.invocationCallOrder[0],
    );
    expect(mockInitExportImport.mock.invocationCallOrder[0]).toBeLessThan(
      mockInitRenderer.mock.invocationCallOrder[0],
    );
    expect(mockInitRenderer.mock.invocationCallOrder[0]).toBeLessThan(
      mockLoadData.mock.invocationCallOrder[0],
    );
    expect(mockLoadData.mock.invocationCallOrder[0]).toBeLessThan(
      mockRender.mock.invocationCallOrder[0],
    );
    expect(mockRender.mock.invocationCallOrder[0]).toBeLessThan(
      mockSubscribe.mock.invocationCallOrder[0],
    );
  });

  it('updateBadges called once after loadData (renderer mock suppresses its own call)', async () => {
    await import('../src/main');
    expect(mockUpdateBadges).toHaveBeenCalledTimes(1);
    expect(mockLoadData.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateBadges.mock.invocationCallOrder[0],
    );
  });

  it('shows storage modal BEFORE loadData when storage disabled', async () => {
    mockIsStorageOK.mockReturnValue(false);
    await import('../src/main');
    expect(mockShowModal).toHaveBeenCalledTimes(1);
    expect(mockShowModal.mock.invocationCallOrder[0]).toBeLessThan(
      mockLoadData.mock.invocationCallOrder[0],
    );
  });

  it('does NOT show storage modal when storage OK', async () => {
    mockIsStorageOK.mockReturnValue(true);
    await import('../src/main');
    expect(mockShowModal).not.toHaveBeenCalled();
  });

  it('FIX-18-01 (H13): init() is guarded — if initRenderer throws, init catches it, logs, and shows fallback UI; subsequent steps (loadData/render/subscribe/preload) are skipped', async () => {
    mockInitRenderer.mockImplementationOnce(() => {
      throw new Error('initRenderer boom');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Provide a #mainContent element so the fallback UI can be injected.
    const mainEl = document.createElement('main');
    mainEl.id = 'mainContent';
    document.body.appendChild(mainEl);
    let threw = false;
    try {
      await import('../src/main');
    } catch {
      threw = true;
    }
    // FIX: init() no longer throws — it catches and shows fallback UI.
    expect(threw).toBe(false);
    expect(console.error).toHaveBeenCalled();
    // Steps after initRenderer are still skipped (throw happens before them).
    expect(mockLoadData).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockPreloadDiscover).not.toHaveBeenCalled();
    // Fallback UI is injected.
    expect(mainEl.querySelector('.empty-state-title')?.textContent).toBe(
      'Errore di avvio',
    );
    mainEl.remove();
    spy.mockRestore();
  });

  it('FIX-18-02 (C3): beforeunload listener is registered INSIDE init() AFTER loadData — if init throws early, beforeunload is NOT registered and saveData is NOT called on tab close', async () => {
    mockInitRenderer.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await import('../src/main');
    } catch {
      // FIX: init no longer throws; expected path is no throw.
    }
    spy.mockRestore();
    // FIX: beforeunload listener is registered AFTER loadData(); since
    // initRenderer throws before loadData, the listener was never attached.
    fireBeforeunload();
    expect(mockSaveData).not.toHaveBeenCalled();
  });

  it('init order tolerates missing DOM (initX mocked; real impls use optional chaining)', async () => {
    document.body.innerHTML = '';
    await import('../src/main');
    expect(mockInitHeader).toHaveBeenCalledTimes(1);
    expect(mockLoadData).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!isMainConfig)('main.ts — applyHash routing', () => {
  beforeEach(async () => {
    resetMocks();
    vi.useFakeTimers();
    vi.resetModules();
    await import('../src/main');
    setHash('');
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove('pwa-standalone');
  });

  function fireApplyHash() {
    fireHashchange();
  }

  it('empty hash → no switchView, no openShow', () => {
    setHash('');
    fireApplyHash();
    expect(mockSwitchView).not.toHaveBeenCalled();
    expect(mockOpenShow).not.toHaveBeenCalled();
  });

  it('#dashboard when currentView=dashboard & currentShowId=null → no switchView (idempotent)', () => {
    __setState({ currentView: 'dashboard', currentShowId: null });
    setHash('#dashboard');
    fireApplyHash();
    expect(mockSwitchView).not.toHaveBeenCalled();
  });

  it('#dashboard when currentView=watching → switchView(dashboard)', () => {
    __setState({ currentView: 'watching', currentShowId: null });
    setHash('#dashboard');
    fireApplyHash();
    expect(mockSwitchView).toHaveBeenCalledWith('dashboard');
  });

  it('#dashboard when currentShowId=5 (in show detail) → switchView(dashboard) clears show', () => {
    __setState({ currentView: 'dashboard', currentShowId: 5 });
    setHash('#dashboard');
    fireApplyHash();
    expect(mockSwitchView).toHaveBeenCalledWith('dashboard');
  });

  it('#stats → switchView(stats)', () => {
    setHash('#stats');
    fireApplyHash();
    expect(mockSwitchView).toHaveBeenCalledWith('stats');
  });

  it('#watching → switchView(watching)', () => {
    setHash('#watching');
    fireApplyHash();
    expect(mockSwitchView).toHaveBeenCalledWith('watching');
  });

  it('#about → NOT in knownViews → no switchView (about is a button, not a view)', () => {
    setHash('#about');
    fireApplyHash();
    expect(mockSwitchView).not.toHaveBeenCalled();
    expect(mockOpenShow).not.toHaveBeenCalled();
  });

  it('#show/123 → openShow(123)', () => {
    setHash('#show/123');
    fireApplyHash();
    expect(mockOpenShow).toHaveBeenCalledWith(123);
  });

  it('#show/0 → id not > 0 → no openShow', () => {
    setHash('#show/0');
    fireApplyHash();
    expect(mockOpenShow).not.toHaveBeenCalled();
  });

  it('#show/abc → no regex match → no openShow', () => {
    setHash('#show/abc');
    fireApplyHash();
    expect(mockOpenShow).not.toHaveBeenCalled();
  });

  it('#show/ (trailing slash, no id) → no match → no openShow', () => {
    setHash('#show/');
    fireApplyHash();
    expect(mockOpenShow).not.toHaveBeenCalled();
  });

  it('#show/123/extra → anchored regex $ → no match → no openShow', () => {
    setHash('#show/123/extra');
    fireApplyHash();
    expect(mockOpenShow).not.toHaveBeenCalled();
  });

  it('#Show/123 (uppercase S) → case-sensitive regex → no match → no openShow', () => {
    setHash('#Show/123');
    fireApplyHash();
    expect(mockOpenShow).not.toHaveBeenCalled();
  });

  it('#show/123 when currentShowId=123 → no openShow (already there)', () => {
    __setState({ currentShowId: 123 });
    setHash('#show/123');
    fireApplyHash();
    expect(mockOpenShow).not.toHaveBeenCalled();
  });

  it('hashchange event triggers applyHash', () => {
    __setState({ currentView: 'dashboard', currentShowId: null });
    setHash('#stats');
    fireHashchange();
    expect(mockSwitchView).toHaveBeenCalledWith('stats');
  });

  it('setTimeout(applyHash, 0) scheduled during init runs after init completes', async () => {
    vi.resetModules();
    resetMocks();
    setHash('#stats');
    await import('../src/main');
    expect(mockSwitchView).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSwitchView).toHaveBeenCalledWith('stats');
  });

  it('flash dashboard→showDetail: first render() runs before applyHash setTimeout fires (cosmetic)', async () => {
    vi.resetModules();
    resetMocks();
    setHash('#show/42');
    await import('../src/main');
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockOpenShow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockOpenShow).toHaveBeenCalledWith(42);
  });

  it('unknown hash like "#foo" → no switchView, no openShow', () => {
    setHash('#foo');
    fireApplyHash();
    expect(mockSwitchView).not.toHaveBeenCalled();
    expect(mockOpenShow).not.toHaveBeenCalled();
  });
});

describe.skipIf(!isMainConfig)('main.ts — SW registration (prod)', () => {
  let originalServiceWorker: any;

  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    vi.resetModules();
    originalServiceWorker = (navigator as any).serviceWorker;
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {},
      configurable: true,
    });
    vi.stubEnv('PROD', true);
    vi.stubEnv('DEV', false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    document.documentElement.classList.remove('pwa-standalone');
    reloadButtons().forEach((b) => b.remove());
    if (originalServiceWorker === undefined) {
      delete (navigator as any).serviceWorker;
    } else {
      Object.defineProperty(navigator, 'serviceWorker', {
        value: originalServiceWorker,
        configurable: true,
      });
    }
  });

  it('PROD: registerSW called with onNeedRefresh/onRegistered/onRegisterError callbacks', async () => {
    await import('../src/main');
    expect(mockRegisterSW).toHaveBeenCalledTimes(1);
    const opts = mockRegisterSW.mock.calls[0][0];
    expect(opts).toHaveProperty('immediate', true);
    expect(typeof opts.onNeedRefresh).toBe('function');
    expect(typeof opts.onRegistered).toBe('function');
    expect(typeof opts.onRegisterError).toBe('function');
  });

  it('PROD: window.__ploppytvUpdateSW exposed and calls updateSW(true)', async () => {
    await import('../src/main');
    const w = window as unknown as { __ploppytvUpdateSW?: () => Promise<void> };
    expect(typeof w.__ploppytvUpdateSW).toBe('function');
    await w.__ploppytvUpdateSW!();
    expect(mockUpdateSW).toHaveBeenCalledWith(true);
  });

  it('PROD: onNeedRefresh shows toast + appends a reload button', async () => {
    await import('../src/main');
    const opts = mockRegisterSW.mock.calls[0][0];
    opts.onNeedRefresh();
    expect(mockShowToast).toHaveBeenCalledWith(
      'Nuova versione disponibile (vedi pulsante in basso a destra)',
      'warning',
    );
    expect(reloadButtons().length).toBe(1);
    expect(reloadButtons()[0].textContent).toBe('Aggiorna ora');
  });

  it('FIX-18-03: onNeedRefresh fires MULTIPLE times → only ONE button shown (dedup); toast re-shown each time to remind user', async () => {
    await import('../src/main');
    const opts = mockRegisterSW.mock.calls[0][0];
    opts.onNeedRefresh();
    opts.onNeedRefresh();
    opts.onNeedRefresh();
    expect(reloadButtons().length).toBe(1);
    // Toast is re-fired on each onNeedRefresh to remind the user.
    expect(mockShowToast).toHaveBeenCalledTimes(3);
  });

  it('reloadBtn.onclick calls updateSW(true) then window.location.reload', async () => {
    await import('../src/main');
    // Stub window.location.reload via spyOn (jsdom's reload may be configurable in some versions)
    try {
      vi.spyOn(window.location, 'reload' as never, undefined as never).mockImplementation((() => {
        /* reload stubbed */
      }) as never);
    } catch {
      // If not configurable, just track that updateSW was called. reload will
      // throw "Not implemented" inside async handler — that's after our assertion.
    }
    const opts = mockRegisterSW.mock.calls[0][0];
    opts.onNeedRefresh();
    const btn = reloadButtons()[0];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Trigger the click handler — main.ts assigns `btn.onclick = async () => {...}`
    const clickHandler = btn.onclick as unknown as (ev: Event) => Promise<void>;
    await clickHandler(new Event('click'));
    expect(mockUpdateSW).toHaveBeenCalledWith(true);
    spy.mockRestore();
  });

  it('reloadBtn auto-removed after 30s; dedup flag reset so a later onNeedRefresh can show button again', async () => {
    await import('../src/main');
    const opts = mockRegisterSW.mock.calls[0][0];
    opts.onNeedRefresh();
    expect(reloadButtons().length).toBe(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(reloadButtons().length).toBe(0);
    // FIX-18-03 follow-up: after the auto-remove timer fires, the dedup
    // flag is cleared, so a subsequent onNeedRefresh can show a fresh
    // button (e.g., a second SW update arrives later).
    opts.onNeedRefresh();
    expect(reloadButtons().length).toBe(1);
  });

  it('FIX-18-04: reloadBtn.onclick catches updateSW rejection — reload still runs, no unhandled rejection', async () => {
    await import('../src/main');
    mockUpdateSW.mockImplementationOnce(() => Promise.reject(new Error('SW skipWaiting failed')));
    // Stub reload so the handler doesn't throw "Not implemented" inside jsdom.
    try {
      vi.spyOn(window.location, 'reload' as never, undefined as never).mockImplementation((() => {
        /* reload stubbed */
      }) as never);
    } catch {
      // reload not configurable — that's fine, the try/catch around updateSW
      // is what we're verifying; the subsequent reload() throw is caught by
      // the test's await below only if it propagates.
    }
    const opts = mockRegisterSW.mock.calls[0][0];
    opts.onNeedRefresh();
    const btn = reloadButtons()[0];
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clickHandler = btn.onclick as unknown as (ev: Event) => Promise<void>;
    // FIX: the handler catches the updateSW rejection; it should resolve
    // (not reject) and log a warning.
    await expect(clickHandler(new Event('click'))).resolves.toBeUndefined();
    expect(mockUpdateSW).toHaveBeenCalledWith(true);
    expect(console.warn).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('onRegisterError logs a warning', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await import('../src/main');
    const opts = mockRegisterSW.mock.calls[0][0];
    opts.onRegisterError(new Error('SW register failed'));
    expect(console.warn).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('onRegistered is intentionally silent (no log)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await import('../src/main');
    const opts = mockRegisterSW.mock.calls[0][0];
    opts.onRegistered(undefined);
    expect(console.log).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('NO serviceWorker in navigator → SW block skipped, registerSW NOT called', async () => {
    delete (navigator as any).serviceWorker;
    vi.resetModules();
    await import('../src/main');
    expect(mockRegisterSW).not.toHaveBeenCalled();
  });
});

describe.skipIf(!isMainConfig)('main.ts — SW registration (dev)', () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubEnv('PROD', false);
    vi.stubEnv('DEV', true);
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {},
      configurable: true,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete (navigator as any).serviceWorker;
    document.documentElement.classList.remove('pwa-standalone');
  });

  it('DEV: registerSW NOT called (skipped)', async () => {
    await import('../src/main');
    expect(mockRegisterSW).not.toHaveBeenCalled();
  });

  it('DEV: window.__ploppytv_state exposed for debugging', async () => {
    await import('../src/main');
    const w = window as unknown as { __ploppytv_state?: unknown };
    expect(typeof w.__ploppytv_state).toBe('function');
  });
});

describe.skipIf(!isMainConfig)('main.ts — beforeunload', () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove('pwa-standalone');
  });

  it('beforeunload fires saveData with {immediate:true}', async () => {
    await import('../src/main');
    fireBeforeunload();
    expect(mockSaveData).toHaveBeenCalledWith({ immediate: true });
  });

  it('FIX-18-05 (H14): beforeunload handler still calls saveData when it returns false (CAS fail) — try/catch wrapper does not suppress the call', async () => {
    mockSaveData.mockReturnValue(false); // CAS fail / quota fail
    await import('../src/main');
    fireBeforeunload();
    expect(mockSaveData).toHaveBeenCalledWith({ immediate: true });
    // The return value is still ignored (no preventDefault, no retry), but
    // the C3 fix ensures the listener only runs after data is loaded, so
    // the false return no longer risks overwriting valid localStorage with
    // empty state — the worst case is the user's last edits in THIS tab
    // are not persisted on close, which is acceptable for a best-effort save.
  });

  it('FIX-18-06: beforeunload handler wraps saveData in try/catch (code-reading — runtime throws no longer escape as uncaught exceptions)', () => {
    const src = readFileSync(
      resolve(__dirname, '../src/main.ts'),
      'utf8',
    );
    // The beforeunload listener is now a multi-statement block with try/catch.
    // Match the full `window.addEventListener('beforeunload', () => { ... })`
    // call, accounting for nested braces.
    const startIdx = src.indexOf("window.addEventListener('beforeunload'");
    expect(startIdx, 'beforeunload listener not found').toBeGreaterThanOrEqual(0);
    // Find the matching closing paren by brace counting from the first `{`.
    const firstBrace = src.indexOf('{', startIdx);
    let depth = 0;
    let endIdx = -1;
    for (let i = firstBrace; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          // Skip trailing whitespace; the next ')' closes the addEventListener call.
          const closeParen = src.indexOf(')', i);
          endIdx = closeParen >= 0 ? closeParen + 1 : i + 1;
          break;
        }
      }
    }
    expect(endIdx, 'could not parse beforeunload block').toBeGreaterThan(startIdx);
    const block = src.slice(startIdx, endIdx);
    expect(block).toContain('saveData');
    expect(block).toContain('immediate: true');
    // FIX: try/catch is now present.
    expect(block).toMatch(/\btry\s*\{/);
    expect(block).toMatch(/\bcatch\s*\(/);
  });
});

describe.skipIf(!isMainConfig)('main.ts — preloadDiscover', () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove('pwa-standalone');
  });

  it('preloadDiscover scheduled after 1.5s when isStorageOK', async () => {
    mockIsStorageOK.mockReturnValue(true);
    await import('../src/main');
    expect(mockPreloadDiscover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockPreloadDiscover).toHaveBeenCalledTimes(1);
  });

  it('preloadDiscover NOT scheduled when !isStorageOK', async () => {
    mockIsStorageOK.mockReturnValue(false);
    await import('../src/main');
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockPreloadDiscover).not.toHaveBeenCalled();
  });

  it('preloadDiscover throw is caught (no uncaught exception)', async () => {
    mockPreloadDiscover.mockImplementation(() => {
      throw new Error('discover boom');
    });
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await import('../src/main');
    expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
    expect(console.warn).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('preloadDiscover runs only ONCE (setTimeout, not interval)', async () => {
    mockIsStorageOK.mockReturnValue(true);
    await import('../src/main');
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockPreloadDiscover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockPreloadDiscover).toHaveBeenCalledTimes(1);
  });

  it('preloadDiscover does NOT run before 1.5s (no race with init render)', async () => {
    mockIsStorageOK.mockReturnValue(true);
    await import('../src/main');
    await vi.advanceTimersByTimeAsync(1499);
    expect(mockPreloadDiscover).not.toHaveBeenCalled();
  });
});

describe.skipIf(!isMainConfig)('main.ts — standalone detection', () => {
  let originalMatchMedia: any;
  let originalStandalone: any;

  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    vi.resetModules();
    originalMatchMedia = window.matchMedia;
    originalStandalone = (navigator as any).standalone;
    document.documentElement.classList.remove('pwa-standalone');
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove('pwa-standalone');
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia;
    } else {
      delete (window as any).matchMedia;
    }
    if (originalStandalone === undefined) {
      delete (navigator as any).standalone;
    } else {
      (navigator as any).standalone = originalStandalone;
    }
  });

  it('navigator.standalone=true → adds pwa-standalone class', async () => {
    (navigator as any).standalone = true;
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as any;
    await import('../src/main');
    expect(document.documentElement.classList.contains('pwa-standalone')).toBe(true);
  });

  it('matchMedia(display-mode: standalone).matches=true → adds pwa-standalone class', async () => {
    (navigator as any).standalone = undefined;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as any;
    await import('../src/main');
    expect(document.documentElement.classList.contains('pwa-standalone')).toBe(true);
    expect(window.matchMedia).toHaveBeenCalledWith('(display-mode: standalone)');
  });

  it('neither standalone signal → no class added', async () => {
    (navigator as any).standalone = undefined;
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as any;
    await import('../src/main');
    expect(document.documentElement.classList.contains('pwa-standalone')).toBe(false);
  });

  it('matchMedia undefined → no throw, no class', async () => {
    (navigator as any).standalone = undefined;
    delete (window as any).matchMedia;
    await import('../src/main');
    expect(document.documentElement.classList.contains('pwa-standalone')).toBe(false);
  });
});

describe.skipIf(!isMainConfig)('main.ts — double init (HMR / re-import)', () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove('pwa-standalone');
  });

  it('without vi.resetModules, second import returns cached module — init runs ONCE', async () => {
    await import('../src/main');
    await import('../src/main');
    expect(mockInitModal).toHaveBeenCalledTimes(1);
    expect(mockInitRenderer).toHaveBeenCalledTimes(1);
  });

  it('FIX-18-08: idempotency guard — with vi.resetModules between imports, init still runs ONCE (no duplicate listeners, no double save on beforeunload)', async () => {
    await import('../src/main');
    vi.resetModules();
    await import('../src/main');
    // FIX: the __ploppytvInit flag on window survives vi.resetModules(), so
    // the second import's init() call short-circuits immediately.
    expect(mockInitModal).toHaveBeenCalledTimes(1);
    expect(mockInitRenderer).toHaveBeenCalledTimes(1);
    expect(mockLoadData).toHaveBeenCalledTimes(1);
    expect(mockRender).toHaveBeenCalledTimes(1);
    // beforeunload listener added ONCE → saveData called once on one event
    fireBeforeunload();
    expect(mockSaveData).toHaveBeenCalledTimes(1);
  });

  it('FIX-18-08: idempotency guard — applyHash fires ONCE on hashchange (single handler even after re-import)', async () => {
    mockIsStorageOK.mockReturnValue(true);
    await import('../src/main');
    vi.resetModules();
    await import('../src/main');
    __setState({ currentView: 'dashboard', currentShowId: null });
    setHash('#stats');
    fireHashchange();
    expect(mockSwitchView).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!isMainConfig)('main.ts — render/subscribe/loadData ordering', () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove('pwa-standalone');
  });

  it('render() called BEFORE subscribe(render) — first render uses initial state', async () => {
    await import('../src/main');
    expect(mockRender.mock.invocationCallOrder[0]).toBeLessThan(
      mockSubscribe.mock.invocationCallOrder[0],
    );
  });

  it('subscribe receives a function (the render callback)', async () => {
    await import('../src/main');
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    const cb = mockSubscribe.mock.calls[0][0];
    expect(typeof cb).toBe('function');
  });

  it('loadData called BEFORE render — render sees loaded shows', async () => {
    await import('../src/main');
    expect(mockLoadData.mock.invocationCallOrder[0]).toBeLessThan(
      mockRender.mock.invocationCallOrder[0],
    );
  });

  it('updateBadges called AFTER loadData (so badges reflect loaded data)', async () => {
    await import('../src/main');
    expect(mockLoadData.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateBadges.mock.invocationCallOrder[0],
    );
  });
});
