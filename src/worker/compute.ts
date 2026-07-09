// Pure compute functions shared by `stats.worker.ts` (worker context) and
// `client.ts` (main-thread fallback). Single source of truth for
// `computeStats` and `computeCalendar` — prevents drift between the worker
// implementation and the fallback (BUG-08-03).
//
// PURITY CONTRACT:
//   - NO `self`, `postMessage`, `Worker`, DOM-only or worker-only globals.
//   - Only standard globals available in BOTH worker and main-thread
//     contexts (`Date`, `Math`, `Array`, `Number`, `Set`, `Object`, etc.).
//   - Functions take `Show[]` (and primitives) and return plain objects.
//   - `computeCalendar` uses `new Date()` for "today" — `Date` is available
//     in both worker and main-thread contexts, so this is safe.

import type { Show, StatsResult, CalendarEpisode } from '../types';
import { getWatchedCount, findNextEpisode, parseISODateLocal, localISODate, safeNum } from '../lib/utils';

/**
 * Sanitize a `weekOffset` input.
 *
 * `NaN` / `±Infinity` (and any other non-finite value) collapse to `0`;
 * non-integers are floored to match `setDate` semantics (a half-week is not
 * a meaningful calendar offset).
 *
 * Applied INSIDE `computeCalendar` so the worker path and the main-thread
 * fallback path share the same defensive behavior. Previously
 * (BUG-16-03) only the worker's `onmessage` applied this guard, so a
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
  // timeLabel migliorato: include minuti residui se < 1h
  const remMin = totalMinutes % 60;
  let timeLabel: string;
  if (totalDays > 0) {
    timeLabel = totalDays + 'g ' + remHours + 'h';
  } else if (totalMinutes >= 60) {
    timeLabel = remHours + 'h' + (remMin > 0 ? ' ' + remMin + 'min' : '');
  } else if (totalMinutes > 0) {
    timeLabel = totalMinutes + 'min';
  } else {
    timeLabel = '0min';
  }

  // Generi
  const genreStats: Record<string, { episodes: number; shows: Set<number> }> = {};
  for (const s of shows) {
    const watched = getWatchedCount(s);
    const genres = Array.isArray(s.genres) && s.genres.length ? s.genres : ['Senza genere'];
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
    timeLabel,
    totalProgress,
    topGenres,
    topShows,
  };
}

export function computeCalendar(
  shows: Show[],
  weekOffset: number,
): { week: CalendarEpisode[]; afterWeek: CalendarEpisode[]; weekStart: string; weekEnd: string } {
  // BUG-16-03: guard applied here (shared with worker) so non-finite / non-integer
  // offsets don't produce Invalid Date when the worker is unavailable.
  const offset = safeWeekOffset(weekOffset);

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
    const nextEp = findNextEpisode(show);
    if (!nextEp || !nextEp.airdate) continue;
    const epDate = parseISODateLocal(nextEp.airdate);
    if (!epDate) continue;
    // Valida nextEp.num (era "S1Eundefined" quando num mancava)
    const num = safeNum(nextEp.num);
    const epObj: CalendarEpisode = {
      showId: show.id,
      showName: show.name,
      totalEpisodes: show.totalEpisodes,
      watchedCount: getWatchedCount(show),
      season: nextEp.season,
      num,
      name: nextEp.name ?? null,
      date: localISODate(epDate),
    };
    if (epDate >= startOfWeek && epDate <= weekEnd) week.push(epObj);
    else if (epDate > weekEnd) afterWeek.push(epObj);
  }
  afterWeek.sort((a, b) => a.date.localeCompare(b.date));
  week.sort((a, b) => a.date.localeCompare(b.date));

  return { week, afterWeek, weekStart: localISODate(startOfWeek), weekEnd: localISODate(weekEnd) };
}
