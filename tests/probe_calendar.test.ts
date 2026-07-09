// Agent 16 probe: stress-test src/views/calendar.ts
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_calendar.test.ts
//
// Strategy:
//  - Mock computeCalendarAsync via vi.mock so we can inject arbitrary week/afterWeek/weekStart/weekEnd
//    (including malformed values) without depending on jsdom Worker support.
//  - Use real store (getState/changeCalendarWeek/resetCalendarWeek) so we can verify state mutations.
//  - jsdom provides a real DOM; main.innerHTML rendering is exercised end-to-end.
//  - vi.useFakeTimers + vi.setSystemTime so `new Date()` in renderCalendarContent is deterministic
//    (used for isToday highlight).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CalendarEpisode } from '../src/types';

// ===== Mocks (hoisted by vitest) =====

vi.mock('../src/worker/client', () => ({
  computeCalendarAsync: vi.fn(),
}));

import { computeCalendarAsync } from '../src/worker/client';
import { renderCalendar, bindCalendarEvents, resetBoundGuard } from '../src/views/calendar';
import { getState, setState, changeCalendarWeek } from '../src/lib/store';

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

beforeEach(() => {
  vi.useFakeTimers();
  // Wednesday 2024-03-13 (weekStart=Mon 2024-03-11, weekEnd=Sun 2024-03-17)
  vi.setSystemTime(new Date('2024-03-13T10:00:00'));
  // Reset store state
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
  mockCal();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// Part 1: Basic rendering (happy path)
// ============================================================

describe('Agent-16 calendar: basic rendering', () => {
  it('renders 7 day cells with Italian day names Mon→Sun', async () => {
    const main = makeMain();
    await renderCalendar(main);
    const headers = Array.from(main.querySelectorAll('.calendar-day-header')).map((e) => e.textContent);
    expect(headers).toEqual(['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica']);
  });

  it('renders "Tutto visto!" empty state + 7 day cells when no episodes', async () => {
    const main = makeMain();
    await renderCalendar(main);
    expect(main.innerHTML).toContain('Tutto visto!');
    expect(main.querySelectorAll('.calendar-day')).toHaveLength(7);
    // Each of the 7 day cells shows "Nessun episodio"; the bottom empty-state also
    // contains "Nessun episodio in programmazione..." → total 8 matches.
    const noEp = main.innerHTML.match(/Nessun episodio/g);
    expect(noEp).toHaveLength(8);
    // Verify the 7 day-cell occurrences are inside .calendar-day elements
    const dayCellNoEp = Array.from(main.querySelectorAll('.calendar-day')).filter((d) =>
      d.innerHTML.includes('Nessun episodio'),
    );
    expect(dayCellNoEp).toHaveLength(7);
  });

  it('shows page title "Calendario" and subtitle', async () => {
    const main = makeMain();
    await renderCalendar(main);
    expect(main.querySelector('.page-title')?.textContent).toBe('Calendario');
    expect(main.innerHTML).toContain('Prossimi episodi delle tue serie in corso');
  });

  it('weekLabel contains day numbers and year (start=11, end=17, year=2024)', async () => {
    const main = makeMain();
    await renderCalendar(main);
    const label = main.querySelector('.calendar-nav-label')?.textContent ?? '';
    expect(label).toContain('11');
    expect(label).toContain('17');
    expect(label).toContain('2024');
  });

  it('"Oggi" reset button hidden when offset=0, shown when offset!=0', async () => {
    let main = makeMain();
    await renderCalendar(main);
    expect(main.querySelector('[data-action="resetWeek"]')).toBeNull();

    setState({ calendarWeekOffset: 1 });
    main = makeMain();
    await renderCalendar(main);
    expect(main.querySelector('[data-action="resetWeek"]')).not.toBeNull();
  });

  it('highlights today cell (Wed 2024-03-13 → index 2)', async () => {
    const main = makeMain();
    await renderCalendar(main);
    const days = main.querySelectorAll('.calendar-day');
    expect(days[0].classList.contains('today')).toBe(false); // Mon
    expect(days[1].classList.contains('today')).toBe(false); // Tue
    expect(days[2].classList.contains('today')).toBe(true); // Wed
    expect(days[3].classList.contains('today')).toBe(false); // Thu
    expect(days[6].classList.contains('today')).toBe(false); // Sun
  });

  it('grid day-header (weekDays[i]) aligns with day.getDate() when start is Monday', async () => {
    // start=Mon 2024-03-11. day 0 = Mon 11. day 6 = Sun 17.
    const main = makeMain();
    await renderCalendar(main);
    const days = main.querySelectorAll('.calendar-day');
    expect(days[0].querySelector('.calendar-day-header')?.textContent).toBe('Lunedì');
    expect(days[0].querySelector('.calendar-day-date')?.textContent).toBe('11');
    expect(days[6].querySelector('.calendar-day-header')?.textContent).toBe('Domenica');
    expect(days[6].querySelector('.calendar-day-date')?.textContent).toBe('17');
  });

  it('passes state.shows and state.calendarWeekOffset to computeCalendarAsync', async () => {
    const main = makeMain();
    setState({ shows: [{ id: 99 } as never], calendarWeekOffset: 3 });
    await renderCalendar(main);
    expect(computeCalendarAsync).toHaveBeenCalledTimes(1);
    const [showsArg, offsetArg] = vi.mocked(computeCalendarAsync).mock.calls[0];
    expect(showsArg).toEqual([{ id: 99 }]);
    expect(offsetArg).toBe(3);
  });
});

// ============================================================
// Part 2: Episode rendering & XSS
// ============================================================

describe('Agent-16 calendar: episode placement & XSS', () => {
  it('places episode in correct day cell based on date weekday (Tue 2024-03-12 → index 1)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ date: '2024-03-12', showName: 'TueShow' })] });
    await renderCalendar(main);
    const days = main.querySelectorAll('.calendar-day');
    expect(days[1].innerHTML).toContain('TueShow');
    expect(days[0].innerHTML).toContain('Nessun episodio');
    expect(days[2].innerHTML).toContain('Nessun episodio');
  });

  it('Sun 2024-03-17 → index 6 (Domenica)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ date: '2024-03-17', showName: 'SunShow' })] });
    await renderCalendar(main);
    const days = main.querySelectorAll('.calendar-day');
    expect(days[6].innerHTML).toContain('SunShow');
    expect(days[0].innerHTML).not.toContain('SunShow');
  });

  it('escapes HTML in showName (grid)', async () => {
    const main = makeMain();
    const evil = '<img src=x onerror=alert(1)>';
    mockCal({ week: [makeCalEp({ showName: evil })] });
    await renderCalendar(main);
    expect(main.innerHTML).not.toContain(evil);
    expect(main.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(main.querySelectorAll('img')).toHaveLength(0);
  });

  it('escapes HTML in episode name (grid)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ name: '<script>alert(1)</script>' })] });
    await renderCalendar(main);
    expect(main.querySelectorAll('script')).toHaveLength(0);
    expect(main.innerHTML).not.toContain('<script>alert(1)</script>');
  });

  it('omits " · " separator when ep.name is null (grid)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ name: null })] });
    await renderCalendar(main);
    const ep = main.querySelector('.calendar-episode');
    expect(ep).toBeTruthy();
    expect(ep!.textContent).not.toContain('·');
  });

  it('renders multiple episodes in same day cell', async () => {
    const main = makeMain();
    mockCal({
      week: [
        makeCalEp({ showId: 1, showName: 'Show A', date: '2024-03-12' }),
        makeCalEp({ showId: 2, showName: 'Show B', date: '2024-03-12' }),
      ],
    });
    await renderCalendar(main);
    const days = main.querySelectorAll('.calendar-day');
    expect(days[1].querySelectorAll('.calendar-episode')).toHaveLength(2);
  });

  it('renders S{season}E{num} in grid', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ season: 2, num: 5, name: 'X' })] });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('S2E5');
  });

  it('episode elements have data-action="openShow" and data-show-id', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ showId: 42, date: '2024-03-12' })] });
    await renderCalendar(main);
    const ep = main.querySelector('.calendar-episode') as HTMLElement;
    expect(ep.dataset.action).toBe('openShow');
    expect(ep.dataset.showId).toBe('42');
  });

  it('duplicates week episodes in "Da vedere questa settimana" list (intentional)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ showName: 'DupShow', date: '2024-03-12' })] });
    await renderCalendar(main);
    const titleIdx = main.innerHTML.indexOf('Da vedere questa settimana');
    expect(titleIdx).toBeGreaterThan(0);
    const afterTitle = main.innerHTML.slice(titleIdx);
    expect(afterTitle).toContain('DupShow');
  });

  it('"Da vedere" list shows watchedCount/totalEpisodes info', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ showName: 'Info', watchedCount: 3, totalEpisodes: 10, date: '2024-03-12' })] });
    await renderCalendar(main);
    const titleIdx = main.innerHTML.indexOf('Da vedere questa settimana');
    const afterTitle = main.innerHTML.slice(titleIdx);
    expect(afterTitle).toContain('3/10');
    expect(afterTitle).toContain('episodi visti');
  });

  it('hides "In arrivo" section when afterWeek is empty', async () => {
    const main = makeMain();
    mockCal({ afterWeek: [] });
    await renderCalendar(main);
    expect(main.innerHTML).not.toContain('In arrivo');
  });

  it('shows "In arrivo" section with future episodes when afterWeek non-empty', async () => {
    const main = makeMain();
    mockCal({ afterWeek: [makeCalEp({ showName: 'FutureShow', date: '2024-03-25' })] });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('In arrivo');
    expect(main.innerHTML).toContain('FutureShow');
  });

  it('afterWeek slice(0,20): 25 episodes → 20 rendered + "altri" indicator (FIXED BUG-16-05)', async () => {
    const main = makeMain();
    const eps: CalendarEpisode[] = [];
    for (let i = 0; i < 25; i++) {
      eps.push(makeCalEp({ showId: i + 1, showName: `S${i}`, date: `2024-04-${String(i + 1).padStart(2, '0')}` }));
    }
    mockCal({ afterWeek: eps });
    await renderCalendar(main);
    const items = main.querySelectorAll('.episode-item');
    expect(items).toHaveLength(20);
    // FIX BUG-16-05: "altri" indicator rendered with remaining count.
    expect(main.innerHTML).toMatch(/\+\s*5\s+altri episodi/i);
  });

  it('afterWeek exactly 20 episodes → no "altri" indicator', async () => {
    const main = makeMain();
    const eps: CalendarEpisode[] = [];
    for (let i = 0; i < 20; i++) {
      eps.push(makeCalEp({ showId: i + 1, showName: `S${i}`, date: `2024-04-${String(i + 1).padStart(2, '0')}` }));
    }
    mockCal({ afterWeek: eps });
    await renderCalendar(main);
    expect(main.querySelectorAll('.episode-item')).toHaveLength(20);
    // No indicator when exactly at the limit.
    expect(main.innerHTML).not.toMatch(/\+\s*\d+\s+altri episodi/i);
  });
});

// ============================================================
// Part 3: Defense-in-depth (non-null assertions)
// ============================================================

describe('Agent-16 calendar: defense-in-depth — null check on parseISODateLocal (BUG-16-04 FIXED)', () => {
  it('malformed weekStart → graceful "Errore date" (FIXED, no TypeError)', async () => {
    const main = makeMain();
    mockCal({ weekStart: 'not-a-date' });
    await renderCalendar(main);
    // FIX: explicit null check shows graceful error (not caught TypeError).
    expect(main.innerHTML).toContain('Errore date');
    expect(main.innerHTML).not.toContain('Calcolando');
  });

  it('malformed weekEnd → graceful "Errore date"', async () => {
    const main = makeMain();
    mockCal({ weekEnd: 'garbage' });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('Errore date');
  });

  it('undefined weekStart → graceful "Errore date"', async () => {
    const main = makeMain();
    vi.mocked(computeCalendarAsync).mockResolvedValue({
      week: [],
      afterWeek: [],
      weekStart: undefined as unknown as string,
      weekEnd: '2024-03-17',
    });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('Errore date');
  });

  it('episode with malformed date → skipped in GRID (no crash, other episodes render)', async () => {
    // FIX BUG-16-04 (cont): episodes with malformed date are SKIPPED in the grid
    // (no null.getDay() crash) instead of bubbling up to "Errore caricamento".
    // They may still appear in the bottom "Da vedere questa settimana" list
    // (where formatDate gracefully returns 'N/D' for bad dates).
    const main = makeMain();
    mockCal({
      week: [
        makeCalEp({ showName: 'Good', date: '2024-03-12' }),
        makeCalEp({ showName: 'Bad', date: 'garbage-date' }),
      ],
    });
    await renderCalendar(main);
    // FIX: no crash, no "Errore" UI — the malformed-date episode was skipped
    // in the grid (no null.getDay() thrown).
    expect(main.innerHTML).not.toContain('Errore');
    expect(main.innerHTML).toContain('Calendario');
    // 'Good' is rendered in the grid (Tue 2024-03-12).
    const grid = main.querySelector('.calendar-grid')!;
    expect(grid.innerHTML).toContain('Good');
    // 'Bad' is NOT rendered in the grid (skipped due to malformed date).
    expect(grid.innerHTML).not.toContain('Bad');
  });

  it('computeCalendarAsync rejection → caught, "Errore caricamento" shown', async () => {
    const main = makeMain();
    vi.mocked(computeCalendarAsync).mockRejectedValueOnce(new Error('boom'));
    await renderCalendar(main);
    expect(main.innerHTML).toContain('Errore caricamento');
  });

  it('NOTE: the worker/fallback ALWAYS return localISODate() (valid YYYY-MM-DD) so this is defense-only; verify contract', async () => {
    // Worker (stats.worker.ts L119) returns weekStart: localISODate(startOfWeek), weekEnd: localISODate(weekEnd)
    // localISODate always returns "YYYY-MM-DD" (padded) which parseISODateLocal always accepts.
    // So in practice the null check is a safety net. This test documents the contract.
    const main = makeMain();
    mockCal({ weekStart: '2024-03-11', weekEnd: '2024-03-17' });
    await renderCalendar(main);
    expect(main.innerHTML).toContain('Calendario');
    expect(main.innerHTML).not.toContain('Errore');
  });
});

// ============================================================
// Part 4: changeWeek / resetWeek + listener accumulation BUG
// ============================================================

describe('Agent-16 calendar: changeWeek & resetWeek (happy path)', () => {
  it('clicking prev button decrements calendarWeekOffset by 1', async () => {
    const main = makeMain();
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    const prevBtn = main.querySelector('[data-action="changeWeek"][data-delta="-1"]') as HTMLElement;
    prevBtn.click();
    expect(getState().calendarWeekOffset).toBe(-1);
  });

  it('clicking next button increments calendarWeekOffset by 1', async () => {
    const main = makeMain();
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    const nextBtn = main.querySelector('[data-action="changeWeek"][data-delta="1"]') as HTMLElement;
    nextBtn.click();
    expect(getState().calendarWeekOffset).toBe(1);
  });

  it('clicking reset button sets calendarWeekOffset to 0', async () => {
    const main = makeMain();
    setState({ calendarWeekOffset: 5 });
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    const resetBtn = main.querySelector('[data-action="resetWeek"]') as HTMLElement;
    expect(resetBtn).toBeTruthy();
    resetBtn.click();
    expect(getState().calendarWeekOffset).toBe(0);
  });

  it('bindCalendarEvents guard works WITHOUT resetBoundGuard (no accumulation)', async () => {
    const main = makeMain();
    const addSpy = vi.spyOn(main, 'addEventListener');
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    bindCalendarEvents(main); // second call without reset → no-op due to _boundCalendar=true
    bindCalendarEvents(main); // third call → also no-op
    // FIX: bindCalendarEvents adds both 'click' and 'keydown' listeners (H17 a11y).
    // Both are guarded by _boundCalendar, so only 2 addEventListener calls total.
    const clickAdds = addSpy.mock.calls.filter(([t]) => t === 'click');
    const keydownAdds = addSpy.mock.calls.filter(([t]) => t === 'keydown');
    expect(clickAdds.length).toBe(1);
    expect(keydownAdds.length).toBe(1);
  });
});

describe('Agent-16 calendar: BUG — listener accumulation FIXED via resetBoundGuard+bind', () => {
  it('BUG-16-01 (FIXED): resetBoundGuard+bindCalendarEvents removes old listener → 1 active', async () => {
    // FIX H1/BUG-16-01: resetBoundGuard ora removeEventListener prima di bindare
    // un nuovo handler. Quindi N cicli → 1 listener attivo → 1 chiamata a
    // changeCalendarWeek per click (no drift triangolare).
    const main = makeMain();
    const addSpy = vi.spyOn(main, 'addEventListener');
    const removeSpy = vi.spyOn(main, 'removeEventListener');

    // First render cycle
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    const firstClickAdds = addSpy.mock.calls.filter(([t]) => t === 'click').length;
    expect(firstClickAdds).toBe(1);

    // Second render cycle (e.g. user clicked changeWeek → emitChange → re-render)
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    // FIX: addEventListener('click') 2 times, removeEventListener('click') 1 time.
    const clickAdds = addSpy.mock.calls.filter(([t]) => t === 'click').length;
    const clickRemoves = removeSpy.mock.calls.filter(([t]) => t === 'click').length;
    expect(clickAdds).toBe(2);
    expect(clickRemoves).toBe(1);

    // Click prev → ONE listener fires → state changes by -1 (FIX).
    const prevBtn = main.querySelector('[data-action="changeWeek"][data-delta="-1"]') as HTMLElement;
    prevBtn.click();
    expect(getState().calendarWeekOffset).toBe(-1); // FIX (was -2)
  });

  it('BUG-16-01 (FIXED cont): after N render cycles, single click applies 1×delta', async () => {
    const main = makeMain();
    for (let i = 0; i < 5; i++) {
      resetBoundGuard();
      await renderCalendar(main);
      bindCalendarEvents(main);
    }
    const prevBtn = main.querySelector('[data-action="changeWeek"][data-delta="-1"]') as HTMLElement;
    prevBtn.click();
    // FIX: 1 active listener × delta(-1) = -1 (was -5).
    expect(getState().calendarWeekOffset).toBe(-1);
  });

  it('BUG-16-01 (FIXED cont): next-button NO drift — each click adds 1', async () => {
    // Simulate the real user flow: click → emitChange → re-render → click → ...
    // FIX: each click adds exactly 1 (no triangular drift).
    const main = makeMain();
    // Initial render
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);

    // Click 1 (1 listener): state = +1
    let nextBtn = main.querySelector('[data-action="changeWeek"][data-delta="1"]') as HTMLElement;
    nextBtn.click();
    expect(getState().calendarWeekOffset).toBe(1);

    // Simulate the RAF callback that emitChange scheduled (re-render)
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);

    // Click 2 (1 listener): state = 1 + 1 = 2 (FIX; was 3)
    nextBtn = main.querySelector('[data-action="changeWeek"][data-delta="1"]') as HTMLElement;
    nextBtn.click();
    expect(getState().calendarWeekOffset).toBe(2);

    // Simulate re-render
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);

    // Click 3 (1 listener): state = 2 + 1 = 3 (FIX; was 6)
    nextBtn = main.querySelector('[data-action="changeWeek"][data-delta="1"]') as HTMLElement;
    nextBtn.click();
    expect(getState().calendarWeekOffset).toBe(3);
  });
});

describe('Agent-16 calendar: NaN delta & state pollution (BUG-16-02 FIXED)', () => {
  it('clicking button with missing data-delta → no-op (FIXED, state unchanged at 0)', async () => {
    // FIX BUG-16-02: changeCalendarWeek(Number(undefined)) → NaN. Ora il bind handler
    // ha un guard `if (!Number.isFinite(delta)) return;` → no-op, state resta 0.
    const main = makeMain();
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    const prevBtn = main.querySelector('[data-action="changeWeek"]') as HTMLElement;
    prevBtn.removeAttribute('data-delta');
    prevBtn.click();
    // FIX: state NOT polluted (no NaN).
    expect(getState().calendarWeekOffset).toBe(0);
    expect(Number.isNaN(getState().calendarWeekOffset)).toBe(false);
  });

  it('NaN state: "Oggi" button still rendered (NaN !== 0 is true)', async () => {
    const main = makeMain();
    setState({ calendarWeekOffset: NaN });
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    const resetBtn = main.querySelector('[data-action="resetWeek"]') as HTMLElement;
    expect(resetBtn).toBeTruthy();
  });

  it('NaN state recoverable via resetWeek click', async () => {
    const main = makeMain();
    setState({ calendarWeekOffset: NaN });
    resetBoundGuard();
    await renderCalendar(main);
    bindCalendarEvents(main);
    const resetBtn = main.querySelector('[data-action="resetWeek"]') as HTMLElement;
    resetBtn.click();
    expect(getState().calendarWeekOffset).toBe(0);
  });

  it('changeCalendarWeek does not coerce non-integer delta (state stores 1.5)', async () => {
    // changeCalendarWeek: state.calendarWeekOffset += delta (no Math.floor, no isFinite check)
    // — this is store.ts behavior, not the bind handler. The bind handler's isFinite
    // guard passes for 1.5 (it's finite). The worker has safeOffset (Math.floor + isFinite).
    changeCalendarWeek(1.5);
    expect(getState().calendarWeekOffset).toBe(1.5);
  });
});

// ============================================================
// Part 5: Async rendering & skeleton
// ============================================================

describe('Agent-16 calendar: async render flow', () => {
  it('skeleton shown before computeCalendarAsync resolves', async () => {
    const main = makeMain();
    let resolveFn!: (v: { week: CalendarEpisode[]; afterWeek: CalendarEpisode[]; weekStart: string; weekEnd: string }) => void;
    vi.mocked(computeCalendarAsync).mockReturnValueOnce(
      new Promise((r) => {
        resolveFn = r as typeof resolveFn;
      }),
    );
    const p = renderCalendar(main);
    // Before resolve, skeleton visible
    expect(main.innerHTML).toContain('Calcolando episodi');
    expect(main.innerHTML).toContain('spinner');
    resolveFn({ week: [], afterWeek: [], weekStart: '2024-03-11', weekEnd: '2024-03-17' });
    await p;
    // After resolve, content replaces skeleton
    expect(main.innerHTML).not.toContain('Calcolando episodi');
    expect(main.innerHTML).toContain('Calendario');
  });

  it('FIX BUG-16-06: rapid re-renders — last-STARTED wins (token guard)', async () => {
    // FIX BUG-16-06: renderCalendar ora ha un token interno. Se due chiamate
    // concorrenti risolvono in ordine diverso da quello di partenza, l'ultima
    // STARTED vince (non l'ultima RESOLVED).
    const main = makeMain();
    let r1!: () => void;
    let r2!: () => void;
    vi.mocked(computeCalendarAsync)
      .mockReturnValueOnce(new Promise((r) => { r1 = () => r({ week: [makeCalEp({ showName: 'First' })], afterWeek: [], weekStart: '2024-03-11', weekEnd: '2024-03-17' }); }))
      .mockReturnValueOnce(new Promise((r) => { r2 = () => r({ week: [makeCalEp({ showName: 'Second' })], afterWeek: [], weekStart: '2024-03-11', weekEnd: '2024-03-17' }); }));
    const p1 = renderCalendar(main);
    const p2 = renderCalendar(main);
    // Resolve r1 FIRST (out-of-order), then r2.
    // FIX: last-STARTED (p2) wins regardless of resolution order.
    r1();
    r2();
    await Promise.all([p1, p2]);
    expect(main.innerHTML).toContain('Second');
    expect(main.innerHTML).not.toContain('First');
  });

  it('FIX BUG-16-06: if first resolves AFTER second, first is discarded (token wins)', async () => {
    const main = makeMain();
    let r1!: () => void;
    let r2!: () => void;
    vi.mocked(computeCalendarAsync)
      .mockReturnValueOnce(new Promise((r) => { r1 = () => r({ week: [makeCalEp({ showName: 'First' })], afterWeek: [], weekStart: '2024-03-11', weekEnd: '2024-03-17' }); }))
      .mockReturnValueOnce(new Promise((r) => { r2 = () => r({ week: [makeCalEp({ showName: 'Second' })], afterWeek: [], weekStart: '2024-03-11', weekEnd: '2024-03-17' }); }));
    const p1 = renderCalendar(main);
    const p2 = renderCalendar(main);
    // Resolve r2 first, then r1. Before the FIX, r1 would overwrite with 'First'.
    // FIX: r1 (started earlier) is discarded; r2 (started later) wins.
    r2();
    r1();
    await Promise.all([p1, p2]);
    expect(main.innerHTML).toContain('Second');
    expect(main.innerHTML).not.toContain('First');
  });
});

// ============================================================
// Part 6: DST / timezone edge cases
// ============================================================

describe('Agent-16 calendar: DST & date arithmetic', () => {
  it('weekStart=2024-03-25 (Mon, DST week in Europe/Rome): episode on Sun 2024-03-31 lands in index 6', async () => {
    // 2024-03-31 is the EU spring-forward Sunday. parseISODateLocal returns local midnight.
    // getDay()=0 for Sunday → (0+6)%7=6 → byDay[6] (Domenica).
    const main = makeMain();
    vi.setSystemTime(new Date('2024-03-28T10:00:00')); // Thursday in that week
    mockCal({
      weekStart: '2024-03-25',
      weekEnd: '2024-03-31',
      week: [makeCalEp({ date: '2024-03-31', showName: 'DSTShow' })],
    });
    await renderCalendar(main);
    const days = main.querySelectorAll('.calendar-day');
    expect(days[6].innerHTML).toContain('DSTShow');
    expect(days[6].querySelector('.calendar-day-header')?.textContent).toBe('Domenica');
  });

  it('weekStart is Monday regardless of "today" weekday (computeCalendar contract)', async () => {
    // Today is Sunday 2024-03-17. Worker would compute startOfWeek = today - 6 = Mon 2024-03-11.
    // We mock the result; verify the grid still aligns weekDays[0]=Lunedì with day 11.
    const main = makeMain();
    vi.setSystemTime(new Date('2024-03-17T10:00:00')); // Sunday
    mockCal({ weekStart: '2024-03-11', weekEnd: '2024-03-17' });
    await renderCalendar(main);
    const days = main.querySelectorAll('.calendar-day');
    expect(days[0].querySelector('.calendar-day-header')?.textContent).toBe('Lunedì');
    expect(days[0].querySelector('.calendar-day-date')?.textContent).toBe('11');
    expect(days[6].querySelector('.calendar-day-header')?.textContent).toBe('Domenica');
    expect(days[6].querySelector('.calendar-day-date')?.textContent).toBe('17');
  });
});

// ============================================================
// Part 7: Limitations / contract notes (not bugs)
// ============================================================

describe('Agent-16 calendar: contract notes (limitations, not bugs)', () => {
  it('calendar displays at most 1 episode per watching show (findNextEpisode contract)', async () => {
    // The worker/fallback uses findNextEpisode which returns ONLY the first unwatched ep.
    // So a show with 2 new episodes in the same week shows only the first.
    // (Cannot test the worker here since computeCalendarAsync is mocked; document the contract.)
    const main = makeMain();
    mockCal({ week: [makeCalEp({ showId: 1, showName: 'Show A', num: 1, date: '2024-03-12' })] });
    await renderCalendar(main);
    const eps = main.querySelectorAll('.calendar-episode');
    expect(eps).toHaveLength(1);
  });

  it('episode click target is openShow (does not jump to specific episode — UX limitation)', async () => {
    const main = makeMain();
    mockCal({ week: [makeCalEp({ showId: 42, season: 3, num: 7, date: '2024-03-12' })] });
    await renderCalendar(main);
    const ep = main.querySelector('.calendar-episode') as HTMLElement;
    // The data attributes only carry showId, not season/num. Clicking opens show detail at S1.
    expect(ep.dataset.action).toBe('openShow');
    expect(ep.dataset.showId).toBe('42');
    expect(ep.dataset.season).toBeUndefined();
    expect(ep.dataset.num).toBeUndefined();
  });
});
