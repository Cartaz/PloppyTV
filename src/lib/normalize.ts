// Normalizzazione show: validazione + sanitizzazione

import type { ListName, Show, TvmazeShow, Episode, TvmazeEpisode } from '../types';
import { ALLOWED_LISTS } from '../types';
import { safeId, safeImageUrl, safeNum, stripHtml, getPosterUrl, getWatchedCount, parseISODateLocal } from './utils';

/**
 * Normalizza uno Show da sorgente non fidata (localStorage, backup JSON).
 * Allinea la sanitizzazione a `buildShowFromTvmaze`:
 *  - stripHtml su name/status/network/summary
 *  - slice su name/status/network/summary per evitare storage bloat
 *  - deduplica generi
 *  - validazione stretta di addedAt (deve essere finito e positivo)
 *  - validazione stretta di airdate/premiered tramite parseISODateLocal
 *  - deduplica episodi per `num` all'interno di ogni stagione
 *  - chiavi stagione validate con safeId (solo interi decimali > 0)
 *  - totalEpisodes/totalSeasons sempre ricalcolati da `seasons` (source of truth)
 *  - manualList coercito a booleano (accetta truthy non-booleani)
 */
export function normalizeShow(raw: unknown): Show | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = safeId(r.id);
  if (!id) return null;

  // name: sanifica HTML (eventuale) e tronca
  const name = stripHtml(typeof r.name === 'string' ? r.name : 'Senza titolo').slice(0, 200);

  // seasons: Record<number, Episode[]>
  const seasons: Record<number, Episode[]> = {};
  if (r.seasons && typeof r.seasons === 'object' && !Array.isArray(r.seasons)) {
    for (const [k, v] of Object.entries(r.seasons as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      // Dedupe episodi per `num` all'interno della stagione (BUG-02-10)
      const seenNums = new Set<number>();
      const eps: Episode[] = [];
      for (const ep of v) {
        if (!ep || typeof ep !== 'object' || Array.isArray(ep)) continue;
        const e = ep as Record<string, unknown>;
        const num = safeId(e.num);
        if (!num) continue; // num deve essere intero > 0
        if (seenNums.has(num)) continue; // salta duplicati
        seenNums.add(num);
        eps.push({
          num,
          id: safeId(e.id),
          watched: !!e.watched,
          airdate: typeof e.airdate === 'string' && parseISODateLocal(e.airdate) !== null ? e.airdate : null,
          name: typeof e.name === 'string' ? e.name.slice(0, 300) : null,
          runtime: typeof e.runtime === 'number' && e.runtime > 0 ? e.runtime : null,
        });
      }
      // Chiave stagione: usa safeId (rifiuta hex/whitespace/scientific)
      const seasonKey = safeId(k);
      if (!seasonKey) continue;
      seasons[seasonKey] = eps;
    }
  }

  // totalEpisodes / totalSeasons: sempre ricalcolati da `seasons` (BUG-02-06)
  const totalEpisodes = Object.values(seasons).reduce((sum, eps) => sum + eps.length, 0);
  const totalSeasons = Object.keys(seasons).length;

  // Generi: filtra stringhe, deduplica, tronca a 20
  const genres: string[] = Array.isArray(r.genres)
    ? Array.from(new Set(r.genres.filter((g): g is string => typeof g === 'string' && g.length > 0))).slice(0, 20)
    : [];

  const list: ListName = ALLOWED_LISTS.includes(r.list as ListName) ? (r.list as ListName) : 'towatch';

  const image = safeImageUrl(r.image);
  const status = stripHtml(typeof r.status === 'string' ? r.status : 'N/D').slice(0, 50);
  const network = stripHtml(typeof r.network === 'string' ? r.network : 'N/D').slice(0, 100);
  const premiered = typeof r.premiered === 'string' && parseISODateLocal(r.premiered) !== null ? r.premiered : null;
  // summary: stripHtml per neutralizzare eventuale HTML grezzo (XSS latente)
  const summary = stripHtml(r.summary).slice(0, 5000);
  const runtime =
    typeof r.runtime === 'number' && Number.isFinite(r.runtime) && r.runtime >= 1 && r.runtime <= 1000
      ? Math.floor(r.runtime)
      : 45;
  const addedAt =
    typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) && r.addedAt > 0 ? Math.floor(r.addedAt) : Date.now();
  const manualList = !!r.manualList;

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
  };
}

// Costruisce uno Show da un TvmazeShow + episodi già fetchati
export function buildShowFromTvmaze(tvmazeShow: TvmazeShow, episodes: TvmazeEpisode[], list: ListName): Show {
  const showId = safeId(tvmazeShow.id);
  if (!showId) throw new Error('Invalid show id from TVMaze');
  const seasons: Record<number, Episode[]> = {};
  let totalEpisodes = 0;
  for (const ep of episodes) {
    if (ep.season == null || ep.season === 0) continue; // skip speciali
    if (ep.number == null) continue;
    const sn = safeId(ep.season);
    if (!sn) continue;
    const num = safeId(ep.number);
    if (!num) continue; // skip num 0 (H10) — allinea a normalizeShow
    if (!seasons[sn]) seasons[sn] = [];
    // Dedupe per `num` all'interno della stagione (BUG-02-10)
    if (seasons[sn].some((e) => e.num === num)) continue;
    seasons[sn].push({
      num,
      id: safeId(ep.id),
      watched: false,
      airdate: typeof ep.airdate === 'string' && parseISODateLocal(ep.airdate) !== null ? ep.airdate : null,
      name: typeof ep.name === 'string' ? ep.name.slice(0, 300) : null,
      runtime: typeof ep.runtime === 'number' && ep.runtime > 0 ? ep.runtime : null,
    });
    totalEpisodes++;
  }
  const totalSeasons = Object.keys(seasons).length;

  // Runtime: clamp a [1, 1000] con fallback 45 (H9) — allinea a normalizeShow
  const rt = safeNum(tvmazeShow.runtime || tvmazeShow.averageRuntime);
  const runtime = Number.isFinite(rt) && rt >= 1 && rt <= 1000 ? Math.floor(rt) : 45;

  return {
    id: showId,
    name: stripHtml(tvmazeShow.name || 'Senza titolo').slice(0, 200),
    image: safeImageUrl(getPosterUrl(tvmazeShow)),
    status: stripHtml(tvmazeShow.status || 'N/D').slice(0, 50),
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
    network: stripHtml(
      (tvmazeShow.network && tvmazeShow.network.name) || (tvmazeShow.webChannel && tvmazeShow.webChannel.name) || 'N/D',
    ).slice(0, 100),
    runtime,
    list: ALLOWED_LISTS.includes(list) ? list : 'towatch',
    manualList: false,
    seasons,
    totalSeasons,
    totalEpisodes,
    addedAt: Date.now(),
  };
}

/**
 * Riconcilia il `list` di tutti gli show in base al conteggio episodi watched.
 * Rispetta `manualList` (allineato a `updateShowListStatus` in store.ts):
 *  - se `totalEpisodes > 0 && watched === totalEpisodes` → promuove a `completed`
 *    e resetta `manualList = false` (auto-promotion);
 *  - se `manualList === true` → non retrocede MAI (rispetta scelta utente);
 *  - altrimenti applica demotion: towatch→watching se watched>0,
 *    completed→towatch se totalEpisodes===0, completed/watching→towatch se watched===0.
 */
export function reconcileAllLists(shows: Show[]): void {
  for (const show of shows) {
    const watched = getWatchedCount(show);
    if (show.totalEpisodes > 0 && watched === show.totalEpisodes) {
      show.list = 'completed';
      show.manualList = false; // auto-promotion clears manual override
      continue;
    }
    if (show.manualList) continue; // respect manual placement — no demote
    if (watched > 0 && show.list === 'towatch') {
      show.list = 'watching';
    } else if (show.totalEpisodes === 0 && show.list === 'completed') {
      show.list = 'towatch';
    } else if (watched === 0 && (show.list === 'completed' || show.list === 'watching')) {
      show.list = 'towatch';
    }
  }
}
