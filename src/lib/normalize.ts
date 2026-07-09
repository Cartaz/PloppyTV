// Normalizzazione show: validazione + sanitizzazione

import type { ListName, Show, TvmazeShow, Episode, TvmazeEpisode } from '../types';
import { ALLOWED_LISTS } from '../types';
import { safeId, safeImageUrl, safeNum, stripHtml, getPosterUrl, getWatchedCount, parseISODateLocal } from './utils';
import { MAX_EPISODE_NOTE_LENGTH, MAX_EPISODE_RATING, MAX_TAG_LENGTH, MAX_TAGS_PER_SHOW } from './constants';

/**
 * Normalizza uno Show da sorgente non fidata (localStorage, backup JSON).
 * Allinea la sanitizzazione a `buildShowFromTvmaze`:
 *  - stripHtml su name/status/network/summary (BUG-02-08 FIXED)
 *  - slice per evitare storage bloat
 *  - deduplica generi
 *  - validazione stretta di addedAt (deve essere finito e positivo)
 *
 * BUG-02-02 (FIXED): premiered e airdate validati con parseISODateLocal
 * (rifiuta 2024-13-40, 2024-02-30, ecc.).
 * BUG-02-06 (FIXED): totalEpisodes e totalSeasons SEMPRE ricalcolati dalle
 * stagioni effettive (i valori in input sono ignorati).
 * BUG-02-07 (FIXED): chiavi stagione validate con safeId (regex ^-?\d+$),
 * quindi " 1 ", "1.5", "0x10", "1e2" sono rifiutate.
 * BUG-02-09 (FIXED): manualList coercito con `!!` (truthy → true).
 * BUG-02-10 (FIXED): episodi duplicati (stesso num) deduplicati — primo
 * tenuto, duplicati saltati.
 */
export function normalizeShow(raw: unknown): Show | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = safeId(r.id);
  if (!id) return null;

  // name: stripHtml (BUG-02-08) e tronca
  const name = stripHtml(typeof r.name === 'string' ? r.name : 'Senza titolo').slice(0, 200);

  // seasons: Record<number, Episode[]>
  const seasons: Record<number, Episode[]> = {};
  if (r.seasons && typeof r.seasons === 'object' && !Array.isArray(r.seasons)) {
    for (const [k, v] of Object.entries(r.seasons as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      // BUG-02-07: valida la chiave con safeId (regex ^-?\d+$); " 1 ", "1.5",
      // "0x10", "1e2" sono rifiutate.
      const seasonKey = safeId(k);
      if (!seasonKey) continue;
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
            watched: !!ep.watched,
            // BUG-02-02: parseISODateLocal valida stretta (rifiuta 2024-13-40, 2024-02-30).
            airdate: typeof ep.airdate === 'string' && parseISODateLocal(ep.airdate) !== null ? ep.airdate : null,
            name: typeof ep.name === 'string' ? ep.name.slice(0, 300) : null,
            runtime: typeof ep.runtime === 'number' && ep.runtime > 0 ? ep.runtime : null,
          };
          // P2.1: rating — intero 1..5, altri valori → undefined.
          if (typeof ep.rating === 'number' && Number.isFinite(ep.rating)) {
            const r = Math.round(ep.rating);
            if (r >= 1 && r <= MAX_EPISODE_RATING) obj.rating = r;
          }
          // P2.2: note — stringa non vuota dopo trim, troncata a MAX_EPISODE_NOTE_LENGTH.
          if (typeof ep.note === 'string' && ep.note.trim().length > 0) {
            obj.note = ep.note.slice(0, MAX_EPISODE_NOTE_LENGTH);
          }
          return obj;
        })
        .filter((ep) => ep.num > 0)
        // BUG-02-10: dedup per num — primo tenuto, duplicati saltati.
        .filter((ep) => {
          if (seenNums.has(ep.num)) return false;
          seenNums.add(ep.num);
          return true;
        });
      seasons[seasonKey] = eps;
    }
  }

  // BUG-02-06: SEMPRE ricalcolati dalle stagioni effettive.
  const totalEpisodes = Object.values(seasons).reduce((sum, eps) => sum + eps.length, 0);
  const totalSeasons = Object.keys(seasons).length;

  // Generi: filtra stringhe, deduplica, tronca a 20
  const genres: string[] = Array.isArray(r.genres)
    ? Array.from(new Set(r.genres.filter((g): g is string => typeof g === 'string' && g.length > 0))).slice(0, 20)
    : [];

  const list: ListName = ALLOWED_LISTS.includes(r.list as ListName) ? (r.list as ListName) : 'towatch';

  const image = safeImageUrl(r.image);
  // BUG-02-08: stripHtml su status e network.
  const status = stripHtml(typeof r.status === 'string' ? r.status : 'N/D').slice(0, 50);
  const network = stripHtml(typeof r.network === 'string' ? r.network : 'N/D').slice(0, 100);
  // BUG-02-02: parseISODateLocal valida stretta.
  const premiered = typeof r.premiered === 'string' && parseISODateLocal(r.premiered) !== null ? r.premiered : null;
  // summary: stripHtml per neutralizzare eventuale HTML grezzo (XSS latente)
  const summary = stripHtml(r.summary).slice(0, 5000);
  const runtime =
    typeof r.runtime === 'number' && Number.isFinite(r.runtime) && r.runtime >= 1 && r.runtime <= 1000
      ? Math.floor(r.runtime)
      : 45;
  const addedAt =
    typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) && r.addedAt > 0 ? Math.floor(r.addedAt) : Date.now();
  // BUG-02-09: truthy coercion `!!` (1, "yes", true → true; 0, "", null → false).
  const manualList = !!r.manualList;

  // P2.3: tags — array di stringhe non vuote, dedup case-insensitive, troncate, max MAX_TAGS_PER_SHOW.
  const tags: string[] = Array.isArray(r.tags)
    ? (() => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const t of r.tags) {
          if (typeof t !== 'string' || t.trim().length === 0) continue;
          const trimmed = t.trim().slice(0, MAX_TAG_LENGTH);
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
 *
 * BUG-02-03 (FIXED): defense-in-depth — lancia se `tvmazeShow.id` non è un
 * ID valido (safeId restituisce 0). Il caller normalmente controlla già, ma
 * questo previene show con id=0 in caso di bug upstream.
 * BUG-02-04 (FIXED): runtime clampato a [1, 1000] come normalizeShow;
 * valori fuori range → fallback 45.
 * BUG-02-05 (FIXED): episodi con number=0 sono filtrati (allineato a
 * normalizeShow che filtra num > 0).
 * BUG-02-08 (FIXED): stripHtml su name, status, network.
 * BUG-02-10 (FIXED): episodi duplicati (stesso number nella stessa season)
 * sono deduplicati — primo tenuto.
 */
export function buildShowFromTvmaze(tvmazeShow: TvmazeShow, episodes: TvmazeEpisode[], list: ListName): Show {
  const showId = safeId(tvmazeShow.id);
  // BUG-02-03: defense-in-depth — rifiuta ID invalidi.
  if (!showId) {
    throw new Error('Invalid show id: ' + String(tvmazeShow.id));
  }

  const seasons: Record<number, Episode[]> = {};
  let totalEpisodes = 0;
  // BUG-02-10: track nums per season per dedup.
  const seenNumsPerSeason: Record<number, Set<number>> = {};
  for (const ep of episodes) {
    if (ep.season == null || ep.season === 0) continue; // skip speciali
    if (ep.number == null) continue;
    const sn = safeId(ep.season);
    if (!sn) continue;
    const epNum = safeId(ep.number);
    // BUG-02-05: salta episodi con number=0 (allineato a normalizeShow).
    if (!epNum) continue;
    if (!seasons[sn]) {
      seasons[sn] = [];
      seenNumsPerSeason[sn] = new Set();
    }
    // BUG-02-10: dedup — primo tenuto, duplicati saltati.
    if (seenNumsPerSeason[sn].has(epNum)) continue;
    seenNumsPerSeason[sn].add(epNum);
    seasons[sn].push({
      num: epNum,
      id: safeId(ep.id),
      watched: false,
      airdate: typeof ep.airdate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ep.airdate) ? ep.airdate : null,
      name: typeof ep.name === 'string' ? ep.name.slice(0, 300) : null,
      runtime: typeof ep.runtime === 'number' && ep.runtime > 0 ? ep.runtime : null,
    });
    totalEpisodes++;
  }
  const totalSeasons = Object.keys(seasons).length;

  // BUG-02-04: runtime clampato a [1, 1000] come normalizeShow.
  const rawRuntime = safeNum(tvmazeShow.runtime || tvmazeShow.averageRuntime);
  const runtime = rawRuntime >= 1 && rawRuntime <= 1000 ? Math.floor(rawRuntime) : 45;

  return {
    id: showId,
    name: stripHtml(String(tvmazeShow.name || 'Senza titolo')).slice(0, 200),
    image: safeImageUrl(getPosterUrl(tvmazeShow)),
    status: stripHtml(String(tvmazeShow.status || 'N/D')).slice(0, 50),
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
    network: stripHtml(
      String(
        (tvmazeShow.network && tvmazeShow.network.name) ||
          (tvmazeShow.webChannel && tvmazeShow.webChannel.name) ||
          'N/D',
      ),
    ).slice(0, 100),
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

/**
 * Riconcilia le liste degli show in base al progresso di visione.
 *
 * BUG-02-01 / C1 (FIXED): `manualList` viene rispettato — se true, lo show
 * non viene declassato/promosso automaticamente. Quando avviene un
 * auto-promotion a completed, `manualList` viene resettato a false.
 *
 * Allineato con `updateShowListStatus` (store.ts):
 *  - watched === totalEpisodes (>0) → completed (clears manualList)
 *  - watched > 0 && list === towatch → watching
 *  - watched === 0 && list === watching → towatch (NEW, aligned)
 *  - totalEpisodes === 0 && list === completed && !manualList → towatch
 */
export function reconcileAllLists(shows: Show[]): void {
  for (const show of shows) {
    const watched = getWatchedCount(show);
    // Auto-promotion a completed (clears manualList).
    if (show.totalEpisodes > 0 && watched === show.totalEpisodes) {
      show.list = 'completed';
      show.manualList = false;
      continue;
    }
    // manualList blocca i cambiamenti automatici successivi.
    if (show.manualList) continue;
    if (watched > 0 && show.list === 'towatch') {
      show.list = 'watching';
    } else if (watched === 0 && (show.list === 'watching' || show.list === 'completed')) {
      // NEW: allineato a updateShowListStatus — demote a towatch quando
      // watched=0 (sia da watching che da completed, con o senza episodi).
      show.list = 'towatch';
    }
  }
}
