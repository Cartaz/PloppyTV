// Calcoli pesanti (statistiche, calendario) nel Web Worker, con fallback sul
// main thread. Worker e fallback usano le stesse funzioni pure di compute.ts.
//
// Ogni richiesta porta un `id` incrementale: le risposte di richieste
// precedenti vengono ignorate. Il listener viene sempre rimosso (risposta,
// errore, timeout, postMessage fallito) e ogni percorso di errore ricade sul
// calcolo locale; se anche quello lancia, la promise viene rifiutata (la vista
// mostra lo stato di errore invece di restare in caricamento).

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
    // Imposta `_workerSupported = false` e `_worker = null` così la
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

function runFallbackOrReject<T>(fn: () => T, resolve: (v: T) => void, reject: (e: unknown) => void): void {
  try {
    resolve(fn());
  } catch (e) {
    reject(e);
  }
}

type CalendarResult = ReturnType<typeof computeCalendar>;
type ResultFor<T extends WorkerRequest['type']> = T extends 'stats' ? StatsResult : CalendarResult;

/**
 * Esegue `request` nel worker; se il worker manca, risponde con un errore,
 * non risponde entro WORKER_TIMEOUT_MS o il messaggio non è clonabile, usa
 * `fallback` sul main thread.
 */
function runInWorker<T extends WorkerRequest['type']>(
  request: Omit<Extract<WorkerRequest, { type: T }>, 'id'>,
  fallback: () => ResultFor<T>,
): Promise<ResultFor<T>> {
  return new Promise((resolve, reject) => {
    const runFallback = () => runFallbackOrReject(fallback, resolve, reject);
    const worker = getWorker();
    if (!worker) {
      runFallback();
      return;
    }
    const id = ++_requestIdCounter;
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeout);
      worker.removeEventListener('message', handler);
      return true;
    };

    const handler = (ev: MessageEvent<WorkerResponse>) => {
      const data = ev.data;
      if (!data || data.id !== id) return;
      if (data.type === request.type) {
        if (!settle()) return;
        resolve(
          (data.type === 'stats'
            ? data.result
            : {
                week: data.result,
                afterWeek: data.afterWeek,
                weekStart: data.weekStart,
                weekEnd: data.weekEnd,
              }) as ResultFor<T>,
        );
      } else if (data.type === 'error') {
        if (!settle()) return;
        console.warn('[worker] ' + request.type + ' error:', data.message, '— using fallback');
        runFallback();
      }
    };

    const timeout = setTimeout(() => {
      if (!settle()) return;
      console.warn('[worker] ' + request.type + ' timeout, fallback main-thread');
      runFallback();
    }, WORKER_TIMEOUT_MS);

    worker.addEventListener('message', handler);
    try {
      worker.postMessage({ ...request, id } as WorkerRequest);
    } catch (e) {
      if (!settle()) return;
      console.warn('[worker] postMessage failed (non-cloneable data?), fallback main-thread:', e);
      runFallback();
    }
  });
}

export function computeStatsAsync(shows: Show[]): Promise<StatsResult> {
  return runInWorker<'stats'>({ type: 'stats', shows }, () => computeStats(shows));
}

export function computeCalendarAsync(
  shows: Show[],
  weekOffset: number,
): Promise<{ week: CalendarEpisode[]; afterWeek: CalendarEpisode[]; weekStart: string; weekEnd: string }> {
  return runInWorker<'calendar'>({ type: 'calendar', shows, weekOffset }, () => computeCalendar(shows, weekOffset));
}
