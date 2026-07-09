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
 */
export function getStateSnapshot(): AppState {
  return {
    ...state,
    shows: state.shows.map((s) => ({ ...s, seasons: { ...s.seasons } })),
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
  requestAnimationFrame(() => {
    _rafScheduled = false;
    listeners.forEach((l) => {
      try {
        l();
      } catch (e) {
        console.error('[store] listener error:', e);
      }
    });
  });
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
  window.scrollTo(0, 0);
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
 * Rispetta `manualList`: se l'utente ha spostato manualmente la serie,
 * non retrocede MAI (non fa towatch→watching→completed nel senso inverso).
 * Può ancora promuovere a `completed` quando tutti gli episodi sono visti,
 * perché quello è un fatto oggettivo (e in quel caso resetta manualList).
 */
export function reconcileList(show: Show): void {
  const watched = getWatchedCount(show);
  if (show.totalEpisodes > 0 && watched === show.totalEpisodes) {
    show.list = 'completed';
    show.manualList = false; // auto-promotion clears manual override
  } else if (watched > 0 && show.list === 'towatch') {
    show.list = 'watching';
  } else if (show.totalEpisodes === 0 && show.list === 'completed') {
    show.list = 'towatch';
  }
  // Nota: non retrocediamo mai una serie con manualList=true
}

/**
 * Come `reconcileList` ma usato dopo azioni utente (toggle, mark season).
 * Rispetta `manualList`: una serie spostata manualmente a `completed`
 * non viene retrocessa a `watching` se l'utente segna un episodio come non visto.
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
