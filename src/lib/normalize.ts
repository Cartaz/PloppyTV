// Normalizzazione show: validazione + sanitizzazione

import type { ListName, Show, TvmazeShow, Episode, TvmazeEpisode } from '../types';
import { ALLOWED_LISTS } from '../types';
import { safeId, safeImageUrl, safeNum, stripHtml, getPosterUrl, getWatchedCount } from './utils';

/**
 * Normalizza uno Show da sorgente non fidata (localStorage, backup JSON).
 * Allinea la sanitizzazione a `buildShowFromTvmaze`:
 *  - stripHtml su summary
 *  - slice su name/status/network/summary per evitare storage bloat
 *  - deduplica generi
 *  - validazione stretta di addedAt (deve essere finito e positivo)
 */
export function normalizeShow(raw: unknown): Show | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = safeId(r.id);
  if (!id) return null;

  // name: sanifica HTML (eventuale) e tronca
  const name = (typeof r.name === 'string' ? r.name : 'Senza titolo').slice(0, 200);

  // seasons: Record<number, Episode[]>
  const seasons: Record<number, Episode[]> = {};
  if (r.seasons && typeof r.seasons === 'object' && !Array.isArray(r.seasons)) {
    for (const [k, v] of Object.entries(r.seasons as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const eps: Episode[] = v
        .filter(
          (ep): ep is Record<string, unknown> =>
            !!ep && typeof ep === 'object' && !Array.isArray(ep) && (ep as { num?: unknown }).num != null,
        )
        .map((ep) => ({
          num: safeId(ep.num),
          id: safeId(ep.id),
          watched: !!ep.watched,
          airdate: typeof ep.airdate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ep.airdate) ? ep.airdate : null,
          name: typeof ep.name === 'string' ? ep.name.slice(0, 300) : null,
          runtime: typeof ep.runtime === 'number' && ep.runtime > 0 ? ep.runtime : null,
        }))
        .filter((ep) => ep.num > 0);
      const seasonKey = Number(k);
      if (Number.isInteger(seasonKey) && seasonKey > 0) {
        seasons[seasonKey] = eps;
      }
    }
  }

  const totalEpisodes =
    typeof r.totalEpisodes === 'number' && Number.isFinite(r.totalEpisodes) && r.totalEpisodes >= 0
      ? Math.floor(r.totalEpisodes)
      : Object.values(seasons).reduce((sum, eps) => sum + eps.length, 0);

  const totalSeasons =
    typeof r.totalSeasons === 'number' && Number.isFinite(r.totalSeasons) && r.totalSeasons >= 0
      ? Math.floor(r.totalSeasons)
      : Object.keys(seasons).length;

  // Generi: filtra stringhe, deduplica, tronca a 20
  const genres: string[] = Array.isArray(r.genres)
    ? Array.from(new Set(r.genres.filter((g): g is string => typeof g === 'string' && g.length > 0))).slice(0, 20)
    : [];

  const list: ListName = ALLOWED_LISTS.includes(r.list as ListName) ? (r.list as ListName) : 'towatch';

  const image = safeImageUrl(r.image);
  const status = (typeof r.status === 'string' ? r.status : 'N/D').slice(0, 50);
  const network = (typeof r.network === 'string' ? r.network : 'N/D').slice(0, 100);
  const premiered = typeof r.premiered === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.premiered) ? r.premiered : null;
  // summary: stripHtml per neutralizzare eventuale HTML grezzo (XSS latente)
  const summary = stripHtml(r.summary).slice(0, 5000);
  const runtime =
    typeof r.runtime === 'number' && Number.isFinite(r.runtime) && r.runtime >= 1 && r.runtime <= 1000
      ? Math.floor(r.runtime)
      : 45;
  const addedAt =
    typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) && r.addedAt > 0 ? Math.floor(r.addedAt) : Date.now();
  const manualList = r.manualList === true;

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
  const seasons: Record<number, Episode[]> = {};
  let totalEpisodes = 0;
  for (const ep of episodes) {
    if (ep.season == null || ep.season === 0) continue; // skip speciali
    if (ep.number == null) continue;
    const sn = safeId(ep.season);
    if (!sn) continue;
    if (!seasons[sn]) seasons[sn] = [];
    seasons[sn].push({
      num: safeId(ep.number),
      id: safeId(ep.id),
      watched: false,
      airdate: typeof ep.airdate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ep.airdate) ? ep.airdate : null,
      name: typeof ep.name === 'string' ? ep.name.slice(0, 300) : null,
      runtime: typeof ep.runtime === 'number' && ep.runtime > 0 ? ep.runtime : null,
    });
    totalEpisodes++;
  }
  const totalSeasons = Object.keys(seasons).length;

  return {
    id: showId,
    name: String(tvmazeShow.name || 'Senza titolo').slice(0, 200),
    image: safeImageUrl(getPosterUrl(tvmazeShow)),
    status: String(tvmazeShow.status || 'N/D').slice(0, 50),
    premiered:
      typeof tvmazeShow.premiered === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tvmazeShow.premiered)
        ? tvmazeShow.premiered
        : null,
    genres: Array.isArray(tvmazeShow.genres)
      ? Array.from(new Set(tvmazeShow.genres.filter((g): g is string => typeof g === 'string' && g.length > 0))).slice(
          0,
          20,
        )
      : [],
    summary: stripHtml(tvmazeShow.summary).slice(0, 5000),
    network: String(
      (tvmazeShow.network && tvmazeShow.network.name) || (tvmazeShow.webChannel && tvmazeShow.webChannel.name) || 'N/D',
    ).slice(0, 100),
    runtime: safeNum(tvmazeShow.runtime || tvmazeShow.averageRuntime) || 45,
    list: ALLOWED_LISTS.includes(list) ? list : 'towatch',
    manualList: false,
    seasons,
    totalSeasons,
    totalEpisodes,
    addedAt: Date.now(),
  };
}

export function reconcileAllLists(shows: Show[]): void {
  for (const show of shows) {
    const watched = getWatchedCount(show);
    if (show.totalEpisodes > 0 && watched === show.totalEpisodes) show.list = 'completed';
    else if (watched > 0 && show.list === 'towatch') show.list = 'watching';
    if (show.totalEpisodes === 0 && show.list === 'completed') show.list = 'towatch';
  }
}
