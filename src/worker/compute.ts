// Pure compute functions shared by `stats.worker.ts` (worker context) and
// `client.ts` (main-thread fallback). Single source of truth for
// `computeStats` and `computeCalendar` — prevents drift between the worker
// implementation and the fallback.
//
// PURITY CONTRACT:
//   - NO `self`, `postMessage`, `Worker`, DOM-only or worker-only globals.
//   - Only standard globals available in BOTH worker and main-thread
//     contexts (`Date`, `Math`, `Array`, `Number`, `Set`, `Object`, etc.).
//   - Functions take `Show[]` (and primitives) and return plain objects.
//   - `computeCalendar` uses `new Date()` for "today" — `Date` is available
//     in both worker and main-thread contexts, so this is safe.

import type { Show, StatsResult, CalendarEpisode } from '../types';
import { getWatchedCount, localISODate, safeNum, unwatchedEpisodesByAirdate, type DatedEpisode } from '../lib/utils';

/**
 * Sanitize a `weekOffset` input.
 *
 * `NaN` / `±Infinity` (and any other non-finite value) collapse to `0`;
 * non-integers are floored to match `setDate` semantics (a half-week is not
 * a meaningful calendar offset).
 *
 * Applied INSIDE `computeCalendar` so the worker path and the main-thread
 * fallback path share the same defensive behavior. Previously
 * only the worker's `onmessage` applied this guard, so a
 * `NaN`/`Infinity` offset produced Invalid Date → "Errore caricamento" UI
 * when the worker was unavailable.
 */
export function safeWeekOffset(weekOffset: number): number {
  return Number.isFinite(weekOffset) ? Math.floor(weekOffset) : 0;
}

export function computeStats(shows: Show[]): StatsResult {
  const totalShows = shows.length;
  const totalWatched = shows.reduce((sum, s) => sum + getWatchedCount(s), 0);
  const totalEpisodes = shows.reduce((sum, s) => sum + safeNum(s.totalEpisodes), 0);
  const completedShows = shows.filter((s) => s.list === 'completed').length;
  const watchingShows = shows.filter((s) => s.list === 'watching').length;
  const towatchShows = shows.filter((s) => s.list === 'towatch').length;

  const totalMinutes = shows.reduce((sum, s) => sum + getWatchedCount(s) * (safeNum(s.runtime) || 45), 0);
  const totalDays = Math.floor(totalMinutes / 1440);
  const remHours = Math.floor((totalMinutes % 1440) / 60);

  // Generi
  const genreStats: Record<string, { episodes: number; shows: Set<number> }> = {};
  for (const s of shows) {
    const watched = getWatchedCount(s);
    // Dedupe genres within a show AND filter to strings.
    //   - Duplicate genres (e.g. `['Drama', 'Drama']`) double-counted
    //     `episodes` (Set dedups `shows` by id, but `episodes += watched`
    //     ran per-iteration). Corrupt imports or TVMaze glitches could
    //     list the same genre twice.
    //   - Non-string elements (numbers, objects, null) would crash
    //     `a[0].localeCompare(b[0])` during the sort (numbers don't have
    //     `localeCompare`). Now filtered out before they enter genreStats.
    const rawGenres = Array.isArray(s.genres) ? s.genres.filter((g): g is string => typeof g === 'string') : [];
    const dedupedGenres = Array.from(new Set(rawGenres));
    // '' = senza genere: l'etichetta tradotta la sceglie la vista (il worker non conosce la lingua).
    const genres = dedupedGenres.length ? dedupedGenres : [''];
    for (const g of genres) {
      if (!genreStats[g]) genreStats[g] = { episodes: 0, shows: new Set() };
      genreStats[g].episodes += watched;
      genreStats[g].shows.add(s.id);
    }
  }
  const topGenres = Object.entries(genreStats)
    .sort((a, b) => b[1].episodes - a[1].episodes || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([genre, st]) => ({ genre, episodes: st.episodes, shows: st.shows.size }));

  // Top serie — clamp pct a [0, 100] per gestire stato inconsistente
  // (watched > totalEpisodes non dovrebbe accadere ma potrebbe a causa di
  // dati corrotti o import malformati).
  const topShows = shows
    .map((s) => {
      const watched = getWatchedCount(s);
      const rawPct = s.totalEpisodes > 0 ? (watched / s.totalEpisodes) * 100 : 0;
      const pct = Math.max(0, Math.min(100, rawPct));
      return { showId: s.id, showName: s.name, image: s.image, watched, totalEpisodes: s.totalEpisodes, pct };
    })
    .sort((a, b) => b.pct - a.pct || b.watched - a.watched)
    .slice(0, 10);

  // totalProgress — clamp a [0, 100] per la stessa ragione
  const rawTotalProgress = totalEpisodes > 0 ? Math.round((totalWatched / totalEpisodes) * 100) : 0;
  const totalProgress = Math.max(0, Math.min(100, rawTotalProgress));

  return {
    totalShows,
    totalWatched,
    totalEpisodes,
    completedShows,
    watchingShows,
    towatchShows,
    totalMinutes,
    totalDays,
    remHours,
    totalProgress,
    topGenres,
    topShows,
  };
}

export function computeCalendar(
  shows: Show[],
  weekOffset: number,
): { week: CalendarEpisode[]; afterWeek: CalendarEpisode[]; weekStart: string; weekEnd: string } {
  // Guard applied here (shared with worker) so non-finite / non-integer
  // offsets don't produce Invalid Date when the worker is unavailable.
  const offset = safeWeekOffset(weekOffset);
  // Filter null/non-object entries (same rationale as computeStats).

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7) + offset * 7);
  const weekEnd = new Date(startOfWeek);
  weekEnd.setDate(startOfWeek.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const week: CalendarEpisode[] = [];
  const afterWeek: CalendarEpisode[] = [];

  for (const show of shows) {
    if (show.list !== 'watching') continue;
    const watchedCount = getWatchedCount(show);
    const toEntry = (ep: DatedEpisode): CalendarEpisode => ({
      showId: show.id,
      showName: show.name,
      totalEpisodes: show.totalEpisodes,
      watchedCount,
      season: ep.season,
      num: ep.num,
      name: ep.name,
      date: localISODate(ep.date),
    });
    // Tutte le uscite non viste della settimana, più la prima successiva
    // (una per serie) per la sezione "In arrivo".
    let nextAfterWeek: DatedEpisode | null = null;
    for (const ep of unwatchedEpisodesByAirdate(show)) {
      if (ep.date >= startOfWeek && ep.date <= weekEnd) week.push(toEntry(ep));
      else if (ep.date > weekEnd && !nextAfterWeek) nextAfterWeek = ep;
    }
    if (nextAfterWeek) afterWeek.push(toEntry(nextAfterWeek));
  }
  afterWeek.sort((a, b) => a.date.localeCompare(b.date));
  week.sort((a, b) => a.date.localeCompare(b.date));

  return { week, afterWeek, weekStart: localISODate(startOfWeek), weekEnd: localISODate(weekEnd) };
}
