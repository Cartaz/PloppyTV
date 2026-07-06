// Web Worker: calcolo statistiche + calendario off-main-thread

import type { WorkerRequest, WorkerResponse, Show, StatsResult, CalendarEpisode } from '../types';
import { getWatchedCount, findNextEpisode, parseISODateLocal, localISODate, safeNum } from '../lib/utils';

function computeStats(shows: Show[]): StatsResult {
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

  // Top serie
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

function computeCalendar(shows: Show[], weekOffset: number): { week: CalendarEpisode[]; afterWeek: CalendarEpisode[]; weekStart: string; weekEnd: string } {
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

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'stats') {
      const result = computeStats(msg.shows);
      const response: WorkerResponse = { type: 'stats', result };
      (self as unknown as Worker).postMessage(response);
    } else if (msg.type === 'calendar') {
      const { week, afterWeek, weekStart, weekEnd } = computeCalendar(msg.shows, msg.weekOffset);
      const response: WorkerResponse = { type: 'calendar', result: week, weekStart, weekEnd, afterWeek };
      (self as unknown as Worker).postMessage(response);
    }
  } catch (e) {
    console.error('[worker] error:', e);
  }
};
