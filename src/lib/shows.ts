// Azioni sulle serie: add, remove, move, toggle episode, mark season

import type { ListName, Show, TvmazeShow } from '../types';
import { ALLOWED_LISTS } from '../types';
import { getState, setState, emitChange, replaceShow, removeShowFromState, updateShowListStatus } from './store';
import { saveData } from './storage';
import { buildShowFromTvmaze } from './normalize';
import { getShowEpisodes, ApiError } from './api';
import { safeId } from './utils';
import { showToast } from '../components/toast';
import { showModal } from '../components/modal';
import { updateBadges } from '../components/header';

const _addShowInFlight = new Set<number>();

export async function addShowToList(tvmazeShow: TvmazeShow, list: ListName): Promise<Show | null> {
  if (!tvmazeShow || typeof tvmazeShow !== 'object' || tvmazeShow.id == null) {
    showToast('Dati serie non validi', 'error');
    return null;
  }
  const showId = safeId(tvmazeShow.id);
  if (!showId) {
    showToast('ID serie non valido', 'error');
    return null;
  }
  const state = getState();
  if (state.shows.find((s) => s.id === showId)) {
    showToast('Serie già presente nella tua lista', 'error');
    return null;
  }
  if (_addShowInFlight.has(showId)) {
    showToast('Aggiunta in corso...', 'warning');
    return null;
  }
  _addShowInFlight.add(showId);
  showToast('Caricamento episodi...');
  try {
    const episodes = await getShowEpisodes(showId);
    if (getState().shows.find((s) => s.id === showId)) {
      showToast('Serie già presente', 'error');
      return null;
    }
    const show = buildShowFromTvmaze(tvmazeShow, episodes, list);
    // Se l'utente ha scelto esplicitamente una lista, marchiala come manuale
    // così reconcileList/updateShowListStatus non la retrocederanno.
    if (list !== 'towatch') show.manualList = true;
    replaceShow(show);
    // H2 (BUG-04-01): mark local edits as in-flight so the multi-tab storage
    // event handler won't overwrite our shows during the save window. Cleared
    // right after saveData returns (success or rollback — both leave no pending edit).
    getState()._localDirty = true;
    const saved = saveData({ immediate: true });
    getState()._localDirty = false;
    if (!saved) {
      // rollback
      removeShowFromState(show.id);
      showToast('Impossibile salvare (storage pieno o modifiche in altro tab?)', 'error');
      return null;
    }
    updateBadges();
    showToast('Serie aggiunta: ' + show.name, 'success');
    if (
      ['dashboard', 'watching', 'towatch', 'completed'].includes(getState().currentView) &&
      !getState().currentShowId
    ) {
      emitChange();
    }
    return show;
  } catch (e: unknown) {
    const err = e as { name?: string; status?: number };
    let msg = 'Errore caricamento serie';
    if (err.name === 'TimeoutError') msg = 'Timeout caricamento. Riprova.';
    else if (err.name === 'NetworkError') msg = 'Connessione internet non disponibile';
    else if (err.status === 429) msg = 'Troppe richieste. Attendi qualche secondo.';
    else if (err.status === 404) msg = 'Serie non trovata';
    showToast(msg, 'error');
    console.error(e);
    return null;
  } finally {
    _addShowInFlight.delete(showId);
  }
}

export function removeShow(showId: number, showName: string): void {
  showModal(
    'Rimuovere "' + showName + '"?',
    '<p>La serie verrà rimossa dalla tua lista. Questa azione non può essere annullata.</p>',
    [
      { label: 'Annulla' },
      {
        label: 'Rimuovi',
        style: 'btn-danger',
        onClick: () => {
          const snapshot = getState().shows.map((s) => ({ ...s }));
          removeShowFromState(showId);
          // H2 (BUG-04-01): guard in-flight edits from multi-tab storage events.
          getState()._localDirty = true;
          const saved = saveData({ immediate: true });
          getState()._localDirty = false;
          if (!saved) {
            // Rollback: ripristina lo snapshot E ri-triggera il render
            setState({ shows: snapshot });
            emitChange();
            showToast('Impossibile rimuovere (storage error o modifiche in altro tab)', 'error');
            return;
          }
          updateBadges();
          showToast('Serie rimossa', 'success');
          setState({ currentView: 'dashboard', currentShowId: null });
          emitChange();
        },
      },
    ],
  );
}

/**
 * Sposta manualmente una serie in un'altra lista. Imposta `manualList=true`
 * solo per 'watching'/'completed' così le azioni successive (toggleEpisode,
 * markSeason) non retrocedono la serie. Per 'towatch' lascia `manualList=false`
 * per consentire la promozione naturale a 'watching' quando l'utente segna
 * un episodio come visto (consistente con addShowToList).
 */
export function moveShowToList(showId: number, list: ListName): void {
  const state = getState();
  const show = state.shows.find((s) => s.id === showId);
  if (!show) return;
  if (!ALLOWED_LISTS.includes(list)) return;
  if (show.list === list) return;
  const prevList = show.list;
  const prevManual = show.manualList ?? false;
  show.list = list;
  // BUG-06-01: only block demotion (watching/completed); allow natural
  // promotion from 'towatch' when the user marks an episode watched.
  show.manualList = list !== 'towatch';
  // H2 (BUG-04-01): guard in-flight edits.
  getState()._localDirty = true;
  const saved = saveData({ immediate: true });
  getState()._localDirty = false;
  if (!saved) {
    show.list = prevList;
    show.manualList = prevManual;
    showToast('Spostamento non salvato (modifiche in altro tab?)', 'error');
    return;
  }
  updateBadges();
  showToast('Serie spostata', 'success');
  emitChange();
}

/**
 * Toggle watched su un episodio. Usa `saveData({ immediate: true })`:
 * il ritorno booleano riflette davvero l'esito del salvataggio (a differenza
 * della versione debounced che ritornava sempre true), permettendo il
 * rollback corretto in caso di fallenza.
 */
export function toggleEpisode(showId: number, seasonNum: number, epNum: number): void {
  const state = getState();
  const show = state.shows.find((s) => s.id === showId);
  if (!show || !show.seasons[seasonNum]) return;
  const ep = show.seasons[seasonNum].find((e) => e.num === epNum);
  if (!ep) return;
  const prevWatched = ep.watched;
  const prevList = show.list;
  const prevManual = show.manualList ?? false;
  ep.watched = !ep.watched;
  updateShowListStatus(show);
  // H2 (BUG-04-01): guard in-flight edits.
  getState()._localDirty = true;
  const saved = saveData({ immediate: true });
  getState()._localDirty = false;
  if (!saved) {
    // Rollback reale (saveData immediate ritorna false su failure)
    ep.watched = prevWatched;
    show.list = prevList;
    show.manualList = prevManual;
    showToast('Modifica non salvata (storage error o modifiche in altro tab)', 'error');
    return;
  }
  updateBadges();
  emitChange();
}

export function markSeasonWatched(showId: number, seasonNum: number, watched: boolean): void {
  const state = getState();
  const show = state.shows.find((s) => s.id === showId);
  if (!show || !show.seasons[seasonNum]) return;
  const prevEps = show.seasons[seasonNum].map((e) => ({ ...e }));
  const prevList = show.list;
  const prevManual = show.manualList ?? false;
  show.seasons[seasonNum].forEach((ep) => {
    ep.watched = watched;
  });
  updateShowListStatus(show);
  // H2 (BUG-04-01): guard in-flight edits.
  getState()._localDirty = true;
  const saved = saveData({ immediate: true });
  getState()._localDirty = false;
  if (!saved) {
    show.seasons[seasonNum] = prevEps;
    show.list = prevList;
    show.manualList = prevManual;
    showToast('Modifica non salvata (storage error o modifiche in altro tab)', 'error');
    return;
  }
  updateBadges();
  emitChange();
}

// ===== Refresh episodi (per serie vecchie senza nome, o per aggiornare airdate) =====
const _refreshInFlight = new Set<number>();

export async function refreshShowEpisodes(showId: number, opts?: { silent?: boolean }): Promise<boolean> {
  const id = safeId(showId);
  if (!id) return false;
  if (_refreshInFlight.has(id)) {
    if (!opts?.silent) showToast('Aggiornamento già in corso...', 'warning');
    return false;
  }
  _refreshInFlight.add(id);

  const state = getState();
  const show = state.shows.find((s) => s.id === id);
  if (!show) {
    _refreshInFlight.delete(id);
    return false;
  }

  // Snapshot per rollback
  const prevSeasons = JSON.parse(JSON.stringify(show.seasons)) as Show['seasons'];
  const prevTotalEpisodes = show.totalEpisodes;
  const prevTotalSeasons = show.totalSeasons;
  const prevList = show.list;
  const prevManual = show.manualList ?? false;

  try {
    const episodes = await getShowEpisodes(id);
    // Mantiene watched state esistente, aggiorna name/airdate/runtime
    const newSeasons: Show['seasons'] = {};
    let totalEpisodes = 0;
    for (const ep of episodes) {
      if (ep.season == null || ep.season === 0) continue;
      if (ep.number == null) continue;
      const sn = safeId(ep.season);
      if (!sn) continue;
      if (!newSeasons[sn]) newSeasons[sn] = [];
      // BUG-06-02: match by stable TVMaze `id` first (survives renumbering),
      // fall back to `num` for backward compat / shows without ids.
      const existingEp =
        show.seasons[sn]?.find((e) => e.id === safeId(ep.id)) ??
        show.seasons[sn]?.find((e) => e.num === safeId(ep.number));
      newSeasons[sn].push({
        num: safeId(ep.number),
        id: safeId(ep.id),
        watched: existingEp?.watched ?? false,
        airdate: typeof ep.airdate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ep.airdate) ? ep.airdate : null,
        name: typeof ep.name === 'string' ? ep.name.slice(0, 300) : null,
        runtime: typeof ep.runtime === 'number' && ep.runtime > 0 ? ep.runtime : null,
      });
      totalEpisodes++;
    }

    show.seasons = newSeasons;
    show.totalEpisodes = totalEpisodes;
    show.totalSeasons = Object.keys(newSeasons).length;
    updateShowListStatus(show);

    // H2 (BUG-04-01): guard in-flight edits.
    getState()._localDirty = true;
    const saved = saveData({ immediate: true });
    getState()._localDirty = false;
    if (!saved) {
      // Rollback
      show.seasons = prevSeasons;
      show.totalEpisodes = prevTotalEpisodes;
      show.totalSeasons = prevTotalSeasons;
      show.list = prevList;
      show.manualList = prevManual;
      showToast('Impossibile salvare aggiornamento (storage o modifiche in altro tab)', 'error');
      return false;
    }
    updateBadges();
    emitChange();
    if (!opts?.silent) showToast('Dati serie aggiornati: ' + show.name, 'success');
    return true;
  } catch (e: unknown) {
    const err = e as { name?: string; status?: number };
    let msg = 'Errore aggiornamento serie';
    if (err.name === 'TimeoutError') msg = 'Timeout aggiornamento. Riprova.';
    else if (err.name === 'NetworkError') msg = 'Connessione internet non disponibile';
    else if (err.status === 429) msg = 'Troppe richieste. Attendi qualche secondo.';
    else if (err.status === 404) msg = 'Serie non trovata su TVMaze';
    if (!opts?.silent) showToast(msg, 'error');
    console.error(e);
    return false;
  } finally {
    _refreshInFlight.delete(id);
  }
}

// Verifica se una serie ha nomi episodi mancanti (per auto-refresh in background)
export function showNeedsEpisodeNames(show: Show): boolean {
  if (!show.seasons) return false;
  for (const eps of Object.values(show.seasons)) {
    if (!Array.isArray(eps)) continue;
    for (const ep of eps) {
      // BUG-06-03: treat empty string as missing too — normalizeShow and
      // buildShowFromTvmaze both produce `name: ''` when TVMaze returns an
      // empty string, which is functionally "missing" but wasn't detected.
      if (ep && (ep.name == null || ep.name === '')) return true;
    }
  }
  return false;
}

// Re-export alias per compatibilità
export { ApiError };
