// Service Worker con strategie differenziate (usando workbox via vite-plugin-pwa)

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL, matchPrecache } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import { registerRoute, NavigationRoute, setCatchHandler } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare const self: ServiceWorkerGlobalScope;

// Precache degli asset generati da Vite
precacheAndRoute(self.__WB_MANIFEST || []);
cleanupOutdatedCaches();
clientsClaim();

// Skip waiting su message dal client
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// SPA fallback: navigazioni -> index.html cached
const handler = createHandlerBoundToURL('index.html');
const navigationRoute = new NavigationRoute(handler, {
  denylist: [/^\/_/, /\/[^/?]+\.[^/]+$/],
});
registerRoute(navigationRoute);

// API TVMaze: network-first con fallback cache (dati freschi quando online)
registerRoute(
  ({ url }) => url.hostname === 'api.tvmaze.com',
  new NetworkFirst({
    cacheName: 'ploppytv-api',
    networkTimeoutSeconds: 10,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 }),
    ],
  })
);

// Immagini poster TVMaze: cache-first con fallback network
registerRoute(
  ({ url }) => url.hostname === 'static.tvmaze.com',
  new CacheFirst({
    cacheName: 'ploppytv-img',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  })
);

// Catch handler per navigazioni offline.
// CRITICAL FIX (H1/T3): usa matchPrecache invece di caches.open('workbox-precache-v2').
// Motivo: il cache name reale include un suffix di scope
// (es. `workbox-precache-v2-https://example.com/PloppyTV/`), quindi
// caches.open senza suffix apre una cache vuota. Inoltre Workbox precacha
// con `?__WB_REVISION__=...` come query string, quindi cache.match senza
// ignoreSearch non trova la entry. matchPrecache gestisce entrambi.
setCatchHandler(async ({ request }) => {
  if (request.mode === 'navigate') {
    const cached = await matchPrecache('index.html');
    if (cached) return cached;
    // Last resort: prova network (utente tornato online ma precache miss)
    try {
      return await fetch(request);
    } catch {
      // fallthrough to Response.error()
    }
  }
  if (request.destination === 'image') {
    return new Response('', { status: 404, statusText: 'Not Found' });
  }
  return Response.error();
});
