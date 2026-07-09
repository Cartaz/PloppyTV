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

// Skip waiting su message dal client.
// BUG-A18-11 (FIXED): workbox-window.messageSkipWaiting() invia un oggetto
// `{ type: 'SKIP_WAITING' }`, NON la stringa 'SKIP_WAITING'. Il precedente
// handler `event.data === 'SKIP_WAITING'` (strict string equality) non
// matchava mai → self.skipWaiting() non veniva mai chiamato → il nuovo SW
// restava in stato "waiting" indefinitamente → l'utente non riceveva mai
// la nuova versione (il reload non attivava il nuovo SW).
// Ora gestiamo entrambi i formati (string legacy + object workbox-window).
self.addEventListener('message', (event) => {
  if (shouldSkipWaiting(event.data)) self.skipWaiting();
});

/**
 * Determina se un messaggio postMessage ricevuto dal SW è una richiesta
 * di skipWaiting. Accetta sia il formato stringa legacy ('SKIP_WAITING')
 * sia il formato oggetto workbox-window ({ type: 'SKIP_WAITING' }).
 *
 * BUG-A18-11 (FIXED): estratta come funzione locale (non esportata: il SW
 * è buildato con rollupFormat "es" ma registrato come classic script, e
 * un export statement romperebbe il parsing in classic mode). Testata
 * indirettamente via message dispatch nei test di probe_a18.
 */
function shouldSkipWaiting(data: unknown): boolean {
  if (data === 'SKIP_WAITING') return true;
  if (typeof data === 'object' && data !== null) {
    return (data as { type?: unknown }).type === 'SKIP_WAITING';
  }
  return false;
}

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
  }),
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
  }),
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
