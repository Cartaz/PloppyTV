import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workbox = vi.hoisted(() => {
  const state = {
    catchHandler: null as null | ((args: { request: Request }) => Promise<Response>),
  };

  return {
    state,
    precacheAndRoute: vi.fn(),
    cleanupOutdatedCaches: vi.fn(),
    clientsClaim: vi.fn(),
    createHandlerBoundToURL: vi.fn(() => vi.fn()),
    matchPrecache: vi.fn(),
    registerRoute: vi.fn(),
    setCatchHandler: vi.fn((handler: (args: { request: Request }) => Promise<Response>) => {
      state.catchHandler = handler;
    }),
    NavigationRoute: vi.fn(function NavigationRoute(handler: unknown, options: unknown) {
      return { kind: 'navigation', handler, options };
    }),
    NetworkFirst: vi.fn(function NetworkFirst(options: unknown) {
      return { kind: 'network-first', options };
    }),
    CacheFirst: vi.fn(function CacheFirst(options: unknown) {
      return { kind: 'cache-first', options };
    }),
    ExpirationPlugin: vi.fn(function ExpirationPlugin(options: unknown) {
      return { kind: 'expiration', options };
    }),
    CacheableResponsePlugin: vi.fn(function CacheableResponsePlugin(options: unknown) {
      return { kind: 'cacheable-response', options };
    }),
  };
});

vi.mock('workbox-precaching', () => ({
  precacheAndRoute: workbox.precacheAndRoute,
  cleanupOutdatedCaches: workbox.cleanupOutdatedCaches,
  createHandlerBoundToURL: workbox.createHandlerBoundToURL,
  matchPrecache: workbox.matchPrecache,
}));
vi.mock('workbox-core', () => ({ clientsClaim: workbox.clientsClaim }));
vi.mock('workbox-routing', () => ({
  registerRoute: workbox.registerRoute,
  NavigationRoute: workbox.NavigationRoute,
  setCatchHandler: workbox.setCatchHandler,
}));
vi.mock('workbox-strategies', () => ({
  CacheFirst: workbox.CacheFirst,
  NetworkFirst: workbox.NetworkFirst,
}));
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: workbox.ExpirationPlugin }));
vi.mock('workbox-cacheable-response', () => ({ CacheableResponsePlugin: workbox.CacheableResponsePlugin }));

import '../src/sw';

const indexSrc = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const indexDoc = new DOMParser().parseFromString(indexSrc, 'text/html');

function dispatchMessage(data: unknown): void {
  self.dispatchEvent(new MessageEvent('message', { data }));
}

function makeRequest(mode: RequestMode, destination: RequestDestination = ''): Request {
  return { mode, destination } as Request;
}

function dispatchNotificationClick(): {
  close: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const waitUntil = vi.fn();
  const event = new Event('notificationclick');
  Object.defineProperties(event, {
    notification: { value: { close } },
    waitUntil: { value: waitUntil },
  });
  self.dispatchEvent(event);
  return { close, waitUntil };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (self as unknown as { skipWaiting?: unknown }).skipWaiting;
  delete (self as unknown as { clients?: unknown }).clients;
  delete (self as unknown as { registration?: unknown }).registration;
});

describe('service worker registration contract', () => {
  it('initializes precache cleanup and clients claim once', () => {
    expect(workbox.precacheAndRoute).toHaveBeenCalledTimes(1);
    expect(workbox.cleanupOutdatedCaches).toHaveBeenCalledTimes(1);
    expect(workbox.clientsClaim).toHaveBeenCalledTimes(1);
  });

  it('registers navigation, TVMaze API and TVMaze image routes', () => {
    expect(workbox.registerRoute).toHaveBeenCalledTimes(3);

    const apiPredicate = workbox.registerRoute.mock.calls[1][0] as (args: { url: URL }) => boolean;
    const imagePredicate = workbox.registerRoute.mock.calls[2][0] as (args: { url: URL }) => boolean;

    expect(apiPredicate({ url: new URL('https://api.tvmaze.com/shows/1') })).toBe(true);
    expect(apiPredicate({ url: new URL('https://static.tvmaze.com/x.jpg') })).toBe(false);
    expect(imagePredicate({ url: new URL('https://static.tvmaze.com/x.jpg') })).toBe(true);
    expect(imagePredicate({ url: new URL('https://api.tvmaze.com/shows/1') })).toBe(false);
  });

  it('configures bounded network-first API caching', () => {
    expect(workbox.NetworkFirst).toHaveBeenCalledWith(
      expect.objectContaining({ cacheName: 'ploppytv-api', networkTimeoutSeconds: 10 }),
    );
    expect(workbox.ExpirationPlugin).toHaveBeenCalledWith({ maxEntries: 100, maxAgeSeconds: 60 * 60 });
  });

  it('configures bounded cache-first image caching', () => {
    expect(workbox.CacheFirst).toHaveBeenCalledWith(expect.objectContaining({ cacheName: 'ploppytv-img' }));
    expect(workbox.ExpirationPlugin).toHaveBeenCalledWith({
      maxEntries: 300,
      maxAgeSeconds: 60 * 60 * 24 * 30,
    });
  });
});

describe('service worker message contract', () => {
  it.each(['SKIP_WAITING', { type: 'SKIP_WAITING' }])('accepts the supported skip-waiting message %j', (data) => {
    const skipWaiting = vi.fn();
    (self as unknown as { skipWaiting: typeof skipWaiting }).skipWaiting = skipWaiting;

    dispatchMessage(data);

    expect(skipWaiting).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, '', 'skip_waiting', 42, true, [], { type: 'OTHER' }])(
    'ignores unrelated messages: %j',
    (data) => {
      const skipWaiting = vi.fn();
      (self as unknown as { skipWaiting: typeof skipWaiting }).skipWaiting = skipWaiting;

      dispatchMessage(data);

      expect(skipWaiting).not.toHaveBeenCalled();
    },
  );
});

describe('service worker offline fallback contract', () => {
  it('serves the precached app shell for offline navigation', async () => {
    const cached = new Response('<html>cached</html>');
    workbox.matchPrecache.mockResolvedValueOnce(cached);

    const response = await workbox.state.catchHandler!({ request: makeRequest('navigate') });

    expect(workbox.matchPrecache).toHaveBeenCalledWith('index.html');
    expect(response).toBe(cached);
  });

  it('falls back to network when the navigation shell is not precached', async () => {
    workbox.matchPrecache.mockResolvedValueOnce(undefined);
    const network = new Response('<html>network</html>');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(network);
    const request = makeRequest('navigate');

    const response = await workbox.state.catchHandler!({ request });

    expect(fetchSpy).toHaveBeenCalledWith(request);
    expect(response).toBe(network);
  });

  it('returns an error response when both precache and navigation network fail', async () => {
    workbox.matchPrecache.mockResolvedValueOnce(undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));

    const response = await workbox.state.catchHandler!({ request: makeRequest('navigate') });

    expect(response.type).toBe('error');
  });

  it('returns a 404 response for an uncached image', async () => {
    const response = await workbox.state.catchHandler!({ request: makeRequest('no-cors', 'image') });

    expect(response.status).toBe(404);
  });
});

describe('service worker notification click contract', () => {
  it('closes the notification and focuses an existing client', async () => {
    const focus = vi.fn().mockResolvedValue(undefined);
    const openWindow = vi.fn();
    (self as unknown as { clients: unknown }).clients = {
      matchAll: vi.fn().mockResolvedValue([{ focus }]),
      openWindow,
    };
    (self as unknown as { registration: unknown }).registration = { scope: 'https://example.com/PloppyTV/' };

    const { close, waitUntil } = dispatchNotificationClick();
    const pending = waitUntil.mock.calls[0][0] as Promise<void>;
    await pending;

    expect(close).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens the scoped app shell when no window client exists', async () => {
    const openWindow = vi.fn().mockResolvedValue(undefined);
    (self as unknown as { clients: unknown }).clients = {
      matchAll: vi.fn().mockResolvedValue([]),
      openWindow,
    };
    (self as unknown as { registration: unknown }).registration = { scope: 'https://example.com/PloppyTV/' };

    const { waitUntil } = dispatchNotificationClick();
    await (waitUntil.mock.calls[0][0] as Promise<void>);

    expect(openWindow).toHaveBeenCalledWith('https://example.com/PloppyTV/index.html');
  });
});

describe('index.html document contract', () => {
  it('declares the app language, viewport and theme metadata', () => {
    expect(indexDoc.documentElement.lang).toBe('it');
    expect(indexDoc.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain('viewport-fit=cover');
    expect(indexDoc.querySelectorAll('meta[name="theme-color"]')).toHaveLength(2);
  });

  it('links the manifest, app icon and module entry point', () => {
    expect(indexDoc.querySelector('link[rel="manifest"][href="manifest.webmanifest"]')).not.toBeNull();
    expect(indexDoc.querySelector('link[rel="apple-touch-icon"][href="icons/apple-touch-icon.png"]')).not.toBeNull();
    expect(indexDoc.querySelector('script[type="module"][src="/src/main.ts"]')).not.toBeNull();
  });

  it('contains the runtime containers required by the app shell', () => {
    expect(indexDoc.getElementById('mainContent')).not.toBeNull();
    expect(indexDoc.getElementById('toast')).not.toBeNull();
    expect(indexDoc.querySelector('[aria-modal="true"]')).not.toBeNull();
  });

  it('provides a noscript fallback inside body before the app shell', () => {
    const noscript = indexDoc.querySelector('body > noscript');
    const app = indexDoc.querySelector('body > .app');
    expect(noscript).not.toBeNull();
    expect(app).not.toBeNull();
    if (!noscript || !app) return;

    expect(noscript.textContent).toContain('JavaScript');
    expect(noscript.compareDocumentPosition(app) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
