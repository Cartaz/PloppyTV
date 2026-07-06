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

export function getState(): AppState {
  return state;
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

// Riconciliazione list basata su watched count
export function reconcileList(show: Show): void {
  const watched = getWatchedCount(show);
  if (show.totalEpisodes > 0 && watched === show.totalEpisodes) {
    show.list = 'completed';
  } else if (watched > 0 && show.list === 'towatch') {
    show.list = 'watching';
  }
  if (show.totalEpisodes === 0 && show.list === 'completed') {
    show.list = 'towatch';
  }
}

export function updateShowListStatus(show: Show): void {
  const watchedCount = getWatchedCount(show);
  if (show.totalEpisodes > 0 && watchedCount === show.totalEpisodes) {
    show.list = 'completed';
  } else if (watchedCount > 0) {
    if (show.list !== 'watching') show.list = 'watching';
  } else {
    if (show.list === 'completed' || show.list === 'watching') show.list = 'towatch';
  }
}

export type { ListName };
