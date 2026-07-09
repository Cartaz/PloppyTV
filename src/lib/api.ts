// Client TVMaze con timeout, abort, errori tipizzati
//
// FIXES applicati:
//  - C2: onExternalAbort listener resta attaccato fino a quando fetch settlea
//    (rimosso nella `finally`, non come microtask). Così un abort esterno
//    successivo (es. l'utente digita di nuovo) propaga correttamente
//    l'abort al controller interno e aborta la fetch in-flight.
//  - H6: searchShows/getShowEpisodes/getShowsPage coerce null → [] (body vuoto).

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
 * C2 FIX: l'`onExternalAbort` listener resta attaccato al signal esterno fino
 * a quando la fetch non settlea (rimosso nella `finally`). Prima veniva
 * rimosso come microtask, il che impediva a un abort esterno successivo
 * (es. l'utente digita di nuovo dopo qualche decina di ms) di propagarsi
 * alla fetch in-flight.
 */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  // C2 FIX: propaga abort dal signal esterno al controller interno.
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
      if (!signal || !signal.aborted) {
        throw new ApiError('Request timeout', 'TimeoutError');
      }
      throw e; // abort richiesto dal caller — propaghiamo l'AbortError originale
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
    // C2 FIX: rimuovi il listener solo qui, dopo che fetch ha settleato.
    if (onExternalAbort && signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * H6 FIX: searchShows/getShowEpisodes/getShowsPage coerciscono null → []
 * (body vuoto da TVMaze ritorna null da apiGet; i caller si aspettano un array).
 */
export async function searchShows(query: string, signal?: AbortSignal): Promise<TvmazeSearchResult[]> {
  const r = await apiGet<TvmazeSearchResult[]>('/search/shows?q=' + encodeURIComponent(query), signal);
  return r ?? [];
}

export async function getShowEpisodes(showId: number, signal?: AbortSignal): Promise<TvmazeEpisode[]> {
  const r = await apiGet<TvmazeEpisode[]>('/shows/' + encodeURIComponent(showId) + '/episodes', signal);
  return r ?? [];
}

export async function getShowsPage(page: number, signal?: AbortSignal): Promise<TvmazeShow[]> {
  const r = await apiGet<TvmazeShow[]>('/shows?page=' + encodeURIComponent(page), signal);
  return r ?? [];
}
