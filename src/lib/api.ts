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
 */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  // Propaga abort dal signal esterno al controller interno.
  // Importante: rimuoviamo il listener quando finiamo per evitare leak
  // su signal long-lived (es. uno stesso AbortController usato per N richieste).
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      controller.abort();
    } else {
      const onExternalAbort = () => controller.abort();
      signal.addEventListener('abort', onExternalAbort, { once: true });
      // Cleanup del listener esterno alla prima risoluzione
      const cleanup = () => signal.removeEventListener('abort', onExternalAbort);
      // Lo agganciamo a microtask+macro per coprire sia fast-resolve che throw
      Promise.resolve(controller.signal.aborted ? null : undefined)
        .then(cleanup)
        .catch(cleanup);
      setTimeout(cleanup, API_TIMEOUT_MS + 50);
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
  }
}

export async function searchShows(query: string, signal?: AbortSignal): Promise<TvmazeSearchResult[]> {
  return apiGet<TvmazeSearchResult[]>('/search/shows?q=' + encodeURIComponent(query), signal);
}

export async function getShowEpisodes(showId: number, signal?: AbortSignal): Promise<TvmazeEpisode[]> {
  return apiGet<TvmazeEpisode[]>('/shows/' + encodeURIComponent(showId) + '/episodes', signal);
}

export async function getShowsPage(page: number, signal?: AbortSignal): Promise<TvmazeShow[]> {
  return apiGet<TvmazeShow[]>('/shows?page=' + encodeURIComponent(page), signal);
}
