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

export function setState(patch: Partial<AppState>): void {
  if (!patch || typeof patch !== 'object') return;
  // Valida `shows` se presente nel patch. Object.assign
  // copia qualsiasi valore, incluso null/undefined — se il caller passa
  // `{ shows: null }` (es. da un parse JSON malformato o un bug upstream),
  // state.shows diventa null e ogni downstream .map/.filter crasha.
  if ('shows' in patch && !Array.isArray(patch.shows)) {
    // Scarta il campo `shows` invalido; applica il resto del patch.
    const { shows: _drop, ...rest } = patch;
    void _drop;
    Object.assign(state, rest);
    return;
  }
  // Shallow-copy difensivo dell'array shows — il caller
  // potrebbe mantenere una reference e mutarla (.push/.splice/.sort) dopo
  // setState, corrompendo lo store.
  const safePatch = Array.isArray(patch.shows) ? { ...patch, shows: patch.shows.slice() } : patch;
  Object.assign(state, safePatch);
}

export function subscribe(fn: Listener): () => void {
  // Valida che fn sia una funzione. Set.add accetta
  // qualsiasi valore; un non-function verrebbe chiamato a ogni emit lanciando
  // TypeError (catturato dal try/catch in flush, ma logga rumore e spreca cicli).
  if (typeof fn !== 'function') return () => {};
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
  // Valida l'input. Se il caller passa null/undefined/
  // non-array (es. da JSON.parse malformato o bug upstream), state.shows
  // diventava null e ogni downstream .map/.filter crashava.
  // Shallow-copy difensivo — il caller potrebbe mantenere
  // una reference e mutarla (.push/.splice/.sort) dopo setShows.
  state.shows = Array.isArray(shows) ? shows.slice() : [];
  emitChange();
}

export function replaceShow(show: Show): void {
  // Valida show. Se show è null/undefined o ha id
  // non positivo/NaN, findIndex restituirebbe -1 (o peggio, matcherebbe
  // un show con id===undefined corrompendolo) e il push appenderebbe garbage.
  if (!show || typeof show !== 'object') return;
  if (typeof show.id !== 'number' || !Number.isFinite(show.id) || show.id <= 0) return;
  // Guard state.shows (defense-in-depth).
  if (!Array.isArray(state.shows)) state.shows = [];
  const idx = state.shows.findIndex((s) => s && s.id === show.id);
  if (idx >= 0) state.shows[idx] = show;
  else state.shows.push(show);
  emitChange();
}

export function removeShowFromState(showId: number): void {
  // Guard state.shows (defense-in-depth — se una corruzione
  // precedente lo ha settato a null, filter crasherebbe).
  if (!Array.isArray(state.shows)) {
    state.shows = [];
    emitChange();
    return;
  }
  state.shows = state.shows.filter((s) => s && s.id !== showId);
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
