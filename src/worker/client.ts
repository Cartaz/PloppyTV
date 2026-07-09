// Wrapper per il worker con fallback al main thread se il worker non è disponibile.
//
// CRITICAL FIX (C4/T2): ogni richiesta porta un `id` incrementale (correlation).
// L'handler valida `ev.data.id === myId` prima di risolvere, così risposte
// stale o tardive di richieste precedenti non cross-talkano con quella corrente.
// Il listener viene rimosso su resolve/reject/timeout per evitare leak.
//
// HIGH FIX (H12): su errore nel worker, riceviamo un messaggio `{type:'error'}`
// e rejected la promise (invece di pendere fino al timeout). Aggiunto anche
// `worker.onerror` per catturare errori di load/script.
//
// BUG-08-01 (FIXED): onerror ora imposta `_workerSupported = false` e
// `_worker = null`, così la richiesta successiva salta direttamente al
// fallback main-thread (no postMessage, no timeout wait).
//
// BUG-08-02 (FIXED): timeout portato da 500ms a WORKER_TIMEOUT_MS (3000ms)
// per dare tempo al worker di calcolare statistiche su librerie grandi.
//
// BUG-08-03 (FIXED): il fallback ora delega alle funzioni pure condivise in
// `./compute.ts` (single source of truth) — nessun drift tra worker e fallback.
//
// BUG-16-03 (FIXED): `computeCalendar` (in `./compute.ts`) applica
// internamente `safeWeekOffset`, quindi il fallback gestisce NaN/Infinity
// weekOffset esattamente come il worker.
//
// BUG-A9-05 (FIXED): `worker.postMessage(req)` può lanciare DataCloneError
// se `shows` contiene dati non-cloneable (funzioni, riferimenti circolari,
// Symbol, WeakMap, ecc.). Prima, il throw propagava fuori dal Promise
// executor (auto-reject), MA il listener e il timeout erano già registrati
// → leak (il listener restava attivo per sempre, il timeout scattava a
// 3s e faceva doppio compute). Ora `postMessage` è wrappato in try/catch:
// su throw, cleanup + fallback main-thread.
//
// BUG-A9-06 (FIXED): il fallback `computeStats(shows)` / `computeCalendar(...)`
// può lanciare (es. se `shows` contiene entry con getter che throwano, o
// se una futura modifica a compute.ts introduce un crash). Prima, il throw
// avveniva dentro un event handler o setTimeout callback → NON catturato
// dal Promise constructor → la promise HANGAVA per sempre (mai risolta né
// rejected) → la UI mostrava il loader "Calcolando..." all'infinito. Ora
// ogni fallback è wrappato in try/catch: su throw, la promise viene
// rejected, e la view (renderStats/renderCalendar) mostra "Errore
// caricamento" tramite il proprio catch.

import type { Show, StatsResult, CalendarEpisode, WorkerResponse, WorkerRequest } from '../types';
import { computeStats, computeCalendar } from './compute';

/** Timeout per le richieste al worker: 3s (WORKER_TIMEOUT_MS). */
const WORKER_TIMEOUT_MS = 3000;

let _worker: Worker | null = null;
let _workerSupported = true;
let _requestIdCounter = 0;

function getWorker(): Worker | null {
  if (!_workerSupported) return null;
  if (_worker) return _worker;
  try {
    _worker = new Worker(new URL('./stats.worker.ts', import.meta.url), { type: 'module' });
    // Cattura errori di load/script del worker (non catturabili dal try/catch sopra).
    // BUG-08-01: imposta `_workerSupported = false` e `_worker = null` così la
    // prossima richiesta salta direttamente al fallback main-thread.
    _worker.onerror = (e) => {
      console.warn('[worker] script/load error:', e.message || e);
      _workerSupported = false;
      _worker = null;
    };
    return _worker;
  } catch (e) {
    console.warn('[worker] non disponibile, fallback main thread:', e);
    _workerSupported = false;
    return null;
  }
}

/**
 * BUG-A9-06 (FIXED): helper per eseguire il fallback main-thread in modo
 * sicuro. Se il compute lancia (es. dati corrotti con getter che throwano,
 * o un bug futuro in compute.ts), la promise viene rejected invece di
 * rimanere pending. La view (renderStats/renderCalendar) ha un try/catch
 * che mostra "Errore caricamento" sulle promise rejected.
 */
function runFallbackOrReject<T>(
  fn: () => T,
  resolve: (v: T) => void,
  reject: (e: unknown) => void,
): void {
  try {
    resolve(fn());
  } catch (e) {
    reject(e);
  }
}

/**
 * Stats via worker. Usa correlation ID per scartare risposte stale.
 * Su errore worker → reject (invece di pendere fino al timeout).
 * Su timeout → fallback main-thread E rimuove il listener (no leak).
 */
export function computeStatsAsync(shows: Show[]): Promise<StatsResult> {
  // BUG-A9-06: aggiunto `reject` — prima il constructor prendeva solo
  // `resolve`, quindi nessun path poteva rejectare la promise. Ora i
  // fallback che lanciano rejectano invece di hangare.
  return new Promise((resolve, reject) => {
    const worker = getWorker();
    if (!worker) {
      runFallbackOrReject(() => computeStats(shows), resolve, reject);
      return;
    }
    const myId = ++_requestIdCounter;
    let settled = false;

    const handler = (ev: MessageEvent<WorkerResponse>) => {
      const data = ev.data;
      // Scarta risposte per altre richieste (cross-talk protection)
      if (data.id !== myId) return;
      if (settled) return;
      if (data.type === 'stats') {
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        resolve(data.result);
      } else if (data.type === 'error') {
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        console.warn('[worker] stats error:', data.message, '— using fallback');
        // BUG-A9-06: se il fallback lancia, reject invece di hangare.
        runFallbackOrReject(() => computeStats(shows), resolve, reject);
      }
      // Risposte calendar per altri id vengono scartate da `data.id !== myId`
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.removeEventListener('message', handler); // CRITICAL: no leak
      console.warn('[worker] stats timeout, fallback main-thread');
      // BUG-A9-06: se il fallback lancia, reject invece di hangare.
      runFallbackOrReject(() => computeStats(shows), resolve, reject);
    }, WORKER_TIMEOUT_MS);

    worker.addEventListener('message', handler);
    const req: WorkerRequest = { type: 'stats', id: myId, shows };
    // BUG-A9-05 (FIXED): postMessage può lanciare DataCloneError se `shows`
    // contiene dati non-cloneable (funzioni, riferimenti circolari, Symbol,
    // ecc.). Senza questo try/catch, il throw propagava fuori dal Promise
    // executor (auto-reject della promise), MA listener e timeout erano
    // già registrati → leak (listener restava attivo, timeout scattava a
    // 3s con doppio compute). Ora: cleanup + fallback main-thread.
    try {
      worker.postMessage(req);
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        console.warn('[worker] postMessage failed (non-cloneable data?), fallback main-thread:', e);
        runFallbackOrReject(() => computeStats(shows), resolve, reject);
      }
    }
  });
}

export function computeCalendarAsync(
  shows: Show[],
  weekOffset: number,
): Promise<{ week: CalendarEpisode[]; afterWeek: CalendarEpisode[]; weekStart: string; weekEnd: string }> {
  // BUG-A9-06: aggiunto `reject` per consistenza con computeStatsAsync.
  return new Promise((resolve, reject) => {
    const worker = getWorker();
    if (!worker) {
      runFallbackOrReject(() => computeCalendar(shows, weekOffset), resolve, reject);
      return;
    }
    const myId = ++_requestIdCounter;
    let settled = false;

    const handler = (ev: MessageEvent<WorkerResponse>) => {
      const data = ev.data;
      if (data.id !== myId) return;
      if (settled) return;
      if (data.type === 'calendar') {
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        resolve({ week: data.result, afterWeek: data.afterWeek, weekStart: data.weekStart, weekEnd: data.weekEnd });
      } else if (data.type === 'error') {
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        console.warn('[worker] calendar error:', data.message, '— using fallback');
        // BUG-A9-06: se il fallback lancia, reject invece di hangare.
        runFallbackOrReject(() => computeCalendar(shows, weekOffset), resolve, reject);
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.removeEventListener('message', handler); // CRITICAL: no leak
      console.warn('[worker] calendar timeout, fallback main-thread');
      // BUG-A9-06: se il fallback lancia, reject invece di hangare.
      runFallbackOrReject(() => computeCalendar(shows, weekOffset), resolve, reject);
    }, WORKER_TIMEOUT_MS);

    worker.addEventListener('message', handler);
    const req: WorkerRequest = { type: 'calendar', id: myId, shows, weekOffset };
    // BUG-A9-05 (FIXED): vedi computeStatsAsync. Stessa guardia per
    // DataCloneError su `shows` non-cloneable.
    try {
      worker.postMessage(req);
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        console.warn('[worker] postMessage failed (non-cloneable data?), fallback main-thread:', e);
        runFallbackOrReject(() => computeCalendar(shows, weekOffset), resolve, reject);
      }
    }
  });
}
