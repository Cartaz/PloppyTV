// Store centralizzato con subscribe (pattern observer minimale)

import type { ListName, Show } from '../types';
import { getWatchedCount } from './utils';

export interface AppState {
  shows: Show[];
  currentView: string;
  currentShowId: number | null;
  currentSeason: number | null;
  calendarWeekOffset: number;
  _storageDisabled: boolean;
  _quotaWarned: boolean;
  _discoverTab: 'popular' | 'recent';
  /**
   * `true` quando ci sono modifiche locali non ancora persistite.
   * Usato dal CAS multi-tab in storage.ts per rifiutare eventi `storage`
   * che sovrascriverebbero modifiche in-flight dell'utente.
   */
  _localDirty: boolean;
}

type Listener = () => void;

const state: AppState = {
  shows: [],
  currentView: 'dashboard',
  currentShowId: null,
  currentSeason: 1,
  calendarWeekOffset: 0,
  _storageDisabled: false,
  _quotaWarned: false,
  _discoverTab: 'popular',
  _localDirty: false,
};

const listeners = new Set<Listener>();

/**
 * Ritorna lo stato corrente. ATTENZIONE: l'oggetto ritornato è un riferimento
 * live allo stato interno. Le mutazioni dei campi (es. `show.list = ...`)
 * si propagano immediatamente. Per ottenere uno snapshot immutabile usare
 * `getStateSnapshot()`.
 */
export function getState(): AppState {
  return state;
}

/**
 * Ritorna una deep-copy dello stato. Da usare quando si vuole inviare i dati
 * a un worker, persistere, o esporre a consumer esterni senza rischiare
 * mutazioni esterne dell'oggetto ritornato.
 *
 * Nota: cloniamo anche gli array di episodi dentro `seasons` (2 livelli di
 * deep-clone). Una shallow copy qui condividerebbe i riferimenti agli array
 * `Episode[]` e una mutazione della snapshot muterebbe anche lo stato live.
 */
export function getStateSnapshot(): AppState {
  return {
    ...state,
    shows: state.shows.map((s) => ({
      ...s,
      seasons: Object.fromEntries(
        Object.entries(s.seasons).map(([k, eps]) => [k, eps.map((e) => ({ ...e }))]),
      ),
    })),
  };
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let _rafScheduled = false;
export function emitChange(): void {
  if (_rafScheduled) return;
  _rafScheduled = true;
  const flush = (): void => {
    _rafScheduled = false;
    listeners.forEach((l) => {
      try {
        l();
      } catch (e) {
        console.error('[store] listener error:', e);
      }
    });
  };
  // Guard: in ambienti senza `requestAnimationFrame` (SSR, jsdom non-visual,
  // worker) il fallback a `setTimeout(...,0)` evita che `_rafScheduled` resti
  // `true` per sempre trasformando emitChange in un no-op silente.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flush);
  } else {
    setTimeout(flush, 0);
  }
}

// ===== Mutators =====
export function switchView(view: string): void {
  state.currentView = view;
  state.currentShowId = null;
  if (view !== 'calendar') state.calendarWeekOffset = 0;
  emitChange();
}

export function openShow(showId: number): void {
  state.currentShowId = showId;
  state.currentSeason = 1;
  emitChange();
  // Guard: in ambienti senza `window` (SSR/Node) o senza `scrollTo` (alcuni
  // jsdom minimi) la chiamata non-effettuata è preferibile a un ReferenceError.
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    window.scrollTo(0, 0);
  }
}

export function closeShow(): void {
  state.currentShowId = null;
  emitChange();
}

export function switchSeason(season: number): void {
  state.currentSeason = season;
  emitChange();
}

export function changeCalendarWeek(delta: number): void {
  state.calendarWeekOffset += delta;
  emitChange();
}

export function resetCalendarWeek(): void {
  state.calendarWeekOffset = 0;
  emitChange();
}

export function setShows(shows: Show[]): void {
  state.shows = shows;
  emitChange();
}

export function replaceShow(show: Show): void {
  const idx = state.shows.findIndex((s) => s.id === show.id);
  if (idx >= 0) state.shows[idx] = show;
  else state.shows.push(show);
  emitChange();
}

export function removeShowFromState(showId: number): void {
  state.shows = state.shows.filter((s) => s.id !== showId);
  emitChange();
}

export function setDiscoverTab(tab: 'popular' | 'recent'): void {
  state._discoverTab = tab;
  emitChange();
}

export function setStorageDisabled(v: boolean): void {
  state._storageDisabled = v;
}

export function setQuotaWarned(v: boolean): void {
  state._quotaWarned = v;
}

/**
 * Riconcilia il `list` di una serie basandosi sul conteggio episodi watched.
 * Usato dopo azioni utente (toggle, mark season).
 *
 * Semantica `manualList`:
 *  - L'auto-promozione a `completed` (tutti gli episodi visti) è un fatto
 *    oggettivo: scatta sempre, e resetta `manualList=false`.
 *  - Se `manualList=true` la serie NON viene mai retrocessa (l'utente ha
 *    spostato manualmente la serie e la sua scelta va rispettata).
 *  - Se `manualList=false`, una serie con `watched===0` viene retrocessa a
 *    `towatch` (qualsiasi fosse la lista precedente).
 */
export function updateShowListStatus(show: Show): void {
  const watchedCount = getWatchedCount(show);
  if (show.totalEpisodes > 0 && watchedCount === show.totalEpisodes) {
    show.list = 'completed';
    show.manualList = false; // auto-promotion to completed clears manual override
    return;
  }
  if (show.manualList) {
    // Rispetta la scelta dell'utente: non retrocedere
    return;
  }
  if (watchedCount > 0) {
    if (show.list !== 'watching') show.list = 'watching';
  } else {
    if (show.list === 'completed' || show.list === 'watching') show.list = 'towatch';
  }
}

export type { ListName };
