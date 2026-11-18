// Normalizzazione show: validazione + sanitizzazione

import type { ListName, Show, TvmazeShow, Episode, TvmazeEpisode } from '../types';
import { ALLOWED_LISTS } from '../types';
import {
  safeId,
  safeTvmazeImageUrl,
  safeNum,
  stripHtml,
  getPosterUrl,
  getWatchedCount,
  parseISODateLocal,
} from './utils';
import { MAX_EPISODE_NOTE_LENGTH, MAX_EPISODE_RATING, MAX_TAG_LENGTH, MAX_TAGS_PER_SHOW } from './constants';

// ===== Helper locali =====
// Centralizzano le sanificazioni applicate sia in normalizeShow che in
// buildShowFromTvmaze, per evitare divergenze tra i due codepath.

/**
 * stripHtml + fallback se la stringa risultante è vuota.
 */
function stripHtmlOrFallback(input: unknown, fallback: string, maxLen: number): string {
  const raw = stripHtml(input);
  if (raw.length === 0) return fallback;
  return raw.slice(0, maxLen);
}

/**
 * Runtime di un episodio: numero finito e > 0, altrimenti null.
 */
function safeEpisodeRuntime(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

/**
 * Coercizione stretta di `watched` a booleano.
 */
function coerceWatched(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

/**
 * Nome episodio sanificato: stripHtml + tronca, oppure null se vuoto/non stringa.
 */
function safeEpisodeName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const stripped = stripHtml(v).slice(0, 300);
  return stripped.length > 0 ? stripped : null;
}

/**
 * Normalizza uno Show da sorgente non fidata (localStorage, backup JSON).
 * Allinea la sanitizzazione a `buildShowFromTvmaze`:
 *  - stripHtml su name/status/network/summary
 *  - slice per evitare storage bloat
 *  - deduplica generi
 *  - validazione stretta di addedAt (deve essere finito e positivo)
 */
export function normalizeShow(raw: unknown): Show | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = safeId(r.id);
  if (!id) return null;

  // name: stripHtml + fallback se vuoto.
  const name = stripHtmlOrFallback(typeof r.name === 'string' ? r.name : 'Senza titolo', 'Senza titolo', 200);

  // seasons: Record<number, Episode[]>
  const seasons: Record<number, Episode[]> = {};
  if (r.seasons && typeof r.seasons === 'object' && !Array.isArray(r.seasons)) {
    for (const [k, v] of Object.entries(r.seasons as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const seasonKey = safeId(k);
      // Una stagione ha una sola rappresentazione persistita. `safeId` è un
      // parser numerico generico e accetta anche "01"; qui il dominio è più
      // stretto, quindi accettiamo solo la forma canonica prodotta da PloppyTV.
      if (!seasonKey || k !== String(seasonKey)) continue;
      const seenNums = new Set<number>();
      const eps: Episode[] = v
        .filter(
          (ep): ep is Record<string, unknown> =>
            !!ep && typeof ep === 'object' && !Array.isArray(ep) && (ep as { num?: unknown }).num != null,
        )
        .map((ep) => {
          const obj: Episode = {
            num: safeId(ep.num),
            id: safeId(ep.id),
            // Stringhe "false"/"0" non diventano true.
            watched: coerceWatched(ep.watched),
            // parseISODateLocal valida stretta (rifiuta 2024-13-40, 2024-02-30).
            airdate: typeof ep.airdate === 'string' && parseISODateLocal(ep.airdate) !== null ? ep.airdate : null,
            // stripHtml su ep.name + fallback null se vuoto.
            name: safeEpisodeName(ep.name),
            // Infinity/NaN → null (Number.isFinite).
            runtime: safeEpisodeRuntime(ep.runtime),
          };
          // P2.1: rating — intero 1..5, altri valori → undefined.
          if (typeof ep.rating === 'number' && Number.isFinite(ep.rating)) {
            const r = Math.round(ep.rating);
            if (r >= 1 && r <= MAX_EPISODE_RATING) obj.rating = r;
          }
          // Le note sono testo dell'utente, non HTML: vanno conservate così
          // come scritte (l'escaping appartiene al renderer). Stessa regola di
          // setEpisodeNote: troncata e trimmata, vuota = assente.
          // watchedAt solo per episodi visti, come timestamp plausibile (non nel futuro).
          if (
            obj.watched &&
            typeof ep.watchedAt === 'number' &&
            Number.isInteger(ep.watchedAt) &&
            ep.watchedAt > 0 &&
            ep.watchedAt <= Date.now() + 24 * 60 * 60 * 1000
          ) {
            obj.watchedAt = ep.watchedAt;
          }
          if (typeof ep.note === 'string') {
            const note = ep.note.slice(0, MAX_EPISODE_NOTE_LENGTH).trim();
            if (note.length > 0) obj.note = note;
          }
          return obj;
        })
        .filter((ep) => ep.num > 0)
        // Dedup per num — primo tenuto, duplicati saltati.
        .filter((ep) => {
          if (seenNums.has(ep.num)) return false;
          seenNums.add(ep.num);
          return true;
        });
      seasons[seasonKey] = eps;
    }
  }

  // SEMPRE ricalcolati dalle stagioni effettive.
  const totalEpisodes = Object.values(seasons).reduce((sum, eps) => sum + eps.length, 0);
  const totalSeasons = Object.keys(seasons).length;

  // Generi: filtra stringhe, deduplica, tronca a 20
  const genres: string[] = Array.isArray(r.genres)
    ? Array.from(new Set(r.genres.filter((g): g is string => typeof g === 'string' && g.length > 0))).slice(0, 20)
    : [];

  const list: ListName = ALLOWED_LISTS.includes(r.list as ListName) ? (r.list as ListName) : 'towatch';

  const image = safeTvmazeImageUrl(r.image);
  // stripHtml su status e network + fallback 'N/D'
  // se vuoti dopo lo strip (es. "<p></p>" o "   ").
  const status = stripHtmlOrFallback(typeof r.status === 'string' ? r.status : 'N/D', 'N/D', 50);
  const network = stripHtmlOrFallback(typeof r.network === 'string' ? r.network : 'N/D', 'N/D', 100);
  // parseISODateLocal valida stretta.
  const premiered = typeof r.premiered === 'string' && parseISODateLocal(r.premiered) !== null ? r.premiered : null;
  // summary: stripHtml per neutralizzare eventuale HTML grezzo (XSS latente)
  const summary = stripHtml(r.summary).slice(0, 5000);
  const runtime =
    typeof r.runtime === 'number' && Number.isFinite(r.runtime) && r.runtime >= 1 && r.runtime <= 1000
      ? Math.floor(r.runtime)
      : 45;
  const addedAt =
    typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) && r.addedAt > 0 ? Math.floor(r.addedAt) : Date.now();
  // Truthy coercion `!!` (1, "yes", true → true; 0, "", null → false).
  const manualList = !!r.manualList;

  // Tag: testo dell'utente (niente stripHtml, l'escaping è del renderer).
  // Stessa regola di addShowTag: trim, troncati, dedup case-insensitive,
  // max MAX_TAGS_PER_SHOW.
  const tags: string[] = Array.isArray(r.tags)
    ? (() => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const t of r.tags) {
          if (typeof t !== 'string') continue;
          const trimmed = t.trim().slice(0, MAX_TAG_LENGTH);
          if (trimmed.length === 0) continue;
          const lower = trimmed.toLowerCase();
          if (seen.has(lower)) continue; // dedup case-insensitive
          seen.add(lower);
          result.push(trimmed);
          if (result.length >= MAX_TAGS_PER_SHOW) break;
        }
        return result;
      })()
    : [];

  return {
    id,
    name,
    image,
    status,
    premiered,
    genres,
    summary,
    network,
    runtime,
    list,
    manualList,
    seasons,
    totalSeasons,
    totalEpisodes,
    addedAt,
    tags,
  };
}

/**
 * Costruisce uno Show da un TvmazeShow + episodi già fetchati.
 */
export function buildShowFromTvmaze(tvmazeShow: TvmazeShow, episodes: TvmazeEpisode[], list: ListName): Show {
  const showId = safeId(tvmazeShow.id);
  // Defense-in-depth — rifiuta ID invalidi.
  if (!showId) {
    throw new Error('Invalid show id: ' + String(tvmazeShow.id));
  }

  const seasons: Record<number, Episode[]> = {};
  let totalEpisodes = 0;
  // Track nums per season per dedup.
  const seenNumsPerSeason: Record<number, Set<number>> = {};
  for (const ep of episodes) {
    // Defense-in-depth — un episodio null/undefined
    // nell'array (API corrotta) faceva throw su ep.season prima di ogni guard.
    if (ep == null) continue;
    if (ep.season == null || ep.season === 0) continue; // skip speciali
    if (ep.number == null) continue;
    const sn = safeId(ep.season);
    if (!sn) continue;
    const epNum = safeId(ep.number);
    // Salta episodi con number=0 (allineato a normalizeShow).
    if (!epNum) continue;
    if (!seasons[sn]) {
      seasons[sn] = [];
      seenNumsPerSeason[sn] = new Set();
    }
    // Dedup — primo tenuto, duplicati saltati.
    if (seenNumsPerSeason[sn].has(epNum)) continue;
    seenNumsPerSeason[sn].add(epNum);
    seasons[sn].push({
      num: epNum,
      id: safeId(ep.id),
      watched: false,
      // parseISODateLocal valida stretta (rifiuta 2024-13-40,
      // 2024-02-30). Prima usavamo una regex sola `/^\d{4}-\d{2}-\d{2}$/` che
      // accettava qualsiasi combo di cifre, incluse date inesistenti.
      airdate: typeof ep.airdate === 'string' && parseISODateLocal(ep.airdate) !== null ? ep.airdate : null,
      // stripHtml su ep.name + fallback null.
      name: safeEpisodeName(ep.name),
      // Infinity/NaN → null.
      runtime: safeEpisodeRuntime(ep.runtime),
    });
    totalEpisodes++;
  }
  const totalSeasons = Object.keys(seasons).length;

  // Runtime clampato a [1, 1000] come normalizeShow.
  const rawRuntime = safeNum(tvmazeShow.runtime || tvmazeShow.averageRuntime);
  const runtime = rawRuntime >= 1 && rawRuntime <= 1000 ? Math.floor(rawRuntime) : 45;

  return {
    id: showId,
    // Fallback 'Senza titolo' se name vuoto dopo stripHtml.
    name: stripHtmlOrFallback(String(tvmazeShow.name || 'Senza titolo'), 'Senza titolo', 200),
    image: getPosterUrl(tvmazeShow),
    // Fallback 'N/D' se status vuoto dopo stripHtml.
    status: stripHtmlOrFallback(String(tvmazeShow.status || 'N/D'), 'N/D', 50),
    // parseISODateLocal valida stretta (rifiuta 2024-13-40,
    // 2024-02-30). Prima la regex `/^\d{4}-\d{2}-\d{2}$/` accettava date
    // inesistenti, divergendo da normalizeShow (che già usava parseISODateLocal).
    premiered:
      typeof tvmazeShow.premiered === 'string' && parseISODateLocal(tvmazeShow.premiered) !== null
        ? tvmazeShow.premiered
        : null,
    genres: Array.isArray(tvmazeShow.genres)
      ? Array.from(new Set(tvmazeShow.genres.filter((g): g is string => typeof g === 'string' && g.length > 0))).slice(
          0,
          20,
        )
      : [],
    summary: stripHtml(tvmazeShow.summary).slice(0, 5000),
    // Fallback 'N/D' se network vuoto dopo stripHtml.
    network: stripHtmlOrFallback(
      String(
        (tvmazeShow.network && tvmazeShow.network.name) ||
          (tvmazeShow.webChannel && tvmazeShow.webChannel.name) ||
          'N/D',
      ),
      'N/D',
      100,
    ),
    runtime,
    list: ALLOWED_LISTS.includes(list) ? list : 'towatch',
    manualList: false,
    seasons,
    totalSeasons,
    totalEpisodes,
    addedAt: Date.now(),
    tags: [],
  };
}

/** Applica la stessa regola di progresso a caricamento, import e azioni utente. */
export function reconcileAllLists(shows: Show[]): void {
  for (const show of shows) updateShowListStatus(show);
}

/** Riconcilia una lista dopo il caricamento o una modifica del progresso. */
export function updateShowListStatus(show: Show): void {
  const watched = getWatchedCount(show);
  if (show.totalEpisodes > 0 && watched === show.totalEpisodes) {
    show.list = 'completed';
    show.manualList = false;
  } else if (!show.manualList) {
    show.list = watched > 0 ? 'watching' : 'towatch';
  }
}
