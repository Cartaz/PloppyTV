// Agent 08 probe tests: src/worker/stats.worker.ts + src/worker/client.ts
//
// Strategy:
//  - The worker module sets `self.onmessage` at import time. In jsdom self === window,
//    so we can invoke the worker's onmessage handler directly and mock self.postMessage
//    to capture responses. This lets us test computeStats / computeCalendar as pure fns.
//  - The client is tested by mocking the global `Worker` constructor, giving us control
//    over message dispatch, timeouts, and onerror.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Show, WorkerRequest, WorkerResponse, StatsResult } from '../src/types';
import { makeShow, makeShowWithSeasons, markWatchedFirst } from './helpers';

// Side-effect import: sets self.onmessage in jsdom
import '../src/worker/stats.worker';

// ============================================================
// Part 1: Worker — computeStats & computeCalendar (via self.onmessage)
// ============================================================

let workerResponses: WorkerResponse[] = [];
let originalPostMessage: typeof self.postMessage;

beforeEach(() => {
  workerResponses = [];
  originalPostMessage = self.postMessage;
  // Mock self.postMessage so the worker's postMessage(response) is captured
  // synchronously instead of dispatching a real 'message' event on window
  // (which would re-enter self.onmessage and loop).
  (self as unknown as { postMessage: (msg: WorkerResponse) => void }).postMessage = (msg) => {
    workerResponses.push(msg);
  };
});

afterEach(() => {
  (self as unknown as { postMessage: typeof self.postMessage }).postMessage = originalPostMessage;
});

function sendToWorker(req: WorkerRequest): WorkerResponse {
  workerResponses = [];
  (self as unknown as { onmessage: (ev: { data: WorkerRequest }) => void }).onmessage({ data: req });
  if (workerResponses.length !== 1) {
    throw new Error(`Expected exactly 1 worker response, got ${workerResponses.length}`);
  }
  return workerResponses[0];
}

function statsOf(shows: Show[]): StatsResult {
  const r = sendToWorker({ type: 'stats', id: 1, shows });
  if (r.type !== 'stats') throw new Error('expected stats response, got ' + r.type);
  return r.result;
}

// ---------------- computeStats ----------------

describe('[worker] computeStats', () => {
  it('empty shows → all zeros, timeLabel "0min"', () => {
    const r = statsOf([]);
    expect(r.totalShows).toBe(0);
    expect(r.totalWatched).toBe(0);
    expect(r.totalEpisodes).toBe(0);
    expect(r.totalMinutes).toBe(0);
    expect(r.totalDays).toBe(0);
    expect(r.remHours).toBe(0);
    expect(r.timeLabel).toBe('0min');
    expect(r.totalProgress).toBe(0);
    expect(r.topGenres).toEqual([]);
    expect(r.topShows).toEqual([]);
  });

  it('runtime=0 → default 45 min/ep applied (safeNum(0)||45 === 45)', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { runtime: 0, id: 1 });
    markWatchedFirst(s, 1, 2);
    expect(statsOf([s]).totalMinutes).toBe(90); // 2 × 45
    expect(statsOf([s]).timeLabel).toBe('1h 30min');
  });

  it('runtime="60" (string) → safeNum parses to 60', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { runtime: '60' as unknown as number, id: 1 });
    markWatchedFirst(s, 1, 2);
    expect(statsOf([s]).totalMinutes).toBe(120);
    expect(statsOf([s]).timeLabel).toBe('2h');
  });

  it('runtime=NaN/undefined/null → default 45', () => {
    for (const rt of [NaN, undefined, null] as unknown[]) {
      const s = makeShowWithSeasons({ 1: 1 }, { runtime: rt as number, id: 1 });
      markWatchedFirst(s, 1, 1);
      expect(statsOf([s]).totalMinutes).toBe(45);
    }
  });

  it('timeLabel boundaries: 60min→"1h", 90min→"1h 30min", 1440min→"1g 0h", 1500min→"1g 1h"', () => {
    const s60 = makeShowWithSeasons({ 1: 1 }, { runtime: 60, id: 1 });
    markWatchedFirst(s60, 1, 1);
    expect(statsOf([s60]).timeLabel).toBe('1h');

    const s90 = makeShowWithSeasons({ 1: 2 }, { runtime: 45, id: 2 });
    markWatchedFirst(s90, 1, 2);
    expect(statsOf([s90]).timeLabel).toBe('1h 30min');

    const s1440 = makeShowWithSeasons({ 1: 32 }, { runtime: 45, id: 3 });
    markWatchedFirst(s1440, 1, 32);
    expect(statsOf([s1440]).totalMinutes).toBe(1440);
    expect(statsOf([s1440]).timeLabel).toBe('1g 0h');

    const s1500 = makeShowWithSeasons({ 1: 25 }, { runtime: 60, id: 4 });
    markWatchedFirst(s1500, 1, 25);
    expect(statsOf([s1500]).totalMinutes).toBe(1500);
    expect(statsOf([s1500]).timeLabel).toBe('1g 1h');
  });

  it('topGenres: multi-genre show counts watched eps in EACH genre (sum > totalWatched)', () => {
    const s = makeShowWithSeasons({ 1: 10 }, { genres: ['Drama', 'Crime', 'Thriller'], id: 1 });
    markWatchedFirst(s, 1, 10);
    const r = statsOf([s]);
    expect(r.topGenres).toHaveLength(3);
    for (const g of r.topGenres) {
      expect(g.episodes).toBe(10);
      expect(g.shows).toBe(1);
    }
    const sumGenreEps = r.topGenres.reduce((sum, g) => sum + g.episodes, 0);
    expect(sumGenreEps).toBe(30); // 3 genres × 10 eps — over-weighting
    expect(r.totalWatched).toBe(10);
  });

  it('topGenres: show with no genres → "Senza genere"', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { genres: [] as string[], id: 1 });
    markWatchedFirst(s, 1, 2);
    const r = statsOf([s]);
    expect(r.topGenres).toHaveLength(1);
    expect(r.topGenres[0].genre).toBe('Senza genere');
    expect(r.topGenres[0].episodes).toBe(2);
  });

  it('topShows: pct clamped to [0,100]; corrupt watched>total → 100%', () => {
    const a = makeShowWithSeasons({ 1: 5 }, { id: 1, name: 'A' });
    markWatchedFirst(a, 1, 5); // 5/5 = 100%
    const b = makeShowWithSeasons({ 1: 100 }, { id: 2, name: 'B' });
    markWatchedFirst(b, 1, 50); // 50/100 = 50%
    // Corrupt: 5 watched but totalEpisodes=3 → 166.67% → clamped 100%
    const c = makeShowWithSeasons({ 1: 5 }, { id: 3, name: 'C', totalEpisodes: 3 });
    markWatchedFirst(c, 1, 5);
    const r = statsOf([a, b, c]);
    const aEntry = r.topShows.find((t) => t.showId === 1)!;
    const bEntry = r.topShows.find((t) => t.showId === 2)!;
    const cEntry = r.topShows.find((t) => t.showId === 3)!;
    expect(aEntry.pct).toBe(100);
    expect(bEntry.pct).toBe(50);
    expect(cEntry.pct).toBe(100); // clamped from 166.67
  });

  it('topShows: sort by pct desc then watched desc', () => {
    const a = makeShowWithSeasons({ 1: 5 }, { id: 1, name: 'A' });
    markWatchedFirst(a, 1, 5); // 100%, 5 watched
    const b = makeShowWithSeasons({ 1: 10 }, { id: 2, name: 'B' });
    markWatchedFirst(b, 1, 5); // 50%, 5 watched
    const c = makeShowWithSeasons({ 1: 100 }, { id: 3, name: 'C' });
    markWatchedFirst(c, 1, 50); // 50%, 50 watched
    const r = statsOf([a, b, c]);
    // A (100%) first; then C (50%, 50 watched) before B (50%, 5 watched)
    expect(r.topShows[0].showId).toBe(1);
    expect(r.topShows[1].showId).toBe(3);
    expect(r.topShows[2].showId).toBe(2);
  });

  it('topShows: show with totalEpisodes=0 → pct=0', () => {
    const s = makeShow({ id: 1, totalEpisodes: 0, seasons: {} });
    const r = statsOf([s]);
    expect(r.topShows[0].pct).toBe(0);
  });

  it('totalProgress clamped to [0,100] when watched>total', () => {
    const s = makeShowWithSeasons({ 1: 10 }, { id: 1, totalEpisodes: 5 });
    markWatchedFirst(s, 1, 10); // 10 watched / 5 total = 200% → 100%
    expect(statsOf([s]).totalProgress).toBe(100);
  });

  it('totalProgress: 50% exact (no rounding drift)', () => {
    const s = makeShowWithSeasons({ 1: 10 }, { id: 1 });
    markWatchedFirst(s, 1, 5);
    expect(statsOf([s]).totalProgress).toBe(50);
  });

  it('totalMinutes: large library (1000 shows × 100 eps × 60 min) — no overflow', () => {
    const shows: Show[] = [];
    for (let i = 0; i < 1000; i++) {
      const s = makeShowWithSeasons({ 1: 100 }, { id: i + 1, runtime: 60 });
      markWatchedFirst(s, 1, 100);
      shows.push(s);
    }
    const r = statsOf(shows);
    expect(r.totalMinutes).toBe(6_000_000);
    expect(r.totalDays).toBe(4166); // floor(6,000,000 / 1440)
    expect(Number.isSafeInteger(r.totalMinutes)).toBe(true);
  });

  it('unknown message type → error response with same id', () => {
    const r = sendToWorker({
      type: 'unknown' as unknown as WorkerRequest['type'],
      id: 42,
    } as WorkerRequest);
    expect(r.type).toBe('error');
    if (r.type === 'error') {
      expect(r.id).toBe(42);
      expect(r.message).toContain('Unknown message type');
    }
  });

  it('error response id defaults to -1 when msg.id missing', () => {
    workerResponses = [];
    (self as unknown as { onmessage: (ev: { data: unknown }) => void }).onmessage({
      data: { type: 'bogus' },
    });
    expect(workerResponses).toHaveLength(1);
    const r = workerResponses[0];
    expect(r.type).toBe('error');
    if (r.type === 'error') expect(r.id).toBe(-1);
  });
});

// ---------------- computeCalendar ----------------

describe('[worker] computeCalendar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Friday, March 15, 2024 at noon local.
    // getDay()=5 → dayIndex=(5+6)%7=4 → startOfWeek=Mar 11 (Mon), weekEnd=Mar 17 (Sun)
    vi.setSystemTime(new Date(2024, 2, 15, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeWatchingShowWithNextEp(airdate: string | null, id: number): Show {
    const s = makeShowWithSeasons({ 1: 1 }, { id, list: 'watching' });
    s.seasons[1][0].airdate = airdate;
    return s;
  }

  it('only includes watching shows (not towatch/completed)', () => {
    const watching = makeWatchingShowWithNextEp('2024-03-13', 1);
    watching.list = 'watching';
    const towatch = makeWatchingShowWithNextEp('2024-03-13', 2);
    towatch.list = 'towatch';
    const completed = makeWatchingShowWithNextEp('2024-03-13', 3);
    completed.list = 'completed';
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [watching, towatch, completed], weekOffset: 0 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.result).toHaveLength(1);
    expect(r.result[0].showId).toBe(1);
  });

  it('skips episodes with null airdate', () => {
    const s = makeWatchingShowWithNextEp(null, 1);
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [s], weekOffset: 0 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.result).toHaveLength(0);
    expect(r.afterWeek).toHaveLength(0);
  });

  it('skips episodes with unparseable airdate', () => {
    const s = makeWatchingShowWithNextEp('not-a-date', 1);
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [s], weekOffset: 0 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.result).toHaveLength(0);
    expect(r.afterWeek).toHaveLength(0);
  });

  it('episode on startOfWeek (Monday Mar 11) → in week', () => {
    const s = makeWatchingShowWithNextEp('2024-03-11', 1);
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [s], weekOffset: 0 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.result).toHaveLength(1);
    expect(r.result[0].date).toBe('2024-03-11');
  });

  it('episode on weekEnd (Sunday Mar 17) → in week', () => {
    const s = makeWatchingShowWithNextEp('2024-03-17', 1);
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [s], weekOffset: 0 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.result).toHaveLength(1);
    expect(r.result[0].date).toBe('2024-03-17');
  });

  it('episode after weekEnd (next Monday Mar 18) → afterWeek', () => {
    const s = makeWatchingShowWithNextEp('2024-03-18', 1);
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [s], weekOffset: 0 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.result).toHaveLength(0);
    expect(r.afterWeek).toHaveLength(1);
    expect(r.afterWeek[0].date).toBe('2024-03-18');
  });

  it('episode BEFORE startOfWeek (Sun Mar 10) → dropped (not in week, not in afterWeek)', () => {
    const s = makeWatchingShowWithNextEp('2024-03-10', 1);
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [s], weekOffset: 0 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.result).toHaveLength(0);
    expect(r.afterWeek).toHaveLength(0);
  });

  it('weekStart/weekEnd for offset 0 → Mar 11 / Mar 17', () => {
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [], weekOffset: 0 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.weekStart).toBe('2024-03-11');
    expect(r.weekEnd).toBe('2024-03-17');
  });

  it('weekOffset=1 → next week (Mar 18–24)', () => {
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [], weekOffset: 1 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.weekStart).toBe('2024-03-18');
    expect(r.weekEnd).toBe('2024-03-24');
  });

  it('weekOffset=-1 → previous week (Mar 4–10)', () => {
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [], weekOffset: -1 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.weekStart).toBe('2024-03-04');
    expect(r.weekEnd).toBe('2024-03-10');
  });

  it('weekOffset=NaN → treated as 0', () => {
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [], weekOffset: NaN });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.weekStart).toBe('2024-03-11');
  });

  it('weekOffset=Infinity → treated as 0', () => {
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [], weekOffset: Infinity });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.weekStart).toBe('2024-03-11');
  });

  it('weekOffset=1.5 → floored to 1', () => {
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [], weekOffset: 1.5 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.weekStart).toBe('2024-03-18');
  });

  it('CalendarEpisode fields populated correctly', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 42, name: 'Test Show', list: 'watching', totalEpisodes: 5 });
    s.seasons[1][0].watched = true; // ep 1 watched
    s.seasons[1][1].airdate = '2024-03-13'; // ep 2 airs Wed
    s.seasons[1][1].name = 'Episode Two';
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [s], weekOffset: 0 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.result).toHaveLength(1);
    const ep = r.result[0];
    expect(ep.showId).toBe(42);
    expect(ep.showName).toBe('Test Show');
    expect(ep.totalEpisodes).toBe(5);
    expect(ep.watchedCount).toBe(1);
    expect(ep.season).toBe(1);
    expect(ep.num).toBe(2);
    expect(ep.name).toBe('Episode Two');
    expect(ep.date).toBe('2024-03-13');
  });

  it('week and afterWeek sorted by date ascending', () => {
    const s1 = makeWatchingShowWithNextEp('2024-03-15', 1);
    const s2 = makeWatchingShowWithNextEp('2024-03-12', 2);
    const s3 = makeWatchingShowWithNextEp('2024-03-20', 3);
    const s4 = makeWatchingShowWithNextEp('2024-03-19', 4);
    const r = sendToWorker({ type: 'calendar', id: 1, shows: [s1, s2, s3, s4], weekOffset: 0 });
    if (r.type !== 'calendar') throw new Error('expected calendar');
    expect(r.result.map((e) => e.date)).toEqual(['2024-03-12', '2024-03-15']);
    expect(r.afterWeek.map((e) => e.date)).toEqual(['2024-03-19', '2024-03-20']);
  });
});

// ============================================================
// Part 2: Client — computeStatsAsync / computeCalendarAsync (mocked Worker)
// ============================================================

describe('[client] computeStatsAsync', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockWorker: any;
  let messageHandlers: ((ev: { data: WorkerResponse }) => void)[];
  let originalWorker: typeof Worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    messageHandlers = [];
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((type: string, handler: (ev: { data: WorkerResponse }) => void) => {
        if (type === 'message') messageHandlers.push(handler);
      }),
      removeEventListener: vi.fn((type: string, handler: (ev: { data: WorkerResponse }) => void) => {
        if (type === 'message') {
          const idx = messageHandlers.indexOf(handler);
          if (idx >= 0) messageHandlers.splice(idx, 1);
        }
      }),
      onerror: null as ((e: ErrorEvent) => void) | null,
      onmessage: null as ((e: MessageEvent) => void) | null,
    };
    originalWorker = globalThis.Worker;
    (globalThis as unknown as { Worker: typeof Worker }).Worker = vi.fn(() => mockWorker) as unknown as typeof Worker;
  });

  afterEach(() => {
    (globalThis as unknown as { Worker: typeof Worker }).Worker = originalWorker;
    vi.useRealTimers();
  });

  function dispatchToClient(data: WorkerResponse): void {
    // Real workers dispatch a 'message' event to ALL registered handlers.
    // Copy the array because handlers may remove themselves mid-dispatch.
    const handlers = [...messageHandlers];
    for (const h of handlers) {
      h({ data });
    }
  }

  async function importClient() {
    return await import('../src/worker/client');
  }

  it('uses worker when available, resolves with worker response', async () => {
    const { computeStatsAsync } = await importClient();
    const shows = [makeShowWithSeasons({ 1: 3 }, { id: 1 })];
    const promise = computeStatsAsync(shows);

    expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);
    const req = mockWorker.postMessage.mock.calls[0][0] as WorkerRequest;
    expect(req.type).toBe('stats');
    expect(req.id).toBe(1);
    expect(req.shows).toBe(shows);

    const fakeResult: StatsResult = {
      totalShows: 1,
      totalWatched: 0,
      totalEpisodes: 3,
      completedShows: 0,
      watchingShows: 0,
      towatchShows: 1,
      totalMinutes: 0,
      totalDays: 0,
      remHours: 0,
      timeLabel: '0min',
      totalProgress: 0,
      topGenres: [],
      topShows: [],
    };
    dispatchToClient({ type: 'stats', id: req.id, result: fakeResult });

    const result = await promise;
    expect(result).toEqual(fakeResult);
    // Handler removed after settle
    expect(mockWorker.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('falls back immediately when Worker constructor throws', async () => {
    (globalThis as unknown as { Worker: typeof Worker }).Worker = vi.fn(() => {
      throw new Error('Worker not supported');
    }) as unknown as typeof Worker;
    const { computeStatsAsync } = await importClient();
    const shows = [makeShowWithSeasons({ 1: 3 }, { id: 1, runtime: 60 })];
    markWatchedFirst(shows[0], 1, 2);
    const result = await computeStatsAsync(shows);
    // Fallback computes: 2 watched × 60 = 120 min
    expect(result.totalMinutes).toBe(120);
    expect(result.timeLabel).toBe('2h');
  });

  it('falls back after WORKER_TIMEOUT_MS timeout when worker never responds', async () => {
    const { computeStatsAsync } = await importClient();
    const shows = [makeShowWithSeasons({ 1: 3 }, { id: 1, runtime: 60 })];
    markWatchedFirst(shows[0], 1, 2);
    const promise = computeStatsAsync(shows);
    expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);

    // WORKER_TIMEOUT_MS-1: still pending (no fallback yet)
    await vi.advanceTimersByTimeAsync(2999);
    // 1ms more: timeout fires at WORKER_TIMEOUT_MS (3000ms) → fallback
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(result.totalMinutes).toBe(120); // 2 × 60
    expect(mockWorker.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('falls back on {type:"error"} response from worker (no 500ms wait)', async () => {
    const { computeStatsAsync } = await importClient();
    const shows = [makeShowWithSeasons({ 1: 3 }, { id: 1, runtime: 60 })];
    markWatchedFirst(shows[0], 1, 2);
    const promise = computeStatsAsync(shows);
    const req = mockWorker.postMessage.mock.calls[0][0] as WorkerRequest;
    dispatchToClient({ type: 'error', id: req.id, message: 'boom' });
    const result = await promise;
    expect(result.totalMinutes).toBe(120); // fallback computed
  });

  it('correlation ID: response for wrong id is ignored, correct id resolves', async () => {
    const { computeStatsAsync } = await importClient();
    const shows1 = [makeShowWithSeasons({ 1: 3 }, { id: 1, runtime: 60 })];
    markWatchedFirst(shows1[0], 1, 1);
    const shows2 = [makeShowWithSeasons({ 1: 3 }, { id: 2, runtime: 60 })];
    markWatchedFirst(shows2[0], 1, 2);

    const p1 = computeStatsAsync(shows1); // id=1
    const p2 = computeStatsAsync(shows2); // id=2

    const req1 = mockWorker.postMessage.mock.calls[0][0] as WorkerRequest;
    const req2 = mockWorker.postMessage.mock.calls[1][0] as WorkerRequest;
    expect(req1.id).toBe(1);
    expect(req2.id).toBe(2);

    // Stale response for id=1 — should resolve p1, NOT p2
    const fake1: StatsResult = { ...statsOf(shows1), totalMinutes: 111 };
    dispatchToClient({ type: 'stats', id: 1, result: fake1 });

    const r1 = await p1;
    expect(r1.totalMinutes).toBe(111);

    // p2 still pending — dispatch wrong-id response (id=999), should be ignored
    const fakeBogus: StatsResult = { ...statsOf(shows2), totalMinutes: 999 };
    dispatchToClient({ type: 'stats', id: 999, result: fakeBogus });

    // Now dispatch correct id=2
    const fake2: StatsResult = { ...statsOf(shows2), totalMinutes: 222 };
    dispatchToClient({ type: 'stats', id: 2, result: fake2 });
    const r2 = await p2;
    expect(r2.totalMinutes).toBe(222);
  });

  it('handler is removed after settle (no leak)', async () => {
    const { computeStatsAsync } = await importClient();
    const shows = [makeShowWithSeasons({ 1: 1 }, { id: 1 })];
    const promise = computeStatsAsync(shows);
    const req = mockWorker.postMessage.mock.calls[0][0] as WorkerRequest;
    dispatchToClient({ type: 'stats', id: req.id, result: statsOf(shows) });
    await promise;
    // After settle, handler removed from messageHandlers
    expect(messageHandlers).toHaveLength(0);
  });

  // ---- BUG-08-01 (FIXED): onerror disables worker ----
  // Previously `_worker.onerror` only logged — did NOT set `_workerSupported = false`.
  // After a script/load error, every subsequent request reused the cached broken
  // worker → postMessage to a dead worker → timeout wait → main-thread fallback,
  // on EVERY request forever. Now onerror sets `_workerSupported = false` and
  // `_worker = null`, so the next call goes straight to the main-thread fallback
  // (no postMessage, no timeout wait). This test asserts the CORRECT behavior.
  it('onerror disables worker so subsequent requests skip it (BUG-08-01 fixed)', async () => {
    const { computeStatsAsync } = await importClient();
    const shows = [makeShowWithSeasons({ 1: 3 }, { id: 1, runtime: 60 })];
    markWatchedFirst(shows[0], 1, 2);

    // First call: creates worker, posts message
    const p1 = computeStatsAsync(shows);
    expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);
    expect(mockWorker.onerror).not.toBeNull();

    // Simulate worker script load error → onerror disables worker
    mockWorker.onerror!({ message: 'load fail' } as ErrorEvent);

    // Advance past WORKER_TIMEOUT_MS (3000ms) — p1 times out → fallback
    await vi.advanceTimersByTimeAsync(3000);
    await p1;

    // Second call: worker is disabled → immediate fallback (no postMessage).
    const p2 = computeStatsAsync(shows);
    expect(mockWorker.postMessage).toHaveBeenCalledTimes(1); // still 1 — worker disabled
    // p2 resolves immediately via the fallback path (no timer wait needed)
    await p2;
  });

  // ---- BUG-08-02 (mitigated): timeout raised to 3000ms ----
  // For large libraries the worker may legitimately take >500ms to compute stats.
  // Previously the client times out at 500ms and runs the SAME computation on the
  // main thread (blocking the UI), while the worker keeps running (wasted work).
  // The timeout is now WORKER_TIMEOUT_MS (3000ms), giving the worker time for big
  // libraries. We verify the timeout fallback still fires when the worker doesn't
  // respond within the (larger) window — the worker request is sent, then after
  // WORKER_TIMEOUT_MS the main-thread fallback runs.
  it('WORKER_TIMEOUT_MS (3000ms) timeout fires for non-responsive worker — slow worker → double compute', async () => {
    const { computeStatsAsync } = await importClient();
    // 500 shows × 50 eps = 25000 eps — non-trivial but the worker mock never responds
    const shows: Show[] = [];
    for (let i = 0; i < 500; i++) {
      const s = makeShowWithSeasons({ 1: 50 }, { id: i + 1, runtime: 60 });
      markWatchedFirst(s, 1, 50);
      shows.push(s);
    }
    const promise = computeStatsAsync(shows);
    // Worker received the request but doesn't respond (simulating slow compute)
    expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);
    // Below the new threshold the promise is still pending
    await vi.advanceTimersByTimeAsync(500);
    expect(mockWorker.removeEventListener).not.toHaveBeenCalled();
    // At WORKER_TIMEOUT_MS (3000ms), timeout fires → fallback runs on main thread
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    // Fallback computed correctly
    expect(result.totalWatched).toBe(25000);
    expect(result.totalMinutes).toBe(1_500_000);
    // The worker request was sent (wasted work — worker will eventually compute
    // a result that gets discarded because the handler is already removed)
    expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);
  });

  // ---- Regression (BUG-08-03): fallback path must produce identical results to worker path ----
  // Both the worker and the main-thread fallback now delegate to the shared
  // pure `computeStats` in `src/worker/compute.ts` (single source of truth).
  // This test verifies the wiring: the worker path (via self.onmessage) and
  // the fallback path (via computeStatsAsync with Worker constructor throwing)
  // produce the same result for the same input.
  it('fallback computeStats produces identical results to worker computeStats', async () => {
    // Force fallback by making Worker constructor throw
    (globalThis as unknown as { Worker: typeof Worker }).Worker = vi.fn(() => {
      throw new Error('unsupported');
    }) as unknown as typeof Worker;
    const { computeStatsAsync } = await importClient();

    const shows = [
      makeShowWithSeasons({ 1: 5 }, { id: 1, runtime: 60, genres: ['Drama', 'Crime'] }),
      makeShowWithSeasons({ 1: 3, 2: 2 }, { id: 2, runtime: 45, genres: [] }),
      makeShow({ id: 3, totalEpisodes: 0, seasons: {}, genres: ['Thriller'] }),
    ];
    markWatchedFirst(shows[0], 1, 3);
    markWatchedFirst(shows[1], 1, 2);
    shows[1].list = 'completed';

    const fallbackResult = await computeStatsAsync(shows);
    const workerResult = statsOf(shows); // via self.onmessage harness
    expect(fallbackResult).toEqual(workerResult);
  });
});

describe('[client] computeCalendarAsync', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockWorker: any;
  let messageHandlers: ((ev: { data: WorkerResponse }) => void)[];
  let originalWorker: typeof Worker;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 2, 15, 12, 0, 0)); // Friday Mar 15 2024
    messageHandlers = [];
    mockWorker = {
      postMessage: vi.fn(),
      addEventListener: vi.fn((type: string, handler: (ev: { data: WorkerResponse }) => void) => {
        if (type === 'message') messageHandlers.push(handler);
      }),
      removeEventListener: vi.fn((type: string, handler: (ev: { data: WorkerResponse }) => void) => {
        if (type === 'message') {
          const idx = messageHandlers.indexOf(handler);
          if (idx >= 0) messageHandlers.splice(idx, 1);
        }
      }),
      onerror: null as ((e: ErrorEvent) => void) | null,
      onmessage: null as ((e: MessageEvent) => void) | null,
    };
    originalWorker = globalThis.Worker;
    (globalThis as unknown as { Worker: typeof Worker }).Worker = vi.fn(() => mockWorker) as unknown as typeof Worker;
  });

  afterEach(() => {
    (globalThis as unknown as { Worker: typeof Worker }).Worker = originalWorker;
    vi.useRealTimers();
  });

  function dispatchToClient(data: WorkerResponse): void {
    const handlers = [...messageHandlers];
    for (const h of handlers) h({ data });
  }

  it('sends calendar request with weekOffset, resolves with worker response', async () => {
    const { computeCalendarAsync } = await import('../src/worker/client');
    const s = makeShowWithSeasons({ 1: 1 }, { id: 1, list: 'watching' });
    s.seasons[1][0].airdate = '2024-03-13';

    const promise = computeCalendarAsync([s], 0);
    expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);
    const req = mockWorker.postMessage.mock.calls[0][0] as WorkerRequest;
    expect(req.type).toBe('calendar');
    if (req.type === 'calendar') {
      expect(req.weekOffset).toBe(0);
    }

    const fakeWeek = [
      {
        showId: 1,
        showName: 'Test Show',
        totalEpisodes: 1,
        watchedCount: 0,
        season: 1,
        num: 1,
        name: null,
        date: '2024-03-13',
      },
    ];
    dispatchToClient({
      type: 'calendar',
      id: req.id,
      result: fakeWeek,
      weekStart: '2024-03-11',
      weekEnd: '2024-03-17',
      afterWeek: [],
    });
    const r = await promise;
    expect(r.week).toEqual(fakeWeek);
    expect(r.weekStart).toBe('2024-03-11');
    expect(r.weekEnd).toBe('2024-03-17');
    expect(r.afterWeek).toEqual([]);
  });

  it('falls back after WORKER_TIMEOUT_MS timeout when worker never responds', async () => {
    const { computeCalendarAsync } = await import('../src/worker/client');
    const s = makeShowWithSeasons({ 1: 1 }, { id: 1, list: 'watching' });
    s.seasons[1][0].airdate = '2024-03-13'; // Wed of current week
    const promise = computeCalendarAsync([s], 0);
    await vi.advanceTimersByTimeAsync(3000);
    const r = await promise;
    expect(r.week).toHaveLength(1);
    expect(r.week[0].date).toBe('2024-03-13');
    expect(r.weekStart).toBe('2024-03-11');
    expect(r.weekEnd).toBe('2024-03-17');
  });

  // Regression (BUG-08-03 + BUG-16-03): worker and fallback both delegate to
  // the shared `computeCalendar` in `src/worker/compute.ts` (which applies
  // `safeWeekOffset` internally), so behavior is identical regardless of
  // worker availability — including for NaN/Infinity weekOffset.
  it('fallback calendar produces identical results to worker calendar', async () => {
    (globalThis as unknown as { Worker: typeof Worker }).Worker = vi.fn(() => {
      throw new Error('unsupported');
    }) as unknown as typeof Worker;
    const { computeCalendarAsync } = await import('../src/worker/client');
    const s1 = makeShowWithSeasons({ 1: 3 }, { id: 1, list: 'watching' });
    s1.seasons[1][0].watched = true;
    s1.seasons[1][1].airdate = '2024-03-13';
    s1.seasons[1][2].airdate = '2024-03-20'; // after week
    const s2 = makeShowWithSeasons({ 1: 1 }, { id: 2, list: 'watching' });
    s2.seasons[1][0].airdate = '2024-03-10'; // before week — dropped

    const fallbackR = await computeCalendarAsync([s1, s2], 0);

    // Compute via worker harness
    workerResponses = [];
    (self as unknown as { onmessage: (ev: { data: WorkerRequest }) => void }).onmessage({
      data: { type: 'calendar', id: 1, shows: [s1, s2], weekOffset: 0 },
    });
    const wResp = workerResponses[0];
    if (wResp.type !== 'calendar') throw new Error('expected calendar');

    expect(fallbackR).toEqual({
      week: wResp.result,
      afterWeek: wResp.afterWeek,
      weekStart: wResp.weekStart,
      weekEnd: wResp.weekEnd,
    });
  });

  // BUG-16-03 (FIXED): `computeCalendarFallback` previously lacked the worker's
  // `safeOffset` guard, so NaN/Infinity weekOffset produced Invalid Date
  // ("NaN-NaN-NaN" weekStart/weekEnd). After the refactor, both paths share
  // `computeCalendar` from `./compute.ts`, which applies `safeWeekOffset`
  // internally → non-finite offsets collapse to 0 (current week).
  it('BUG-16-03: fallback path handles NaN/Infinity weekOffset (no Invalid Date)', async () => {
    (globalThis as unknown as { Worker: typeof Worker }).Worker = vi.fn(() => {
      throw new Error('unsupported');
    }) as unknown as typeof Worker;
    const { computeCalendarAsync } = await import('../src/worker/client');

    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = await computeCalendarAsync([], bad);
      // Same as offset 0 (current week — Mon Mar 11 – Sun Mar 17 2024)
      expect(r.weekStart).toBe('2024-03-11');
      expect(r.weekEnd).toBe('2024-03-17');
      // No "NaN" leaks into the date strings
      expect(r.weekStart).not.toContain('NaN');
      expect(r.weekEnd).not.toContain('NaN');
    }
  });

  it('BUG-16-03: fallback path floors non-integer weekOffset (matches worker)', async () => {
    (globalThis as unknown as { Worker: typeof Worker }).Worker = vi.fn(() => {
      throw new Error('unsupported');
    }) as unknown as typeof Worker;
    const { computeCalendarAsync } = await import('../src/worker/client');

    // 1.5 → floored to 1 (next week: Mar 18–24)
    const r = await computeCalendarAsync([], 1.5);
    expect(r.weekStart).toBe('2024-03-18');
    expect(r.weekEnd).toBe('2024-03-24');
  });
});
