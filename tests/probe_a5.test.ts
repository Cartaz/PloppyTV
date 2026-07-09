// Agent A5 — probe tests for src/lib/api.ts
// Verifies: BUG-A5-01 (timeout vs external-abort race), BUG-A5-02 (non-array
// JSON coercion), plus edge cases NOT already covered by probe_api.test.ts:
//  - URL encoding edge cases (empty/unicode/special chars/negative ids)
//  - listener cleanup (no leak on settle / on external abort / on pre-aborted)
//  - HTTP edge cases (429 with body, 403, 502, body-read TypeError)
// Mocks global.fetch and uses vi.useFakeTimers for the timeout race test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiGet, ApiError, searchShows, getShowEpisodes, getShowsPage } from '../src/lib/api';
import { API_BASE, API_TIMEOUT_MS } from '../src/lib/constants';

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

/** Mock fetch that never resolves on its own; rejects with AbortError when
 *  its signal is aborted. Captures the signal passed in `signalRef`. */
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
        signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
      }
    });
  }) as typeof fetch;
  return {
    signalRef,
    restore: () => {
      global.fetch = original;
    },
  };
}

// ---------- tests ----------

describe('BUG-A5-01: timeout vs external-abort race condition', () => {
  let original: typeof fetch;
  beforeEach(() => {
    vi.useFakeTimers();
    original = global.fetch;
  });
  afterEach(() => {
    global.fetch = original;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('timeout fires, THEN external aborts (before microtask flush) — TimeoutError wins', async () => {
    // Race: setTimeout callback fires (timedOut=true, controller.abort()),
    // fetch's abort listener fires (reject queued as microtask). BEFORE the
    // microtask runs, external.abort() is called — signal.aborted becomes true.
    // With the A5-01 fix, the catch sees timedOut=true → TimeoutError (not
    // AbortError). With the OLD code, signal.aborted=true → AbortError.
    global.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          if (signal.aborted) {
            reject(makeAbortError());
            return;
          }
          signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        }
      });
    }) as typeof fetch;

    const external = new AbortController();
    const p = apiGet<unknown>('/shows/1/episodes', external.signal);
    p.catch(() => undefined); // silence unhandled-rejection timing noise

    // Fire the internal timeout SYNCHRONOUSLY (vi.advanceTimersByTime is sync
    // and does NOT flush microtasks). At this point, setTimeout callback has
    // run: timedOut=true, controller.abort() called, fetch's abort listener
    // called (reject queued as microtask).
    vi.advanceTimersByTime(API_TIMEOUT_MS + 10);

    // The external signal was NOT aborted by the timeout (only the internal
    // controller was). So signal.aborted is still false here.
    expect(external.signal.aborted).toBe(false);

    // NOW the external signal aborts — e.g., user typed again ~10s after
    // starting the search, slightly after the internal timeout fired but
    // before the fetch's reject microtask runs (since vi.advanceTimersByTime
    // is sync and doesn't flush microtasks).
    external.abort();
    expect(external.signal.aborted).toBe(true);

    // Flush microtasks — fetch's reject runs, then apiGet's catch runs.
    // With the fix: timedOut=true → TimeoutError.
    // With the old code: signal.aborted=true → AbortError (MISCLASSIFIED).
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
    // Also assert it's an ApiError (not a raw AbortError).
    await expect(p).rejects.toBeInstanceOf(ApiError);
  });

  it('control: external abort fires BEFORE timeout — AbortError wins (not TimeoutError)', async () => {
    // Sanity check: if the external signal aborts before the timeout fires,
    // we propagate the original AbortError (not TimeoutError). The `timedOut`
    // flag must NOT be set in this case.
    global.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          if (signal.aborted) {
            reject(makeAbortError());
            return;
          }
          signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        }
      });
    }) as typeof fetch;

    const external = new AbortController();
    const p = apiGet<unknown>('/shows/1/episodes', external.signal);
    p.catch(() => undefined);

    // External abort at t=5s (before timeout at t=API_TIMEOUT_MS).
    vi.advanceTimersByTime(5000);
    expect(external.signal.aborted).toBe(false);
    external.abort();
    expect(external.signal.aborted).toBe(true);

    // Advance past the timeout — it should NOT fire (clearTimeout in finally).
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS);

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('control: timeout fires with NO external signal — TimeoutError (unchanged)', async () => {
    // Original behavior: no external signal, only timeout. TimeoutError.
    global.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          if (signal.aborted) {
            reject(makeAbortError());
            return;
          }
          signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        }
      });
    }) as typeof fetch;

    const p = apiGet<unknown>('/shows/1/episodes');
    p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS + 10);
    await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(p).rejects.toBeInstanceOf(ApiError);
  });
});

describe('BUG-A5-02: wrappers coerce non-array JSON to []', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('searchShows returns [] when TVMaze returns JSON object (not array)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      makeResponse('{"error":"internal"}', 200) as Response,
    );
    const result = await searchShows('foo');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it('searchShows returns [] when TVMaze returns JSON primitive (number)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('42', 200) as Response);
    const result = await searchShows('foo');
    expect(result).toEqual([]);
  });

  it('searchShows returns [] when TVMaze returns JSON string', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      makeResponse('"not an array"', 200) as Response,
    );
    const result = await searchShows('foo');
    expect(result).toEqual([]);
  });

  it('searchShows returns [] when TVMaze returns JSON boolean', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('true', 200) as Response);
    const result = await searchShows('foo');
    expect(result).toEqual([]);
  });

  it('getShowEpisodes returns [] when TVMaze returns JSON object', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      makeResponse('{"message":"moved"}', 200) as Response,
    );
    const result = await getShowEpisodes(1);
    expect(result).toEqual([]);
  });

  it('getShowEpisodes returns [] when TVMaze returns JSON primitive', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('0', 200) as Response);
    const result = await getShowEpisodes(1);
    expect(result).toEqual([]);
  });

  it('getShowsPage returns [] when TVMaze returns JSON null', async () => {
    // H6 regression: null is still coerced to [] (not just non-array).
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('null', 200) as Response);
    const result = await getShowsPage(0);
    expect(result).toEqual([]);
  });

  it('getShowsPage returns [] when TVMaze returns JSON object', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      makeResponse('{"page":0}', 200) as Response,
    );
    const result = await getShowsPage(0);
    expect(result).toEqual([]);
  });

  it('still returns the array when TVMaze returns a valid JSON array', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      makeResponse('[{"score":0.5,"show":{"id":1}}]', 200) as Response,
    );
    const result = await searchShows('foo');
    expect(result).toHaveLength(1);
    expect(result[0].show.id).toBe(1);
  });

  it('apiGet (low-level) still returns the raw object — only wrappers coerce', async () => {
    // apiGet is generic <T> and may legitimately return non-arrays for other
    // endpoints. The Array.isArray coercion is ONLY in the wrappers.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      makeResponse('{"foo":"bar"}', 200) as Response,
    );
    const result = await apiGet<{ foo: string }>('/some/endpoint');
    expect(result).toEqual({ foo: 'bar' });
  });
});

describe('apiGet — URL building edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('searchShows encodes empty query (q= with no value)', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await searchShows('');
    expect(spy).toHaveBeenCalledOnce();
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe(API_BASE + '/search/shows?q=');
  });

  it('searchShows encodes unicode query (café → caf%C3%A9)', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await searchShows('café');
    expect(spy).toHaveBeenCalledOnce();
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe(API_BASE + '/search/shows?q=caf%C3%A9');
  });

  it('searchShows encodes < > # & to prevent URL injection / fragment', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await searchShows('<script>alert(1)</script>#frag&param=1');
    expect(spy).toHaveBeenCalledOnce();
    const url = spy.mock.calls[0][0] as string;
    // No raw <, >, # in the URL (they must be percent-encoded).
    expect(url).not.toContain('<');
    expect(url).not.toContain('>');
    expect(url).not.toContain('#');
    // No raw & either — encoded as %26.
    expect(url).not.toMatch(/[^%]&/);
    expect(url).toContain('%3C'); // <
    expect(url).toContain('%3E'); // >
    expect(url).toContain('%23'); // #
    expect(url).toContain('%26'); // &
  });

  it('searchShows encodes spaces as %20 (not +)', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await searchShows('foo bar baz');
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe(API_BASE + '/search/shows?q=foo%20bar%20baz');
  });

  it('getShowEpisodes with showId=0 hits /shows/0/episodes', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await getShowEpisodes(0);
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe(API_BASE + '/shows/0/episodes');
  });

  it('getShowEpisodes with negative showId hits /shows/-1/episodes', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await getShowEpisodes(-1);
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe(API_BASE + '/shows/-1/episodes');
  });

  it('getShowsPage with negative page hits /shows?page=-1', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await getShowsPage(-1);
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe(API_BASE + '/shows?page=-1');
  });

  it('getShowsPage with NaN page hits /shows?page=NaN', async () => {
    const spy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(makeResponse('[]', 200) as Response);
    await getShowsPage(NaN);
    const url = spy.mock.calls[0][0] as string;
    expect(url).toBe(API_BASE + '/shows?page=NaN');
  });
});

describe('apiGet — onExternalAbort listener cleanup (no leak)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listener is removed after fetch settles normally (no external abort)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('[]', 200) as Response);
    const external = new AbortController();
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener');

    await apiGet<unknown>('/shows/1/episodes', external.signal);

    // removeEventListener was called for 'abort' in the finally block.
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('listener is removed even after external abort fired (once:true auto-remove + finally)', async () => {
    let rejectFn!: (e: Error) => void;
    vi.spyOn(global, 'fetch').mockImplementation((_u, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        rejectFn = reject;
        if (signal) {
          if (signal.aborted) {
            reject(makeAbortError());
            return;
          }
          signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        }
      }) as Promise<Response>;
    });

    const external = new AbortController();
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener');
    const p = apiGet<unknown>('/shows/1/episodes', external.signal);
    p.catch(() => undefined);

    // External abort — onExternalAbort fires (once:true auto-removes).
    external.abort();

    // Flush microtasks so catch+finally run.
    await new Promise((r) => setTimeout(r, 10));

    // removeEventListener still called in finally (defensive; no-op since
    // already auto-removed by once:true, but the call happens).
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    // rejectFn unused — abort path rejects via the abort listener.
    void rejectFn;
  });

  it('pre-aborted signal: NO listener registered (fast-path), NO leak', async () => {
    const spy = vi.spyOn(global, 'fetch').mockImplementation((_u, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) reject(makeAbortError());
      }) as Promise<Response>;
    });

    const external = new AbortController();
    external.abort();
    const addSpy = vi.spyOn(external.signal, 'addEventListener');
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener');

    await expect(apiGet<unknown>('/shows/1/episodes', external.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    // No listener was registered (pre-aborted fast-path).
    expect(addSpy).not.toHaveBeenCalledWith('abort', expect.any(Function), expect.anything());
    // No listener to remove either.
    expect(removeSpy).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('timeout fires → listener removed in finally (no leak on timeout path)', async () => {
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
          signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        }
      });
    }) as typeof fetch;

    try {
      const external = new AbortController();
      const removeSpy = vi.spyOn(external.signal, 'removeEventListener');
      const p = apiGet<unknown>('/shows/1/episodes', external.signal);
      p.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS + 10);
      await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });

      // Listener was cleaned up in finally.
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
      // And the external signal was NOT aborted (timeout, not external).
      expect(external.signal.aborted).toBe(false);
    } finally {
      global.fetch = original;
      vi.useRealTimers();
    }
  });
});

describe('apiGet — HTTP edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HTTP 429 with JSON body → RateLimitError (body ignored)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      makeResponse('{"message":"slow down"}', 429) as Response,
    );
    await expect(getShowEpisodes(1)).rejects.toMatchObject({
      name: 'RateLimitError',
      status: 429,
    });
  });

  it('HTTP 403 → ApiError with status 403', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('', 403) as Response);
    await expect(getShowEpisodes(1)).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
    });
  });

  it('HTTP 502 → ApiError with status 502', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('', 502) as Response);
    await expect(getShowEpisodes(1)).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
    });
  });

  it('HTTP 400 with JSON error body → ApiError with status 400', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      makeResponse('{"error":"bad request"}', 400) as Response,
    );
    await expect(getShowEpisodes(1)).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
    });
  });

  it('res.text() rejects with TypeError (connection drop during body read) → NetworkError', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.reject(new TypeError('network dropped during body read')),
    } as unknown as Response);
    await expect(getShowEpisodes(1)).rejects.toMatchObject({ name: 'NetworkError' });
    await expect(getShowEpisodes(1)).rejects.toBeInstanceOf(ApiError);
  });

  it('200 OK with whitespace-only body → ParseError (not null)', async () => {
    // Whitespace-only body is truthy, so it skips the empty-body branch and
    // goes to JSON.parse, which throws SyntaxError → ParseError. This
    // documents the behavior (debatable; could also be treated as empty).
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('   \n  ', 200) as Response);
    await expect(getShowEpisodes(1)).rejects.toMatchObject({ name: 'ParseError' });
  });

  it('HTTP 200 with empty body → low-level apiGet returns null (contract)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(makeResponse('', 200) as Response);
    const result = await apiGet<unknown>('/shows/1/episodes');
    expect(result).toBeNull();
  });
});

describe('apiGet — concurrent calls with shared external signal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two concurrent apiGet calls sharing one signal: both abort when signal aborts', async () => {
    // Both calls register their own onExternalAbort listener. When the signal
    // aborts, both fire, both controllers abort, both fetches reject.
    const { signalRef, restore } = installPendingFetch();
    try {
      const external = new AbortController();
      const p1 = apiGet<unknown>('/shows/1/episodes', external.signal);
      const p2 = apiGet<unknown>('/shows/2/episodes', external.signal);
      p1.catch(() => undefined);
      p2.catch(() => undefined);

      // Wait for both fetch mocks to capture their signals.
      await new Promise((r) => setTimeout(r, 0));

      external.abort();
      await new Promise((r) => setTimeout(r, 20));

      await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
      await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
      // signalRef only captures the last fetch's signal, but both should be
      // aborted (each controller aborted via its own listener).
      expect(signalRef.current).toBeDefined();
      expect(signalRef.current!.aborted).toBe(true);
    } finally {
      restore();
    }
  });
});
