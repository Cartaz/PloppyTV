// Probe tests for src/views/yearReview.ts (Task A14)
//
// Covers:
//   - computeYearStats edge cases (BUG-A14-01..04, 10, 14)
//   - exportYearCard canvas error handling (BUG-A14-05..09): tainted canvas
//     SecurityError (mocked toBlob throw), null blob, click failure, blob URL
//     leak prevention, toBlob not available, filename year sanitization
//   - renderYearReview with corrupted data (BUG-A14-12, 13) + XSS via showName
//
// jsdom non ha canvas reale: getContext() ritorna null e toBlob() non chiama
// il callback. Per testare il flow di export, mockiamo HTMLCanvasElement.prototype
// .getContext / .toBlob con comportamenti controllabili.

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { computeYearStats, exportYearCard, renderYearReview } from '../src/views/yearReview';
import type { YearStats } from '../src/views/yearReview';
import { setShows } from '../src/lib/store';
import { makeShow, makeEpisode } from './helpers';
import type { Show, Episode } from '../src/types';

// ===== Canvas mocking =====

// Fake CanvasRenderingContext2D: tutti i metodi/setters sono no-op.
// Solo i metodi usati da exportYearCard sono implementati.
function makeFakeCtx(): unknown {
  return {
    createLinearGradient: () => ({ addColorStop: () => {} }),
    fillRect: () => {},
    fillText: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    set fillStyle(_: unknown) {},
    set strokeStyle(_: unknown) {},
    set lineWidth(_: unknown) {},
    set font(_: unknown) {},
    set textAlign(_: unknown) {},
  };
}

const origGetContext = HTMLCanvasElement.prototype.getContext;
const origToBlob = HTMLCanvasElement.prototype.toBlob;

type ToBlobBehavior = 'success' | 'null' | 'throw' | 'no-callback';
let _toBlobBehavior: ToBlobBehavior = 'success';
let _toBlobCalls = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setupCanvasMock(ctxOk: boolean): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).getContext = function () {
    return ctxOk ? makeFakeCtx() : null;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLCanvasElement.prototype as any).toBlob = function (callback: (b: Blob | null) => void) {
    _toBlobCalls++;
    if (_toBlobBehavior === 'throw') {
      throw new DOMException('Tainted canvas', 'SecurityError');
    }
    if (_toBlobBehavior === 'no-callback') return;
    if (_toBlobBehavior === 'null') {
      callback(null);
      return;
    }
    callback(new Blob([], { type: 'image/png' }));
  };
}

function restoreCanvas(): void {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  HTMLCanvasElement.prototype.toBlob = origToBlob;
}

// ===== Test setup =====

// jsdom non implementa URL.createObjectURL/revokeObjectURL di default.
// Definiamo stub a livello di modulo (prima di qualsiasi spy).
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = (() => 'blob:stub') as typeof URL.createObjectURL;
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
}

let toastEl: HTMLDivElement;
let createObjectURLSpy: MockInstance;
let revokeObjectURLSpy: MockInstance;
let clickSpy: MockInstance;
let consoleErrorSpy: MockInstance;

beforeEach(() => {
  // Toast element required by showToast()
  toastEl = document.createElement('div');
  toastEl.id = 'toast';
  document.body.appendChild(toastEl);

  _toBlobBehavior = 'success';
  _toBlobCalls = 0;
  setupCanvasMock(true);

  createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
  revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  // Suppress expected console.error noise from error-path tests
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreCanvas();
  if (createObjectURLSpy) createObjectURLSpy.mockRestore();
  if (revokeObjectURLSpy) revokeObjectURLSpy.mockRestore();
  if (clickSpy) clickSpy.mockRestore();
  if (consoleErrorSpy) consoleErrorSpy.mockRestore();
  toastEl.remove();
  // Reset store state to avoid cross-test leakage
  setShows([]);
});

function toastText(): string {
  return toastEl.textContent || '';
}

function toastHasError(): boolean {
  return toastEl.className.includes('error');
}

function toastHasSuccess(): boolean {
  return toastEl.className.includes('success');
}

// ===== Helper: build a show with watched episodes in a year =====

function makeShowWithWatchedEpsInYear(
  id: number,
  name: string,
  year: number,
  epCount: number,
  over: Partial<Show> = {},
): Show {
  const eps: Episode[] = [];
  for (let i = 1; i <= epCount; i++) {
    const month = (i % 9) + 1; // 1..9, evita month 0 o > 12
    eps.push(
      makeEpisode({
        num: i,
        id: id * 1000 + i,
        watched: true,
        airdate: `${year}-0${month}-15`,
        runtime: 45,
      }),
    );
  }
  return makeShow({
    id,
    name,
    seasons: { 1: eps },
    totalSeasons: 1,
    totalEpisodes: epCount,
    runtime: 45,
    genres: ['Drama'],
    ...over,
  });
}

// ===== computeYearStats: BUG-A14-01 (watched strict === true) =====

describe('BUG-A14-01: ep.watched strict === true', () => {
  it('counts watched=true', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 3);
    const stats = computeYearStats([show], 2023);
    expect(stats.totalEpisodes).toBe(3);
  });

  it('does NOT count watched="false" (string, truthy before fix)', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        1: [
          makeEpisode({
            num: 1,
            id: 10,
            watched: 'false' as unknown as boolean,
            airdate: '2023-01-01',
            runtime: 45,
          }),
        ],
      },
    });
    const stats = computeYearStats([show], 2023);
    expect(stats.totalEpisodes).toBe(0);
  });

  it('does NOT count watched=1 (number, truthy before fix)', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        1: [
          makeEpisode({
            num: 1,
            id: 10,
            watched: 1 as unknown as boolean,
            airdate: '2023-01-01',
            runtime: 45,
          }),
        ],
      },
    });
    const stats = computeYearStats([show], 2023);
    expect(stats.totalEpisodes).toBe(0);
  });

  it('does NOT count watched="true" (string)', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        1: [
          makeEpisode({
            num: 1,
            id: 10,
            watched: 'true' as unknown as boolean,
            airdate: '2023-01-01',
            runtime: 45,
          }),
        ],
      },
    });
    const stats = computeYearStats([show], 2023);
    expect(stats.totalEpisodes).toBe(0);
  });
});

// ===== computeYearStats: BUG-A14-02 (airdate must be string) =====

describe('BUG-A14-02: ep.airdate must be string', () => {
  it('does not throw when airdate is a number', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        1: [
          makeEpisode({
            num: 1,
            id: 10,
            watched: true,
            airdate: 20230101 as unknown as string,
            runtime: 45,
          }),
        ],
      },
    });
    expect(() => computeYearStats([show], 2023)).not.toThrow();
    expect(computeYearStats([show], 2023).totalEpisodes).toBe(0);
  });

  it('does not throw when airdate is an object', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        1: [
          makeEpisode({
            num: 1,
            id: 10,
            watched: true,
            airdate: { year: 2023 } as unknown as string,
            runtime: 45,
          }),
        ],
      },
    });
    expect(() => computeYearStats([show], 2023)).not.toThrow();
  });

  it('counts only episodes with string airdate matching year', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2);
    // Corrupt one episode's airdate to a number
    (show.seasons[1][0] as Episode).airdate = 20230101 as unknown as string;
    const stats = computeYearStats([show], 2023);
    expect(stats.totalEpisodes).toBe(1); // only the one with string airdate
  });
});

// ===== computeYearStats: BUG-A14-03 (runtime must be finite number) =====

describe('BUG-A14-03: runtime must be finite number', () => {
  it('does NOT concatenate strings when runtime is "30"', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        1: [
          makeEpisode({ num: 1, id: 10, watched: true, airdate: '2023-01-01', runtime: '30' as unknown as number }),
          makeEpisode({ num: 2, id: 11, watched: true, airdate: '2023-02-01', runtime: '30' as unknown as number }),
        ],
      },
      runtime: 45,
    });
    const stats = computeYearStats([show], 2023);
    // Before fix: totalMinutes = "3030" (string concat). After fix: 90 (45 fallback each).
    expect(stats.totalMinutes).toBe(90);
    expect(typeof stats.totalMinutes).toBe('number');
  });

  it('uses ep.runtime when it is a valid number', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        1: [makeEpisode({ num: 1, id: 10, watched: true, airdate: '2023-01-01', runtime: 60 })],
      },
      runtime: 45,
    });
    const stats = computeYearStats([show], 2023);
    expect(stats.totalMinutes).toBe(60);
  });

  it('falls back to show.runtime when ep.runtime is Infinity', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        1: [makeEpisode({ num: 1, id: 10, watched: true, airdate: '2023-01-01', runtime: Infinity })],
      },
      runtime: 60,
    });
    const stats = computeYearStats([show], 2023);
    expect(stats.totalMinutes).toBe(60);
  });

  it('falls back to 45 when both ep.runtime and show.runtime are invalid', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        1: [makeEpisode({ num: 1, id: 10, watched: true, airdate: '2023-01-01', runtime: NaN })],
      },
      runtime: 'bad' as unknown as number,
    });
    const stats = computeYearStats([show], 2023);
    expect(stats.totalMinutes).toBe(45);
  });

  it('handles ep.runtime = 0 (falsy) by falling back', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        1: [makeEpisode({ num: 1, id: 10, watched: true, airdate: '2023-01-01', runtime: 0 })],
      },
      runtime: 50,
    });
    const stats = computeYearStats([show], 2023);
    expect(stats.totalMinutes).toBe(50); // falls back to show.runtime
  });
});

// ===== computeYearStats: BUG-A14-04 (show.seasons null/undefined/array) =====

describe('BUG-A14-04: show.seasons null/undefined/array', () => {
  it('does not throw when seasons is null', () => {
    const show = makeShow({ id: 1, name: 'A', seasons: null as unknown as Record<number, Episode[]> });
    expect(() => computeYearStats([show], 2023)).not.toThrow();
  });

  it('does not throw when seasons is undefined', () => {
    const show = makeShow({ id: 1, name: 'A' });
    // @ts-expect-error intentionally malformed
    show.seasons = undefined;
    expect(() => computeYearStats([show], 2023)).not.toThrow();
  });

  it('does not throw when seasons is an array', () => {
    const show = makeShow({ id: 1, name: 'A', seasons: [] as unknown as Record<number, Episode[]> });
    expect(() => computeYearStats([show], 2023)).not.toThrow();
  });

  it('does not throw when seasons is a string', () => {
    const show = makeShow({ id: 1, name: 'A', seasons: 'bad' as unknown as Record<number, Episode[]> });
    expect(() => computeYearStats([show], 2023)).not.toThrow();
  });

  it('skips null show entries in array', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2);
    expect(() => computeYearStats([show, null as unknown as Show], 2023)).not.toThrow();
    expect(computeYearStats([show, null as unknown as Show], 2023).totalEpisodes).toBe(2);
  });

  it('skips non-object show entries', () => {
    expect(() => computeYearStats(['bad' as unknown as Show, 42 as unknown as Show], 2023)).not.toThrow();
  });
});

// ===== computeYearStats: BUG-A14-10 (empty/non-string genres) =====

describe('BUG-A14-10: empty/non-string genres skipped', () => {
  it('does not set empty string as dominantGenre', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2, { genres: ['', '  ', 'Drama'] });
    const stats = computeYearStats([show], 2023);
    expect(stats.dominantGenre).toBe('Drama');
  });

  it('falls back to N/D when all genres are empty/whitespace', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2, { genres: ['', '  ', '\t'] });
    const stats = computeYearStats([show], 2023);
    expect(stats.dominantGenre).toBe('N/D');
  });

  it('skips non-string genre entries (number, null, object)', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2, {
      genres: [123 as unknown as string, null as unknown as string, { x: 1 } as unknown as string, 'Drama'],
    });
    const stats = computeYearStats([show], 2023);
    expect(stats.dominantGenre).toBe('Drama');
  });

  it('handles show.genres = null', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2, { genres: null as unknown as string[] });
    const stats = computeYearStats([show], 2023);
    expect(stats.dominantGenre).toBe('N/D');
  });

  it('handles show.genres = undefined', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2);
    // @ts-expect-error intentionally malformed
    show.genres = undefined;
    const stats = computeYearStats([show], 2023);
    expect(stats.dominantGenre).toBe('N/D');
  });
});

// ===== computeYearStats: BUG-A14-14 (year validation) =====

describe('BUG-A14-14: year validation', () => {
  const validShow = makeShowWithWatchedEpsInYear(1, 'A', 2023, 3);

  it('returns empty stats for NaN year', () => {
    const stats = computeYearStats([validShow], NaN);
    expect(stats.totalEpisodes).toBe(0);
    expect(stats.topShows).toEqual([]);
    expect(stats.dominantGenre).toBe('N/D');
    expect(stats.longestSeason).toBeNull();
  });

  it('returns empty stats for year=0', () => {
    expect(computeYearStats([validShow], 0).totalEpisodes).toBe(0);
  });

  it('returns empty stats for negative year', () => {
    expect(computeYearStats([validShow], -5).totalEpisodes).toBe(0);
  });

  it('returns empty stats for non-integer year', () => {
    expect(computeYearStats([validShow], 2023.5).totalEpisodes).toBe(0);
  });

  it('returns empty stats for year too far in past (< 1900)', () => {
    expect(computeYearStats([validShow], 1800).totalEpisodes).toBe(0);
  });

  it('returns empty stats for year too far in future (>= 3000)', () => {
    expect(computeYearStats([validShow], 3000).totalEpisodes).toBe(0);
  });

  it('returns empty stats for year = Infinity', () => {
    expect(computeYearStats([validShow], Infinity).totalEpisodes).toBe(0);
  });

  it('returns empty stats for year = string', () => {
    expect(computeYearStats([validShow], '2023' as unknown as number).totalEpisodes).toBe(0);
  });

  it('preserves original year value in returned stats (even if invalid)', () => {
    const stats = computeYearStats([validShow], NaN);
    expect(stats.year).toBe(NaN);
    // Note: year is echoed back as-is; only computation is skipped.
  });
});

// ===== computeYearStats: happy path + top 5 / longest season =====

describe('computeYearStats: happy path', () => {
  it('computes top 5 correctly (sorted desc by watched)', () => {
    const shows = [
      makeShowWithWatchedEpsInYear(1, 'A', 2023, 10),
      makeShowWithWatchedEpsInYear(2, 'B', 2023, 8),
      makeShowWithWatchedEpsInYear(3, 'C', 2023, 6),
      makeShowWithWatchedEpsInYear(4, 'D', 2023, 4),
      makeShowWithWatchedEpsInYear(5, 'E', 2023, 2),
      makeShowWithWatchedEpsInYear(6, 'F', 2023, 1),
    ];
    const stats = computeYearStats(shows, 2023);
    expect(stats.topShows).toHaveLength(5);
    expect(stats.topShows[0].showName).toBe('A');
    expect(stats.topShows[0].watched).toBe(10);
    expect(stats.topShows[4].showName).toBe('E');
    expect(stats.topShows.find((s) => s.showName === 'F')).toBeUndefined();
  });

  it('handles less than 5 series (no padding)', () => {
    const stats = computeYearStats([makeShowWithWatchedEpsInYear(1, 'A', 2023, 3)], 2023);
    expect(stats.topShows).toHaveLength(1);
  });

  it('handles 0 series', () => {
    const stats = computeYearStats([], 2023);
    expect(stats.totalEpisodes).toBe(0);
    expect(stats.topShows).toEqual([]);
    expect(stats.dominantGenre).toBe('N/D');
    expect(stats.longestSeason).toBeNull();
  });

  it('handles 0 episodes watched in selected year', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2022, 3);
    const stats = computeYearStats([show], 2023);
    expect(stats.totalEpisodes).toBe(0);
  });

  it('computes dominantGenre by episode count (not show count)', () => {
    const shows = [
      makeShowWithWatchedEpsInYear(1, 'A', 2023, 10, { genres: ['Drama'] }),
      makeShowWithWatchedEpsInYear(2, 'B', 2023, 2, { genres: ['Comedy'] }),
    ];
    expect(computeYearStats(shows, 2023).dominantGenre).toBe('Drama');
  });

  it('computes longestSeason by episodes watched in year', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 5);
    // Add season 2 with more watched eps in 2023
    show.seasons[2] = [];
    for (let i = 1; i <= 8; i++) {
      show.seasons[2].push(
        makeEpisode({ num: i, id: 2000 + i, watched: true, airdate: '2023-03-01', runtime: 45 }),
      );
    }
    const stats = computeYearStats([show], 2023);
    expect(stats.longestSeason).not.toBeNull();
    expect(stats.longestSeason!.showName).toBe('A');
    expect(stats.longestSeason!.season).toBe(2);
    expect(stats.longestSeason!.episodes).toBe(8);
  });

  it('handles null shows array', () => {
    expect(() => computeYearStats(null as unknown as Show[], 2023)).not.toThrow();
    expect(computeYearStats(null as unknown as Show[], 2023).totalEpisodes).toBe(0);
  });

  it('handles show with null name (falls back to N/D)', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2);
    show.name = null as unknown as string;
    const stats = computeYearStats([show], 2023);
    expect(stats.topShows[0].showName).toBe('N/D');
    expect(stats.longestSeason!.showName).toBe('N/D');
  });

  it('handles show with non-number id (falls back to 0)', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2);
    show.id = 'abc' as unknown as number;
    const stats = computeYearStats([show], 2023);
    expect(stats.topShows[0].showId).toBe(0);
  });

  it('handles show with non-string image (falls back to null)', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2);
    show.image = 123 as unknown as string;
    const stats = computeYearStats([show], 2023);
    expect(stats.topShows[0].image).toBeNull();
  });

  it('ignores episodes in season 0', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        0: [makeEpisode({ num: 1, id: 10, watched: true, airdate: '2023-01-01', runtime: 45 })],
        1: [makeEpisode({ num: 1, id: 11, watched: true, airdate: '2023-02-01', runtime: 45 })],
      },
    });
    const stats = computeYearStats([show], 2023);
    expect(stats.totalEpisodes).toBe(1); // only season 1
  });

  it('ignores non-integer season keys (e.g. "1.5")', () => {
    const show = makeShow({
      id: 1,
      name: 'A',
      seasons: {
        '1.5': [makeEpisode({ num: 1, id: 10, watched: true, airdate: '2023-01-01', runtime: 45 })],
        1: [makeEpisode({ num: 1, id: 11, watched: true, airdate: '2023-02-01', runtime: 45 })],
      },
    });
    const stats = computeYearStats([show], 2023);
    expect(stats.totalEpisodes).toBe(1);
  });
});

// ===== exportYearCard: BUG-A14-05 (showName null/undefined in canvas) =====

function makeStats(over: Partial<YearStats> = {}): YearStats {
  return {
    year: 2023,
    totalEpisodes: 10,
    totalMinutes: 450,
    topShows: [{ showId: 1, showName: 'Test Show', image: null, watched: 10 }],
    dominantGenre: 'Drama',
    longestSeason: { showName: 'Test Show', season: 1, episodes: 10 },
    ...over,
  };
}

describe('BUG-A14-05: showName null/undefined in canvas', () => {
  it('does not throw when showName is null', () => {
    const stats = makeStats({
      topShows: [{ showId: 1, showName: null as unknown as string, image: null, watched: 5 }],
    });
    expect(() => exportYearCard(stats)).not.toThrow();
  });

  it('does not throw when showName is undefined', () => {
    const stats = makeStats({
      topShows: [{ showId: 1, showName: undefined as unknown as string, image: null, watched: 5 }],
    });
    expect(() => exportYearCard(stats)).not.toThrow();
  });

  it('does not throw when showName is a number', () => {
    const stats = makeStats({
      topShows: [{ showId: 1, showName: 42 as unknown as string, image: null, watched: 5 }],
    });
    expect(() => exportYearCard(stats)).not.toThrow();
  });

  it('truncates long show names without throwing', () => {
    const stats = makeStats({
      topShows: [{ showId: 1, showName: 'A'.repeat(100), image: null, watched: 5 }],
    });
    expect(() => exportYearCard(stats)).not.toThrow();
  });
});

// ===== exportYearCard: BUG-A14-06 (toBlob SecurityError / tainted canvas) =====

describe('BUG-A14-06: toBlob SecurityError (tainted canvas)', () => {
  it('shows error toast when toBlob throws synchronously', () => {
    _toBlobBehavior = 'throw';
    exportYearCard(makeStats());
    expect(toastHasError()).toBe(true);
    expect(toastText()).toContain('Errore export');
  });

  it('does not throw uncaught when toBlob throws', () => {
    _toBlobBehavior = 'throw';
    expect(() => exportYearCard(makeStats())).not.toThrow();
  });

  it('shows error toast when toBlob calls callback with null', () => {
    _toBlobBehavior = 'null';
    exportYearCard(makeStats());
    expect(toastHasError()).toBe(true);
  });

  it('does not show success toast when toBlob throws', () => {
    _toBlobBehavior = 'throw';
    exportYearCard(makeStats());
    expect(toastHasSuccess()).toBe(false);
  });

  it('calls console.error when toBlob throws (for debugging)', () => {
    _toBlobBehavior = 'throw';
    exportYearCard(makeStats());
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

// ===== exportYearCard: BUG-A14-07 (revokeObjectURL always called) =====

describe('BUG-A14-07: revokeObjectURL always called (leak prevention)', () => {
  it('revokes blob URL on successful download', () => {
    _toBlobBehavior = 'success';
    exportYearCard(makeStats());
    expect(revokeObjectURLSpy).toHaveBeenCalled();
  });

  it('revokes blob URL even when a.click() throws', () => {
    _toBlobBehavior = 'success';
    clickSpy.mockImplementation(() => {
      throw new Error('click failed');
    });
    exportYearCard(makeStats());
    expect(revokeObjectURLSpy).toHaveBeenCalled();
    expect(toastHasError()).toBe(true);
  });

  it('does not show success toast when click() throws', () => {
    _toBlobBehavior = 'success';
    clickSpy.mockImplementation(() => {
      throw new Error('click failed');
    });
    exportYearCard(makeStats());
    expect(toastHasSuccess()).toBe(false);
  });

  it('does not revoke when blob is null (no URL created)', () => {
    _toBlobBehavior = 'null';
    exportYearCard(makeStats());
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
  });
});

// ===== exportYearCard: BUG-A14-08 (toBlob / getContext not available) =====

describe('BUG-A14-08: canvas methods not available', () => {
  it('shows error toast when getContext returns null', () => {
    setupCanvasMock(false);
    exportYearCard(makeStats());
    expect(toastHasError()).toBe(true);
    expect(toastText()).toContain('Canvas non supportato');
  });

  it('shows error toast when toBlob is not a function', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).toBlob = undefined;
    exportYearCard(makeStats());
    expect(toastHasError()).toBe(true);
    expect(toastText()).toContain('Canvas non supportato');
  });
});

// ===== exportYearCard: BUG-A14-09 (filename year sanitization) =====

describe('BUG-A14-09: filename year sanitization', () => {
  function captureAnchorDownload(): {
    createSpy: MockInstance;
    getDownload: () => string | undefined;
  } {
    const createdAnchors: HTMLAnchorElement[] = [];
    const origCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') createdAnchors.push(el as HTMLAnchorElement);
      return el;
    });
    return { createSpy, getDownload: () => createdAnchors[0]?.download };
  }

  it('uses valid year in filename', () => {
    _toBlobBehavior = 'success';
    const { createSpy, getDownload } = captureAnchorDownload();
    exportYearCard(makeStats({ year: 2023 }));
    createSpy.mockRestore();
    expect(getDownload()).toBe('ploppytv-2023.png');
  });

  it('uses "export" fallback when year is NaN', () => {
    _toBlobBehavior = 'success';
    const { createSpy, getDownload } = captureAnchorDownload();
    exportYearCard(makeStats({ year: NaN }));
    createSpy.mockRestore();
    expect(getDownload()).toBe('ploppytv-export.png');
  });

  it('uses "export" fallback when year is 0', () => {
    _toBlobBehavior = 'success';
    const { createSpy, getDownload } = captureAnchorDownload();
    exportYearCard(makeStats({ year: 0 }));
    createSpy.mockRestore();
    expect(getDownload()).toBe('ploppytv-export.png');
  });

  it('uses "export" fallback when year is negative', () => {
    _toBlobBehavior = 'success';
    const { createSpy, getDownload } = captureAnchorDownload();
    exportYearCard(makeStats({ year: -5 }));
    createSpy.mockRestore();
    expect(getDownload()).toBe('ploppytv-export.png');
  });

  it('uses "export" fallback when year is non-integer', () => {
    _toBlobBehavior = 'success';
    const { createSpy, getDownload } = captureAnchorDownload();
    exportYearCard(makeStats({ year: 2023.5 }));
    createSpy.mockRestore();
    expect(getDownload()).toBe('ploppytv-export.png');
  });
});

// ===== exportYearCard: happy path =====

describe('exportYearCard: happy path', () => {
  it('triggers download and shows success toast', () => {
    _toBlobBehavior = 'success';
    exportYearCard(makeStats());
    expect(clickSpy).toHaveBeenCalled();
    expect(createObjectURLSpy).toHaveBeenCalled();
    expect(toastHasSuccess()).toBe(true);
  });

  it('does not call click when toBlob returns null', () => {
    _toBlobBehavior = 'null';
    exportYearCard(makeStats());
    expect(clickSpy).not.toHaveBeenCalled();
  });
});

// ===== renderYearReview: edge cases + XSS =====

describe('renderYearReview: edge cases', () => {
  it('renders empty state when no shows', () => {
    setShows([]);
    const main = document.createElement('div');
    expect(() => renderYearReview(main)).not.toThrow();
    expect(main.innerHTML).toContain('empty-state');
  });

  it('renders empty state when no watched episodes', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 0);
    setShows([show]);
    const main = document.createElement('div');
    renderYearReview(main);
    expect(main.innerHTML).toContain('empty-state');
  });

  it('does not throw when state.shows is null (defense-in-depth)', () => {
    // setShows(null) would be rejected by store, but test direct null
    // by temporarily breaking state via setState
    // Actually, store's setShows guards against null. So we test the
    // renderYearReview guard by passing shows with null seasons.
    const show = makeShow({ id: 1, name: 'A', seasons: null as unknown as Record<number, Episode[]> });
    setShows([show]);
    const main = document.createElement('div');
    expect(() => renderYearReview(main)).not.toThrow();
  });

  it('does not throw when show.seasons is undefined', () => {
    const show = makeShow({ id: 1, name: 'A' });
    // @ts-expect-error intentionally malformed
    show.seasons = undefined;
    setShows([show]);
    const main = document.createElement('div');
    expect(() => renderYearReview(main)).not.toThrow();
  });

  it('does not throw when show.seasons is an array', () => {
    const show = makeShow({ id: 1, name: 'A', seasons: [] as unknown as Record<number, Episode[]> });
    setShows([show]);
    const main = document.createElement('div');
    expect(() => renderYearReview(main)).not.toThrow();
  });

  it('renders stats grid when data available', () => {
    setShows([makeShowWithWatchedEpsInYear(1, 'Test Show', 2023, 5)]);
    const main = document.createElement('div');
    renderYearReview(main);
    expect(main.innerHTML).toContain('year-stats-grid');
    expect(main.innerHTML).toContain('Test Show');
  });

  it('renders year selector buttons', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2);
    show.seasons[2] = [makeEpisode({ num: 1, id: 2001, watched: true, airdate: '2022-01-01', runtime: 45 })];
    setShows([show]);
    const main = document.createElement('div');
    renderYearReview(main);
    expect(main.querySelectorAll('.year-btn').length).toBeGreaterThanOrEqual(2);
  });
});

describe('renderYearReview: XSS defense', () => {
  it('escapes showName in HTML (no <script> injection)', () => {
    const show = makeShowWithWatchedEpsInYear(1, '<script>alert(1)</script>', 2023, 2);
    setShows([show]);
    const main = document.createElement('div');
    renderYearReview(main);
    expect(main.innerHTML).not.toContain('<script>alert(1)</script>');
    expect(main.innerHTML).toContain('&lt;script&gt;');
  });

  it('escapes dominantGenre in HTML (no <img onerror> injection)', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2, {
      genres: ['<img src=x onerror=alert(1)>'],
    });
    setShows([show]);
    const main = document.createElement('div');
    renderYearReview(main);
    expect(main.innerHTML).not.toContain('<img src=x onerror=alert(1)>');
    expect(main.innerHTML).toContain('&lt;img');
  });

  it('escapes showName with quotes (no attribute breakout)', () => {
    // showName with quotes — should not break out of any attribute
    const show = makeShowWithWatchedEpsInYear(1, 'A"onclick="alert(1)', 2023, 2);
    setShows([show]);
    const main = document.createElement('div');
    renderYearReview(main);
    // No element should have an onclick attribute injected via showName
    expect(main.querySelector('[onclick]')).toBeNull();
    // The showName text should be preserved (decoded) in the visible text node
    const nameEl = main.querySelector('.year-top-name');
    expect(nameEl?.textContent).toContain('A"onclick');
  });
});

describe('renderYearReview: year button click (BUG-A14-11)', () => {
  it('changes selected year on valid button click', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2);
    show.seasons[2] = [makeEpisode({ num: 1, id: 2001, watched: true, airdate: '2022-01-01', runtime: 45 })];
    setShows([show]);
    const main = document.createElement('div');
    document.body.appendChild(main);
    renderYearReview(main);

    const buttons = main.querySelectorAll('.year-btn');
    expect(buttons.length).toBe(2);
    // Click the non-active button
    const inactiveBtn = Array.from(buttons).find((b) => !b.classList.contains('active')) as HTMLElement;
    const targetYear = inactiveBtn.dataset.year;
    inactiveBtn.click();

    const activeBtn = main.querySelector('.year-btn.active') as HTMLElement;
    expect(activeBtn.dataset.year).toBe(targetYear);
    main.remove();
  });

  it('ignores click on button with invalid data-year (DOM tampered)', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2);
    setShows([show]);
    const main = document.createElement('div');
    document.body.appendChild(main);
    renderYearReview(main);

    // Tamper with the button's data-year
    const btn = main.querySelector('.year-btn') as HTMLElement;
    btn.dataset.year = 'abc';
    const activeBefore = main.querySelector('.year-btn.active') as HTMLElement;
    const yearBefore = activeBefore.dataset.year;
    btn.click();
    const activeAfter = main.querySelector('.year-btn.active') as HTMLElement;
    expect(activeAfter.dataset.year).toBe(yearBefore); // unchanged
    main.remove();
  });

  it('ignores click on button with year=0 (DOM tampered, no re-render)', () => {
    const show = makeShowWithWatchedEpsInYear(1, 'A', 2023, 2);
    setShows([show]);
    const main = document.createElement('div');
    document.body.appendChild(main);
    renderYearReview(main);

    const btnBefore = main.querySelector('.year-btn') as HTMLElement;
    btnBefore.dataset.year = '0';
    btnBefore.click();
    // Fix: click ignored (0 is not > 1900) → no re-render → same element reference
    const btnAfter = main.querySelector('.year-btn');
    expect(btnAfter).toBe(btnBefore);
    // Page title should still reference 2023 (not re-rendered with year 0)
    const title = main.querySelector('.page-title');
    expect(title?.textContent).toContain('2023');
    main.remove();
  });
});

describe('renderYearReview: share button', () => {
  it('share button triggers exportYearCard and shows success toast', () => {
    _toBlobBehavior = 'success';
    setShows([makeShowWithWatchedEpsInYear(1, 'A', 2023, 2)]);
    const main = document.createElement('div');
    document.body.appendChild(main);
    renderYearReview(main);

    const shareBtn = main.querySelector('#yearShareBtn') as HTMLButtonElement;
    expect(shareBtn).toBeTruthy();
    shareBtn.click();
    expect(toastHasSuccess()).toBe(true);
    main.remove();
  });

  it('share button shows error toast when canvas fails', () => {
    _toBlobBehavior = 'throw';
    setShows([makeShowWithWatchedEpsInYear(1, 'A', 2023, 2)]);
    const main = document.createElement('div');
    document.body.appendChild(main);
    renderYearReview(main);

    const shareBtn = main.querySelector('#yearShareBtn') as HTMLButtonElement;
    shareBtn.click();
    expect(toastHasError()).toBe(true);
    main.remove();
  });
});
