// Client TVMaze con timeout, abort, errori tipizzati
//
// FIXES applicati:
//  - C2: onExternalAbort listener resta attaccato fino a quando fetch settlea
//    (rimosso nella `finally`, non come microtask). Così un abort esterno
//    successivo (es. l'utente digita di nuovo) propaga correttamente
//    l'abort al controller interno e aborta la fetch in-flight.
//  - H6: searchShows/getShowEpisodes/getShowsPage coerce null → [] (body vuoto).
//  - A5-01: `timedOut` flag distingue timeout interno da abort esterno anche
//    nel race window tra il fire del setTimeout interno e il microtask che
//    risolve il reject della fetch. Prima, se `signal.aborted` era true al
//    catch, si propagava AbortError — anche quando l'abort della fetch era
//    stato causato dal timeout interno e l'abort esterno era arrivato
//    tardivamente (subito dopo il fire del timeout, ma prima che il microtask
//    di reject della fetch girasse). Con il flag, timeout vince.
//  - A5-02: i wrapper validano `Array.isArray(r)` (non solo `r ?? []`).
//    Se TVMaze ritorna JSON non-array (es. `{"error":...}`, primitiva, stringa)
//    su endpoint documentati come array, i wrapper ritornano `[]` invece di
//    passare through l'oggetto e far crashare il caller in `for (const ep of episodes)`.

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
    // C2 FIX: rimuovi il listener solo qui, dopo che fetch ha settleato.
    if (onExternalAbort && signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * H6 + A5-02 FIX: i wrapper coerciscono non solo `null` ma qualsiasi
 * valore non-array (oggetto, primitiva, stringa) a `[]`. Se TVMaze ritorna
 * JSON inatteso su endpoint documentati come array, i caller non crashano
 * in `for (const ep of episodes)`.
 */
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
