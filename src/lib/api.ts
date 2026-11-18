// Client TVMaze con timeout, abort, errori tipizzati

import type { TvmazeEpisode, TvmazeSearchResult, TvmazeShow } from '../types';
import { API_BASE, API_TIMEOUT_MS } from './constants';

export class ApiError extends Error {
  status?: number;
  override name: string;
  constructor(message: string, name: string, status?: number) {
    super(message);
    this.name = name;
    this.status = status;
  }
}

/**
 * GET con timeout, abort propagato da signal esterno, e parse error tipizzato.
 *
 * Tipi di errore (tutti ApiError):
 *  - `TimeoutError`: timeout interno (API_TIMEOUT_MS)
 *  - `AbortError`: abort richiesto dal caller via `signal`
 *  - `NetworkError`: fetch fallita lato rete (TypeError)
 *  - `RateLimitError`: HTTP 429
 *  - `ApiError`: HTTP non ok (con `status`)
 *  - `ParseError`: body non JSON o JSON malformato (anche 200 OK con HTML)
 *
 * A5-01 FIX: il flag `timedOut` viene settato quando il setTimeout interno
 * fire (prima di chiamare `controller.abort()`). Nel catch, se `timedOut` è
 * true, classifichiamo come `TimeoutError` — anche se `signal.aborted` nel
 * frattempo è diventato true (race: external abort tardivo dopo il fire del
 * timeout, ma prima del microtask di reject della fetch).
 */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  // A5-01: flag esplicito per distinguere timeout interno da abort esterno.
  // Nel race window tra il fire del setTimeout e il microtask di reject della
  // fetch, `signal.aborted` potrebbe diventare true (abort esterno tardivo),
  // ma la vera causa del reject è il timeout interno.
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_TIMEOUT_MS);

  // Propaga abort dal signal esterno al controller interno.
  // Il listener resta attaccato fino alla `finally` (non microtask cleanup).
  let onExternalAbort: (() => void) | null = null;
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetch(API_BASE + path, { signal: controller.signal });
    if (!res.ok) {
      throw new ApiError('API error ' + res.status, res.status === 429 ? 'RateLimitError' : 'ApiError', res.status);
    }
    // Body vuoto o non-JSON: gestione esplicita per evitare SyntaxError
    // non tipizzato che il caller non saprebbe gestire.
    const text = await res.text();
    if (!text) {
      // Body vuoto: ritorniamo null come "no data" (TVMaze fa così su alcuni endpoint)
      return null as unknown as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      // Body presente ma non JSON valido (es. HTML 200 da preview server)
      throw new ApiError('Risposta API non valida (JSON malformato)', 'ParseError');
    }
  } catch (e: unknown) {
    if (e instanceof ApiError) throw e;
    const err = e as { name?: string };
    if (err.name === 'AbortError') {
      // A5-01: timeout interno vince sul race con abort esterno tardivo.
      if (timedOut) {
        throw new ApiError('Request timeout', 'TimeoutError');
      }
      // Abort richiesto dal caller via signal — propaghiamo l'AbortError originale.
      if (signal && signal.aborted) {
        throw e;
      }
      // Defensive fallback (non dovrebbe mai succedere con fetch standard):
      // trattiamo come timeout per non propagare un AbortError non tipizzato.
      throw new ApiError('Request timeout', 'TimeoutError');
    }
    if (err.name === 'SyntaxError') {
      // Safety net (dovrebbe essere già coperto dal try/catch sopra)
      throw new ApiError('Risposta API non valida', 'ParseError');
    }
    if (err.name === 'TypeError') {
      throw new ApiError('Network error', 'NetworkError');
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
    // Rimuovi il listener solo qui, dopo che fetch ha settleato.
    if (onExternalAbort && signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export async function searchShows(query: string, signal?: AbortSignal): Promise<TvmazeSearchResult[]> {
  const r = await apiGet<TvmazeSearchResult[]>('/search/shows?q=' + encodeURIComponent(query), signal);
  return Array.isArray(r) ? r : [];
}

export async function getShowEpisodes(showId: number, signal?: AbortSignal): Promise<TvmazeEpisode[]> {
  const r = await apiGet<TvmazeEpisode[]>('/shows/' + encodeURIComponent(showId) + '/episodes', signal);
  return Array.isArray(r) ? r : [];
}

export async function getShowsPage(page: number, signal?: AbortSignal): Promise<TvmazeShow[]> {
  const r = await apiGet<TvmazeShow[]>('/shows?page=' + encodeURIComponent(page), signal);
  return Array.isArray(r) ? r : [];
}

/** Mappa `{ [showId]: updatedAt }` delle serie aggiornate nel periodo. */
export async function getUpdatedShowIds(since: 'day' | 'week', signal?: AbortSignal): Promise<number[]> {
  const r = await apiGet<Record<string, unknown>>('/updates/shows?since=' + since, signal);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return [];
  return Object.keys(r)
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}
