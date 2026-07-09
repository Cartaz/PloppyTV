// Agent 05 — probe tests for src/lib/api.ts
// Verifies: external abort propagation, empty-body null contract, error typing,
// timeout, rate-limit, parse-error, network-error. Mocks global fetch and uses
// real AbortController (and fake timers for the timeout case).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiGet, ApiError, searchShows, getShowEpisodes, getShowsPage } from '../src/lib/api';
import { API_BASE, API_TIMEOUT_MS } from '../src/lib/constants';
import { buildShowFromTvmaze } from '../src/lib/normalize';
import type { TvmazeShow } from '../src/types';

// ---------- helpers ----------

function makeAbortError(msg = 'Aborted'): Error {
  const err = new Error(msg);
  err.name = 'AbortError';
  return err;
}

function makeResponse(body: string, status = 200): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/** Installs a `fetch` mock that NEVER resolves on its own; rejects with AbortError
 *  when its signal is aborted. Captures the signal passed in `signalRef`. */
function installPendingFetch(): {
  signalRef: { current: AbortSignal | undefined };
  restore: () => void;
} {
  const original = global.fetch;
  const signalRef: { current: AbortSignal | undefined } = { current: undefined };
  global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    signalRef.current = signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal) {
        if (signal.aborted) {
          reject(makeAbortError());
          return;
        }
        signal.addEventListener(
          'abort',
          () => reject(makeAbortError()),
          { once: true },
        );
      }
      // never resolves otherwise
    });
  }) as typeof fetch;
  return {
    signalRef,
    restore: () => {
      global.fetch = original;
    },
  };
}

const SAMPLE_SHOW = { id: 1, name: 'Foo' } as TvmazeShow;

// ---------- tests ----------

describe('apiGet — abort propagation', () => {
  let restore: () => void;
  let signalRef: { current: AbortSignal | undefined };

  beforeEach(() => {
    const r = installPendingFetch();
    signalRef = r.signalRef;
    restore = r.restore;
  });
  afterEach(() => restore());

  it('FIXED: external abort AFTER awaits DOES abort in-flight fetch (C2 fix)', async () => {
    // This is the normal case in search.ts: apiGet is called, then later (after
    // the user types again) the external signal is aborted. With the C2 fix,
    // the onExternalAbort listener stays attached until `finally` runs (i.e.
    // until fetch settles), so the external abort DOES propagate to the
    // internal controller and aborts the in-flight fetch.
    const external = new AbortController();
    const p = apiGet<unknown>('/shows/1/episodes', external.signal);
    p.catch(() => undefined); // silence Node unhandled-rejection timing noise

    // Flush microtasks — with the fix there is no microtask-cleanup hack,
    // so the onExternalAbort listener is still attached.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Sanity: the in-flight fetch signal is not yet aborted.
    expect(signalRef.current).toBeDefined();
    expect(signalRef.current!.aborted).toBe(false);

    // Now abort the external signal — the listener is still attached →
    // controller.abort() fires → fetch is aborted.
    external.abort();

    // Give the abort listener a chance to fire.
    await new Promise((r) => setTimeout(r, 50));

    // FIXED: the internal controller.signal passed to fetch IS aborted.
    expect(signalRef.current!.aborted).toBe(true);

    // FIXED: the apiGet promise rejects with AbortError (fetch was aborted).
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('external abort SYNCHRONOUSLY (before microtask) DOES abort in-flight fetch', async () => {
    // This is the rare case where abort() happens in the same synchronous
    // tick as apiGet() — before the microtask cleanup runs.
    const external = new AbortController();
    const p = apiGet<unknown>('/shows/1/episodes', external.signal);
    p.catch(() => undefined); // silence Node unhandled-rejection timing noise

    // Abort synchronously, no awaits in between.
    external.abort();

    await new Promise((r) => setTimeout(r, 20));

    expect(signalRef.current).toBeDefined();
    expect(signalRef.current!.aborted).toBe(true);

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('pre-aborted signal: fetch is called with already-aborted controller.signal', async () => {
    const external = new AbortController();
    external.abort();
    const p = apiGet<unknown>('/shows/1/episodes', external.signal);

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    // The fast-path inside apiGet aborted the internal controller before fetch.
    expect(signalRef.current).toBeDefined();
    expect(signalRef.current!.aborted).toBe(true);
  });
});

describe('apiGet — internal timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires TimeoutError when fetch hangs past API_TIMEOUT_MS (no external signal)', async () => {
    const original = global.fetch;
    let captured: AbortSignal | undefined;
    global.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      captured = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (captured) {
          captured.addEventListener(
            'abort',
            () => reject(makeAbortError()),
            { once: true },
          );
        }
      });
    }) as typeof fetch;

    try {
      const p = apiGet<unknown>('/shows/1/episodes');
      p.catch(() => undefined); // silence Node unhandled-rejection timing noise
      // Advance past the internal timeout.
      await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS + 10);
      await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(captured).toBeDefined();
      expect(captured!.aborted).toBe(true);
    } finally {
      global.fetch = original;
    }
  });

  it('does NOT classify as TimeoutError when external signal is aborted (even if both fire)', async () => {
    // If the external signal aborts first, signal.aborted is true → AbortError.
    vi.useFakeTimers();
    const original = global.fetch;
    global.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          if (signal.aborted) {
            reject(makeAbortError());
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(makeAbortError()),
            { once: true },
          );
        }
      });
    }) as typeof fetch;

    try {
      // Pre-aborted so internal controller.abort() runs synchronously.
      const external = new AbortController();
      external.abort();
      const p = apiGet<unknown>('/shows/1/episodes', external.signal);
      p.catch(() => undefined); // silence Node unhandled-rejection timing noise
      await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS + 10);
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      global.fetch = original;
      vi.useRealTimers();
    }
  });
});

describe('apiGet — empty body contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('apiGet (low-level) returns null cast to T on 200 OK empty body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('', 200) as Response);
    // The low-level apiGet still returns null (contract). The wrappers
    // (getShowEpisodes/getShowsPage/searchShows) coerce null → [].
    const result = await apiGet<unknown>('/shows/1/episodes');
    expect(result).toBeNull();
  });

  it('H6 fix: getShowEpisodes coerces null → [] on 200 OK empty body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('', 200) as Response);
    const result = await getShowEpisodes(1);
    expect(result).toEqual([]);
  });

  it('H6 fix: searchShows coerces null → [] on 200 OK empty body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('', 200) as Response);
    const result = await searchShows('foo');
    expect(result).toEqual([]);
  });

  it('H6 fix: getShowsPage coerces null → [] on 200 OK empty body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('', 200) as Response);
    const result = await getShowsPage(0);
    expect(result).toEqual([]);
  });

  it('CALLER buildShowFromTvmaze crashes when episodes is null (TypeError) — raw contract', () => {
    // buildShowFromTvmaze (normalize.ts L105) does `for (const ep of episodes)`.
    // With the H6 fix, getShowEpisodes never returns null to its callers — but
    // the raw apiGet contract still can, so buildShowFromTvmaze remains
    // defensive only via its callers. This test documents the raw behavior.
    expect(() => buildShowFromTvmaze(SAMPLE_SHOW, null as unknown as never, 'towatch')).toThrow(TypeError);
  });

  it('iterating null directly throws TypeError (simulates refreshShowEpisodes loop)', () => {
    // refreshShowEpisodes (shows.ts L215) does `for (const ep of episodes)`.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const _ep of (null as unknown as never[])) {
        // never reached
      }
    }).toThrow(TypeError);
  });
});

describe('apiGet — error typing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HTTP 429 → ApiError name "RateLimitError" with status 429', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('', 429) as Response);
    await expect(getShowEpisodes(1)).rejects.toMatchObject({
      name: 'RateLimitError',
      status: 429,
    });
  });

  it('HTTP 404 → ApiError name "ApiError" with status 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('', 404) as Response);
    await expect(getShowEpisodes(999)).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
    });
  });

  it('HTTP 500 → ApiError name "ApiError" with status 500', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('', 500) as Response);
    await expect(getShowEpisodes(1)).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    });
  });

  it('200 OK with HTML body → ApiError name "ParseError"', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      makeResponse('<html><body>not json</body></html>', 200) as Response,
    );
    await expect(getShowEpisodes(1)).rejects.toMatchObject({ name: 'ParseError' });
  });

  it('fetch throws TypeError → ApiError name "NetworkError"', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(
      Object.assign(new TypeError('Failed to fetch'), {}),
    );
    await expect(getShowEpisodes(1)).rejects.toMatchObject({ name: 'NetworkError' });
  });

  it('ApiError is instanceof Error', () => {
    const e = new ApiError('msg', 'RateLimitError', 429);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('RateLimitError');
    expect(e.status).toBe(429);
    expect(e.message).toBe('msg');
  });
});

describe('apiGet — happy path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses JSON array body', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      makeResponse(JSON.stringify([{ id: 1, season: 1, number: 1 }]), 200) as Response,
    );
    const eps = await getShowEpisodes(1);
    expect(Array.isArray(eps)).toBe(true);
    expect((eps as Array<{ id: number }>)[0].id).toBe(1);
  });

  it('searchShows encodes query and hits /search/shows', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await searchShows('a & b');
    expect(spy).toHaveBeenCalledOnce();
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe(API_BASE + '/search/shows?q=a%20%26%20b');
  });

  it('getShowsPage encodes page number', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await getShowsPage(42);
    expect(spy).toHaveBeenCalledOnce();
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe(API_BASE + '/shows?page=42');
  });

  it('getShowEpisodes encodes showId', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await getShowEpisodes(7);
    expect(spy).toHaveBeenCalledOnce();
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe(API_BASE + '/shows/7/episodes');
  });
});

describe('apiGet — abort race-condition (search-like scenario)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('FIXED: two concurrent searchShows calls — first fetch IS aborted when ac1.abort() fires (C2 fix)', async () => {
    // Simulate the search.ts race-protect pattern:
    //   1) searchShows(q1, signal1) starts
    //   2) (later) signal1.abort()  // user typed again
    //   3) searchShows(q2, signal2) starts
    // With the C2 fix, the first fetch's internal controller.signal IS
    // aborted when ac1.abort() fires — so the phantom fetch is cancelled.
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    vi.spyOn(global, 'fetch').mockImplementation(async (_u, init) => {
      const sig = init?.signal as AbortSignal | undefined;
      if (!firstSignal) firstSignal = sig;
      else if (!secondSignal) secondSignal = sig;
      return new Promise<Response>((_resolve, reject) => {
        if (sig) {
          if (sig.aborted) {
            reject(makeAbortError());
            return;
          }
          sig.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        }
      });
    });

    const ac1 = new AbortController();
    const p1 = searchShows('foo', ac1.signal);
    p1.catch(() => undefined); // silence unhandled-rejection noise

    // User types again: search.ts calls ac1.abort() and creates ac2.
    ac1.abort();
    const ac2 = new AbortController();
    const p2 = searchShows('bar', ac2.signal);
    p2.catch(() => undefined);

    // Give abort listeners a chance to fire.
    await new Promise((r) => setTimeout(r, 30));

    // FIXED: the first fetch's internal controller.signal IS aborted.
    expect(firstSignal).toBeDefined();
    expect(firstSignal!.aborted).toBe(true);

    // The first promise rejects with AbortError.
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });

    // Clean up the second in-flight request.
    ac2.abort();
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
  });
});
