// Vista calendario: usa Web Worker per il calcolo

import { getState, changeCalendarWeek, resetCalendarWeek } from '../lib/store';
import { computeCalendarAsync } from '../worker/client';
import { escapeHtml, formatDate, parseISODateLocal, isSameLocalDay } from '../lib/utils';
import type { CalendarEpisode } from '../types';

let _boundCalendar = false;
let _clickHandler: ((e: MouseEvent) => void) | null = null;
let _keyHandler: ((e: KeyboardEvent) => void) | null = null;
let _mainEl: HTMLElement | null = null;

// BUG-16-06 (Low): token di invalidazione per renderCalendar. Se due
// renderCalendar concorrenti risolvono in ordine diverso da quello di
// partenza, l'ultimo STARTED vince (non l'ultimo RESOLVED).
let _calendarRenderToken = 0;

/**
 * Reset della guardia + rimozione listener accumulati. FIX H1/BUG-16-01:
 * prima di questo fix, resetBoundGuard resettava solo il flag lasciando i
 * listener click su `main` accumularsi ad ogni re-render (anche >1
 * changeCalendarWeek applicato per singolo click — drift "triangolare").
 */
export function resetBoundGuard(): void {
  if (_clickHandler && _mainEl) _mainEl.removeEventListener('click', _clickHandler);
  if (_keyHandler && _mainEl) _mainEl.removeEventListener('keydown', _keyHandler);
  _clickHandler = null;
  _keyHandler = null;
  _mainEl = null;
  _boundCalendar = false;
}

function renderCalendarSkeleton(main: HTMLElement): void {
  main.innerHTML =
    '<h1 class="page-title">Calendario</h1>' +
    '<p class="page-subtitle">Prossimi episodi delle tue serie in corso (basato su airdate TVMaze)</p>' +
    '<div class="loading"><div class="spinner"></div>Calcolando episodi...</div>';
}

function renderCalendarContent(
  main: HTMLElement,
  week: CalendarEpisode[],
  afterWeek: CalendarEpisode[],
  weekStart: string,
  weekEnd: string,
): void {
  const state = getState();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekDays = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];
  // BUG-16-04 (Low): non-null assertions erano bug potenziali — parseISODateLocal
  // può ritornare null per date malformed. Validiamo esplicitamente e mostriamo
  // un errore graceful invece di far scoppiare toLocaleDateString() sul null.
  const start = parseISODateLocal(weekStart);
  const end = parseISODateLocal(weekEnd);
  if (!start || !end) {
    main.innerHTML =
      '<h1 class="page-title">Calendario</h1>' +
      '<div class="empty-state"><div class="empty-state-title">Errore date</div><div class="empty-state-text">Date della settimana non valide. Riprova ad aprire il calendario.</div></div>';
    return;
  }

  // Raggruppa per giorno della settimana corrente
  const byDay: CalendarEpisode[][] = [[], [], [], [], [], [], []];
  for (const ep of week) {
    const epDate = parseISODateLocal(ep.date);
    // BUG-16-04 (cont): salta episodi con data malformed invece di lasciar
    // scoppiare getDay() sul null.
    if (!epDate) continue;
    const dayIdx = (epDate.getDay() + 6) % 7; // 0=Lun
    byDay[dayIdx].push(ep);
  }

  let html = '<h1 class="page-title">Calendario</h1>';
  html += '<p class="page-subtitle">Prossimi episodi delle tue serie in corso (basato su airdate TVMaze)</p>';

  const weekLabel =
    start.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) +
    ' – ' +
    end.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
  html +=
    '<div class="calendar-nav"><div class="calendar-nav-controls">' +
    '<button class="btn btn-secondary btn-sm" data-action="changeWeek" data-delta="-1" aria-label="Settimana precedente">‹</button>' +
    '<span class="calendar-nav-label">' +
    weekLabel +
    '</span>' +
    '<button class="btn btn-secondary btn-sm" data-action="changeWeek" data-delta="1" aria-label="Settimana successiva">›</button></div>' +
    (state.calendarWeekOffset !== 0
      ? '<button class="btn btn-secondary btn-sm" data-action="resetWeek">Oggi</button>'
      : '') +
    '</div>';

  html += '<div class="calendar-grid">';
  for (let i = 0; i < 7; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    day.setHours(0, 0, 0, 0);
    const dayName = weekDays[i];
    const isToday = isSameLocalDay(day, today);
    const dayEpisodes = byDay[i];
    html +=
      '<div class="calendar-day ' +
      (isToday ? 'today' : '') +
      '">' +
      '<div class="calendar-day-header">' +
      dayName +
      '</div>' +
      '<div class="calendar-day-date">' +
      day.getDate() +
      '</div>' +
      (dayEpisodes.length > 0
        ? dayEpisodes
            .map(
              (ep) =>
                '<div class="calendar-episode" role="button" tabindex="0" data-action="openShow" data-show-id="' +
                ep.showId +
                '">' +
                '<div class="calendar-ep-name">' +
                escapeHtml(ep.showName) +
                '</div>' +
                '<div class="calendar-ep-show">S' +
                ep.season +
                'E' +
                ep.num +
                (ep.name ? ' · ' + escapeHtml(ep.name) : '') +
                '</div></div>',
            )
            .join('')
        : '<div style="color:var(--text-muted);font-size:12px;">Nessun episodio</div>') +
      '</div>';
  }
  html += '</div>';

  if (afterWeek.length > 0) {
    html +=
      '<div class="section" style="margin-top:32px;"><h2 class="section-title">In arrivo</h2><div class="episode-list">';
    for (const ep of afterWeek.slice(0, 20)) {
      const epTitle = ep.name
        ? escapeHtml(ep.showName) + ' · ' + escapeHtml(ep.name)
        : escapeHtml(ep.showName) + ' · Stagione ' + ep.season + ', Episodio ' + ep.num;
      // H17 a11y: episode-item clickable — role="button" + tabindex="0".
      // (No aria-label to avoid XSS test regressions on innerHTML serialization;
      // the visible episode-name text is the accessible name.)
      html +=
        '<div class="episode-item" role="button" tabindex="0"' +
        ' data-action="openShow" data-show-id="' +
        ep.showId +
        '" style="cursor:pointer;">' +
        '<div class="episode-checkbox"></div>' +
        '<div class="episode-info"><div class="episode-name">' +
        epTitle +
        '</div>' +
        '<div class="episode-meta">S' +
        ep.season +
        'E' +
        ep.num +
        ' • ' +
        formatDate(ep.date) +
        '</div></div></div>';
    }
    // BUG-16-05 (Low): indica quando afterWeek è troncato a 20 elementi,
    // così l'utente sa che ci sono altri episodi non mostrati.
    if (afterWeek.length > 20) {
      html +=
        '<div class="after-week-more" style="padding:8px 12px;color:var(--text-muted);font-size:12px;">+ ' +
        (afterWeek.length - 20) +
        ' altri episodi in arrivo…</div>';
    }
    html += '</div></div>';
  }

  html += '<div class="section" style="margin-top:32px;"><h2 class="section-title">Da vedere questa settimana</h2>';
  if (week.length === 0) {
    html +=
      '<div class="empty-state"><div class="empty-state-title">Tutto visto!</div><div class="empty-state-text">Nessun episodio in programmazione questa settimana.</div></div>';
  } else {
    html += '<div class="episode-list">';
    for (const ep of week) {
      const epTitle = ep.name
        ? escapeHtml(ep.showName) + ' · ' + escapeHtml(ep.name)
        : escapeHtml(ep.showName) + ' · Stagione ' + ep.season + ', Episodio ' + ep.num;
      // H17 a11y: episode-item clickable — role="button" + tabindex="0".
      html +=
        '<div class="episode-item" role="button" tabindex="0"' +
        ' data-action="openShow" data-show-id="' +
        ep.showId +
        '" style="cursor:pointer;">' +
        '<div class="episode-checkbox"></div>' +
        '<div class="episode-info"><div class="episode-name">' +
        epTitle +
        '</div>' +
        '<div class="episode-meta">S' +
        ep.season +
        'E' +
        ep.num +
        ' • ' +
        formatDate(ep.date) +
        ' • ' +
        ep.watchedCount +
        '/' +
        ep.totalEpisodes +
        ' episodi visti</div></div></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  main.innerHTML = html;
}

export async function renderCalendar(main: HTMLElement): Promise<void> {
  // BUG-16-06 (Low): token di invalidazione. Se un'altra renderCalendar
  // parte mentre questa è in await, il risultato di questa viene scartato
  // (last-STARTED wins, non last-RESOLVED).
  const myToken = ++_calendarRenderToken;
  renderCalendarSkeleton(main);
  try {
    const state = getState();
    const result = await computeCalendarAsync(state.shows, state.calendarWeekOffset);
    if (_calendarRenderToken !== myToken) return; // superseded
    renderCalendarContent(main, result.week, result.afterWeek, result.weekStart, result.weekEnd);
  } catch (e) {
    if (_calendarRenderToken !== myToken) return; // superseded
    console.error('[calendar] error:', e);
    main.innerHTML =
      '<h1 class="page-title">Calendario</h1>' +
      '<div class="empty-state"><div class="empty-state-title">Errore caricamento</div><div class="empty-state-text">Riprova ad aprire il calendario.</div></div>';
  }
}

export function bindCalendarEvents(main: HTMLElement): void {
  if (_boundCalendar) return;
  _boundCalendar = true;
  _mainEl = main;

  _clickHandler = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'changeWeek') {
      // BUG-16-02 (Medium): Number(undefined) === NaN. Guard con isFinite
      // per evitare di pollute state.calendarWeekOffset con NaN se
      // data-delta manca (DOM tampering, future regression).
      const delta = Number(actionEl.dataset.delta);
      if (!Number.isFinite(delta)) return;
      changeCalendarWeek(delta);
    } else if (action === 'resetWeek') {
      resetCalendarWeek();
    }
  };

  _keyHandler = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    if (actionEl !== target && !actionEl.contains(target)) return;
    e.preventDefault();
    actionEl.click();
  };

  main.addEventListener('click', _clickHandler);
  main.addEventListener('keydown', _keyHandler);
}
