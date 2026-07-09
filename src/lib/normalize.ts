// Normalizzazione show: validazione + sanitizzazione

import type { ListName, Show, TvmazeShow, Episode, TvmazeEpisode } from '../types';
import { ALLOWED_LISTS } from '../types';
import { safeId, safeImageUrl, safeNum, stripHtml, getPosterUrl, getWatchedCount, parseISODateLocal } from './utils';
import { MAX_EPISODE_NOTE_LENGTH, MAX_EPISODE_RATING, MAX_TAG_LENGTH, MAX_TAGS_PER_SHOW } from './constants';

// ===== Helper locali (BUG-A1-xx) =====
// Centralizzano le sanificazioni applicate sia in normalizeShow che in
// buildShowFromTvmaze, per evitare divergenze tra i due codepath.

/**
 * stripHtml + fallback se la stringa risultante è vuota.
 * BUG-A1-05 / BUG-A1-06 (FIXED): prima name/status/network vuoti dopo lo
 * stripHtml (es. input "<p></p>" o "   ") restavano "". Ora ricadono sul
 * fallback ('Senza titolo' / 'N/D') in modo coerente con il path non-string.
 */
function stripHtmlOrFallback(input: unknown, fallback: string, maxLen: number): string {
  const raw = stripHtml(input);
  if (raw.length === 0) return fallback;
  return raw.slice(0, maxLen);
}

/**
 * Runtime di un episodio: numero finito e > 0, altrimenti null.
 * BUG-A1-03 (FIXED): `Infinity`/`NaN` non erano filtrati dal vecchio check
 * `> 0` (Infinity > 0 è true) → runtime poteva restare Infinity e
 * avvelenare i totali statistici. Ora Number.isFinite blocca entrambi.
 */
function safeEpisodeRuntime(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

/**
 * Coercizione stretta di `watched` a booleano.
 * BUG-A1-04 (FIXED): il vecchio `!!ep.watched` trattava le stringhe "false",
 * "0", "null" e perfino [] come `true` (truthy). Questo era incoerente con
 * `getWatchedCount` (che usa `=== true`): un episodio "falsamente watched"
 * veniva contato come visto, sballando reconciliation e stats.
 * Ora accettiamo solo i valori esplicitamente true: `true`, `"true"`, `1`.
 * (Backward-compat: i test esistenti documentano 'true' e 1 → true.)
 */
function coerceWatched(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

/**
 * Nome episodio sanificato: stripHtml + tronca, oppure null se vuoto/non stringa.
 * BUG-A1-07 (FIXED): il nome episodio NON veniva stripHtml'd né in
 * normalizeShow né in buildShowFromTvmaze (gap rispetto a summary/name show).
 * Era un rischio XSS defense-in-depth (il renderer fa comunque escapeHtml,
 * ma i dati immagazzinati dovevano essere neutralizzati a monte).
 */
function safeEpisodeName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const stripped = stripHtml(v).slice(0, 300);
  return stripped.length > 0 ? stripped : null;
}

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

  // name: stripHtml (BUG-02-08) + fallback se vuoto (BUG-A1-05 FIXED).
  const name = stripHtmlOrFallback(typeof r.name === 'string' ? r.name : 'Senza titolo', 'Senza titolo', 200);

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
            // BUG-A1-04 FIXED: stringhe "false"/"0" non diventano true.
            watched: coerceWatched(ep.watched),
            // BUG-02-02: parseISODateLocal valida stretta (rifiuta 2024-13-40, 2024-02-30).
            airdate: typeof ep.airdate === 'string' && parseISODateLocal(ep.airdate) !== null ? ep.airdate : null,
            // BUG-A1-07 FIXED: stripHtml su ep.name + fallback null se vuoto.
            name: safeEpisodeName(ep.name),
            // BUG-A1-03 FIXED: Infinity/NaN → null (Number.isFinite).
            runtime: safeEpisodeRuntime(ep.runtime),
          };
          // P2.1: rating — intero 1..5, altri valori → undefined.
          if (typeof ep.rating === 'number' && Number.isFinite(ep.rating)) {
            const r = Math.round(ep.rating);
            if (r >= 1 && r <= MAX_EPISODE_RATING) obj.rating = r;
          }
          // P2.2 + BUG-A1-08 FIXED: note — stripHtml (XSS defense-in-depth)
          // + stringa non vuota dopo trim, troncata a MAX_EPISODE_NOTE_LENGTH.
          if (typeof ep.note === 'string') {
            const noteStripped = stripHtml(ep.note).slice(0, MAX_EPISODE_NOTE_LENGTH);
            if (noteStripped.trim().length > 0) {
              obj.note = noteStripped;
            }
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
  // BUG-02-08 + BUG-A1-06 FIXED: stripHtml su status e network + fallback 'N/D'
  // se vuoti dopo lo strip (es. "<p></p>" o "   ").
  const status = stripHtmlOrFallback(typeof r.status === 'string' ? r.status : 'N/D', 'N/D', 50);
  const network = stripHtmlOrFallback(typeof r.network === 'string' ? r.network : 'N/D', 'N/D', 100);
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

  // P2.3 + BUG-A1-09 FIXED: tags — stripHtml (XSS defense-in-depth) + array di
  // stringhe non vuote, dedup case-insensitive, troncate, max MAX_TAGS_PER_SHOW.
  const tags: string[] = Array.isArray(r.tags)
    ? (() => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const t of r.tags) {
          if (typeof t !== 'string') continue;
          const stripped = stripHtml(t).trim();
          if (stripped.length === 0) continue;
          const trimmed = stripped.slice(0, MAX_TAG_LENGTH);
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
    // BUG-A1-10 FIXED: defense-in-depth — un episodio null/undefined
    // nell'array (API corrotta) faceva throw su ep.season prima di ogni guard.
    if (ep == null) continue;
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
      // BUG-A1-02 FIXED: parseISODateLocal valida stretta (rifiuta 2024-13-40,
      // 2024-02-30). Prima usavamo una regex sola `/^\d{4}-\d{2}-\d{2}$/` che
      // accettava qualsiasi combo di cifre, incluse date inesistenti.
      airdate: typeof ep.airdate === 'string' && parseISODateLocal(ep.airdate) !== null ? ep.airdate : null,
      // BUG-A1-07 FIXED: stripHtml su ep.name + fallback null.
      name: safeEpisodeName(ep.name),
      // BUG-A1-03 FIXED: Infinity/NaN → null.
      runtime: safeEpisodeRuntime(ep.runtime),
    });
    totalEpisodes++;
  }
  const totalSeasons = Object.keys(seasons).length;

  // BUG-02-04: runtime clampato a [1, 1000] come normalizeShow.
  const rawRuntime = safeNum(tvmazeShow.runtime || tvmazeShow.averageRuntime);
  const runtime = rawRuntime >= 1 && rawRuntime <= 1000 ? Math.floor(rawRuntime) : 45;

  return {
    id: showId,
    // BUG-A1-05 FIXED: fallback 'Senza titolo' se name vuoto dopo stripHtml.
    name: stripHtmlOrFallback(String(tvmazeShow.name || 'Senza titolo'), 'Senza titolo', 200),
    image: safeImageUrl(getPosterUrl(tvmazeShow)),
    // BUG-A1-06 FIXED: fallback 'N/D' se status vuoto dopo stripHtml.
    status: stripHtmlOrFallback(String(tvmazeShow.status || 'N/D'), 'N/D', 50),
    // BUG-A1-01 FIXED: parseISODateLocal valida stretta (rifiuta 2024-13-40,
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
    // BUG-A1-06 FIXED: fallback 'N/D' se network vuoto dopo stripHtml.
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
