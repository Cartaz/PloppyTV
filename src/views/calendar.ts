// Vista calendario: usa Web Worker per il calcolo

import { getState, changeCalendarWeek, resetCalendarWeek } from '../lib/store';
import { computeCalendarAsync } from '../worker/client';
import { escapeHtml, formatDate, parseISODateLocal, isSameLocalDay } from '../lib/utils';
import type { CalendarEpisode } from '../types';

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
  weekEnd: string
): void {
  const state = getState();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekDays = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];
  const start = parseISODateLocal(weekStart)!;
  const end = parseISODateLocal(weekEnd)!;

  // Raggruppa per giorno della settimana corrente
  const byDay: CalendarEpisode[][] = [[], [], [], [], [], [], []];
  for (const ep of week) {
    const epDate = parseISODateLocal(ep.date)!;
    const dayIdx = (epDate.getDay() + 6) % 7; // 0=Lun
    byDay[dayIdx].push(ep);
  }

  let html = '<h1 class="page-title">Calendario</h1>';
  html += '<p class="page-subtitle">Prossimi episodi delle tue serie in corso (basato su airdate TVMaze)</p>';

  const weekLabel = start.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) + ' – ' + end.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
  html +=
    '<div class="calendar-nav"><div class="calendar-nav-controls">' +
    '<button class="btn btn-secondary btn-sm" data-action="changeWeek" data-delta="-1" aria-label="Settimana precedente">‹</button>' +
    '<span class="calendar-nav-label">' + weekLabel + '</span>' +
    '<button class="btn btn-secondary btn-sm" data-action="changeWeek" data-delta="1" aria-label="Settimana successiva">›</button></div>' +
    (state.calendarWeekOffset !== 0 ? '<button class="btn btn-secondary btn-sm" data-action="resetWeek">Oggi</button>' : '') +
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
      '<div class="calendar-day ' + (isToday ? 'today' : '') + '">' +
      '<div class="calendar-day-header">' + dayName + '</div>' +
      '<div class="calendar-day-date">' + day.getDate() + '</div>' +
      (dayEpisodes.length > 0
        ? dayEpisodes
            .map(
              (ep) =>
                '<div class="calendar-episode" data-action="openShow" data-show-id="' + ep.showId + '">' +
                '<div class="calendar-ep-name">' + escapeHtml(ep.showName) + '</div>' +
                '<div class="calendar-ep-show">S' + ep.season + 'E' + ep.num + (ep.name ? ' · ' + escapeHtml(ep.name) : '') + '</div></div>'
            )
            .join('')
        : '<div style="color:var(--text-muted);font-size:12px;">Nessun episodio</div>') +
      '</div>';
  }
  html += '</div>';

  if (afterWeek.length > 0) {
    html += '<div class="section" style="margin-top:32px;"><h2 class="section-title">In arrivo</h2><div class="episode-list">';
    for (const ep of afterWeek.slice(0, 20)) {
      const epTitle = ep.name
        ? escapeHtml(ep.showName) + ' · ' + escapeHtml(ep.name)
        : escapeHtml(ep.showName) + ' · Stagione ' + ep.season + ', Episodio ' + ep.num;
      html +=
        '<div class="episode-item" data-action="openShow" data-show-id="' + ep.showId + '" style="cursor:pointer;">' +
        '<div class="episode-checkbox"></div>' +
        '<div class="episode-info"><div class="episode-name">' + epTitle + '</div>' +
        '<div class="episode-meta">S' + ep.season + 'E' + ep.num + ' • ' + formatDate(ep.date) + '</div></div></div>';
    }
    html += '</div></div>';
  }

  html += '<div class="section" style="margin-top:32px;"><h2 class="section-title">Da vedere questa settimana</h2>';
  if (week.length === 0) {
    html += '<div class="empty-state"><div class="empty-state-title">Tutto visto!</div><div class="empty-state-text">Nessun episodio in programmazione questa settimana.</div></div>';
  } else {
    html += '<div class="episode-list">';
    for (const ep of week) {
      const epTitle = ep.name
        ? escapeHtml(ep.showName) + ' · ' + escapeHtml(ep.name)
        : escapeHtml(ep.showName) + ' · Stagione ' + ep.season + ', Episodio ' + ep.num;
      html +=
        '<div class="episode-item" data-action="openShow" data-show-id="' + ep.showId + '" style="cursor:pointer;">' +
        '<div class="episode-checkbox"></div>' +
        '<div class="episode-info"><div class="episode-name">' + epTitle + '</div>' +
        '<div class="episode-meta">S' + ep.season + 'E' + ep.num + ' • ' + formatDate(ep.date) + ' • ' + ep.watchedCount + '/' + ep.totalEpisodes + ' episodi visti</div></div></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  main.innerHTML = html;
}

export async function renderCalendar(main: HTMLElement): Promise<void> {
  renderCalendarSkeleton(main);
  try {
    const state = getState();
    const result = await computeCalendarAsync(state.shows, state.calendarWeekOffset);
    renderCalendarContent(main, result.week, result.afterWeek, result.weekStart, result.weekEnd);
  } catch (e) {
    console.error('[calendar] error:', e);
    main.innerHTML =
      '<h1 class="page-title">Calendario</h1>' +
      '<div class="empty-state"><div class="empty-state-title">Errore caricamento</div><div class="empty-state-text">Riprova ad aprire il calendario.</div></div>';
  }
}

export function bindCalendarEvents(main: HTMLElement): void {
  main.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'changeWeek') {
      changeCalendarWeek(Number(actionEl.dataset.delta));
    } else if (action === 'resetWeek') {
      resetCalendarWeek();
    }
  });
}
