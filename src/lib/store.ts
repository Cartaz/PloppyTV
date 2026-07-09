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
//
// Agent A2 fixes:
//  - BUG-A2-01: setShows valida l'input (null/undefined/non-array → []).
//  - BUG-A2-02: setShows/setState shallow-copy difensivo dell'array shows;
//    replaceShow/removeShowFromState guardano state.shows (defense-in-depth).
//  - BUG-A2-03: replaceShow valida show (null/undefined/id non positivo → no-op).
//  - BUG-A2-04: getStateSnapshot deep-clona anche tags e genres (prima erano
//    shared reference → mutare snap.shows[0].tags.push(...) leakava nel live).
//  - BUG-A2-05: getStateSnapshot gestisce seasons malformati (null/array/
//    non-object) senza throw — restituisce {} in quel caso.
//  - BUG-A2-06: setState valida `shows` se presente nel patch (Object.assign
//    con shows:null corrompeva state.shows).
//  - BUG-A2-07: emitChange fa snapshot dei listener prima di iterare
//    (Set.forEach è live: un listener iscritto durante l'emit sarebbe
//    stato chiamato nello stesso flush — reentrancy hazard).
//  - BUG-A2-08: subscribe valida che fn sia una funzione (Set.add accetta
//    qualsiasi valore; non-function avrebbe throwato a ogni emit).

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
 *
 * BUG-A2-04 (FIXED): deep-clona anche gli array `tags` e `genres`. Prima
 * erano copiati per reference (`{ ...s }` copia solo i top-level props),
 * quindi snap.shows[0].tags === live.shows[0].tags → push/pop sul snapshot
 * leakavano nel live state.
 *
 * BUG-A2-05 (FIXED): gestisce seasons malformati (null, undefined, array,
 * primitive) senza throw. Prima Object.entries(s.seasons) lanciava TypeError
 * se seasons era null/undefined, corrompendo l'intero snapshot.
 */
export function getStateSnapshot(): AppState {
  return {
    ...state,
    // BUG-A2-05: guard contro state.shows non-array (non dovrebbe mai
    // succedere dopo le fix di setShows/setState, ma defense-in-depth).
    shows: (Array.isArray(state.shows) ? state.shows : [])
      .filter((s): s is Show => !!s && typeof s === 'object')
      .map((s) => {
        const cloned: Show = { ...s };
        // BUG-A2-04: deep-clone tags e genres (array di stringhe).
        if (Array.isArray(cloned.tags)) cloned.tags = cloned.tags.slice();
        if (Array.isArray(cloned.genres)) cloned.genres = cloned.genres.slice();
        // BUG-A2-05: guard contro seasons malformati.
        if (s.seasons && typeof s.seasons === 'object' && !Array.isArray(s.seasons)) {
          cloned.seasons = Object.fromEntries(
            Object.entries(s.seasons).map(([k, eps]) => [
              k,
              Array.isArray(eps) ? eps.map((ep) => ({ ...ep })) : [],
            ]),
          );
        } else {
          cloned.seasons = {};
        }
        return cloned;
      }),
  };
}

export function setState(patch: Partial<AppState>): void {
  if (!patch || typeof patch !== 'object') return;
  // BUG-A2-06 (FIXED): valida `shows` se presente nel patch. Object.assign
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
  // BUG-A2-02 (FIXED): shallow-copy difensivo dell'array shows — il caller
  // potrebbe mantenere una reference e mutarla (.push/.splice/.sort) dopo
  // setState, corrompendo lo store.
  const safePatch = Array.isArray(patch.shows) ? { ...patch, shows: patch.shows.slice() } : patch;
  Object.assign(state, safePatch);
}

export function subscribe(fn: Listener): () => void {
  // BUG-A2-08 (FIXED): valida che fn sia una funzione. Set.add accetta
  // qualsiasi valore; un non-function verrebbe chiamato a ogni emit lanciando
  // TypeError (catturato dal try/catch in flush, ma logga rumore e spreca cicli).
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let _rafScheduled = false;

/**
 * BUG-03-03 (FIXED): emitChange guarda RAF — se requestAnimationFrame non è
 * disponibile (SSR, headless non-visual), fallback a setTimeout(...,0).
 * In entrambi i casi, i listener vengono invocati; non viene lanciato
 * ReferenceError.
 *
 * BUG-A2-07 (FIXED): snapshot dei listener prima di iterare. Set.forEach
 * itera il set LIVE: un listener iscritto durante l'emit sarebbe stato
 * chiamato nello stesso flush (reentrancy hazard), e un listener rimosso
 * da un altro listener durante l'emit sarebbe stato saltato silenziosamente.
 * Ora si itera su uno snapshot Array; i listener aggiunti durante l'emit
 * non fireano nel flush corrente (fireano nel prossimo emitChange).
 * I listener rimossi durante l'emit vengono saltati (check listeners.has).
 */
export function emitChange(): void {
  if (_rafScheduled) return;
  _rafScheduled = true;
  const flush = () => {
    _rafScheduled = false;
    // BUG-A2-07: snapshot statico per stabilità dell'iterazione.
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
  // BUG-A2-01 (FIXED): valida l'input. Se il caller passa null/undefined/
  // non-array (es. da JSON.parse malformato o bug upstream), state.shows
  // diventava null e ogni downstream .map/.filter crashava.
  // BUG-A2-02 (FIXED): shallow-copy difensivo — il caller potrebbe mantenere
  // una reference e mutarla (.push/.splice/.sort) dopo setShows.
  state.shows = Array.isArray(shows) ? shows.slice() : [];
  emitChange();
}

export function replaceShow(show: Show): void {
  // BUG-A2-03 (FIXED): valida show. Se show è null/undefined o ha id
  // non positivo/NaN, findIndex restituirebbe -1 (o peggio, matcherebbe
  // un show con id===undefined corrompendolo) e il push appenderebbe garbage.
  if (!show || typeof show !== 'object') return;
  if (typeof show.id !== 'number' || !Number.isFinite(show.id) || show.id <= 0) return;
  // BUG-A2-02: guard state.shows (defense-in-depth).
  if (!Array.isArray(state.shows)) state.shows = [];
  const idx = state.shows.findIndex((s) => s && s.id === show.id);
  if (idx >= 0) state.shows[idx] = show;
  else state.shows.push(show);
  emitChange();
}

export function removeShowFromState(showId: number): void {
  // BUG-A2-02: guard state.shows (defense-in-depth — se una corruzione
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
