// Wrapper per il worker con fallback al main thread se il worker non è disponibile

import type { Show, StatsResult, CalendarEpisode, WorkerResponse, WorkerRequest } from '../types';

let _worker: Worker | null = null;
let _workerSupported = true;

function getWorker(): Worker | null {
  if (!_workerSupported) return null;
  if (_worker) return _worker;
  try {
    _worker = new Worker(new URL('./stats.worker.ts', import.meta.url), { type: 'module' });
    return _worker;
  } catch (e) {
    console.warn('[worker] non disponibile, fallback main thread:', e);
    _workerSupported = false;
    return null;
  }
}

// Implementazioni inline di fallback (importa le stesse funzioni del worker)
import { getWatchedCount, findNextEpisode, parseISODateLocal, localISODate, safeNum } from '../lib/utils';

function computeStatsFallback(shows: Show[]): StatsResult {
  const totalShows = shows.length;
  const totalWatched = shows.reduce((sum, s) => sum + getWatchedCount(s), 0);
  const totalEpisodes = shows.reduce((sum, s) => sum + safeNum(s.totalEpisodes), 0);
  const completedShows = shows.filter((s) => s.list === 'completed').length;
  const watchingShows = shows.filter((s) => s.list === 'watching').length;
  const towatchShows = shows.filter((s) => s.list === 'towatch').length;
  const totalMinutes = shows.reduce((sum, s) => sum + getWatchedCount(s) * (safeNum(s.runtime) || 45), 0);
  const totalDays = Math.floor(totalMinutes / 1440);
  const remHours = Math.floor((totalMinutes % 1440) / 60);
  const timeLabel = totalDays > 0 ? totalDays + 'g ' + remHours + 'h' : Math.floor(totalMinutes / 60) + 'h';

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

  const topShows = shows
    .map((s) => {
      const watched = getWatchedCount(s);
      const pct = s.totalEpisodes > 0 ? (watched / s.totalEpisodes) * 100 : 0;
      return { showId: s.id, showName: s.name, image: s.image, watched, totalEpisodes: s.totalEpisodes, pct };
    })
    .sort((a, b) => b.pct - a.pct || b.watched - a.watched)
    .slice(0, 10);

  const totalProgress = totalEpisodes > 0 ? Math.round((totalWatched / totalEpisodes) * 100) : 0;

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

function computeCalendarFallback(shows: Show[], weekOffset: number): { week: CalendarEpisode[]; afterWeek: CalendarEpisode[]; weekStart: string; weekEnd: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7) + weekOffset * 7);
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
    const epObj: CalendarEpisode = {
      showId: show.id,
      showName: show.name,
      totalEpisodes: show.totalEpisodes,
      watchedCount: getWatchedCount(show),
      season: nextEp.season,
      num: nextEp.num,
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

export function computeStatsAsync(shows: Show[]): Promise<StatsResult> {
  return new Promise((resolve) => {
    const worker = getWorker();
    if (!worker) {
      resolve(computeStatsFallback(shows));
      return;
    }
    const timeout = setTimeout(() => {
      // Worker non risponde entro 500ms, fallback
      resolve(computeStatsFallback(shows));
    }, 500);
    const handler = (ev: MessageEvent<WorkerResponse>) => {
      if (ev.data.type === 'stats') {
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        resolve(ev.data.result);
      }
    };
    worker.addEventListener('message', handler);
    const req: WorkerRequest = { type: 'stats', shows };
    worker.postMessage(req);
  });
}

export function computeCalendarAsync(
  shows: Show[],
  weekOffset: number
): Promise<{ week: CalendarEpisode[]; afterWeek: CalendarEpisode[]; weekStart: string; weekEnd: string }> {
  return new Promise((resolve) => {
    const worker = getWorker();
    if (!worker) {
      resolve(computeCalendarFallback(shows, weekOffset));
      return;
    }
    const timeout = setTimeout(() => {
      resolve(computeCalendarFallback(shows, weekOffset));
    }, 500);
    const handler = (ev: MessageEvent<WorkerResponse>) => {
      if (ev.data.type === 'calendar') {
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        resolve({ week: ev.data.result, afterWeek: ev.data.afterWeek, weekStart: ev.data.weekStart, weekEnd: ev.data.weekEnd });
      }
    };
    worker.addEventListener('message', handler);
    const req: WorkerRequest = { type: 'calendar', shows, weekOffset };
    worker.postMessage(req);
  });
}
