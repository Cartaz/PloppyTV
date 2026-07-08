// Wrapper per il worker con fallback al main thread se il worker non è disponibile.
//
// CRITICAL FIX (C4/T2): ogni richiesta porta un `id` incrementale (correlation).
// L'handler valida `ev.data.id === myId` prima di risolvere, così risposte
// stale o tardive di richieste precedenti non cross-talkano con quella corrente.
// Il listener viene rimosso su resolve/reject/timeout per evitare leak.
//
// HIGH FIX (H12): su errore nel worker, riceviamo un messaggio `{type:'error'}`
// e rejected la promise (invece di pendere fino al timeout). Aggiunto anche
// `worker.onerror` per catturare errori di load/script.

import type { Show, StatsResult, CalendarEpisode, WorkerResponse, WorkerRequest } from '../types';

let _worker: Worker | null = null;
let _workerSupported = true;
let _requestIdCounter = 0;

function getWorker(): Worker | null {
  if (!_workerSupported) return null;
  if (_worker) return _worker;
  try {
    _worker = new Worker(new URL('./stats.worker.ts', import.meta.url), { type: 'module' });
    // Cattura errori di load/script del worker (non catturabili dal try/catch sopra)
    _worker.onerror = (e) => {
      console.warn('[worker] script/load error:', e.message || e);
    };
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
      const rawPct = s.totalEpisodes > 0 ? (watched / s.totalEpisodes) * 100 : 0;
      const pct = Math.max(0, Math.min(100, rawPct));
      return { showId: s.id, showName: s.name, image: s.image, watched, totalEpisodes: s.totalEpisodes, pct };
    })
    .sort((a, b) => b.pct - a.pct || b.watched - a.watched)
    .slice(0, 10);

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

/**
 * Stats via worker. Usa correlation ID per scartare risposte stale.
 * Su errore worker → reject (invece di pendere fino al timeout).
 * Su timeout → fallback main-thread E rimuove il listener (no leak).
 */
export function computeStatsAsync(shows: Show[]): Promise<StatsResult> {
  return new Promise((resolve) => {
    const worker = getWorker();
    if (!worker) {
      resolve(computeStatsFallback(shows));
      return;
    }
    const myId = ++_requestIdCounter;
    let settled = false;

    const handler = (ev: MessageEvent<WorkerResponse>) => {
      const data = ev.data;
      // Scarta risposte per altre richieste (cross-talk protection)
      if (data.id !== myId) return;
      if (settled) return;
      if (data.type === 'stats') {
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        resolve(data.result);
      } else if (data.type === 'error') {
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        console.warn('[worker] stats error:', data.message, '— using fallback');
        resolve(computeStatsFallback(shows));
      }
      // Risposte calendar per altri id vengono scartate da `data.id !== myId`
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.removeEventListener('message', handler); // CRITICAL: no leak
      console.warn('[worker] stats timeout, fallback main-thread');
      resolve(computeStatsFallback(shows));
    }, 500);

    worker.addEventListener('message', handler);
    const req: WorkerRequest = { type: 'stats', id: myId, shows };
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
    const myId = ++_requestIdCounter;
    let settled = false;

    const handler = (ev: MessageEvent<WorkerResponse>) => {
      const data = ev.data;
      if (data.id !== myId) return;
      if (settled) return;
      if (data.type === 'calendar') {
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        resolve({ week: data.result, afterWeek: data.afterWeek, weekStart: data.weekStart, weekEnd: data.weekEnd });
      } else if (data.type === 'error') {
        settled = true;
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        console.warn('[worker] calendar error:', data.message, '— using fallback');
        resolve(computeCalendarFallback(shows, weekOffset));
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.removeEventListener('message', handler); // CRITICAL: no leak
      console.warn('[worker] calendar timeout, fallback main-thread');
      resolve(computeCalendarFallback(shows, weekOffset));
    }, 500);

    worker.addEventListener('message', handler);
    const req: WorkerRequest = { type: 'calendar', id: myId, shows, weekOffset };
    worker.postMessage(req);
  });
}
