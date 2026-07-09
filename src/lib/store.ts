// Store centralizzato con subscribe (pattern observer minimale)
//
// FIXES applicati:
//  - BUG-03-02: getStateSnapshot deep-clona anche gli array di episodi
//    (non solo l'oggetto seasons) → snapshot non condiviso con live state.
//  - BUG-03-03: emitChange guarda RAF con fallback a setTimeout(...,0).
//  - BUG-03-04: openShow guarda window.scrollTo (no throw se assente).
//  - BUG-03-05 / H11: reconcileList DELETATO (dead code).
//  - updateShowListStatus e reconcileAllLists (in normalize.ts) allineati:
//    entrambi rispettano manualList, demoted watching→towatch su watched=0,
//    demote completed→towatch su watched=0 (no manualList), clear manualList
//    su auto-promotion a completed.

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
 * BUG-03-02 (FIXED): deep-clona anche gli array di episodi dentro seasons,
 * non solo l'oggetto seasons. Prima, snapshot.seasons[k] === live.seasons[k]
 * (stessa reference) → mutare gli episodi nello snapshot mutava anche il live.
 */
export function getStateSnapshot(): AppState {
  return {
    ...state,
    shows: state.shows.map((s) => ({
      ...s,
      seasons: Object.fromEntries(Object.entries(s.seasons).map(([k, eps]) => [k, eps.map((ep) => ({ ...ep }))])),
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

/**
 * BUG-03-03 (FIXED): emitChange guarda RAF — se requestAnimationFrame non è
 * disponibile (SSR, headless non-visual), fallback a setTimeout(...,0).
 * In entrambi i casi, i listener vengono invocati; non viene lanciato
 * ReferenceError.
 */
export function emitChange(): void {
  if (_rafScheduled) return;
  _rafScheduled = true;
  const flush = () => {
    _rafScheduled = false;
    listeners.forEach((l) => {
      try {
        l();
      } catch (e) {
        console.error('[store] listener error:', e);
      }
    });
  };
  // Guard: se RAF non disponibile, fallback a setTimeout.
  const w = window as unknown as { requestAnimationFrame?: typeof requestAnimationFrame };
  if (typeof w.requestAnimationFrame === 'function') {
    w.requestAnimationFrame(flush);
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

/**
 * BUG-03-04 (FIXED): openShow guarda window.scrollTo — se non disponibile
 * (SSR, env di test), non lancia ReferenceError.
 */
export function openShow(showId: number): void {
  state.currentShowId = showId;
  state.currentSeason = 1;
  emitChange();
  const w = window as unknown as { scrollTo?: (x: number, y: number) => void };
  if (typeof w.scrollTo === 'function') {
    w.scrollTo(0, 0);
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
 * Rispetta `manualList`: una serie spostata manualmente non viene retrocessa.
 * Auto-promotion a `completed` resetta manualList=false.
 *
 * Allineato con `reconcileAllLists` in normalize.ts (entrambi rispettano
 * manualList, demote watching→towatch su watched=0, demote completed→towatch
 * su watched=0 senza manualList).
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
    // watched=0 → demote a towatch (sia da completed che da watching).
    if (show.list === 'completed' || show.list === 'watching') show.list = 'towatch';
  }
}

export type { ListName };
