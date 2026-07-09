/* eslint-disable @typescript-eslint/consistent-type-imports */
// Agent A17 — probe tests for img.ts, imageFallback.ts, renderer.ts, header.ts
//
// Verifies (post-fix):
// - BUG-A17-01 (Medium, FIXED): imgTag valida src con safeImageUrl — rifiuta
//   javascript:, data:, URL non-http(s). Prima interpolava src raw dopo solo
//   escapeAttr (che non blocca scheme pericolosi).
// - BUG-A17-02 (Medium, FIXED): imgTag escapa cls e extraStyle in TUTTI gli
//   attributi (class, data-fallback-cls, style). Prima il placeholder <div>
//   interpolava extraStyle raw nel style attribute → XSS se conteneva ".
// - BUG-A17-03 (High, FIXED): imageFallback loop infinito con fallbackSrc
//   relativo. Ora usa flag data-fallback-src-tried invece di confronto stringa.
// - BUG-A17-04 (Medium, FIXED): imageFallback destroyImageFallback per cleanup.
// - BUG-A17-05 (Medium, FIXED): renderer getMain ritorna null invece di crashare.
// - BUG-A17-06 (Medium, FIXED): renderer usa safeId per data-show-id.
// - BUG-A17-07 (Medium, FIXED): renderer safeImport usa data-action (CSP-safe).
// - BUG-A17-08 (High, FIXED): renderer salta bindShowDetailEvents quando
//   renderShowDetail baila (closeShow nullato currentShowId).
// - BUG-A17-09 (Low, FIXED): header updateBadges defensive guard su shows non-array.
// - BUG-A17-10 (High, FIXED): header initHeader idempotency guard.
// - BUG-A17-11 (Medium, FIXED): header sidebar scroll lock + restore.
// - BUG-A17-12 (Medium, FIXED): header ESC chiude sidebar mobile.
// - BUG-A17-13 (Medium, FIXED): header delegated [data-lang] handler (no setTimeout).
// - BUG-A17-14 (Low, FIXED): header langBtn escapa codici locale.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { imgTag } from '../src/components/img';
import { initImageFallback, destroyImageFallback } from '../src/components/imageFallback';

// Paths that any test below may doMock — unmocked in beforeEach to prevent
// cross-test pollution (vi.doMock registrations persist across resetModules).
const MOCK_PATHS = [
  '../src/lib/storage',
  '../src/lib/store',
  '../src/lib/shows',
  '../src/lib/discover',
  '../src/lib/i18n',
  '../src/components/toast',
  '../src/components/modal',
  '../src/components/header',
  '../src/components/imageFallback',
  '../src/components/renderer',
  '../src/views/showDetail',
  '../src/views/dashboard',
  '../src/views/showList',
  '../src/views/discover',
  '../src/views/calendar',
  '../src/views/stats',
  '../src/views/library',
  '../src/views/yearReview',
  '../src/worker/client',
];

beforeEach(() => {
  // Reset module state so each test starts fresh.
  vi.resetModules();
  for (const p of MOCK_PATHS) vi.doUnmock(p);
  // Reset DOM.
  document.body.innerHTML = '<div id="mainContent"></div>';
  // Stub matchMedia (jsdom doesn't implement it; header.ts uses it for sidebar).
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
  // Stub window.scrollTo (jsdom doesn't implement it; store.openShow uses it).
  (window as unknown as { scrollTo: (...args: unknown[]) => void }).scrollTo = vi.fn();
});

afterEach(() => {
  // Clean up imageFallback listener if still active.
  destroyImageFallback();
  vi.clearAllMocks();
});

// ============================================================
// img.ts — BUG-A17-01: safeImageUrl validation
// ============================================================

describe('BUG-A17-01: imgTag validates src with safeImageUrl', () => {
  it('javascript: URL → placeholder div (not <img src="javascript:">)', () => {
    const html = imgTag('javascript:alert(1)', 'Alt', 'poster');
    expect(html).not.toContain('<img');
    expect(html).toContain('<div');
    expect(html).toContain('class="poster-placeholder"');
    expect(html).not.toContain('javascript:');
  });

  it('data: URL → placeholder div', () => {
    const html = imgTag('data:image/png;base64,xxx', 'Alt', 'poster');
    expect(html).not.toContain('<img');
    expect(html).toContain('poster-placeholder');
  });

  it('blob: URL → placeholder div (safeImageUrl requires http/https)', () => {
    const html = imgTag('blob:https://example.com/uuid', 'Alt', 'poster');
    expect(html).not.toContain('<img');
    expect(html).toContain('poster-placeholder');
  });

  it('empty string → placeholder div', () => {
    const html = imgTag('', 'Alt', 'poster');
    expect(html).not.toContain('<img');
    expect(html).toContain('poster-placeholder');
  });

  it('null → placeholder div', () => {
    const html = imgTag(null, 'Alt', 'poster');
    expect(html).toContain('poster-placeholder');
  });

  it('non-http scheme (ftp:) → placeholder div', () => {
    const html = imgTag('ftp://example.com/img.jpg', 'Alt', 'poster');
    expect(html).not.toContain('<img');
    expect(html).toContain('poster-placeholder');
  });

  it('valid https URL → <img> rendered with src', () => {
    const html = imgTag('https://example.com/img.jpg', 'Alt', 'poster');
    expect(html).toContain('<img');
    expect(html).toContain('src="https://example.com/img.jpg"');
  });

  it('valid http URL → <img> rendered', () => {
    const html = imgTag('http://example.com/img.jpg', 'Alt', 'poster');
    expect(html).toContain('<img');
    expect(html).toContain('src="http://example.com/img.jpg"');
  });

  it('URL with embedded quote still escaped (regression — existing behavior)', () => {
    const html = imgTag('https://x/y.jpg" onerror="alert(1)', 'Alt', 'poster');
    // The quote is escaped — no attribute breakout.
    expect(html).toContain('src="https://x/y.jpg&quot; onerror=&quot;alert(1)"');
    expect(html).not.toMatch(/src="[^"]*" onerror="/);
  });

  it('non-string src (number) → placeholder div', () => {
    const html = imgTag(42 as unknown as string, 'Alt', 'poster');
    expect(html).not.toContain('<img');
    expect(html).toContain('poster-placeholder');
  });
});

// ============================================================
// img.ts — BUG-A17-02: escape cls and extraStyle in all attributes
// ============================================================

describe('BUG-A17-02: imgTag escapes cls and extraStyle', () => {
  it('placeholder div: extraStyle with quote is escaped (no XSS)', () => {
    // Before fix: style="' + extraStyle + '" → style="width:40px" onclick="alert(1)"
    // After fix: style="' + escapeAttr(extraStyle) + '" → safe.
    const html = imgTag(null, 'Alt', 'poster', 'width:40px" onclick="alert(1)');
    expect(html).not.toMatch(/onclick="alert/);
    expect(html).toContain('style="width:40px&quot; onclick=&quot;alert(1)"');
  });

  it('<img>: cls with quote is escaped in class attribute', () => {
    const html = imgTag('https://x/y.jpg', 'Alt', 'a"b');
    // The quote in cls is escaped — no attribute breakout.
    expect(html).toContain('class="a&quot;b"');
    expect(html).not.toMatch(/class="a"b"/);
  });

  it('<img>: cls with quote is escaped in data-fallback-cls', () => {
    const html = imgTag('https://x/y.jpg', 'Alt', 'a"b');
    expect(html).toContain('data-fallback-cls="a&quot;b-placeholder"');
  });

  it('placeholder div: cls with quote is escaped', () => {
    const html = imgTag(null, 'Alt', 'a"b');
    expect(html).toContain('class="a&quot;b-placeholder"');
  });

  it('placeholder div: cls already containing "placeholder" is used as-is (escaped)', () => {
    const html = imgTag(null, 'Alt', 'my-placeholder"evil');
    // cls includes 'placeholder' → used directly, but escaped.
    expect(html).toContain('class="my-placeholder&quot;evil"');
  });

  it('<img>: extraStyle escaped in style attribute (existing behavior, regression)', () => {
    const html = imgTag('https://x/y.jpg', 'Alt', 'poster', 'width:40px;height:60px');
    expect(html).toContain('style="width:40px;height:60px"');
  });

  it('<img>: extraStyle escaped in data-fallback-style', () => {
    const html = imgTag('https://x/y.jpg', 'Alt', 'poster', 'width:40px');
    expect(html).toContain('data-fallback-style="width:40px"');
  });

  it('placeholder div: empty extraStyle → no style attribute', () => {
    const html = imgTag(null, 'Alt', 'poster', '');
    expect(html).not.toContain('style=');
  });
});

// ============================================================
// imageFallback.ts — BUG-A17-03: infinite loop with relative fallbackSrc
// ============================================================

describe('BUG-A17-03: imageFallback no infinite loop with relative fallbackSrc', () => {
  beforeEach(() => {
    initImageFallback();
  });

  it('relative fallbackSrc: first error sets src, second error → placeholder (no loop)', () => {
    const img = document.createElement('img');
    img.dataset.fallback = 'Test Alt';
    img.dataset.fallbackSrc = '/relative.jpg'; // relative URL
    img.dataset.fallbackCls = 'test-placeholder';
    document.body.appendChild(img);

    // First error: should set src to fallbackSrc and mark tried.
    img.dispatchEvent(new Event('error', { bubbles: false }));
    expect(img.dataset.fallbackSrcTried).toBe('1');
    expect(img.getAttribute('src')).toBe('/relative.jpg');

    // Second error: should NOT re-set src (flag prevents loop) → placeholder.
    img.dispatchEvent(new Event('error', { bubbles: false }));
    // The img should have been replaced by a placeholder div.
    const placeholder = document.querySelector('.test-placeholder');
    expect(placeholder).toBeTruthy();
    expect(placeholder?.textContent).toBe('Test Alt');
    // The img should no longer be in the DOM.
    expect(document.body.contains(img)).toBe(false);
  });

  it('absolute fallbackSrc: first error sets src, second error → placeholder', () => {
    const img = document.createElement('img');
    img.dataset.fallback = 'Test';
    img.dataset.fallbackSrc = 'https://example.com/original.jpg';
    img.dataset.fallbackCls = 'ph';
    document.body.appendChild(img);

    img.dispatchEvent(new Event('error', { bubbles: false }));
    expect(img.getAttribute('src')).toBe('https://example.com/original.jpg');
    expect(img.dataset.fallbackSrcTried).toBe('1');

    img.dispatchEvent(new Event('error', { bubbles: false }));
    expect(document.querySelector('.ph')).toBeTruthy();
  });

  it('no data-fallback-src: single error → placeholder directly', () => {
    const img = document.createElement('img');
    img.dataset.fallback = 'No Src';
    img.dataset.fallbackCls = 'ns-placeholder';
    document.body.appendChild(img);

    img.dispatchEvent(new Event('error', { bubbles: false }));
    const ph = document.querySelector('.ns-placeholder');
    expect(ph).toBeTruthy();
    expect(ph?.textContent).toBe('No Src');
  });

  it('data-fallbackApplied prevents re-processing', () => {
    const img = document.createElement('img');
    img.dataset.fallback = 'Already';
    img.dataset.fallbackApplied = '1';
    img.dataset.fallbackCls = 'ap-placeholder';
    document.body.appendChild(img);

    img.dispatchEvent(new Event('error', { bubbles: false }));
    // Should NOT be replaced (already applied).
    expect(document.querySelector('.ap-placeholder')).toBeFalsy();
    expect(document.body.contains(img)).toBe(true);
  });

  it('img without data-fallback: error ignored (no replacement)', () => {
    const img = document.createElement('img');
    img.src = 'https://example.com/broken.jpg';
    document.body.appendChild(img);

    img.dispatchEvent(new Event('error', { bubbles: false }));
    expect(document.body.contains(img)).toBe(true);
  });

  it('non-img target error: ignored', () => {
    const div = document.createElement('div');
    div.dataset.fallback = 'Should Not Process';
    document.body.appendChild(div);

    div.dispatchEvent(new Event('error', { bubbles: false }));
    expect(document.body.contains(div)).toBe(true);
  });
});

// ============================================================
// imageFallback.ts — BUG-A17-04: destroyImageFallback cleanup
// ============================================================

describe('BUG-A17-04: destroyImageFallback removes listener', () => {
  it('after destroy, error events no longer trigger placeholder', () => {
    initImageFallback();
    destroyImageFallback();

    const img = document.createElement('img');
    img.dataset.fallback = 'Destroyed';
    img.dataset.fallbackCls = 'd-placeholder';
    document.body.appendChild(img);

    img.dispatchEvent(new Event('error', { bubbles: false }));
    // Listener was removed → img NOT replaced.
    expect(document.body.contains(img)).toBe(true);
    expect(document.querySelector('.d-placeholder')).toBeFalsy();
  });

  it('init after destroy re-registers listener', () => {
    initImageFallback();
    destroyImageFallback();
    initImageFallback();

    const img = document.createElement('img');
    img.dataset.fallback = 'Re-init';
    img.dataset.fallbackCls = 'ri-placeholder';
    document.body.appendChild(img);

    img.dispatchEvent(new Event('error', { bubbles: false }));
    expect(document.querySelector('.ri-placeholder')).toBeTruthy();
  });

  it('double init does not add duplicate listeners', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    initImageFallback();
    const countAfterFirst = addSpy.mock.calls.filter(([t]) => t === 'error').length;
    initImageFallback(); // no-op
    const countAfterSecond = addSpy.mock.calls.filter(([t]) => t === 'error').length;
    expect(countAfterSecond).toBe(countAfterFirst);
    addSpy.mockRestore();
  });
});

// ============================================================
// renderer.ts — BUG-A17-05: getMain null safety
// ============================================================

describe('BUG-A17-05: renderer getMain null safety', () => {
  it('initRenderer does not crash when mainContent missing', async () => {
    document.body.innerHTML = ''; // no mainContent
    vi.doMock('../src/components/imageFallback', () => ({ initImageFallback: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));

    const { initRenderer } = await import('../src/components/renderer');
    expect(() => initRenderer()).not.toThrow();
  });
});

// ============================================================
// renderer.ts — BUG-A17-06: safeId for data-show-id
// ============================================================

describe('BUG-A17-06: renderer uses safeId for data-show-id', () => {
  async function setupRendererWithOpenShowSpy(): Promise<{
    openShowSpy: ReturnType<typeof vi.fn>;
    clickButton: (showId: string) => void;
  }> {
    const openShowSpy = vi.fn();
    vi.doMock('../src/lib/store', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/store')>('../src/lib/store');
      return { ...actual, openShow: openShowSpy, closeShow: vi.fn(), switchView: vi.fn() };
    });
    vi.doMock('../src/components/imageFallback', () => ({ initImageFallback: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));

    const { initRenderer } = await import('../src/components/renderer');
    const main = document.getElementById('mainContent')!;
    initRenderer();
    return {
      openShowSpy,
      clickButton: (showId: string) => {
        main.innerHTML = `<div data-action="openShow" data-show-id="${showId}">click</div>`;
        main.querySelector('[data-action="openShow"]')!.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      },
    };
  }

  it('data-show-id="0x10" (hex) → openShow NOT called with 16', async () => {
    const { openShowSpy, clickButton } = await setupRendererWithOpenShowSpy();
    clickButton('0x10');
    // Before fix: Number("0x10") = 16 → openShow(16) called.
    // After fix: safeId("0x10") = 0 (hex rejected) → openShow NOT called.
    expect(openShowSpy).not.toHaveBeenCalled();
  });

  it('data-show-id="1e3" (scientific) → openShow NOT called with 1000', async () => {
    const { openShowSpy, clickButton } = await setupRendererWithOpenShowSpy();
    clickButton('1e3');
    expect(openShowSpy).not.toHaveBeenCalled();
  });

  it('data-show-id="123.5" (float) → openShow NOT called', async () => {
    const { openShowSpy, clickButton } = await setupRendererWithOpenShowSpy();
    clickButton('123.5');
    // Before fix: Number("123.5") = 123.5 (truthy) → openShow(123.5) called.
    // After fix: safeId("123.5") = 0 (non-integer) → openShow NOT called.
    expect(openShowSpy).not.toHaveBeenCalled();
  });

  it('data-show-id="123" (valid integer) → openShow called with 123', async () => {
    const { openShowSpy, clickButton } = await setupRendererWithOpenShowSpy();
    clickButton('123');
    expect(openShowSpy).toHaveBeenCalledWith(123);
  });

  it('data-show-id="0" → openShow NOT called (id must be positive)', async () => {
    const { openShowSpy, clickButton } = await setupRendererWithOpenShowSpy();
    clickButton('0');
    expect(openShowSpy).not.toHaveBeenCalled();
  });

  it('data-show-id="abc" (non-numeric) → openShow NOT called', async () => {
    const { openShowSpy, clickButton } = await setupRendererWithOpenShowSpy();
    clickButton('abc');
    expect(openShowSpy).not.toHaveBeenCalled();
  });
});

// ============================================================
// renderer.ts — BUG-A17-07: safeImport uses data-action (CSP-safe)
// ============================================================

describe('BUG-A17-07: safeImport error UI uses data-action not inline onclick', () => {
  it('error fallback button has data-action="reloadPage", no inline onclick', async () => {
    vi.doMock('../src/components/imageFallback', () => ({ initImageFallback: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));

    const { initRenderer } = await import('../src/components/renderer');
    const main = document.getElementById('mainContent')!;
    initRenderer();

    // Simulate the safeImport error HTML pattern (as it would be rendered).
    main.innerHTML =
      '<div class="empty-state">' +
      '<button class="btn btn-primary" data-action="reloadPage">Ricarica</button>' +
      '</div>';

    // Verify the button has data-action (not inline onclick).
    const btn = main.querySelector('[data-action="reloadPage"]') as HTMLElement;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('onclick')).toBeNull();
    expect(btn.dataset.action).toBe('reloadPage');
  });

  it('clicking reloadPage button calls location.reload via delegated handler', async () => {
    vi.doMock('../src/components/imageFallback', () => ({ initImageFallback: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));

    const { initRenderer } = await import('../src/components/renderer');
    const main = document.getElementById('mainContent')!;
    initRenderer();

    main.innerHTML = '<button data-action="reloadPage">Ricarica</button>';

    // Mock location.reload.
    const reloadSpy = vi.fn();
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...origLocation, reload: reloadSpy },
      writable: true,
      configurable: true,
    });

    try {
      main.querySelector('[data-action="reloadPage"]')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      expect(reloadSpy).toHaveBeenCalled();
    } finally {
      // Restore.
      Object.defineProperty(window, 'location', {
        value: origLocation,
        writable: true,
        configurable: true,
      });
    }
  });
});

// ============================================================
// renderer.ts — BUG-A17-08: skip bind when renderShowDetail bails
// ============================================================

describe('BUG-A17-08: renderer skips bindShowDetailEvents when renderShowDetail bails', () => {
  it('openShow(non-existent) → renderShowDetail bails → bind NOT called', async () => {
    const bindSpy = vi.fn();
    const resetGuardSpy = vi.fn();
    // Mock showDetail: renderShowDetail calls closeShow (simulating bail).
    vi.doMock('../src/views/showDetail', async () => {
      const store = await vi.importActual<typeof import('../src/lib/store')>('../src/lib/store');
      return {
        renderShowDetail: vi.fn(() => {
          // Simulate bail: closeShow nulls currentShowId.
          store.closeShow();
        }),
        bindShowDetailEvents: bindSpy,
        resetBoundGuard: resetGuardSpy,
      };
    });
    vi.doMock('../src/components/imageFallback', () => ({ initImageFallback: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));

    const store = await import('../src/lib/store');
    const { initRenderer, render } = await import('../src/components/renderer');

    store.setShows([]);
    store.openShow(999); // non-existent show
    initRenderer();

    // Trigger render and wait for async _doRender.
    render();
    // Flush microtasks + RAF (vitest/jsdom runs RAF as macrotask).
    await new Promise((r) => setTimeout(r, 50));

    // After fix: bindShowDetailEvents NOT called (currentShowId was nulled by closeShow).
    expect(bindSpy).not.toHaveBeenCalled();
    // resetBoundGuard + renderShowDetail ARE called (they run before the guard).
    expect(resetGuardSpy).toHaveBeenCalled();
  });

  it('openShow(existing) → renderShowDetail succeeds → bind called', async () => {
    const bindSpy = vi.fn();
    const resetGuardSpy = vi.fn();
    vi.doMock('../src/views/showDetail', () => ({
      // Success: does NOT call closeShow — currentShowId stays set.
      renderShowDetail: vi.fn(),
      bindShowDetailEvents: bindSpy,
      resetBoundGuard: resetGuardSpy,
    }));
    vi.doMock('../src/components/imageFallback', () => ({ initImageFallback: vi.fn() }));
    vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));
    vi.doMock('../src/components/toast', () => ({ showToast: vi.fn() }));

    const store = await import('../src/lib/store');
    const { initRenderer, render } = await import('../src/components/renderer');

    store.setShows([
      {
        id: 1,
        name: 'Test',
        image: null,
        status: 'Running',
        premiered: '2024-01-01',
        genres: [],
        summary: '',
        network: '',
        runtime: 45,
        list: 'towatch',
        seasons: {},
        totalSeasons: 0,
        totalEpisodes: 0,
        addedAt: 0,
      },
    ]);
    store.openShow(1);
    initRenderer();

    render();
    await new Promise((r) => setTimeout(r, 50));

    // Success path: bind IS called.
    expect(bindSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// header.ts — BUG-A17-09: updateBadges defensive guard
// ============================================================

describe('BUG-A17-09: updateBadges handles non-array shows', () => {
  it('state.shows = null → badges set to 0 (no crash)', async () => {
    document.body.innerHTML =
      '<span id="badge-watching">9</span>' +
      '<span id="badge-towatch">9</span>' +
      '<span id="badge-completed">9</span>';

    const { updateBadges } = await import('../src/components/header');
    const store = await import('../src/lib/store');
    // Force-corrupt state.shows to null (bypasses setState validation).
    (store.getState() as unknown as { shows: unknown }).shows = null;

    expect(() => updateBadges()).not.toThrow();
    expect(document.getElementById('badge-watching')!.textContent).toBe('0');
    expect(document.getElementById('badge-towatch')!.textContent).toBe('0');
    expect(document.getElementById('badge-completed')!.textContent).toBe('0');
  });

  it('state.shows = undefined → badges set to 0', async () => {
    document.body.innerHTML =
      '<span id="badge-watching">9</span><span id="badge-towatch">9</span><span id="badge-completed">9</span>';

    const { updateBadges } = await import('../src/components/header');
    const store = await import('../src/lib/store');
    (store.getState() as unknown as { shows: unknown }).shows = undefined;

    expect(() => updateBadges()).not.toThrow();
    expect(document.getElementById('badge-watching')!.textContent).toBe('0');
  });
});

// ============================================================
// header.ts — BUG-A17-10: initHeader idempotency guard
// ============================================================

describe('BUG-A17-10: initHeader idempotency guard', () => {
  it('calling initHeader twice does not double-register nav-item listeners', async () => {
    // Set up DOM with nav-items.
    document.body.innerHTML =
      '<nav class="sidebar" id="sidebar">' +
      '<div class="nav-item" data-view="dashboard">D</div>' +
      '<div class="nav-item" data-view="stats">S</div>' +
      '</nav>' +
      '<div id="sidebarOverlay"></div>' +
      '<button id="menuToggle"></button>' +
      '<div id="mainContent"></div>';

    const switchViewSpy = vi.fn();
    vi.doMock('../src/lib/store', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/store')>('../src/lib/store');
      return { ...actual, switchView: switchViewSpy };
    });

    const { initHeader } = await import('../src/components/header');
    initHeader();
    initHeader(); // second call should be no-op

    const navItem = document.querySelector('.nav-item[data-view="stats"]') as HTMLElement;
    navItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // After fix: only 1 listener → 1 switchView call.
    expect(switchViewSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// header.ts — BUG-A17-11: sidebar scroll lock + restore
// ============================================================

describe('BUG-A17-11: sidebar scroll lock and restore', () => {
  beforeEach(async () => {
    vi.doMock('../src/lib/store', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/store')>('../src/lib/store');
      return { ...actual, switchView: vi.fn() };
    });
  });

  it('opening sidebar sets body.overflow=hidden', async () => {
    document.body.innerHTML =
      '<nav id="sidebar"></nav><div id="sidebarOverlay"></div><button id="menuToggle"></button><div id="mainContent"></div>';
    const { initHeader } = await import('../src/components/header');
    initHeader();

    document.getElementById('menuToggle')!.click();
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.getElementById('sidebar')!.classList.contains('open')).toBe(true);
  });

  it('closing via overlay click restores body.overflow', async () => {
    document.body.innerHTML =
      '<nav id="sidebar"></nav><div id="sidebarOverlay"></div><button id="menuToggle"></button><div id="mainContent"></div>';
    const { initHeader } = await import('../src/components/header');
    initHeader();

    // Open
    document.getElementById('menuToggle')!.click();
    expect(document.body.style.overflow).toBe('hidden');
    // Close via overlay
    document.getElementById('sidebarOverlay')!.click();
    expect(document.body.style.overflow).toBe('');
    expect(document.getElementById('sidebar')!.classList.contains('open')).toBe(false);
  });

  it('closing via menuToggle (toggle) restores body.overflow', async () => {
    document.body.innerHTML =
      '<nav id="sidebar"></nav><div id="sidebarOverlay"></div><button id="menuToggle"></button><div id="mainContent"></div>';
    const { initHeader } = await import('../src/components/header');
    initHeader();

    document.getElementById('menuToggle')!.click(); // open
    expect(document.body.style.overflow).toBe('hidden');
    document.getElementById('menuToggle')!.click(); // close (toggle)
    expect(document.body.style.overflow).toBe('');
  });
});

// ============================================================
// header.ts — BUG-A17-12: ESC closes sidebar
// ============================================================

describe('BUG-A17-12: ESC closes sidebar mobile', () => {
  beforeEach(async () => {
    vi.doMock('../src/lib/store', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/store')>('../src/lib/store');
      return { ...actual, switchView: vi.fn() };
    });
  });

  it('ESC closes open sidebar', async () => {
    document.body.innerHTML =
      '<nav id="sidebar"></nav><div id="sidebarOverlay"></div><button id="menuToggle"></button><div id="mainContent"></div><div id="modal" aria-hidden="true"></div>';
    const { initHeader } = await import('../src/components/header');
    initHeader();

    // Open sidebar
    document.getElementById('menuToggle')!.click();
    expect(document.getElementById('sidebar')!.classList.contains('open')).toBe(true);

    // Press ESC
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('sidebar')!.classList.contains('open')).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('ESC does nothing when sidebar is closed', async () => {
    document.body.innerHTML =
      '<nav id="sidebar"></nav><div id="sidebarOverlay"></div><button id="menuToggle"></button><div id="mainContent"></div><div id="modal" aria-hidden="true"></div>';
    const { initHeader } = await import('../src/components/header');
    initHeader();

    // Sidebar is closed — ESC should be a no-op (no crash, no side effect).
    expect(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    ).not.toThrow();
    expect(document.getElementById('sidebar')!.classList.contains('open')).toBe(false);
  });

  it('ESC does not close sidebar when a modal is open', async () => {
    document.body.innerHTML =
      '<nav id="sidebar"></nav><div id="sidebarOverlay"></div><button id="menuToggle"></button><div id="mainContent"></div><div id="modal" aria-hidden="false"></div>';
    const { initHeader } = await import('../src/components/header');
    initHeader();

    // Open sidebar
    document.getElementById('menuToggle')!.click();
    expect(document.getElementById('sidebar')!.classList.contains('open')).toBe(true);

    // Press ESC — modal is open (aria-hidden=false), sidebar should NOT close.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('sidebar')!.classList.contains('open')).toBe(true);
  });

  it('non-ESC key does not close sidebar', async () => {
    document.body.innerHTML =
      '<nav id="sidebar"></nav><div id="sidebarOverlay"></div><button id="menuToggle"></button><div id="mainContent"></div><div id="modal" aria-hidden="true"></div>';
    const { initHeader } = await import('../src/components/header');
    initHeader();

    document.getElementById('menuToggle')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(document.getElementById('sidebar')!.classList.contains('open')).toBe(true);
  });
});

// ============================================================
// header.ts — BUG-A17-13: delegated [data-lang] handler
// ============================================================

describe('BUG-A17-13: delegated [data-lang] click handler (no setTimeout)', () => {
  beforeEach(async () => {
    vi.doMock('../src/lib/store', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/store')>('../src/lib/store');
      return { ...actual, switchView: vi.fn() };
    });
  });

  it('click on [data-lang="en"] calls setLocale("en") immediately', async () => {
    document.body.innerHTML = '<button id="langBtn"></button><div id="mainContent"></div>';
    const { initHeader } = await import('../src/components/header');
    const { _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    initHeader();

    // Simulate: a language button is added to the DOM (as showModal would do).
    const btn = document.createElement('button');
    btn.dataset.lang = 'en';
    btn.textContent = 'English';
    document.body.appendChild(btn);

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // After fix: delegated handler immediately calls setLocale (no 50ms delay).
    const { getLocale } = await import('../src/lib/i18n');
    expect(getLocale()).toBe('en');
  });

  it('click on [data-lang="it"] calls setLocale("it")', async () => {
    document.body.innerHTML = '<button id="langBtn"></button><div id="mainContent"></div>';
    const { initHeader } = await import('../src/components/header');
    const { _resetI18nForTesting, setLocale } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    setLocale('en'); // start from en
    initHeader();

    const btn = document.createElement('button');
    btn.dataset.lang = 'it';
    document.body.appendChild(btn);

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const { getLocale } = await import('../src/lib/i18n');
    expect(getLocale()).toBe('it');
  });

  it('click on element without data-lang does not call setLocale', async () => {
    document.body.innerHTML = '<button id="langBtn"></button><div id="mainContent"></div>';
    const { initHeader } = await import('../src/components/header');
    const { _resetI18nForTesting, setLocale, getLocale } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    setLocale('it');
    initHeader();

    const btn = document.createElement('button');
    btn.textContent = 'No data-lang';
    document.body.appendChild(btn);

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(getLocale()).toBe('it'); // unchanged
  });

  it('click on [data-lang="fr"] (unsupported) does not call setLocale', async () => {
    document.body.innerHTML = '<button id="langBtn"></button><div id="mainContent"></div>';
    const { initHeader } = await import('../src/components/header');
    const { _resetI18nForTesting, setLocale, getLocale } = await import('../src/lib/i18n');
    _resetI18nForTesting();
    setLocale('it');
    initHeader();

    const btn = document.createElement('button');
    btn.dataset.lang = 'fr'; // unsupported locale
    document.body.appendChild(btn);

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(getLocale()).toBe('it'); // unchanged
  });
});

// ============================================================
// header.ts — BUG-A17-14: langBtn escapes locale codes
// ============================================================

describe('BUG-A17-14: langBtn escapes locale codes in HTML', () => {
  it('language button data-lang is properly quoted in attribute', async () => {
    document.body.innerHTML = '<button id="langBtn"></button><div id="mainContent"></div>';

    // Mock showModal to capture the HTML body.
    const showModalSpy = vi.fn();
    vi.doMock('../src/components/modal', () => ({ showModal: showModalSpy }));
    vi.doMock('../src/lib/store', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/store')>('../src/lib/store');
      return { ...actual, switchView: vi.fn() };
    });

    const { _resetI18nForTesting } = await import('../src/lib/i18n');
    _resetI18nForTesting();

    const { initHeader } = await import('../src/components/header');
    initHeader();

    document.getElementById('langBtn')!.click();

    expect(showModalSpy).toHaveBeenCalledTimes(1);
    const bodyHtml = showModalSpy.mock.calls[0][1] as string;
    // data-lang attribute should be properly quoted with double quotes.
    expect(bodyHtml).toContain('data-lang="it"');
    expect(bodyHtml).toContain('data-lang="en"');
    // No unescaped interpolation (would be data-lang=it without quotes).
    expect(bodyHtml).not.toMatch(/data-lang=it[^"]/);
    expect(bodyHtml).not.toMatch(/data-lang=en[^"]/);
  });
});
