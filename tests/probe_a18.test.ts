// Agent A18 — probe tests for src/main.ts, src/sw.ts, index.html
//
// Questo file gira sotto il DEFAULT vitest.config.ts (non richiede
// vitest.config.main.ts). Verifica via code-reading che i fix BUG-A18-01..10
// siano presenti nei sorgenti, e via runtime (con workbox mockato) che
// BUG-A18-11 (SKIP_WAITING message format) funzioni end-to-end.
//
// I test runtime di main.ts (init order, hash routing, SW registration)
// sono in tests/probe_main.test.ts (gira sotto vitest.config.main.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// =====================================================================
// Mock workbox modules so we can import sw.ts in a jsdom env.
// sw.ts registers a `message` listener on `self` at module top-level;
// we test BUG-A18-11 by dispatching MessageEvents and checking skipWaiting.
// =====================================================================
vi.mock('workbox-precaching', () => ({
  precacheAndRoute: vi.fn(),
  cleanupOutdatedCaches: vi.fn(),
  createHandlerBoundToURL: vi.fn(() => vi.fn()),
  matchPrecache: vi.fn(),
}));
vi.mock('workbox-core', () => ({ clientsClaim: vi.fn() }));
vi.mock('workbox-routing', () => ({
  registerRoute: vi.fn(),
  NavigationRoute: vi.fn(() => ({})),
  setCatchHandler: vi.fn(),
}));
vi.mock('workbox-strategies', () => ({
  CacheFirst: vi.fn(() => ({})),
  NetworkFirst: vi.fn(() => ({})),
}));
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: vi.fn(() => ({})) }));
vi.mock('workbox-cacheable-response', () => ({
  CacheableResponsePlugin: vi.fn(() => ({})),
}));

// Import sw.ts (side-effect: registers `message` listener on self).
import '../src/sw';

// =====================================================================
// Read source files for code-reading tests.
// =====================================================================
const mainSrc = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');
const swSrc = readFileSync(resolve(__dirname, '../src/sw.ts'), 'utf8');
const indexSrc = readFileSync(resolve(__dirname, '../index.html'), 'utf8');

// =====================================================================
// Helper: extract a brace-balanced block starting at `startIdx`.
// =====================================================================
function extractBlock(src: string, startIdx: number): string {
  const firstBrace = src.indexOf('{', startIdx);
  if (firstBrace < 0) return '';
  let depth = 0;
  for (let i = firstBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        const closeParen = src.indexOf(')', i);
        return closeParen >= 0 ? src.slice(startIdx, closeParen + 1) : src.slice(startIdx, i + 1);
      }
    }
  }
  return src.slice(startIdx);
}

// =====================================================================
// main.ts — code-reading tests for BUG-A18-01..08
// =====================================================================
describe('main.ts — BUG-A18 fixes (code-reading)', () => {
  // BUG-A18-01: SW registration try/catch
  it('BUG-A18-01: registerPWA wraps registerSW in try/catch', () => {
    const fnStart = mainSrc.indexOf('function registerPWA');
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const fnEnd = mainSrc.indexOf('function detectStandalone');
    const fnBody = mainSrc.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/\btry\s*\{/);
    expect(fnBody).toMatch(/\bcatch\s*\(\s*\w+\s*\)/);
    expect(fnBody).toContain('registerSW');
    expect(fnBody).toContain("console.warn('[PWA] registerSW threw:");
  });

  it('BUG-A18-01: registerPWA returns early if serviceWorker not in navigator', () => {
    const fnStart = mainSrc.indexOf('function registerPWA');
    const fnBody = mainSrc.slice(fnStart, fnStart + 200);
    expect(fnBody).toContain("'serviceWorker' in navigator");
    expect(fnBody).toContain('import.meta.env.PROD');
  });

  // BUG-A18-02: init() try/catch + beforeunload inside init
  it('BUG-A18-02: init() body wrapped in try/catch with showFatalError', () => {
    const fnStart = mainSrc.indexOf('function init()');
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const fnBody = mainSrc.slice(fnStart);
    expect(fnBody).toMatch(/\btry\s*\{/);
    expect(fnBody).toMatch(/catch\s*\(\s*\w+\s*\)\s*\{/);
    expect(fnBody).toContain('showFatalError');
  });

  it('BUG-A18-02: beforeunload listener is INSIDE init() AFTER loadData()', () => {
    const initStart = mainSrc.indexOf('function init()');
    const beforeunloadIdx = mainSrc.indexOf("window.addEventListener('beforeunload'", initStart);
    expect(beforeunloadIdx).toBeGreaterThan(initStart);
    const loadDataIdx = mainSrc.indexOf('loadData();', initStart);
    expect(loadDataIdx).toBeGreaterThan(initStart);
    expect(beforeunloadIdx).toBeGreaterThan(loadDataIdx);
  });

  it('BUG-A18-02: exactly ONE beforeunload listener (no module-top-level duplicate)', () => {
    const matches = [...mainSrc.matchAll(/window\.addEventListener\('beforeunload'/g)];
    expect(matches.length).toBe(1);
    const initStart = mainSrc.indexOf('function init()');
    expect(matches[0].index).toBeGreaterThan(initStart);
  });

  it('BUG-A18-02: showFatalError injects "Errore di avvio" fallback UI', () => {
    const fnStart = mainSrc.indexOf('function showFatalError');
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const fnBody = mainSrc.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain('Errore di avvio');
    expect(fnBody).toContain('empty-state-title');
    expect(fnBody).toContain('console.error');
  });

  // BUG-A18-03: onNeedRefresh dedup
  it('BUG-A18-03: onNeedRefresh has dedup guard (if updateBtn return)', () => {
    const idx = mainSrc.indexOf('onNeedRefresh()');
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = mainSrc.slice(idx, idx + 600);
    expect(block).toMatch(/if\s*\(\s*updateBtn\s*\)\s*return/);
  });

  it('BUG-A18-03: auto-remove setTimeout resets updateBtn to null', () => {
    const idx = mainSrc.indexOf('autoRemoveTimer = setTimeout');
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = mainSrc.slice(idx, idx + 400);
    expect(block).toMatch(/updateBtn\s*=\s*null/);
    expect(block).toMatch(/autoRemoveTimer\s*=\s*null/);
  });

  // BUG-A18-04: reloadBtn.onclick catch
  it('BUG-A18-04: reloadBtn.onclick wraps updateSW in try/catch with console.warn', () => {
    const idx = mainSrc.indexOf('reloadBtn.onclick = async');
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = mainSrc.slice(idx, idx + 600);
    expect(block).toMatch(/\btry\s*\{/);
    expect(block).toMatch(/catch\s*\(\s*\w+\s*\)/);
    expect(block).toContain('updateSW');
    expect(block).toContain("console.warn('[PWA] updateSW failed:");
  });

  it('BUG-A18-04: reloadBtn.onclick calls window.location.reload (in try/catch)', () => {
    const idx = mainSrc.indexOf('reloadBtn.onclick = async');
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = mainSrc.slice(idx, idx + 800);
    expect(block).toContain('window.location.reload()');
    // reload is inside its own try/catch (jsdom throws "Not implemented")
    const reloadIdx = block.indexOf('window.location.reload()');
    const afterReload = block.slice(0, reloadIdx);
    const tryCount = (afterReload.match(/\btry\s*\{/g) || []).length;
    expect(tryCount).toBeGreaterThanOrEqual(2); // one for updateSW, one for reload
  });

  // BUG-A18-05: toast message
  it('BUG-A18-05: toast message mentions "pulsante in basso a destra"', () => {
    expect(mainSrc).toContain('Nuova versione disponibile (vedi pulsante in basso a destra)');
    expect(mainSrc).not.toContain('Nuova versione disponibile — tocca per aggiornare');
  });

  // BUG-A18-06: beforeunload try/catch
  it('BUG-A18-06: beforeunload handler wraps saveData in try/catch', () => {
    const startIdx = mainSrc.indexOf("window.addEventListener('beforeunload'");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const block = extractBlock(mainSrc, startIdx);
    expect(block).toContain('saveData');
    expect(block).toContain('immediate: true');
    expect(block).toMatch(/\btry\s*\{/);
    expect(block).toMatch(/\bcatch\s*\(/);
  });

  // BUG-A18-07: idempotency guard
  it('BUG-A18-07: init() has __ploppytvInit guard at the top', () => {
    const fnStart = mainSrc.indexOf('function init()');
    const fnBody = mainSrc.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('__ploppytvInit');
    expect(fnBody).toMatch(/if\s*\(\s*w\.__ploppytvInit\s*\)\s*return/);
    expect(fnBody).toMatch(/w\.__ploppytvInit\s*=\s*true/);
  });

  // BUG-A18-08: global error handlers
  it('BUG-A18-08: registerGlobalErrorHandlers registers error + unhandledrejection', () => {
    const fnStart = mainSrc.indexOf('function registerGlobalErrorHandlers');
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const fnBody = mainSrc.slice(fnStart, fnStart + 800);
    expect(fnBody).toContain("window.addEventListener('error'");
    expect(fnBody).toContain("window.addEventListener('unhandledrejection'");
  });

  it('BUG-A18-08: unhandledrejection handler skips AbortError (expected from search)', () => {
    const fnStart = mainSrc.indexOf('function registerGlobalErrorHandlers');
    const fnBody = mainSrc.slice(fnStart, fnStart + 1200);
    expect(fnBody).toContain('AbortError');
  });

  it('BUG-A18-08: registerGlobalErrorHandlers called inside init() BEFORE try block', () => {
    const initStart = mainSrc.indexOf('function init()');
    const initBody = mainSrc.slice(initStart, initStart + 700);
    const handlerCallIdx = initBody.indexOf('registerGlobalErrorHandlers()');
    const tryIdx = initBody.indexOf('try {');
    expect(handlerCallIdx).toBeGreaterThanOrEqual(0);
    expect(tryIdx).toBeGreaterThanOrEqual(0);
    expect(handlerCallIdx).toBeLessThan(tryIdx);
  });

  // Structural sanity: applyHash + setupHashRouting preserved
  it('applyHash parses #show/<id> with digit-capturing regex', () => {
    expect(mainSrc).toMatch(/\/\^show\\\/\(\\d\+\)\$\/\.exec\(hash\)/);
  });

  it('applyHash checks id > 0 before openShow', () => {
    const idx = mainSrc.indexOf('const showMatch =');
    const block = mainSrc.slice(idx, idx + 200);
    expect(block).toContain('id > 0');
  });

  it('setupHashRouting registers hashchange + setTimeout(applyHash, 0)', () => {
    const fnStart = mainSrc.indexOf('function setupHashRouting');
    const fnBody = mainSrc.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain("window.addEventListener('hashchange', applyHash)");
    expect(fnBody).toContain('setTimeout(applyHash, 0)');
  });

  it('preloadDiscover wrapped in try/catch inside setTimeout', () => {
    const idx = mainSrc.indexOf('preloadDiscover()');
    const block = mainSrc.slice(idx - 100, idx + 100);
    expect(block).toMatch(/\btry\s*\{/);
    expect(block).toMatch(/catch\s*\(/);
  });

  it('detectStandalone wrapped in try/catch', () => {
    const fnStart = mainSrc.indexOf('function detectStandalone');
    const fnBody = mainSrc.slice(fnStart, fnStart + 500);
    expect(fnBody).toMatch(/\btry\s*\{/);
    expect(fnBody).toMatch(/catch\s*\(/);
  });

  it('init() called at module top-level', () => {
    // init() must be called after its definition, at the top level (not inside another function)
    const initCallIdx = mainSrc.lastIndexOf('\ninit();');
    expect(initCallIdx).toBeGreaterThanOrEqual(0);
  });

  it('DEV mode exposes __ploppytv_state for debugging', () => {
    expect(mainSrc).toContain('__ploppytv_state');
    expect(mainSrc).toContain('import.meta.env.DEV');
  });
});

// =====================================================================
// sw.ts — runtime tests for BUG-A18-11 (SKIP_WAITING message format)
// =====================================================================
describe('sw.ts — BUG-A18-11: SKIP_WAITING message dispatch', () => {
  beforeEach(() => {
    (self as unknown as { skipWaiting: ReturnType<typeof vi.fn> }).skipWaiting = vi.fn();
  });

  afterEach(() => {
    delete (self as unknown as { skipWaiting?: unknown }).skipWaiting;
  });

  function dispatchMessage(data: unknown): void {
    self.dispatchEvent(new MessageEvent('message', { data }));
  }

  it('dispatching { type: "SKIP_WAITING" } (workbox-window format) calls self.skipWaiting', () => {
    dispatchMessage({ type: 'SKIP_WAITING' });
    expect(
      (self as unknown as { skipWaiting: ReturnType<typeof vi.fn> }).skipWaiting,
    ).toHaveBeenCalledTimes(1);
  });

  it('dispatching "SKIP_WAITING" string (legacy format) calls self.skipWaiting', () => {
    dispatchMessage('SKIP_WAITING');
    expect(
      (self as unknown as { skipWaiting: ReturnType<typeof vi.fn> }).skipWaiting,
    ).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['wrong string "SKIP"', 'SKIP'],
    ['wrong case "skip_waiting"', 'skip_waiting'],
    ['object without type', { foo: 'bar' }],
    ['object with wrong type', { type: 'OTHER' }],
    ['object with type wrong case', { type: 'skip_waiting' }],
    ['number 42', 42],
    ['boolean true', true],
    ['array', ['SKIP_WAITING']],
    ['object with type number', { type: 0 }],
  ])('dispatching %s does NOT call self.skipWaiting', (_label, data) => {
    dispatchMessage(data);
    expect(
      (self as unknown as { skipWaiting: ReturnType<typeof vi.fn> }).skipWaiting,
    ).not.toHaveBeenCalled();
  });

  it('dispatching multiple valid messages calls skipWaiting multiple times', () => {
    dispatchMessage({ type: 'SKIP_WAITING' });
    dispatchMessage('SKIP_WAITING');
    dispatchMessage({ type: 'SKIP_WAITING' });
    expect(
      (self as unknown as { skipWaiting: ReturnType<typeof vi.fn> }).skipWaiting,
    ).toHaveBeenCalledTimes(3);
  });
});

// =====================================================================
// sw.ts — code-reading tests
// =====================================================================
describe('sw.ts — code-reading', () => {
  it('BUG-A18-11: message handler calls shouldSkipWaiting(event.data)', () => {
    expect(swSrc).toContain('if (shouldSkipWaiting(event.data)) self.skipWaiting()');
  });

  it('BUG-A18-11: shouldSkipWaiting handles both string and object formats', () => {
    const fnStart = swSrc.indexOf('function shouldSkipWaiting');
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const fnBody = swSrc.slice(fnStart, fnStart + 400);
    expect(fnBody).toContain("=== 'SKIP_WAITING'");
    expect(fnBody).toContain("typeof data === 'object'");
    expect(fnBody).toContain('.type');
  });

  it('precacheAndRoute uses self.__WB_MANIFEST with fallback to []', () => {
    expect(swSrc).toMatch(/precacheAndRoute\(self\.__WB_MANIFEST\s*\|\|\s*\[\]\)/);
  });

  it('cleanupOutdatedCaches called', () => {
    expect(swSrc).toContain('cleanupOutdatedCaches()');
  });

  it('clientsClaim called', () => {
    expect(swSrc).toContain('clientsClaim()');
  });

  it('NavigationRoute uses createHandlerBoundToURL("index.html")', () => {
    expect(swSrc).toContain("createHandlerBoundToURL('index.html')");
    expect(swSrc).toContain('new NavigationRoute(handler');
  });

  it('NavigationRoute denylist has two patterns', () => {
    expect(swSrc).toContain('denylist:');
    // /^\/_/ — denies paths starting with /_
    expect(swSrc).toContain('^\\/_');
    // /\/[^/?]+\.[^/]+$/ — denies paths with file extensions
    expect(swSrc).toContain('[^/?]+');
  });

  it('API route targets api.tvmaze.com with NetworkFirst', () => {
    expect(swSrc).toContain("url.hostname === 'api.tvmaze.com'");
    expect(swSrc).toContain('new NetworkFirst(');
    expect(swSrc).toContain("'ploppytv-api'");
    expect(swSrc).toContain('networkTimeoutSeconds: 10');
    expect(swSrc).toContain('maxEntries: 100');
    expect(swSrc).toContain('maxAgeSeconds: 60 * 60');
  });

  it('image route targets static.tvmaze.com with CacheFirst', () => {
    expect(swSrc).toContain("url.hostname === 'static.tvmaze.com'");
    expect(swSrc).toContain('new CacheFirst(');
    expect(swSrc).toContain("'ploppytv-img'");
    expect(swSrc).toContain('maxEntries: 300');
    expect(swSrc).toContain('60 * 60 * 24 * 30');
  });

  it('setCatchHandler uses matchPrecache for navigation fallback', () => {
    expect(swSrc).toContain('setCatchHandler');
    expect(swSrc).toContain("matchPrecache('index.html')");
  });

  it('setCatchHandler tries network fetch as last resort for navigation', () => {
    expect(swSrc).toMatch(/return await fetch\(request\)/);
  });

  it('setCatchHandler returns 404 for image requests', () => {
    expect(swSrc).toContain("request.destination === 'image'");
    expect(swSrc).toMatch(/new Response\(''\s*,\s*\{\s*status:\s*404/);
  });

  it('setCatchHandler returns Response.error() as final fallback', () => {
    expect(swSrc).toContain('Response.error()');
  });

  it('CacheableResponsePlugin uses statuses [0, 200] for both API and image routes', () => {
    const matches = [...swSrc.matchAll(/statuses:\s*\[0,\s*200\]/g)];
    expect(matches.length).toBe(2);
  });

  it('ExpirationPlugin used on both API and image caches', () => {
    const matches = [...swSrc.matchAll(/new ExpirationPlugin\(/g)];
    expect(matches.length).toBe(2);
  });

  it('shouldSkipWaiting is NOT exported (would break classic SW registration)', () => {
    // The SW is built with rollupFormat "es" but registered with type "classic".
    // An `export` statement would cause a syntax error in classic script mode.
    expect(swSrc).not.toMatch(/export\s+function\s+shouldSkipWaiting/);
    expect(swSrc).not.toMatch(/export\s*\{.*shouldSkipWaiting/);
  });
});

// =====================================================================
// index.html — BUG-A18-09/10 + structure
// =====================================================================
describe('index.html — BUG-A18-09/10 + structure', () => {
  // BUG-A18-09: noscript fallback
  it('BUG-A18-09: has <noscript> fallback with Italian JavaScript message', () => {
    expect(indexSrc).toContain('<noscript>');
    expect(indexSrc).toContain('</noscript>');
    expect(indexSrc).toContain('JavaScript');
    expect(indexSrc).toContain('ricarica');
  });

  it('BUG-A18-09: noscript is inside <body> before .app div', () => {
    const bodyIdx = indexSrc.indexOf('<body>');
    const noscriptIdx = indexSrc.indexOf('<noscript>');
    const appIdx = indexSrc.indexOf('<div class="app">');
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(noscriptIdx).toBeGreaterThan(bodyIdx);
    expect(appIdx).toBeGreaterThan(noscriptIdx);
  });

  // BUG-A18-10: dark-mode theme-color
  it('BUG-A18-10: has dark-mode theme-color meta with #0f0f14', () => {
    expect(indexSrc).toMatch(
      /<meta\s+name="theme-color"\s+media="\(prefers-color-scheme:\s*dark\)"\s+content="#0f0f14">/,
    );
  });

  it('has default (light) theme-color #ff6b35', () => {
    expect(indexSrc).toMatch(/<meta\s+name="theme-color"\s+content="#ff6b35">/);
  });

  it('has exactly two theme-color meta tags (light + dark)', () => {
    const matches = [...indexSrc.matchAll(/<meta\s+name="theme-color"/g)];
    expect(matches.length).toBe(2);
  });

  // Structural sanity
  it('has lang="it" on <html>', () => {
    expect(indexSrc).toMatch(/<html\s+lang="it">/);
  });

  it('has charset UTF-8', () => {
    expect(indexSrc).toMatch(/<meta\s+charset="UTF-8">/);
  });

  it('has viewport meta with viewport-fit=cover', () => {
    expect(indexSrc).toMatch(/<meta\s+name="viewport"\s+content="[^"]*viewport-fit=cover/);
  });

  it('has description meta', () => {
    expect(indexSrc).toMatch(/<meta\s+name="description"\s+content="[^"]*PloppyTV/);
  });

  it('has manifest link', () => {
    expect(indexSrc).toMatch(/<link\s+rel="manifest"\s+href="manifest\.webmanifest">/);
  });

  it('has preconnect to api.tvmaze.com with crossorigin', () => {
    expect(indexSrc).toMatch(
      /<link\s+rel="preconnect"\s+href="https:\/\/api\.tvmaze\.com"\s+crossorigin>/,
    );
  });

  it('has preconnect to static.tvmaze.com with crossorigin', () => {
    expect(indexSrc).toMatch(
      /<link\s+rel="preconnect"\s+href="https:\/\/static\.tvmaze\.com"\s+crossorigin>/,
    );
  });

  it('has dns-prefetch for both TVMaze hosts', () => {
    expect(indexSrc).toMatch(/<link\s+rel="dns-prefetch"\s+href="https:\/\/api\.tvmaze\.com">/);
    expect(indexSrc).toMatch(/<link\s+rel="dns-prefetch"\s+href="https:\/\/static\.tvmaze\.com">/);
  });

  it('has module script pointing to /src/main.ts', () => {
    expect(indexSrc).toMatch(/<script\s+type="module"\s+src="\/src\/main\.ts"><\/script>/);
  });

  it('has apple-mobile-web-app-capable', () => {
    expect(indexSrc).toContain('apple-mobile-web-app-capable');
  });

  it('has mobile-web-app-capable', () => {
    expect(indexSrc).toContain('mobile-web-app-capable');
  });

  it('has color-scheme meta with dark light', () => {
    expect(indexSrc).toMatch(/<meta\s+name="color-scheme"\s+content="dark light">/);
  });

  it('has format-detection telephone=no', () => {
    expect(indexSrc).toMatch(/<meta\s+name="format-detection"\s+content="telephone=no">/);
  });

  it('title contains PloppyTV', () => {
    expect(indexSrc).toMatch(/<title>[^<]*PloppyTV[^<]*<\/title>/);
  });

  it('has apple-touch-icon link', () => {
    expect(indexSrc).toMatch(
      /<link\s+rel="apple-touch-icon"\s+href="icons\/apple-touch-icon\.png">/,
    );
  });

  it('has SVG favicon', () => {
    expect(indexSrc).toMatch(/<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="icons\/icon\.svg">/);
  });

  it('has main content container #mainContent', () => {
    expect(indexSrc).toContain('id="mainContent"');
  });

  it('has toast container #toast', () => {
    expect(indexSrc).toContain('id="toast"');
  });

  it('has modal overlay with aria-modal', () => {
    expect(indexSrc).toContain('aria-modal="true"');
  });

  it('XSS check: no unescaped reflected query param pattern in HTML', () => {
    // index.html is static — no server-side templating, no reflected params.
    // Verify no <script> with inline src containing user-controlled data.
    const scriptMatches = [...indexSrc.matchAll(/<script[^>]*>/g)];
    for (const m of scriptMatches) {
      // The only script should be type="module" src="/src/main.ts"
      expect(m[0]).toMatch(/src="\/src\/main\.ts"/);
    }
  });
});
