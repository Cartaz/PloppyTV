// Store centralizzato con subscribe (pattern observer minimale)

import type { Show } from '../types';

export interface AppState {
  shows: Show[];
  currentView: string;
  currentShowId: number | null;
  currentSeason: number | null;
  calendarWeekOffset: number;
  _storageDisabled: boolean;
  _quotaWarned: boolean;
  _discoverTab: 'popular' | 'recent';
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
};

const listeners = new Set<Listener>();

/**
 * Ritorna lo stato corrente. ATTENZIONE: l'oggetto ritornato è un riferimento
 * live allo stato interno. Le mutazioni dei campi (es. `show.list = ...`)
 * si propagano immediatamente.
 */
export function getState(): AppState {
  return state;
}

/** Applica un patch allo stato. L'array `shows` viene copiato (il chiamante può riusare il suo). */
export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch.shows ? { ...patch, shows: patch.shows.slice() } : patch);
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let _rafScheduled = false;

export function emitChange(): void {
  if (_rafScheduled) return;
  _rafScheduled = true;
  const flush = () => {
    _rafScheduled = false;
    // Snapshot statico per stabilità dell'iterazione.
    const snapshot = Array.from(listeners);
    for (const l of snapshot) {
      // Salta listener rimossi durante questo flush (rispetta unsubscribe).
      if (!listeners.has(l)) continue;
      try {
        l();
      } catch (e) {
        console.error('[store] listener error:', e);
      }
    }
  };
  requestAnimationFrame(flush);
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
  state.shows = shows.slice();
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
