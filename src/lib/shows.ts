// Azioni sulle serie: add, remove, move, toggle episode, mark season

import type { Episode, ListName, Show, TvmazeShow } from '../types';
import { ALLOWED_LISTS } from '../types';
import { getState, setState, emitChange, replaceShow, removeShowFromState, updateShowListStatus } from './store';
import { saveData } from './storage';
import { buildShowFromTvmaze } from './normalize';
import { getShowEpisodes, ApiError } from './api';
import { safeId, stripHtml, parseISODateLocal } from './utils';
import { showToast } from '../components/toast';
import { showModal } from '../components/modal';
import { updateBadges } from '../components/header';
import { MAX_EPISODE_NOTE_LENGTH, MAX_EPISODE_RATING, MAX_TAG_LENGTH, MAX_TAGS_PER_SHOW } from './constants';

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
  // BUG-A6-10: valida `list` — un valore non in ALLOWED_LISTS causerebbe
  // `buildShowFromTvmaze` a fare fallback a 'towatch', ma poi la riga
  // `if (list !== 'towatch') show.manualList = true` imposterebbe manualList=true,
  // lasciando lo stato inconsistente (list='towatch', manualList=true).
  if (!ALLOWED_LISTS.includes(list)) {
    showToast('Lista non valida', 'error');
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
    if (!saveData({ immediate: true })) {
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
          if (!saveData({ immediate: true })) {
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
  // BUG-06-01: towatch NON imposta manualList (permette promozione naturale).
  // watching e completed impostano manualList=true (blocca retrocessione).
  show.manualList = list !== 'towatch';
  if (!saveData({ immediate: true })) {
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
  // BUG-A6-07: guard show.seasons (corrupted state) e Array.isArray per seasonArr.
  // Prima, `!show.seasons[seasonNum]` lanciava TypeError se show.seasons era undefined.
  if (!show || !show.seasons || typeof show.seasons !== 'object') return;
  const seasonArr = show.seasons[seasonNum];
  if (!Array.isArray(seasonArr)) return;
  const ep = seasonArr.find((e) => e && e.num === epNum);
  if (!ep) return;
  const prevWatched = ep.watched;
  const prevList = show.list;
  const prevManual = show.manualList ?? false;
  ep.watched = !ep.watched;
  updateShowListStatus(show);
  if (!saveData({ immediate: true })) {
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
  // BUG-A6-07: guard show.seasons (corrupted state) e Array.isArray per seasonArr.
  if (!show || !show.seasons || typeof show.seasons !== 'object') return;
  const seasonArr = show.seasons[seasonNum];
  if (!Array.isArray(seasonArr)) return;
  const prevEps = seasonArr.map((e) => ({ ...e }));
  const prevList = show.list;
  const prevManual = show.manualList ?? false;
  seasonArr.forEach((ep) => {
    ep.watched = watched;
  });
  updateShowListStatus(show);
  if (!saveData({ immediate: true })) {
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
  // BUG-A6-06: guard show.seasons — su dati corrotti potrebbe essere null/array.
  // Prima, `JSON.parse(JSON.stringify(show.seasons))` su undefined lanciava SyntaxError.
  if (!show || !show.seasons || typeof show.seasons !== 'object' || Array.isArray(show.seasons)) {
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
    // BUG-A6-05: defensive — se la risposta API non è un array, abort (non crashare).
    if (!Array.isArray(episodes)) {
      if (!opts?.silent) showToast('Risposta API non valida', 'error');
      return false;
    }
    // BUG-A6-04: se l'API ritorna 0 episodi ma lo show ne aveva, NON wipeare
    // i dati utente (potrebbe essere un glitch temporaneo dell'API o un 200 OK vuoto).
    if (episodes.length === 0 && Object.keys(show.seasons).length > 0) {
      if (!opts?.silent) showToast('Nessun episodio ricevuto — dati non aggiornati', 'warning');
      return false;
    }
    // Mantiene watched state esistente, aggiorna name/airdate/runtime
    // BUG-06-04: matched by TVMaze id (più stabile di num quando TVMaze renumber).
    const newSeasons: Show['seasons'] = {};
    let totalEpisodes = 0;
    // BUG-A6-03: dedup per num dentro ogni stagione (allineato a buildShowFromTvmaze).
    const seenNumsPerSeason: Record<number, Set<number>> = {};
    for (const ep of episodes) {
      if (ep.season == null || ep.season === 0) continue;
      if (ep.number == null) continue;
      const sn = safeId(ep.season);
      if (!sn) continue;
      const epId = safeId(ep.id);
      const epNum = safeId(ep.number);
      // BUG-A6-02: skip episodi con num=0 (allineato a buildShowFromTvmaze/normalizeShow).
      // Prima venivano aggiunti con num:0, gonfiando totalEpisodes e rompendo la UI.
      if (!epNum) continue;
      if (!newSeasons[sn]) {
        newSeasons[sn] = [];
        seenNumsPerSeason[sn] = new Set();
      }
      // BUG-A6-03: dedup — primo tenuto, duplicati saltati (allineato a buildShowFromTvmaze).
      if (seenNumsPerSeason[sn].has(epNum)) continue;
      seenNumsPerSeason[sn].add(epNum);
      // BUG-06-04: prima prova match by id (stable TVMaze id).
      let existingEp: Episode | undefined;
      for (const seasonArr of Object.values(show.seasons)) {
        if (!Array.isArray(seasonArr)) continue;
        const found = seasonArr.find((e) => e && e.id === epId);
        if (found) {
          existingEp = found;
          break;
        }
      }
      // Fallback: match by num nella stessa stagione (backward compat).
      if (!existingEp) {
        const arr = show.seasons[sn];
        if (Array.isArray(arr)) existingEp = arr.find((e) => e && e.num === epNum);
      }
      // BUG-A6-01: preserva rating e note dall'episodio esistente.
      // Prima, il nuovo episodio copiava solo watched/airdate/name/runtime,
      // perdendo rating e note personali dell'utente ad ogni refresh.
      // BUG-A19-01: valida airdate con parseISODateLocal (strict) invece della
      // regex loose /^\d{4}-\d{2}-\d{2}$/ che accettava date inesistenti come
      // '2024-13-40' o '2024-02-30' (rollover). Allineato a normalize.ts.
      // BUG-A19-02: stripHtml su ep.name (defense-in-depth, allineato a
      // normalize.ts safeEpisodeName) — ep.name arriva dall'API TVMaze e potrebbe
      // contenere HTML; senza strip, un renderer distratto genererebbe XSS.
      const epName =
        typeof ep.name === 'string' && stripHtml(ep.name).trim().length > 0
          ? stripHtml(ep.name).trim().slice(0, 300)
          : null;
      const newEp: Episode = {
        num: epNum,
        id: epId,
        watched: existingEp?.watched ?? false,
        airdate:
          typeof ep.airdate === 'string' && parseISODateLocal(ep.airdate) !== null
            ? ep.airdate
            : null,
        name: epName,
        runtime: typeof ep.runtime === 'number' && ep.runtime > 0 ? ep.runtime : null,
      };
      if (existingEp && typeof existingEp.rating === 'number' && Number.isFinite(existingEp.rating)) {
        const r = Math.round(existingEp.rating);
        if (r >= 1 && r <= MAX_EPISODE_RATING) newEp.rating = r;
      }
      if (existingEp && typeof existingEp.note === 'string' && existingEp.note.length > 0) {
        newEp.note = existingEp.note.slice(0, MAX_EPISODE_NOTE_LENGTH);
      }
      newSeasons[sn].push(newEp);
      totalEpisodes++;
    }

    show.seasons = newSeasons;
    show.totalEpisodes = totalEpisodes;
    show.totalSeasons = Object.keys(newSeasons).length;
    updateShowListStatus(show);

    if (!saveData({ immediate: true })) {
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
      if (ep && (ep.name === undefined || ep.name === null || ep.name === '')) return true;
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
  const state = getState();
  const show = state.shows.find((s) => s.id === showId);
  // BUG-A6-07: guard show.seasons (corrupted state) e Array.isArray per seasonArr.
  if (!show || !show.seasons || typeof show.seasons !== 'object') return;
  const seasonArr = show.seasons[seasonNum];
  if (!Array.isArray(seasonArr)) return;
  const ep = seasonArr.find((e) => e && e.num === epNum);
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

  if (!saveData({ immediate: true })) {
    ep.rating = prevRating;
    showToast('Rating non salvato (storage error o modifiche in altro tab)', 'error');
    return;
  }
  emitChange();
}

// ===== P2.2: Note private per episodio =====

/**
 * Imposta la nota privata di un episodio (max 500 char). Stringa vuota = rimuovi.
 * Salva immediatamente su localStorage con rollback in caso di fallimento.
 */
export function setEpisodeNote(showId: number, seasonNum: number, epNum: number, note: string): void {
  const state = getState();
  const show = state.shows.find((s) => s.id === showId);
  // BUG-A6-07: guard show.seasons (corrupted state) e Array.isArray per seasonArr.
  if (!show || !show.seasons || typeof show.seasons !== 'object') return;
  const seasonArr = show.seasons[seasonNum];
  if (!Array.isArray(seasonArr)) return;
  const ep = seasonArr.find((e) => e && e.num === epNum);
  if (!ep) return;

  const trimmed = typeof note === 'string' ? note.slice(0, MAX_EPISODE_NOTE_LENGTH).trim() : '';
  const newNote = trimmed.length > 0 ? trimmed : undefined;
  const prevNote = ep.note;
  ep.note = newNote;

  if (!saveData({ immediate: true })) {
    ep.note = prevNote;
    showToast('Nota non salvata (storage error o modifiche in altro tab)', 'error');
    return;
  }
  emitChange();
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

  // BUG-A6-09: defensive — show.tags potrebbe non essere un array su dati corrotti.
  const tags = Array.isArray(show.tags) ? show.tags : [];
  // Dedup case-insensitive: se "Estate" esiste, "estate" non viene aggiunto.
  const lower = trimmed.toLowerCase();
  if (tags.some((t) => typeof t === 'string' && t.toLowerCase() === lower)) {
    showToast('Tag già presente', 'warning');
    return false;
  }
  if (tags.length >= MAX_TAGS_PER_SHOW) {
    showToast('Massimo ' + MAX_TAGS_PER_SHOW + ' tag per serie', 'warning');
    return false;
  }

  const prevTags = show.tags;
  show.tags = [...tags, trimmed];

  if (!saveData({ immediate: true })) {
    show.tags = prevTags;
    showToast('Tag non salvato (storage error o modifiche in altro tab)', 'error');
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
  // BUG-A6-08: tag non-string causerebbe TypeError su toLowerCase().
  // BUG-A6-09: show.tags non-array causerebbe TypeError su filter()/length.
  if (!show || !Array.isArray(show.tags) || show.tags.length === 0) return;
  if (typeof tag !== 'string') return;
  const lower = tag.toLowerCase();
  const prevTags = show.tags;
  show.tags = show.tags.filter((t) => typeof t === 'string' && t.toLowerCase() !== lower);

  if (show.tags.length === prevTags.length) return; // nessun cambiamento

  if (!saveData({ immediate: true })) {
    show.tags = prevTags;
    showToast('Rimozione tag non salvata (storage error o modifiche in altro tab)', 'error');
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
    // Guard: seasons potrebbe essere null/undefined su dati malformati.
    if (!show.seasons || typeof show.seasons !== 'object' || Array.isArray(show.seasons)) continue;
    for (const seasonKey of Object.keys(show.seasons)) {
      const seasonNum = Number(seasonKey);
      if (!Number.isInteger(seasonNum) || seasonNum <= 0) continue;
      const eps = show.seasons[seasonNum];
      if (!Array.isArray(eps)) continue;
      for (const ep of eps) {
        if (ep && ep.rating === MAX_EPISODE_RATING && ep.watched) {
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
    // BUG-A6-09: defensive — show.tags potrebbe non essere un array su dati corrotti.
    if (Array.isArray(show.tags)) for (const t of show.tags) if (typeof t === 'string') set.add(t);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// Re-export alias per compatibilità
export { ApiError };
