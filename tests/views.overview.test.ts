// Dashboard e statistiche renderizzate con lo store reale.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as Compute from '../src/worker/compute';

const computeStatsAsync = vi.fn();
vi.mock('../src/worker/client', async () => {
  const compute = await vi.importActual<typeof Compute>('../src/worker/compute');
  return {
    computeStatsAsync: (...args: unknown[]) => computeStatsAsync(...args),
    computeCalendarAsync: vi.fn(async (shows: never, offset: number) => compute.computeCalendar(shows, offset)),
  };
});

import { setShows, setState } from '../src/lib/store';
import { renderDashboard } from '../src/views/dashboard';
import { renderStats } from '../src/views/stats';
import { renderCalendar } from '../src/views/calendar';
import { computeStats } from '../src/worker/compute';
import { makeShowWithSeasons, markWatchedFirst } from './helpers';

let main: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<main id="mainContent"></main><div id="toast"></div>';
  main = document.getElementById('mainContent')!;
  computeStatsAsync.mockReset();
  const watching = makeShowWithSeasons({ 1: 3 }, { id: 1, name: 'In visione', list: 'watching' });
  markWatchedFirst(watching, 1, 1);
  const towatch = makeShowWithSeasons({ 1: 2 }, { id: 2, name: 'Da iniziare', list: 'towatch' });
  const completed = makeShowWithSeasons({ 1: 1 }, { id: 3, name: 'Finita', list: 'completed' });
  markWatchedFirst(completed, 1, 1);
  setShows([watching, towatch, completed]);
  setState({ currentView: 'dashboard', currentShowId: null });
});

describe('dashboard', () => {
  it('renders one section per list, linking to the full list', () => {
    renderDashboard(main);
    const titles = Array.from(main.querySelectorAll('.section-title')).map((el) => el.textContent);
    expect(titles).toEqual(expect.arrayContaining(['Continua a guardare', 'Sto guardando', 'Da vedere', 'Completate']));
    const links = Array.from(main.querySelectorAll<HTMLElement>('.section-link')).map((el) => el.dataset.view);
    expect(links).toEqual(['watching', 'towatch', 'completed']);
    expect(main.querySelector('.continue-card-ep')?.textContent).toBe('Prossimo: Stagione 1, Ep 2');
  });
});

describe('stats view', () => {
  it('renders the computed totals', async () => {
    computeStatsAsync.mockImplementation(async (shows) => computeStats(shows as never));
    setState({ currentView: 'stats' });
    await renderStats(main);
    expect(main.querySelector('.page-title')?.textContent).toBe('Statistiche');
    expect(main.textContent).toContain('In visione');
  });

  it('shows an error state when the computation fails', async () => {
    computeStatsAsync.mockRejectedValue(new Error('worker crashed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setState({ currentView: 'stats' });
    await renderStats(main);
    expect(main.querySelector('.empty-state-title')?.textContent).toBe('Errore caricamento');
  });

  it('does not overwrite another view when the failure arrives after navigation', async () => {
    let fail!: (e: Error) => void;
    computeStatsAsync.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    setState({ currentView: 'stats' });
    const pending = renderStats(main);
    setState({ currentView: 'dashboard' });
    main.innerHTML = '<p id="other">altra vista</p>';
    fail(new Error('late'));
    await pending;
    expect(main.querySelector('#other')).not.toBeNull();
  });
});

describe('calendar view', () => {
  it('places this week’s releases on their day, lists later ones and offers "Oggi" on other weeks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 12, 0, 0)); // mercoledì
    const s = makeShowWithSeasons({ 1: 3 }, { id: 9, name: 'Settimanale', list: 'watching' });
    s.seasons[1][0].airdate = '2026-11-16';
    s.seasons[1][1].airdate = '2026-11-19';
    s.seasons[1][2].airdate = '2026-12-03';
    setShows([s]);

    setState({ currentView: 'calendar', calendarWeekOffset: 0 });
    await renderCalendar(main);
    const days = Array.from(main.querySelectorAll('.calendar-day'));
    expect(days[0].querySelectorAll('.calendar-episode')).toHaveLength(1); // lunedì 16
    expect(days[3].querySelectorAll('.calendar-episode')).toHaveLength(1); // giovedì 19
    expect(days[3].classList.contains('today')).toBe(false);
    expect(days[2].classList.contains('today')).toBe(true);
    expect(main.textContent).toContain('In arrivo');
    expect(main.querySelector('[data-action="resetWeek"]')).toBeNull();

    setState({ calendarWeekOffset: 2 });
    await renderCalendar(main);
    expect(main.querySelector('[data-action="resetWeek"]')).not.toBeNull();
    expect(main.querySelectorAll('.calendar-episode')).toHaveLength(1); // 3 dicembre
    vi.useRealTimers();
  });
});
