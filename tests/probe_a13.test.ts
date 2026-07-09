// Agent A13 probe: race conditions, XSS, NaN edge cases in calendar.ts and stats.ts
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_a13.test.ts
//
// Strategy:
//  - Mock '../src/worker/client' so we can inject arbitrary results (incl. malformed).
//  - Use the REAL store (not mocked) so we can change currentView/currentShowId
//    and verify the cross-view race protection (BUG-A13-01).
//  - jsdom provides a real DOM; main.innerHTML rendering is exercised end-to-end.
//  - vi.useFakeTimers + vi.setSystemTime so `new Date()` in renderCalendarContent
//    is deterministic (used for isToday highlight).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CalendarEpisode, StatsResult } from '../src/types';

// ===== Mocks (hoisted by vitest) =====

vi.mock('../src/worker/client', () => ({
  computeCalendarAsync: vi.fn(),
  computeStatsAsync: vi.fn(),
}));

import { computeCalendarAsync, computeStatsAsync } from '../src/worker/client';
import { renderCalendar, bindCalendarEvents, resetBoundGuard } from '../src/views/calendar';
import { renderStats } from '../src/views/stats';
import { getState, setState } from '../src/lib/store';

// ===== Helpers =====

function makeMain(): HTMLElement {
  document.body.innerHTML = '<main id="mainContent"></main>';
  return document.getElementById('mainContent') as HTMLElement;
}

function makeCalEp(over: Partial<CalendarEpisode> = {}): CalendarEpisode {
  return {
    showId: 1,
    showName: 'Test Show',
    totalEpisodes: 10,
    watchedCount: 0,
    season: 1,
    num: 1,
    name: 'Pilot',
    date: '2024-03-11',
    ...over,
  };
}

function makeStats(over: Partial<StatsResult> = {}): StatsResult {
  return {
    totalShows: 1,
    totalWatched: 0,
    totalEpisodes: 0,
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
    ...over,
  };
}

function mockCal(opts: {
  week?: CalendarEpisode[];
  afterWeek?: CalendarEpisode[];
  weekStart?: string;
  weekEnd?: string;
} = {}) {
  vi.mocked(computeCalendarAsync).mockResolvedValue({
    week: opts.week ?? [],
    afterWeek: opts.afterWeek ?? [],
    weekStart: opts.weekStart ?? '2024-03-11', // Monday
    weekEnd: opts.weekEnd ?? '2024-03-17', // Sunday
  });
}

function statValues(main: HTMLElement): string[] {
  return Array.from(main.querySelectorAll<HTMLElement>('.stat-card .stat-value')).map(
    (el) => el.textContent ?? '',
  );
}

function progressBar(main: HTMLElement): HTMLElement {
  return main.querySelector('.section > div > div') as HTMLElement;
}

function generiSection(main: HTMLElement): HTMLElement {
  return main.querySelectorAll<HTMLElement>('.section')[1];
}

function generiBars(main: HTMLElement): HTMLElement[] {
  return Array.from(
    generiSection(main).querySelectorAll<HTMLDivElement>('div[style*="height:8px"] > div'),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // Wednesday 2024-03-13 (weekStart=Mon 2024-03-11, weekEnd=Sun 2024-03-17)
  vi.setSystemTime(new Date('2024-03-13T10:00:00'));
  // Reset store state — use the REAL store (not mocked) so we can change
  // currentView/currentShowId to test the cross-view race protection.
  setState({
    shows: [],
    currentView: 'calendar',
    currentShowId: null,
    currentSeason: 1,
    calendarWeekOffset: 0,
    _storageDisabled: false,
    _quotaWarned: false,
    _discoverTab: 'popular',
    _localDirty: false,
  });
  vi.mocked(computeCalendarAsync).mockReset();
  vi.mocked(computeStatsAsync).mockReset();
  mockCal();
  vi.mocked(computeStatsAsync).mockResolvedValue(makeStats());
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// BUG-A13-01: Stale render race across view switches
// ============================================================

describe('BUG-A13-01: stale render race across view switches', () => {
  it('calendar: worker resolves AFTER user switched to stats → calendar does NOT overwrite stats', async () => {
    const main = makeMain();
    setState({ currentView: 'calendar' });

    let resolveCal!: (v: {
      week: CalendarEpisode[];
      afterWeek: CalendarEpisode[];
      weekStart: string;
      weekEnd: string;
    }) => void;
    vi.mocked(computeCalendarAsync).mockReturnValueOnce(
      new Promise((r) => {
        resolveCal = r as typeof resolveCal;
      }),
    );

    // Start calendar render (skeleton shown, worker pending)
    const calPromise = renderCalendar(main);
    expect(main.innerHTML).toContain('Calcolando episodi');

    // User switches to stats (currentView changes synchronously)
    setState({ currentView: 'stats' });

    // Render stats (mocked to resolve immediately)
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(makeStats({ totalShows: 5 }));
    await renderStats(main);
    expect(main.innerHTML).toContain('Statistiche');
    expect(main.querySelector('.stats-grid')).not.toBeNull();
    expect(statValues(main)[0]).toBe('5'); // totalShows card

    // Now the calendar worker resolves (late) — before the FIX this would
    // overwrite the stats content with calendar HTML.
    resolveCal({
      week: [makeCalEp({ showName: 'STALE_CALENDAR_CONTENT' })],
      afterWeek: [],
      weekStart: '2024-03-11',
      weekEnd: '2024-03-17',
    });
    await calPromise;

    // FIX: calendar should NOT have overwritten stats content
    expect(main.innerHTML).not.toContain('STALE_CALENDAR_CONTENT');
    expect(main.querySelector('.stats-grid')).not.toBeNull();
    expect(main.innerHTML).not.toContain('Calcolando episodi');
    expect(main.innerHTML).toContain('5'); // stats still visible
  });

  it('stats: worker resolves AFTER user switched to calendar → stats does NOT overwrite calendar', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });

    let resolveStats!: (v: StatsResult) => void;
    vi.mocked(computeStatsAsync).mockReturnValueOnce(
      new Promise((r) => {
        resolveStats = r as typeof resolveStats;
      }),
    );

    // Start stats render (skeleton shown, worker pending)
    const statsPromise = renderStats(main);
    expect(main.innerHTML).toContain('Calcolando statistiche');

    // User switches to calendar (currentView changes synchronously)
    setState({ currentView: 'calendar' });

    // Render calendar (mocked to resolve immediately)
    vi.mocked(computeCalendarAsync).mockResolvedValueOnce({
      week: [makeCalEp({ showName: 'CALENDAR_CONTENT' })],
      afterWeek: [],
      weekStart: '2024-03-11',
      weekEnd: '2024-03-17',
    });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('CALENDAR_CONTENT');
    expect(main.querySelector('.calendar-grid')).not.toBeNull();

    // Now the stats worker resolves (late) — before the FIX this would
    // overwrite the calendar content with stats HTML.
    resolveStats(makeStats({ totalShows: 999 }));
    await statsPromise;

    // FIX: stats should NOT have overwritten calendar content
    expect(main.innerHTML).not.toContain('999');
    expect(main.querySelector('.calendar-grid')).not.toBeNull();
    expect(main.innerHTML).toContain('CALENDAR_CONTENT');
  });

  it('calendar: worker resolves AFTER user opened a show detail → no overwrite', async () => {
    const main = makeMain();
    setState({ currentView: 'calendar' });

    let resolveCal!: (v: {
      week: CalendarEpisode[];
      afterWeek: CalendarEpisode[];
      weekStart: string;
      weekEnd: string;
    }) => void;
    vi.mocked(computeCalendarAsync).mockReturnValueOnce(
      new Promise((r) => {
        resolveCal = r as typeof resolveCal;
      }),
    );

    const calPromise = renderCalendar(main);

    // User opens a show detail (currentShowId set, currentView unchanged)
    setState({ currentShowId: 42 });

    // Simulate show detail rendering (just put some content in main)
    main.innerHTML = '<div class="show-detail">Show Detail Content</div>';

    // Calendar worker resolves late
    resolveCal({
      week: [makeCalEp({ showName: 'STALE_CALENDAR' })],
      afterWeek: [],
      weekStart: '2024-03-11',
      weekEnd: '2024-03-17',
    });
    await calPromise;

    // FIX: calendar should NOT have overwritten show detail
    expect(main.innerHTML).not.toContain('STALE_CALENDAR');
    expect(main.innerHTML).toContain('Show Detail Content');
  });

  it('stats: worker resolves AFTER user opened a show detail → no overwrite', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });

    let resolveStats!: (v: StatsResult) => void;
    vi.mocked(computeStatsAsync).mockReturnValueOnce(
      new Promise((r) => {
        resolveStats = r as typeof resolveStats;
      }),
    );

    const statsPromise = renderStats(main);

    // User opens a show detail
    setState({ currentShowId: 42 });
    main.innerHTML = '<div class="show-detail">Show Detail Content</div>';

    // Stats worker resolves late
    resolveStats(makeStats({ totalShows: 999 }));
    await statsPromise;

    expect(main.innerHTML).not.toContain('999');
    expect(main.innerHTML).toContain('Show Detail Content');
  });

  it('calendar: same-view re-render still works (token check, BUG-16-06 regression)', async () => {
    // Verify that the currentView check doesn't break the existing token-based race fix
    const main = makeMain();
    setState({ currentView: 'calendar' });

    let r1!: () => void;
    let r2!: () => void;
    vi.mocked(computeCalendarAsync)
      .mockReturnValueOnce(
        new Promise((r) => {
          r1 = () =>
            r({
              week: [makeCalEp({ showName: 'First' })],
              afterWeek: [],
              weekStart: '2024-03-11',
              weekEnd: '2024-03-17',
            });
        }),
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          r2 = () =>
            r({
              week: [makeCalEp({ showName: 'Second' })],
              afterWeek: [],
              weekStart: '2024-03-11',
              weekEnd: '2024-03-17',
            });
        }),
      );

    const p1 = renderCalendar(main);
    const p2 = renderCalendar(main);
    r1();
    r2();
    await Promise.all([p1, p2]);
    expect(main.innerHTML).toContain('Second');
    expect(main.innerHTML).not.toContain('First');
  });

  it('stats: same-view re-render still works (token check, BUG-17-02 regression)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });

    let r1!: (v: StatsResult) => void;
    let r2!: (v: StatsResult) => void;
    vi.mocked(computeStatsAsync)
      .mockReturnValueOnce(
        new Promise((r) => {
          r1 = r;
        }),
      )
      .mockReturnValueOnce(
        new Promise((r) => {
          r2 = r;
        }),
      );

    const p1 = renderStats(main);
    const p2 = renderStats(main);
    r1(makeStats({ totalShows: 111 }));
    r2(makeStats({ totalShows: 222 }));
    await Promise.all([p1, p2]);
    expect(main.innerHTML).toContain('222');
    expect(main.innerHTML).not.toContain('111');
  });

  it('calendar: return-to-calendar after a stale render works correctly', async () => {
    // User on calendar → switches to stats → switches back to calendar.
    // The first calendar render (pending) should be discarded (cross-view race).
    // The second calendar render (fresh) should render normally.
    const main = makeMain();
    setState({ currentView: 'calendar' });

    let resolveFirst!: (v: {
      week: CalendarEpisode[];
      afterWeek: CalendarEpisode[];
      weekStart: string;
      weekEnd: string;
    }) => void;
    vi.mocked(computeCalendarAsync).mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r as typeof resolveFirst;
      }),
    );

    // First calendar render — pending
    const p1 = renderCalendar(main);

    // Switch to stats
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(makeStats({ totalShows: 7 }));
    await renderStats(main);
    expect(main.innerHTML).toContain('7');

    // Switch back to calendar
    setState({ currentView: 'calendar' });
    vi.mocked(computeCalendarAsync).mockResolvedValueOnce({
      week: [makeCalEp({ showName: 'FRESH_CALENDAR' })],
      afterWeek: [],
      weekStart: '2024-03-11',
      weekEnd: '2024-03-17',
    });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('FRESH_CALENDAR');

    // Now first calendar's worker resolves (stale) — should NOT overwrite
    resolveFirst({
      week: [makeCalEp({ showName: 'STALE_FIRST' })],
      afterWeek: [],
      weekStart: '2024-03-11',
      weekEnd: '2024-03-17',
    });
    await p1;

    // FIX: stale first render discarded (cross-view race + token check)
    expect(main.innerHTML).not.toContain('STALE_FIRST');
    expect(main.innerHTML).toContain('FRESH_CALENDAR');
  });

  it('stats: error path also respects cross-view race (no error UI after view switch)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });

    let rejectStats!: (e: Error) => void;
    vi.mocked(computeStatsAsync).mockReturnValueOnce(
      new Promise((_res, rej) => {
        rejectStats = rej;
      }),
    );

    const statsPromise = renderStats(main);
    expect(main.innerHTML).toContain('Calcolando statistiche');

    // User switches to calendar before the rejection fires
    setState({ currentView: 'calendar' });
    vi.mocked(computeCalendarAsync).mockResolvedValueOnce({
      week: [makeCalEp({ showName: 'CAL' })],
      afterWeek: [],
      weekStart: '2024-03-11',
      weekEnd: '2024-03-17',
    });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('CAL');

    // Now stats rejects — before the FIX, the error UI would overwrite the calendar
    rejectStats(new Error('late boom'));
    await statsPromise;

    // FIX: stats error path respects cross-view race — calendar content preserved
    expect(main.innerHTML).not.toContain('Errore caricamento');
    expect(main.innerHTML).toContain('CAL');
  });
});

// ============================================================
// BUG-A13-02: XSS via data-show-id attribute (calendar)
// ============================================================

describe('BUG-A13-02: XSS via data-show-id attribute', () => {
  it('calendar grid: showId as malicious string → attribute escaped (no XSS)', async () => {
    const main = makeMain();
    const evil = '42" onclick="alert(1)';
    mockCal({ week: [makeCalEp({ showId: evil as unknown as number })] });
    await renderCalendar(main);
    const ep = main.querySelector('.calendar-episode') as HTMLElement;
    expect(ep).not.toBeNull();
    // The data-show-id attribute should be escaped — no onclick attribute injected
    expect(ep.getAttribute('onclick')).toBeNull();
    // The dataset.showId reflects the escaped value
    expect(ep.dataset.showId).toBe(evil);
    // No alert(1) as a live attribute
    expect(main.innerHTML).not.toContain('onclick="alert(1)"');
  });

  it('calendar "In arrivo": showId as malicious string → attribute escaped', async () => {
    const main = makeMain();
    const evil = '42" onclick="alert(1)';
    mockCal({ afterWeek: [makeCalEp({ showId: evil as unknown as number })] });
    await renderCalendar(main);
    const item = main.querySelector('.episode-item') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.getAttribute('onclick')).toBeNull();
  });

  it('calendar "Da vedere": showId as malicious string → attribute escaped', async () => {
    const main = makeMain();
    const evil = '42" onclick="alert(1)';
    mockCal({ week: [makeCalEp({ showId: evil as unknown as number })] });
    await renderCalendar(main);
    // The "Da vedere" list also has episode-item elements
    const items = main.querySelectorAll('.episode-item');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.getAttribute('onclick')).toBeNull();
    }
  });

  it('calendar: normal numeric showId still works (regression)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ showId: 42 })] });
    await renderCalendar(main);
    const ep = main.querySelector('.calendar-episode') as HTMLElement;
    expect(ep.dataset.showId).toBe('42');
  });

  it('stats topShows: showId as malicious string → attribute escaped (BUG-A13-02 in stats)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    const evil = '42" onclick="alert(1)';
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: evil as unknown as number,
            showName: 'A',
            image: null,
            watched: 1,
            totalEpisodes: 1,
            pct: 100,
          },
        ],
      }),
    );
    await renderStats(main);
    const item = main.querySelector('.episode-item') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.getAttribute('onclick')).toBeNull();
    expect(item.dataset.showId).toBe(evil);
  });
});

// ============================================================
// BUG-A13-03: NaN/Infinity handling in stats
// ============================================================

describe('BUG-A13-03: NaN/Infinity handling in stats', () => {
  it('totalProgress=NaN → falls back to 0% (not "NaN%")', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({ totalShows: 1, totalProgress: NaN }),
    );
    await renderStats(main);
    const card = main.querySelectorAll('.stat-card .stat-value')[6];
    expect(card.textContent).toBe('0%');
    const bar = progressBar(main);
    expect(bar.getAttribute('style') ?? '').toContain('width:0%');
  });

  it('totalProgress=undefined → falls back to 0% (not "undefined%")', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({ totalShows: 1, totalProgress: undefined as unknown as number }),
    );
    await renderStats(main);
    const card = main.querySelectorAll('.stat-card .stat-value')[6];
    expect(card.textContent).toBe('0%');
  });

  it('totalProgress=Infinity → clamped to 100% (not "Infinity%")', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({ totalShows: 1, totalProgress: Infinity }),
    );
    await renderStats(main);
    const card = main.querySelectorAll('.stat-card .stat-value')[6];
    expect(card.textContent).toBe('100%');
    const bar = progressBar(main);
    expect(bar.getAttribute('style') ?? '').toContain('width:100%');
    expect(bar.getAttribute('style') ?? '').toContain('var(--success');
  });

  it('totalProgress=-Infinity → clamped to 0%', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({ totalShows: 1, totalProgress: -Infinity }),
    );
    await renderStats(main);
    const card = main.querySelectorAll('.stat-card .stat-value')[6];
    expect(card.textContent).toBe('0%');
  });

  it('topShows item.pct=NaN → falls back to 0% (not "NaN%")', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: 'A',
            image: null,
            watched: 5,
            totalEpisodes: 10,
            pct: NaN,
          },
        ],
      }),
    );
    await renderStats(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toBe('5/10 episodi • 0%');
  });

  it('topShows item.pct=Infinity → clamped to 100%', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: 'A',
            image: null,
            watched: 5,
            totalEpisodes: 10,
            pct: Infinity,
          },
        ],
      }),
    );
    await renderStats(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toBe('5/10 episodi • 100%');
  });

  it('topShows item.watched=NaN, totalEpisodes=NaN → "0/0" (not "NaN/NaN")', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: 'A',
            image: null,
            watched: NaN,
            totalEpisodes: NaN,
            pct: 50,
          },
        ],
      }),
    );
    await renderStats(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toBe('0/0 episodi • 50%');
  });

  it('topShows item.watched=negative → coerced to 0', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: 'A',
            image: null,
            watched: -5,
            totalEpisodes: 10,
            pct: 50,
          },
        ],
      }),
    );
    await renderStats(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toBe('0/10 episodi • 50%');
  });

  it('genre episodes=NaN → coerced to 0 → "Nessun dato" (not "NaN ep")', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topGenres: [{ genre: 'Drama', episodes: NaN, shows: 2 }],
      }),
    );
    await renderStats(main);
    const section = generiSection(main);
    // NaN coerced to 0 → every() check returns true → "Nessun dato" message.
    // This is the CORRECT behavior: NaN episodes means no real data to show.
    expect(section.textContent).toContain('Nessun dato');
    expect(section.textContent).not.toContain('NaN');
    expect(generiBars(main)).toHaveLength(0);
  });

  it('genre shows=NaN → "0 serie" (not "NaN serie")', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topGenres: [{ genre: 'Drama', episodes: 5, shows: NaN }],
      }),
    );
    await renderStats(main);
    const section = generiSection(main);
    expect(section.textContent).toContain('0 serie');
    expect(section.textContent).not.toContain('NaN');
  });

  it('genre episodes=Infinity → coerced to 0 → "Nessun dato" (no Infinity in display)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topGenres: [{ genre: 'Drama', episodes: Infinity, shows: 2 }],
      }),
    );
    await renderStats(main);
    const section = generiSection(main);
    // Infinity coerced to 0 (non-finite) → every() check → "Nessun dato".
    expect(section.textContent).toContain('Nessun dato');
    expect(section.textContent).not.toContain('Infinity');
  });

  it('genre episodes=NaN mixed with valid → NaN coerced to 0, valid renders normally', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topGenres: [
          { genre: 'Drama', episodes: 10, shows: 2 },
          { genre: 'Comedy', episodes: NaN, shows: 1 },
        ],
      }),
    );
    await renderStats(main);
    const section = generiSection(main);
    // Drama renders with 10 ep; Comedy has NaN → coerced to 0 → shows "0 ep"
    expect(section.textContent).toContain('10 ep');
    expect(section.textContent).toContain('0 ep');
    expect(section.textContent).not.toContain('NaN');
    const bars = generiBars(main);
    expect(bars).toHaveLength(2);
    // Drama: 10/10*100=100%; Comedy: 0/10*100=0%
    expect(bars[0].getAttribute('style') ?? '').toContain('width:100%');
    expect(bars[1].getAttribute('style') ?? '').toContain('width:0%');
  });

  it('fractional totalProgress still preserved (50.7 → "50.7%", regression)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({ totalShows: 1, totalProgress: 50.7 }),
    );
    await renderStats(main);
    const card = main.querySelectorAll('.stat-card .stat-value')[6];
    expect(card.textContent).toBe('50.7%');
  });

  it('pct rounding still works (50.5 → 51%, regression)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: 'A',
            image: null,
            watched: 101,
            totalEpisodes: 200,
            pct: 50.5,
          },
        ],
      }),
    );
    await renderStats(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toBe('101/200 episodi • 51%');
  });
});

// ============================================================
// BUG-A13-04: NaN/invalid season/num in calendar
// ============================================================

describe('BUG-A13-04: NaN/invalid season/num in calendar', () => {
  it('grid: season=NaN, num=NaN → "S?E?" (not "SNaNENaN")', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ season: NaN as unknown as number, num: NaN as unknown as number })] });
    await renderCalendar(main);
    const ep = main.querySelector('.calendar-episode') as HTMLElement;
    expect(ep).not.toBeNull();
    const showLine = ep.querySelector('.calendar-ep-show')?.textContent ?? '';
    expect(showLine).toContain('S?E?');
    expect(showLine).not.toContain('NaN');
  });

  it('grid: season=Infinity → "S?" (not "SInfinity")', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ season: Infinity as unknown as number, num: 1 })] });
    await renderCalendar(main);
    const ep = main.querySelector('.calendar-episode') as HTMLElement;
    const showLine = ep.querySelector('.calendar-ep-show')?.textContent ?? '';
    expect(showLine).toContain('S?E1');
    expect(showLine).not.toContain('Infinity');
  });

  it('grid: season=0 → "S?" (zero is not a valid season number)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ season: 0, num: 1 })] });
    await renderCalendar(main);
    const ep = main.querySelector('.calendar-episode') as HTMLElement;
    const showLine = ep.querySelector('.calendar-ep-show')?.textContent ?? '';
    expect(showLine).toContain('S?E1');
  });

  it('grid: season=1.5 (float) → "S?" (must be integer)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ season: 1.5, num: 1 })] });
    await renderCalendar(main);
    const ep = main.querySelector('.calendar-episode') as HTMLElement;
    const showLine = ep.querySelector('.calendar-ep-show')?.textContent ?? '';
    expect(showLine).toContain('S?E1');
  });

  it('grid: season=-1 → "S?" (negative invalid)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ season: -1, num: 1 })] });
    await renderCalendar(main);
    const ep = main.querySelector('.calendar-episode') as HTMLElement;
    const showLine = ep.querySelector('.calendar-ep-show')?.textContent ?? '';
    expect(showLine).toContain('S?E1');
  });

  it('"In arrivo" list: season/num invalid → "S?E?"', async () => {
    const main = makeMain();
    mockCal({
      afterWeek: [
        makeCalEp({
          season: undefined as unknown as number,
          num: undefined as unknown as number,
          name: null,
          date: '2024-03-25',
        }),
      ],
    });
    await renderCalendar(main);
    const meta = main.querySelector('.episode-meta')?.textContent ?? '';
    expect(meta).toContain('S?E?');
    expect(meta).not.toContain('undefined');
  });

  it('"Da vedere" list: season/num invalid → "S?E?"', async () => {
    const main = makeMain();
    mockCal({
      week: [
        makeCalEp({
          season: 'abc' as unknown as number,
          num: 'def' as unknown as number,
          name: null,
          date: '2024-03-12',
        }),
      ],
    });
    await renderCalendar(main);
    // Find the "Da vedere questa settimana" section
    const titleIdx = main.innerHTML.indexOf('Da vedere questa settimana');
    expect(titleIdx).toBeGreaterThan(0);
    const afterTitle = main.innerHTML.slice(titleIdx);
    expect(afterTitle).toContain('S?E?');
    expect(afterTitle).not.toContain('abc');
    expect(afterTitle).not.toContain('def');
  });

  it('normal numeric season/num still works (regression: S2E5)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ season: 2, num: 5, name: 'X' })] });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('S2E5');
  });
});

// ============================================================
// BUG-A13-05: Non-array guards (worker/corrupted data)
// ============================================================

describe('BUG-A13-05: non-array guards', () => {
  it('calendar: week=null → no crash, empty grid renders', async () => {
    const main = makeMain();
    vi.mocked(computeCalendarAsync).mockResolvedValueOnce({
      week: null as unknown as CalendarEpisode[],
      afterWeek: [],
      weekStart: '2024-03-11',
      weekEnd: '2024-03-17',
    });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('Calendario');
    expect(main.innerHTML).toContain('Tutto visto!');
    expect(main.querySelectorAll('.calendar-day')).toHaveLength(7);
  });

  it('calendar: afterWeek=undefined → no crash, "In arrivo" hidden', async () => {
    const main = makeMain();
    vi.mocked(computeCalendarAsync).mockResolvedValueOnce({
      week: [],
      afterWeek: undefined as unknown as CalendarEpisode[],
      weekStart: '2024-03-11',
      weekEnd: '2024-03-17',
    });
    await renderCalendar(main);
    expect(main.innerHTML).not.toContain('In arrivo');
  });

  it('calendar: week entry is a non-object (string) → skipped, no crash', async () => {
    const main = makeMain();
    vi.mocked(computeCalendarAsync).mockResolvedValueOnce({
      week: ['not-an-episode', makeCalEp({ showName: 'Good', date: '2024-03-12' })] as unknown as CalendarEpisode[],
      afterWeek: [],
      weekStart: '2024-03-11',
      weekEnd: '2024-03-17',
    });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('Calendario');
    expect(main.innerHTML).toContain('Good');
    // The string entry was skipped — no crash, no "not-an-episode" in DOM
    expect(main.innerHTML).not.toContain('not-an-episode');
  });

  it('stats: topGenres=null → "Nessun dato" (no crash)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({ totalShows: 1, topGenres: null as unknown as StatsResult['topGenres'] }),
    );
    await renderStats(main);
    expect(main.innerHTML).toContain('Statistiche');
    expect(generiSection(main).textContent).toContain('Nessun dato');
  });

  it('stats: topShows=null → "Nessun dato." (no crash)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({ totalShows: 1, topShows: null as unknown as StatsResult['topShows'] }),
    );
    await renderStats(main);
    expect(main.innerHTML).toContain('Statistiche');
    const topSection = main.querySelectorAll<HTMLElement>('.section')[2];
    expect(topSection.textContent).toContain('Nessun dato');
  });

  it('stats: topShows entry is a non-object (string) → skipped, no crash', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          'not-an-object',
          { showId: 1, showName: 'Good', image: null, watched: 1, totalEpisodes: 1, pct: 100 },
        ] as unknown as StatsResult['topShows'],
      }),
    );
    await renderStats(main);
    expect(main.innerHTML).toContain('Statistiche');
    expect(main.innerHTML).toContain('Good');
    expect(main.innerHTML).not.toContain('not-an-object');
  });

  it('stats: stats=null → empty state (no crash)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(null as unknown as StatsResult);
    await renderStats(main);
    expect(main.querySelector('.empty-state-title')?.textContent).toBe('Nessun dato');
    expect(main.querySelector('.stats-grid')).toBeNull();
  });
});

// ============================================================
// BUG-A13-06: Non-string image guard (stats)
// ============================================================

describe('BUG-A13-06: non-string image guard (stats)', () => {
  it('item.image=42 (number truthy) → no <img> rendered (would be invalid src)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: 'A',
            image: 42 as unknown as string,
            watched: 1,
            totalEpisodes: 1,
            pct: 100,
          },
        ],
      }),
    );
    await renderStats(main);
    const img = main.querySelector('.episode-item img');
    // FIX: non-string image → no <img> rendered (imgTag would have produced invalid src="42")
    expect(img).toBeNull();
  });

  it('item.image={} (object truthy) → no <img> rendered', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: 'A',
            image: {} as unknown as string,
            watched: 1,
            totalEpisodes: 1,
            pct: 100,
          },
        ],
      }),
    );
    await renderStats(main);
    const img = main.querySelector('.episode-item img');
    expect(img).toBeNull();
  });

  it('item.image="" (empty string) → no <img> rendered (falsy)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: 'A',
            image: '',
            watched: 1,
            totalEpisodes: 1,
            pct: 100,
          },
        ],
      }),
    );
    await renderStats(main);
    const img = main.querySelector('.episode-item img');
    expect(img).toBeNull();
  });

  it('item.image=valid URL string → <img> rendered (regression)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: 'A',
            image: 'https://example.com/p.jpg',
            watched: 1,
            totalEpisodes: 1,
            pct: 100,
          },
        ],
      }),
    );
    await renderStats(main);
    const img = main.querySelector('.episode-item img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.com/p.jpg');
  });
});

// ============================================================
// Regression: existing behavior preserved
// ============================================================

describe('Regression: existing behavior preserved', () => {
  it('calendar: changeWeek button still decrements offset (regression)', async () => {
    const main = makeMain();
    setState({ currentView: 'calendar' });
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    const prevBtn = main.querySelector('[data-action="changeWeek"][data-delta="-1"]') as HTMLElement;
    prevBtn.click();
    expect(getState().calendarWeekOffset).toBe(-1);
  });

  it('calendar: resetWeek button still works (regression)', async () => {
    const main = makeMain();
    setState({ currentView: 'calendar', calendarWeekOffset: 5 });
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    const resetBtn = main.querySelector('[data-action="resetWeek"]') as HTMLElement;
    expect(resetBtn).toBeTruthy();
    resetBtn.click();
    expect(getState().calendarWeekOffset).toBe(0);
  });

  it('stats: empty state (totalShows=0) still renders (regression)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(makeStats({ totalShows: 0 }));
    await renderStats(main);
    expect(main.querySelector('.empty-state-title')?.textContent).toBe('Nessun dato');
    expect(main.querySelector('.stats-grid')).toBeNull();
  });

  it('stats: XSS in genre still escaped (regression)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topGenres: [{ genre: '<script>alert(1)</script>', episodes: 1, shows: 1 }],
      }),
    );
    await renderStats(main);
    const sectionHtml = generiSection(main).innerHTML;
    expect(sectionHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(sectionHtml).not.toContain('<script>');
  });

  it('stats: XSS in showName still escaped (regression)', async () => {
    const main = makeMain();
    setState({ currentView: 'stats' });
    vi.mocked(computeStatsAsync).mockResolvedValueOnce(
      makeStats({
        totalShows: 1,
        topShows: [
          {
            showId: 1,
            showName: '<b>X</b>',
            image: null,
            watched: 1,
            totalEpisodes: 1,
            pct: 100,
          },
        ],
      }),
    );
    await renderStats(main);
    const nameEl = main.querySelector('.episode-name') as HTMLElement;
    expect(nameEl.innerHTML).toBe('&lt;b&gt;X&lt;/b&gt;');
  });
});
