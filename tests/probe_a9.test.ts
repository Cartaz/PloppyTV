// Agent A9 probe: src/worker/stats.worker.ts + src/worker/compute.ts + src/worker/client.ts
//
// Strategy:
//  - compute.ts (pure functions): test directly via import.
//  - stats.worker.ts: test via self.onmessage harness (same as probe_worker.test.ts).
//  - client.ts: test by mocking global Worker constructor (same as probe_worker.test.ts).
//
// Covers:
//  - BUG-A9-01/02/03: safeShows filter (null/undefined/non-object entries, non-array input)
//  - BUG-A9-04: genre dedup + non-string genre filtering
//  - BUG-A9-05: client postMessage DataCloneError → fallback + no leak
//  - BUG-A9-06: client fallback computeStats/computeCalendar throws → reject (no hang)
//  - BUG-A9-10: worker non-object message → clean error response

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Show, WorkerRequest, WorkerResponse } from '../src/types';
import { makeShow, makeShowWithSeasons, markWatchedFirst } from './helpers';
import { computeStats, computeCalendar } from '../src/worker/compute';

// Side-effect import: sets self.onmessage in jsdom (for worker tests)
import '../src/worker/stats.worker';

// ============================================================
// Part 1: compute.ts — direct tests (pure functions)
// ============================================================

describe('[compute] BUG-A9-01/03: safeShows — null/undefined/non-object entries', () => {
  it('computeStats with null entry in shows[] → filters it out, no crash', () => {
    const valid = makeShowWithSeasons({ 1: 5 }, { id: 1, runtime: 60 });
    markWatchedFirst(valid, 1, 3);
    // Simulate corrupt state.shows with a null entry mixed in.
    const shows = [null, valid, undefined] as unknown as Show[];
    const r = computeStats(shows);
    expect(r.totalShows).toBe(1);
    expect(r.totalWatched).toBe(3);
    expect(r.totalEpisodes).toBe(5);
    expect(r.completedShows).toBe(0);
  });

  it('computeStats with all-null shows[] → empty stats, no crash', () => {
    const shows = [null, undefined, null] as unknown as Show[];
    const r = computeStats(shows);
    expect(r.totalShows).toBe(0);
    expect(r.totalWatched).toBe(0);
    expect(r.timeLabel).toBe('0min');
    expect(r.topGenres).toEqual([]);
    expect(r.topShows).toEqual([]);
  });

  it('computeStats with primitive entries (number/string) → filters them out', () => {
    const valid = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    markWatchedFirst(valid, 1, 1);
    const shows = [42, 'not-a-show', true, valid] as unknown as Show[];
    const r = computeStats(shows);
    expect(r.totalShows).toBe(1);
    expect(r.totalWatched).toBe(1);
  });

  it('BUG-A9-03: computeStats with non-array shows → empty stats (defense-in-depth)', () => {
    expect(computeStats(null as unknown as Show[]).totalShows).toBe(0);
    expect(computeStats(undefined as unknown as Show[]).totalShows).toBe(0);
    expect(computeStats({ not: 'array' } as unknown as Show[]).totalShows).toBe(0);
    expect(computeStats('string' as unknown as Show[]).totalShows).toBe(0);
  });

  it('computeCalendar with null entry in shows[] → filters it out, no crash', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 2, 15, 12, 0, 0)); // Friday Mar 15
    try {
      const valid = makeShowWithSeasons({ 1: 1 }, { id: 1, list: 'watching' });
      valid.seasons[1][0].airdate = '2024-03-13';
      const shows = [null, valid, undefined] as unknown as Show[];
      const r = computeCalendar(shows, 0);
      expect(r.week).toHaveLength(1);
      expect(r.week[0].showId).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('BUG-A9-03: computeCalendar with non-array shows → empty result (no crash)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 2, 15, 12, 0, 0));
    try {
      const r = computeCalendar(null as unknown as Show[], 0);
      expect(r.week).toEqual([]);
      expect(r.afterWeek).toEqual([]);
      // weekStart/weekEnd are still computed (based on today), not empty.
      expect(r.weekStart).toBe('2024-03-11');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('[compute] BUG-A9-04: topGenres — dedup + non-string filtering', () => {
  it('duplicate genres in same show → episodes counted once per genre (not double)', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 1, genres: ['Drama', 'Drama', 'Drama'] });
    markWatchedFirst(s, 1, 5);
    const r = computeStats([s]);
    expect(r.topGenres).toHaveLength(1);
    expect(r.topGenres[0].genre).toBe('Drama');
    expect(r.topGenres[0].episodes).toBe(5); // NOT 15
    expect(r.topGenres[0].shows).toBe(1);
  });

  it('duplicate genres case-sensitive (Drama vs drama → both kept)', () => {
    const s = makeShowWithSeasons({ 1: 4 }, { id: 1, genres: ['Drama', 'drama'] });
    markWatchedFirst(s, 1, 4);
    const r = computeStats([s]);
    expect(r.topGenres).toHaveLength(2);
    // Both genres present; each with 4 episodes.
    const drama = r.topGenres.find((g) => g.genre === 'Drama')!;
    const dramaLower = r.topGenres.find((g) => g.genre === 'drama')!;
    expect(drama.episodes).toBe(4);
    expect(dramaLower.episodes).toBe(4);
  });

  it('mixed-case dedup preserves first-seen casing', () => {
    // 'Drama' and 'Drama' dedup; 'Drama' kept (first occurrence).
    const s = makeShowWithSeasons({ 1: 3 }, { id: 1, genres: ['Drama', 'Drama', 'Crime'] });
    markWatchedFirst(s, 1, 3);
    const r = computeStats([s]);
    expect(r.topGenres).toHaveLength(2);
    expect(r.topGenres.map((g) => g.genre).sort()).toEqual(['Crime', 'Drama']);
  });

  it('non-string genre elements (numbers, objects, null) → filtered out, no crash', () => {
    const s = makeShowWithSeasons({ 1: 2 }, {
      id: 1,
      genres: [42, { evil: true }, null, 'Drama', 'Crime'] as unknown as string[],
    });
    markWatchedFirst(s, 1, 2);
    // Without the fix, the sort's `a[0].localeCompare(b[0])` would throw
    // TypeError because numbers don't have localeCompare.
    const r = computeStats([s]);
    const genreNames = r.topGenres.map((g) => g.genre).sort();
    expect(genreNames).toEqual(['Crime', 'Drama']);
  });

  it('all-non-string genres → falls back to "Senza genere"', () => {
    const s = makeShowWithSeasons({ 1: 2 }, {
      id: 1,
      genres: [42, null, { x: 1 }] as unknown as string[],
    });
    markWatchedFirst(s, 1, 2);
    const r = computeStats([s]);
    expect(r.topGenres).toHaveLength(1);
    expect(r.topGenres[0].genre).toBe('Senza genere');
  });

  it('two shows with same genre → genre episodes = sum, shows = 2', () => {
    const s1 = makeShowWithSeasons({ 1: 5 }, { id: 1, genres: ['Drama', 'Drama'] });
    markWatchedFirst(s1, 1, 5);
    const s2 = makeShowWithSeasons({ 1: 3 }, { id: 2, genres: ['Drama'] });
    markWatchedFirst(s2, 1, 3);
    const r = computeStats([s1, s2]);
    const drama = r.topGenres.find((g) => g.genre === 'Drama')!;
    expect(drama.episodes).toBe(8); // 5 + 3, NOT 13 (5+5+3)
    expect(drama.shows).toBe(2);
  });

  it('regression: multi-genre show still counts episodes in EACH distinct genre', () => {
    const s = makeShowWithSeasons({ 1: 10 }, { genres: ['Drama', 'Crime', 'Thriller'], id: 1 });
    markWatchedFirst(s, 1, 10);
    const r = computeStats([s]);
    expect(r.topGenres).toHaveLength(3);
    for (const g of r.topGenres) {
      expect(g.episodes).toBe(10);
      expect(g.shows).toBe(1);
    }
  });

  it('genres not an array (string/null) → falls back to "Senza genere"', () => {
    const s1 = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    (s1 as unknown as { genres: unknown }).genres = 'Drama'; // not an array
    markWatchedFirst(s1, 1, 2);
    const s2 = makeShowWithSeasons({ 1: 1 }, { id: 2 });
    (s2 as unknown as { genres: unknown }).genres = null;
    markWatchedFirst(s2, 1, 1);
    const r = computeStats([s1, s2]);
    expect(r.topGenres).toHaveLength(1);
    expect(r.topGenres[0].genre).toBe('Senza genere');
    expect(r.topGenres[0].episodes).toBe(3);
    expect(r.topGenres[0].shows).toBe(2);
  });
});

// ============================================================
// Part 2: stats.worker.ts — non-object message guard (BUG-A9-10)
// ============================================================

describe('[worker] BUG-A9-10: non-object message guard', () => {
  let workerResponses: WorkerResponse[];
  let originalPostMessage: typeof self.postMessage;

  beforeEach(() => {
    workerResponses = [];
    originalPostMessage = self.postMessage;
    (self as unknown as { postMessage: (msg: WorkerResponse) => void }).postMessage = (msg) => {
      workerResponses.push(msg);
    };
  });

  afterEach(() => {
    (self as unknown as { postMessage: typeof self.postMessage }).postMessage = originalPostMessage;
  });

  function sendRaw(data: unknown): WorkerResponse {
    workerResponses = [];
    (self as unknown as { onmessage: (ev: { data: unknown }) => void }).onmessage({ data });
    if (workerResponses.length !== 1) {
      throw new Error(`Expected exactly 1 response, got ${workerResponses.length}`);
    }
    return workerResponses[0];
  }

  it('null message → error response with id=-1', () => {
    const r = sendRaw(null);
    expect(r.type).toBe('error');
    if (r.type === 'error') {
      expect(r.id).toBe(-1);
      expect(r.message).toContain('expected object');
    }
  });

  it('undefined message → error response with id=-1', () => {
    const r = sendRaw(undefined);
    expect(r.type).toBe('error');
    if (r.type === 'error') expect(r.id).toBe(-1);
  });

  it('string message → error response with id=-1', () => {
    const r = sendRaw('not-an-object');
    expect(r.type).toBe('error');
    if (r.type === 'error') {
      expect(r.id).toBe(-1);
      expect(r.message).toContain('string');
    }
  });

  it('number message → error response with id=-1', () => {
    const r = sendRaw(42);
    expect(r.type).toBe('error');
    if (r.type === 'error') expect(r.id).toBe(-1);
  });

  it('valid object with unknown type → still error but preserves id', () => {
    // Regression: the guard must NOT intercept valid objects (even with
    // unknown type). The existing else-branch handles unknown types.
    const r = sendRaw({ type: 'bogus', id: 99 });
    expect(r.type).toBe('error');
    if (r.type === 'error') {
      expect(r.id).toBe(99); // preserved from msg.id
      expect(r.message).toContain('Unknown message type');
    }
  });

  it('valid object with missing id → error id defaults to -1', () => {
    const r = sendRaw({ type: 'bogus' });
    expect(r.type).toBe('error');
    if (r.type === 'error') expect(r.id).toBe(-1);
  });
});

// ============================================================
// Part 3: client.ts — postMessage throw + fallback throw
// ============================================================

// Helper: a Show with a getter that throws on .totalEpisodes access.
// Used to make computeStats crash on the main thread (simulating corrupt
// data or a Proxy-wrapped object) — verifies the client's fallback
// try/catch rejects instead of hanging.
function makeGetterBombShow(): Show {
  const s = makeShow({ id: 1, name: 'Evil', totalEpisodes: 10 });
  Object.defineProperty(s, 'totalEpisodes', {
    get() {
      throw new Error('getter bomb');
    },
    configurable: true,
  });
  return s;
}

describe('[client] BUG-A9-05: postMessage throws DataCloneError → fallback + no leak', () => {
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

  async function importClient() {
    return await import('../src/worker/client');
  }

  it('stats: postMessage throws → fallback resolves, listener removed (no leak)', async () => {
    const { computeStatsAsync } = await importClient();
    // Make postMessage throw (simulates DataCloneError on non-cloneable shows)
    mockWorker.postMessage = vi.fn(() => {
      throw new Error('DataCloneError: cannot clone');
    });
    const shows = [makeShowWithSeasons({ 1: 3 }, { id: 1, runtime: 60 })];
    markWatchedFirst(shows[0], 1, 2);

    const promise = computeStatsAsync(shows);
    const result = await promise;
    // Fallback computed on main thread: 2 watched × 60 = 120 min
    expect(result.totalMinutes).toBe(120);
    // Listener was removed (no leak)
    expect(messageHandlers).toHaveLength(0);
    // removeEventListener was called
    expect(mockWorker.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('stats: postMessage throws → timeout does NOT fire later (cleared)', async () => {
    const { computeStatsAsync } = await importClient();
    mockWorker.postMessage = vi.fn(() => {
      throw new Error('DataCloneError');
    });
    const shows = [makeShowWithSeasons({ 1: 1 }, { id: 1, runtime: 60 })];
    markWatchedFirst(shows[0], 1, 1);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await computeStatsAsync(shows);
    // The postMessage-failure path logs a specific warning.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('postMessage failed'),
      expect.anything(),
    );
    // Advance past WORKER_TIMEOUT_MS — the timeout should have been cleared,
    // so the 'stats timeout' warning is NOT logged.
    await vi.advanceTimersByTimeAsync(3000);
    const timeoutCalls = warnSpy.mock.calls.filter((c) => c[0]?.includes?.('stats timeout'));
    expect(timeoutCalls).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('calendar: postMessage throws → fallback resolves, listener removed', async () => {
    vi.setSystemTime(new Date(2024, 2, 15, 12, 0, 0)); // Friday Mar 15
    const { computeCalendarAsync } = await importClient();
    mockWorker.postMessage = vi.fn(() => {
      throw new Error('DataCloneError');
    });
    const s = makeShowWithSeasons({ 1: 1 }, { id: 1, list: 'watching' });
    s.seasons[1][0].airdate = '2024-03-13';

    const r = await computeCalendarAsync([s], 0);
    // Fallback computed: episode in week
    expect(r.week).toHaveLength(1);
    expect(r.weekStart).toBe('2024-03-11');
    expect(messageHandlers).toHaveLength(0);
  });
});

describe('[client] BUG-A9-06: fallback compute throws → promise rejects (no hang)', () => {
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
    const handlers = [...messageHandlers];
    for (const h of handlers) h({ data });
  }

  async function importClient() {
    return await import('../src/worker/client');
  }

  it('worker null (constructor throws) + computeStats throws → rejects (not hangs)', async () => {
    // Force the no-worker fallback path
    (globalThis as unknown as { Worker: typeof Worker }).Worker = vi.fn(() => {
      throw new Error('unsupported');
    }) as unknown as typeof Worker;
    const { computeStatsAsync } = await importClient();
    const evilShows = [makeGetterBombShow()];
    // Without BUG-A9-06 fix: the executor's sync throw auto-rejects (this
    // path already worked). But we verify it rejects rather than hangs.
    await expect(computeStatsAsync(evilShows)).rejects.toThrow('getter bomb');
  });

  it('worker emits error + fallback computeStats throws → rejects (not hangs)', async () => {
    // This is the KEY test for BUG-A9-06: the fallback runs inside an event
    // handler (NOT the Promise executor). Before the fix, a throw here was
    // NOT caught by the Promise constructor → promise hung forever.
    const { computeStatsAsync } = await importClient();
    const evilShows = [makeGetterBombShow()];

    const promise = computeStatsAsync(evilShows);
    // Attach handler immediately to prevent Node's "unhandled rejection"
    // warning in the window between dispatchToClient (sync reject) and the
    // expect().rejects assertion below.
    promise.catch(() => {});
    expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);
    const req = mockWorker.postMessage.mock.calls[0][0] as WorkerRequest;

    // Worker emits an error response (simulating compute crash in worker)
    dispatchToClient({ type: 'error', id: req.id, message: 'worker compute crashed' });

    // Before fix: promise hangs forever. After fix: rejects with 'getter bomb'.
    await expect(promise).rejects.toThrow('getter bomb');
    // Listener was cleaned up
    expect(messageHandlers).toHaveLength(0);
  });

  it('worker timeout + fallback computeStats throws → rejects (not hangs)', async () => {
    // KEY test: fallback runs inside setTimeout callback. Before the fix,
    // a throw here was an uncaught exception + promise hung forever.
    const { computeStatsAsync } = await importClient();
    const evilShows = [makeGetterBombShow()];

    const promise = computeStatsAsync(evilShows);
    // Attach handler immediately to prevent Node's "unhandled rejection"
    // warning in the window between the timeout firing (reject) and the
    // expect().rejects assertion below.
    promise.catch(() => {});
    expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);

    // Suppress console.warn for the timeout message
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Advance past WORKER_TIMEOUT_MS — timeout fires, fallback throws
    await vi.advanceTimersByTimeAsync(3000);

    // Before fix: promise hangs. After fix: rejects.
    await expect(promise).rejects.toThrow('getter bomb');
    expect(messageHandlers).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('worker emits error + fallback computeCalendar throws → rejects', async () => {
    vi.setSystemTime(new Date(2024, 2, 15, 12, 0, 0));
    const { computeCalendarAsync } = await importClient();

    // Evil show: getter bomb on totalEpisodes (computeCalendar accesses
    // show.totalEpisodes when building CalendarEpisode).
    const evilShow = makeGetterBombShow();
    evilShow.list = 'watching';
    evilShow.seasons = { 1: [{ num: 1, id: 1, watched: false, airdate: '2024-03-13', name: null, runtime: null }] };

    const promise = computeCalendarAsync([evilShow], 0);
    promise.catch(() => {});
    const req = mockWorker.postMessage.mock.calls[0][0] as WorkerRequest;
    dispatchToClient({ type: 'error', id: req.id, message: 'worker crash' });

    await expect(promise).rejects.toThrow('getter bomb');
  });

  it('worker timeout + fallback computeCalendar throws → rejects', async () => {
    vi.setSystemTime(new Date(2024, 2, 15, 12, 0, 0));
    const { computeCalendarAsync } = await importClient();
    const evilShow = makeGetterBombShow();
    evilShow.list = 'watching';
    evilShow.seasons = { 1: [{ num: 1, id: 1, watched: false, airdate: '2024-03-13', name: null, runtime: null }] };

    const promise = computeCalendarAsync([evilShow], 0);
    promise.catch(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).rejects.toThrow('getter bomb');
    warnSpy.mockRestore();
  });

  it('stats: postMessage throws + fallback computeStats throws → rejects (not hangs)', async () => {
    // Combined: BUG-A9-05 path (postMessage throws) + BUG-A9-06 path
    // (fallback also throws). The postMessage catch must cleanup and then
    // runFallbackOrReject must reject.
    const { computeStatsAsync } = await importClient();
    mockWorker.postMessage = vi.fn(() => {
      throw new Error('DataCloneError');
    });
    const evilShows = [makeGetterBombShow()];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(computeStatsAsync(evilShows)).rejects.toThrow('getter bomb');
    expect(messageHandlers).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

// ============================================================
// Part 4: Regression — existing behavior preserved
// ============================================================

describe('[compute] regression: existing behavior preserved', () => {
  it('empty shows → all zeros, timeLabel "0min"', () => {
    const r = computeStats([]);
    expect(r.totalShows).toBe(0);
    expect(r.totalWatched).toBe(0);
    expect(r.timeLabel).toBe('0min');
    expect(r.totalProgress).toBe(0);
    expect(r.topGenres).toEqual([]);
    expect(r.topShows).toEqual([]);
  });

  it('runtime=0 → default 45 min/ep', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { runtime: 0, id: 1 });
    markWatchedFirst(s, 1, 2);
    expect(computeStats([s]).totalMinutes).toBe(90);
  });

  it('topShows pct clamped to [0,100]', () => {
    const a = makeShowWithSeasons({ 1: 5 }, { id: 1, name: 'A' });
    markWatchedFirst(a, 1, 5);
    const c = makeShowWithSeasons({ 1: 5 }, { id: 3, name: 'C', totalEpisodes: 3 });
    markWatchedFirst(c, 1, 5);
    const r = computeStats([a, c]);
    const cEntry = r.topShows.find((t) => t.showId === 3)!;
    expect(cEntry.pct).toBe(100);
  });

  it('totalProgress clamped when watched>total', () => {
    const s = makeShowWithSeasons({ 1: 10 }, { id: 1, totalEpisodes: 5 });
    markWatchedFirst(s, 1, 10);
    expect(computeStats([s]).totalProgress).toBe(100);
  });

  it('calendar: only watching shows included', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 2, 15, 12, 0, 0));
    try {
      const watching = makeShowWithSeasons({ 1: 1 }, { id: 1, list: 'watching' });
      watching.seasons[1][0].airdate = '2024-03-13';
      const towatch = makeShowWithSeasons({ 1: 1 }, { id: 2, list: 'towatch' });
      towatch.seasons[1][0].airdate = '2024-03-13';
      const r = computeCalendar([watching, towatch], 0);
      expect(r.week).toHaveLength(1);
      expect(r.week[0].showId).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calendar: weekOffset NaN → treated as 0', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 2, 15, 12, 0, 0));
    try {
      const r = computeCalendar([], NaN);
      expect(r.weekStart).toBe('2024-03-11');
    } finally {
      vi.useRealTimers();
    }
  });
});
