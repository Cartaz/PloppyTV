// Azioni sulle serie: add, remove, move, toggle episode, mark season

import type { Episode, ListName, Show, TvmazeShow } from '../types';
import { ALLOWED_LISTS } from '../types';
import { getState, setState, emitChange, replaceShow, removeShowFromState } from './store';
import { saveData } from './storage';
import { buildShowFromTvmaze, updateShowListStatus } from './normalize';
import { getShowEpisodes, apiErrorMessage } from './api';
import { safeId } from './utils';
import { showToast } from '../components/toast';
import { showModal } from '../components/modal';
import { updateBadges } from '../components/header';
import { MAX_EPISODE_NOTE_LENGTH, MAX_EPISODE_RATING, MAX_TAG_LENGTH, MAX_TAGS_PER_SHOW } from './constants';
import { t } from './i18n';

const _addShowInFlight = new Set<number>();

function findShow(showId: number): Show | undefined {
  return getState().shows.find((s) => s.id === showId);
}

function findEpisode(show: Show, seasonNum: number, epNum: number): Episode | undefined {
  return show.seasons[seasonNum]?.find((e) => e.num === epNum);
}

export async function addShowToList(tvmazeShow: TvmazeShow, list: ListName): Promise<Show | null> {
  if (!tvmazeShow || typeof tvmazeShow !== 'object' || tvmazeShow.id == null) {
    showToast(t('search.datiSerieValidi'), 'error');
    return null;
  }
  const showId = safeId(tvmazeShow.id);
  if (!showId) {
    showToast(t('shows.idSerieValido'), 'error');
    return null;
  }
  // Valida `list` — un valore non in ALLOWED_LISTS causerebbe
  // `buildShowFromTvmaze` a fare fallback a 'towatch', ma poi la riga
  // `if (list !== 'towatch') show.manualList = true` imposterebbe manualList=true,
  // lasciando lo stato inconsistente (list='towatch', manualList=true).
  if (!ALLOWED_LISTS.includes(list)) {
    showToast(t('shows.listaValida'), 'error');
    return null;
  }
  const state = getState();
  if (state.shows.find((s) => s.id === showId)) {
    showToast(t('toast.serieExists'), 'error');
    return null;
  }
  if (_addShowInFlight.has(showId)) {
    showToast(t('toast.adding'), 'warning');
    return null;
  }
  _addShowInFlight.add(showId);
  showToast(t('toast.loadingEpisodes'));
  try {
    const episodes = await getShowEpisodes(showId);
    if (getState().shows.find((s) => s.id === showId)) {
      showToast(t('toast.serieExistsShort'), 'error');
      return null;
    }
    const show = buildShowFromTvmaze(tvmazeShow, episodes, list);
    // Se l'utente ha scelto esplicitamente una lista, marchiala come manuale
    // così updateShowListStatus non la retrocederà.
    if (list !== 'towatch') show.manualList = true;
    // "Completata" significa già vista: senza segnare gli episodi la serie
    // risulterebbe completata con 0 episodi visti (stats e calendario incoerenti).
    if (list === 'completed') {
      for (const eps of Object.values(show.seasons)) for (const ep of eps) ep.watched = true;
      updateShowListStatus(show);
    }
    replaceShow(show);
    if (!saveData()) {
      // rollback
      removeShowFromState(show.id);
      showToast(t('shows.impossibileSalvareStoragePieno'), 'error');
      return null;
    }
    updateBadges();
    showToast(t('shows.added', { name: show.name }), 'success');
    if (
      ['dashboard', 'watching', 'towatch', 'completed'].includes(getState().currentView) &&
      !getState().currentShowId
    ) {
      emitChange();
    }
    return show;
  } catch (e: unknown) {
    showToast(apiErrorMessage(e, 'load'), 'error');
    console.error(e);
    return null;
  } finally {
    _addShowInFlight.delete(showId);
  }
}

export function removeShow(showId: number, showName: string): void {
  showModal(t('shows.removeTitle', { name: showName }), '<p>' + t('modal.remove.body') + '</p>', [
    { label: t('actions.cancel') },
    {
      label: t('actions.remove'),
      style: 'btn-danger',
      onClick: () => {
        const snapshot = getState().shows.map((s) => ({ ...s }));
        removeShowFromState(showId);
        if (!saveData()) {
          // Rollback: ripristina lo snapshot E ri-triggera il render
          setState({ shows: snapshot });
          emitChange();
          showToast(t('toast.removeError'), 'error');
          return;
        }
        updateBadges();
        showToast(t('toast.serieRemoved'), 'success');
        setState({ currentView: 'dashboard', currentShowId: null });
        emitChange();
      },
    },
  ]);
}

/**
 * Sposta manualmente una serie in un'altra lista. Imposta `manualList=true`
 * così le azioni successive (toggleEpisode, markSeason) non retrocedono
 * la serie a meno che l'utente non raggiunga naturalmente `completed`.
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
  // Towatch NON imposta manualList (permette promozione naturale).
  // watching e completed impostano manualList=true (blocca retrocessione).
  show.manualList = list !== 'towatch';
  if (!saveData()) {
    show.list = prevList;
    show.manualList = prevManual;
    showToast(t('toast.moveError'), 'error');
    return;
  }
  updateBadges();
  showToast(t('toast.serieMoved'), 'success');
  emitChange();
}

/** Toggle watched su un episodio, con rollback se il salvataggio fallisce. */
export function toggleEpisode(showId: number, seasonNum: number, epNum: number): void {
  const show = findShow(showId);
  const ep = show && findEpisode(show, seasonNum, epNum);
  if (!show || !ep) return;
  const prevWatched = ep.watched;
  const prevList = show.list;
  const prevManual = show.manualList ?? false;
  ep.watched = !ep.watched;
  updateShowListStatus(show);
  if (!saveData()) {
    ep.watched = prevWatched;
    show.list = prevList;
    show.manualList = prevManual;
    showToast(t('toast.notSaved'), 'error');
    return;
  }
  updateBadges();
  emitChange();
}

export function markSeasonWatched(showId: number, seasonNum: number, watched: boolean): void {
  const show = findShow(showId);
  const seasonArr = show?.seasons[seasonNum];
  if (!show || !seasonArr) return;
  const prevEps = seasonArr.map((e) => ({ ...e }));
  const prevList = show.list;
  const prevManual = show.manualList ?? false;
  seasonArr.forEach((ep) => {
    ep.watched = watched;
  });
  updateShowListStatus(show);
  if (!saveData()) {
    show.seasons[seasonNum] = prevEps;
    show.list = prevList;
    show.manualList = prevManual;
    showToast(t('toast.notSaved'), 'error');
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
    if (!opts?.silent) showToast(t('shows.aggiornamentoGiaCorso'), 'warning');
    return false;
  }
  _refreshInFlight.add(id);

  const show = findShow(id);
  if (!show) {
    _refreshInFlight.delete(id);
    return false;
  }

  try {
    const episodes = await getShowEpisodes(id);
    // Se l'API ritorna 0 episodi ma lo show ne aveva, NON wipeare
    // i dati utente (potrebbe essere un glitch temporaneo dell'API o un 200 OK vuoto).
    if (episodes.length === 0 && Object.keys(show.seasons).length > 0) {
      if (!opts?.silent) showToast(t('shows.nessunEpisodioRicevutoDati'), 'warning');
      return false;
    }
    // Un import, una rimozione o la sincronizzazione multi-tab può aver
    // sostituito la serie durante la richiesta. La risposta appartiene solo
    // all'istanza per cui è partita; non deve modificare la nuova istanza.
    if (findShow(id) !== show) return false;

    // La normalizzazione dei metadati API ha un solo proprietario, condiviso
    // con l'aggiunta iniziale. Anche un array non vuoto può non contenere
    // nessun episodio utilizzabile: in quel caso preserviamo i dati esistenti.
    const refreshed = buildShowFromTvmaze({ id }, episodes, show.list);
    if (refreshed.totalEpisodes === 0 && show.totalEpisodes > 0) {
      if (!opts?.silent) showToast(t('shows.nessunEpisodioRicevutoDati'), 'warning');
      return false;
    }
    const newSeasons = refreshed.seasons;
    const existingById = new Map<number, Episode>();
    for (const season of Object.values(show.seasons)) {
      for (const ep of season) {
        if (ep.id > 0) existingById.set(ep.id, ep);
      }
    }
    for (const [season, seasonEpisodes] of Object.entries(newSeasons)) {
      for (const ep of seasonEpisodes) {
        let existing = ep.id > 0 ? existingById.get(ep.id) : undefined;
        if (!existing) {
          const positional = show.seasons[Number(season)]?.find((old) => old.num === ep.num);
          // La posizione è un fallback per dati legacy senza ID. Due ID
          // validi e diversi identificano episodi diversi, anche dopo renumber.
          if (positional && (!ep.id || !safeId(positional.id))) existing = positional;
        }
        ep.watched = existing?.watched === true;
        if (existing && typeof existing.rating === 'number' && Number.isFinite(existing.rating)) {
          const rating = Math.round(existing.rating);
          if (rating >= 1 && rating <= MAX_EPISODE_RATING) ep.rating = rating;
        }
        if (existing && typeof existing.note === 'string' && existing.note.length > 0) {
          ep.note = existing.note.slice(0, MAX_EPISODE_NOTE_LENGTH);
        }
      }
    }

    // Il rollback appartiene alla modifica sincrona, dopo l'await: comprende
    // anche gli edit dell'utente effettuati mentre l'API rispondeva.
    const prevSeasons = show.seasons;
    const prevTotalEpisodes = show.totalEpisodes;
    const prevTotalSeasons = show.totalSeasons;
    const prevList = show.list;
    const prevManual = show.manualList;

    show.seasons = newSeasons;
    show.totalEpisodes = refreshed.totalEpisodes;
    show.totalSeasons = refreshed.totalSeasons;
    updateShowListStatus(show);

    if (!saveData()) {
      // Rollback
      show.seasons = prevSeasons;
      show.totalEpisodes = prevTotalEpisodes;
      show.totalSeasons = prevTotalSeasons;
      show.list = prevList;
      show.manualList = prevManual;
      showToast(t('shows.impossibileSalvareAggiornamentoStorage'), 'error');
      return false;
    }
    updateBadges();
    emitChange();
    if (!opts?.silent) showToast(t('shows.refreshed', { name: show.name }), 'success');
    return true;
  } catch (e: unknown) {
    if (!opts?.silent) showToast(apiErrorMessage(e, 'refresh'), 'error');
    console.error(e);
    return false;
  } finally {
    _refreshInFlight.delete(id);
  }
}

// Verifica se una serie ha nomi episodi mancanti (per auto-refresh in background)
export function showNeedsEpisodeNames(show: Show): boolean {
  for (const eps of Object.values(show.seasons)) {
    for (const ep of eps) {
      if (!ep.name) return true;
    }
  }
  return false;
}

// ===== P2.1: Rating 5★ per episodio =====

/**
 * Imposta il rating (1-5) di un episodio. Passare 0 o undefined per rimuovere.
 * Salva immediatamente su localStorage con rollback in caso di fallimento.
 */
export function setEpisodeRating(showId: number, seasonNum: number, epNum: number, rating: number): void {
  const show = findShow(showId);
  const ep = show && findEpisode(show, seasonNum, epNum);
  if (!ep) return;

  // Valida rating: 0 = rimuovi, 1..MAX = valido.
  let newRating: number | undefined;
  if (typeof rating === 'number' && Number.isFinite(rating)) {
    const r = Math.round(rating);
    if (r >= 1 && r <= MAX_EPISODE_RATING) newRating = r;
    else if (r === 0) newRating = undefined;
    else return; // valore fuori range, ignora
  } else {
    newRating = undefined;
  }

  const prevRating = ep.rating;
  ep.rating = newRating;

  if (!saveData()) {
    ep.rating = prevRating;
    showToast(t('toast.ratingError'), 'error');
    return;
  }
  emitChange();
}

// ===== P2.2: Note private per episodio =====

/**
 * Imposta la nota privata di un episodio (max 500 char). Stringa vuota = rimuovi.
 * Salva immediatamente su localStorage con rollback in caso di fallimento.
 */
export function setEpisodeNote(showId: number, seasonNum: number, epNum: number, note: string): boolean {
  const show = findShow(showId);
  const ep = show && findEpisode(show, seasonNum, epNum);
  if (!ep) return false;

  const trimmed = typeof note === 'string' ? note.slice(0, MAX_EPISODE_NOTE_LENGTH).trim() : '';
  const newNote = trimmed.length > 0 ? trimmed : undefined;
  const prevNote = ep.note;
  ep.note = newNote;

  if (!saveData()) {
    ep.note = prevNote;
    showToast(t('toast.noteError'), 'error');
    return false;
  }
  emitChange();
  return true;
}

// ===== P2.3: Tag personalizzabili per serie =====

/**
 * Aggiunge un tag a una serie. Dedup case-insensitive, tronca a MAX_TAG_LENGTH,
 * max MAX_TAGS_PER_SHOW tag per serie.
 */
export function addShowTag(showId: number, tag: string): boolean {
  const state = getState();
  const show = state.shows.find((s) => s.id === showId);
  if (!show) return false;
  const trimmed = typeof tag === 'string' ? tag.trim().slice(0, MAX_TAG_LENGTH) : '';
  if (trimmed.length === 0) return false;

  const tags = show.tags ?? [];
  // Dedup case-insensitive: se "Estate" esiste, "estate" non viene aggiunto.
  const lower = trimmed.toLowerCase();
  if (tags.some((t) => t.toLowerCase() === lower)) {
    showToast(t('tags.duplicate'), 'warning');
    return false;
  }
  if (tags.length >= MAX_TAGS_PER_SHOW) {
    showToast(t('shows.maxTags', { max: MAX_TAGS_PER_SHOW }), 'warning');
    return false;
  }

  const prevTags = show.tags;
  show.tags = [...tags, trimmed];

  if (!saveData()) {
    show.tags = prevTags;
    showToast(t('toast.tagError'), 'error');
    return false;
  }
  emitChange();
  return true;
}

/**
 * Rimuove un tag da una serie (match case-insensitive).
 */
export function removeShowTag(showId: number, tag: string): void {
  const state = getState();
  const show = state.shows.find((s) => s.id === showId);
  // Tag non-string causerebbe TypeError su toLowerCase().
  // Show.tags non-array causerebbe TypeError su filter()/length.
  if (!show?.tags?.length) return;
  const lower = tag.toLowerCase();
  const prevTags = show.tags;
  show.tags = show.tags.filter((t) => t.toLowerCase() !== lower);

  if (show.tags.length === prevTags.length) return; // nessun cambiamento

  if (!saveData()) {
    show.tags = prevTags;
    showToast(t('toast.tagRemoveError'), 'error');
    return;
  }
  emitChange();
}

// ===== P2.5: Rivedi un episodio casuale (gold 5★) =====

/**
 * Ritorna un episodio casuale con rating 5★ dalla libreria dell'utente.
 * Usa crypto.getRandomValues se disponibile (better randomness), fallback Math.random.
 * Ritorna null se non ci sono episodi gold.
 */
export function getRandomGoldEpisode(): {
  show: Show;
  season: number;
  ep: Show['seasons'][number][number];
} | null {
  const state = getState();
  const gold: Array<{ show: Show; season: number; ep: Show['seasons'][number][number] }> = [];
  for (const show of state.shows) {
    for (const seasonKey of Object.keys(show.seasons)) {
      const seasonNum = Number(seasonKey);
      if (!Number.isInteger(seasonNum) || seasonNum <= 0) continue;
      for (const ep of show.seasons[seasonNum]) {
        if (ep.rating === MAX_EPISODE_RATING && ep.watched) {
          gold.push({ show, season: seasonNum, ep });
        }
      }
    }
  }
  if (gold.length === 0) return null;
  // crypto-safe random index
  let idx: number;
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    idx = arr[0] % gold.length;
  } else {
    idx = Math.floor(Math.random() * gold.length);
  }
  return gold[idx];
}

/**
 * Raccoglie tutti i tag usati dall'utente (per autocomplete/suggerimenti filtri).
 */
export function getAllUserTags(): string[] {
  const state = getState();
  const set = new Set<string>();
  for (const show of state.shows) {
    for (const t of show.tags ?? []) set.add(t);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
