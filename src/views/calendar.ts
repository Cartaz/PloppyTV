// Vista calendario: usa Web Worker per il calcolo

import { getState, changeCalendarWeek, resetCalendarWeek } from '../lib/store';
import { computeCalendarAsync } from '../worker/client';
import { escapeHtml, escapeAttr, formatDate, parseISODateLocal, isSameLocalDay } from '../lib/utils';
import type { CalendarEpisode } from '../types';
import { t } from '../lib/i18n';

function safeNumLabel(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0) {
    return String(v);
  }
  return '?';
}

let _calendarClickHandler: ((e: MouseEvent) => void) | null = null;
let _calendarKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let _calendarMain: HTMLElement | null = null;
// Render token — last-STARTED render wins (not last-resolved).
let _calendarRenderToken = 0;

function renderCalendarSkeleton(main: HTMLElement): void {
  main.innerHTML =
    '<h1 class="page-title">' +
    t('calendar.title') +
    '</h1>' +
    '<p class="page-subtitle">' +
    t('calendar.prossimiEpisodiDelleTue') +
    '</p>' +
    '<div class="loading"><div class="spinner"></div>' +
    t('calendar.calcolandoEpisodi') +
    '</div>';
}

function renderCalendarContent(
  main: HTMLElement,
  weekIn: CalendarEpisode[],
  afterWeekIn: CalendarEpisode[],
  weekStart: string,
  weekEnd: string,
): void {
  // Null check esplicito su weekStart/weekEnd.
  const start = parseISODateLocal(weekStart);
  const end = parseISODateLocal(weekEnd);
  if (!start || !end) {
    main.innerHTML =
      '<h1 class="page-title">' +
      t('calendar.title') +
      '</h1>' +
      '<div class="empty-state"><div class="empty-state-title">' +
      t('calendar.erroreDate') +
      '</div><div class="empty-state-text">' +
      t('calendar.dateSettimanaSonoValide') +
      '</div></div>';
    return;
  }

  // Defensive coercion (worker/corrupted data).
  const week = weekIn;
  const afterWeek = afterWeekIn;

  const state = getState();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekDays = [
    t('calendar.lunedi'),
    t('calendar.martedi'),
    t('calendar.mercoledi'),
    t('calendar.giovedi'),
    t('calendar.venerdi'),
    t('calendar.sabato'),
    t('calendar.domenica'),
  ];

  // Raggruppa per giorno della settimana corrente (gli episodi con data malformata vengono saltati).
  const byDay: CalendarEpisode[][] = [[], [], [], [], [], [], []];
  for (const ep of week) {
    const epDate = parseISODateLocal(ep.date);
    if (!epDate) continue; // skip episodi con data malformata
    const dayIdx = (epDate.getDay() + 6) % 7; // 0=Lun
    byDay[dayIdx].push(ep);
  }

  let html = '<h1 class="page-title">' + t('calendar.title') + '</h1>';
  html += '<p class="page-subtitle">' + t('calendar.prossimiEpisodiDelleTue') + '</p>';

  const weekLabel =
    start.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) +
    ' – ' +
    end.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
  html +=
    '<div class="calendar-nav"><div class="calendar-nav-controls">' +
    '<button class="btn btn-secondary btn-sm" data-action="changeWeek" data-delta="-1" aria-label="' +
    t('calendar.prevWeek') +
    '">‹</button>' +
    '<span class="calendar-nav-label">' +
    weekLabel +
    '</span>' +
    '<button class="btn btn-secondary btn-sm" data-action="changeWeek" data-delta="1" aria-label="' +
    t('calendar.nextWeek') +
    '">›</button></div>' +
    (state.calendarWeekOffset !== 0
      ? '<button class="btn btn-secondary btn-sm" data-action="resetWeek">' + t('calendar.oggi') + '</button>'
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
                // escapeAttr su showId (defense-in-depth contro
                // showId non-number che romperebbe l'attributo).
                '<div class="calendar-episode" data-action="openShow" data-show-id="' +
                escapeAttr(ep.showId) +
                '">' +
                '<div class="calendar-ep-name">' +
                escapeHtml(ep.showName) +
                '</div>' +
                '<div class="calendar-ep-show">S' +
                // safeNumLabel valida season/num.
                safeNumLabel(ep.season) +
                'E' +
                safeNumLabel(ep.num) +
                (ep.name ? ' · ' + escapeHtml(ep.name) : '') +
                '</div></div>',
            )
            .join('')
        : '<div style="color:var(--text-muted);font-size:12px;">' + t('calendar.nessunEpisodio') + '</div>') +
      '</div>';
  }
  html += '</div>';

  if (afterWeek.length > 0) {
    // slice(0,20) + "altri" indicator.
    const cap = 20;
    const shown = afterWeek.slice(0, cap);
    const remaining = afterWeek.length - shown.length;
    html +=
      '<div class="section" style="margin-top:32px;"><h2 class="section-title">' +
      t('calendar.arrivo') +
      '</h2><div class="episode-list">';
    for (const ep of shown) {
      const epTitle = ep.name
        ? escapeHtml(ep.showName) + ' · ' + escapeHtml(ep.name)
        : escapeHtml(ep.showName) +
          ' · ' +
          t('calendar.seasonEpisode', { season: safeNumLabel(ep.season), ep: safeNumLabel(ep.num) });
      html +=
        '<div class="episode-item" data-action="openShow" data-show-id="' +
        escapeAttr(ep.showId) +
        '" style="cursor:pointer;">' +
        '<div class="episode-checkbox"></div>' +
        '<div class="episode-info"><div class="episode-name">' +
        epTitle +
        '</div>' +
        '<div class="episode-meta">S' +
        safeNumLabel(ep.season) +
        'E' +
        safeNumLabel(ep.num) +
        ' • ' +
        formatDate(ep.date) +
        '</div></div></div>';
    }
    if (remaining > 0) {
      html += '<div class="episode-more">' + t('calendar.more', { count: remaining }) + '</div>';
    }
    html += '</div></div>';
  }

  html +=
    '<div class="section" style="margin-top:32px;"><h2 class="section-title">' +
    t('calendar.vedereQuestaSettimana') +
    '</h2>';
  if (week.length === 0) {
    html +=
      '<div class="empty-state"><div class="empty-state-title">' +
      t('calendar.tuttoVisto') +
      '</div><div class="empty-state-text">' +
      t('calendar.nessunEpisodioProgrammazioneQuesta') +
      '</div></div>';
  } else {
    html += '<div class="episode-list">';
    for (const ep of week) {
      const epTitle = ep.name
        ? escapeHtml(ep.showName) + ' · ' + escapeHtml(ep.name)
        : escapeHtml(ep.showName) +
          ' · ' +
          t('calendar.seasonEpisode', { season: safeNumLabel(ep.season), ep: safeNumLabel(ep.num) });
      html +=
        '<div class="episode-item" data-action="openShow" data-show-id="' +
        escapeAttr(ep.showId) +
        '" style="cursor:pointer;">' +
        '<div class="episode-checkbox"></div>' +
        '<div class="episode-info"><div class="episode-name">' +
        epTitle +
        '</div>' +
        '<div class="episode-meta">S' +
        safeNumLabel(ep.season) +
        'E' +
        safeNumLabel(ep.num) +
        ' • ' +
        formatDate(ep.date) +
        ' • ' +
        t('common.watchedOf', { watched: ep.watchedCount, total: ep.totalEpisodes }) +
        '</div></div></div>';
    }
    html += '</div>';
  }
  html += '</div>';
  main.innerHTML = html;
}

export async function renderCalendar(main: HTMLElement): Promise<void> {
  // Token increment — last-STARTED render wins.
  const myToken = ++_calendarRenderToken;
  // Capture the view/show state at the START of the render. We only
  // enforce the cross-view race check if we were actually on 'calendar' with no
  // show detail open at the start — this preserves compatibility with tests
  // that call renderCalendar directly without setting currentView, and with
  // stores that don't expose currentView (mocked).
  const startView = getState().currentView;
  const startShowId = getState().currentShowId;
  const wasCalendarActive = startView === 'calendar' && startShowId === null;
  renderCalendarSkeleton(main);
  try {
    const state = getState();
    const result = await computeCalendarAsync(state.shows, state.calendarWeekOffset);
    // Discard if a newer render has started.
    if (myToken !== _calendarRenderToken) return;
    // Cross-view race protection. Il token qui sopra protegge solo
    // contro nuove renderCalendar (stessa vista). Se l'utente ha cambiato vista
    // o aperto un detail mentre il worker calcolava, _calendarRenderToken non
    // è stato incrementato (nessuna nuova renderCalendar chiamata), ma applicare
    // il risultato stale sovrascriverebbe il DOM della nuova vista.
    if (wasCalendarActive) {
      const postState = getState();
      if (postState.currentView !== 'calendar') return;
      if (postState.currentShowId !== null) return;
    }
    renderCalendarContent(main, result.week, result.afterWeek, result.weekStart, result.weekEnd);
  } catch (e) {
    if (myToken !== _calendarRenderToken) return;
    // Stessa protezione cross-view nel path di errore.
    if (wasCalendarActive) {
      const postState = getState();
      if (postState.currentView !== 'calendar') return;
      if (postState.currentShowId !== null) return;
    }
    console.error('[calendar] error:', e);
    main.innerHTML =
      '<h1 class="page-title">' +
      t('calendar.title') +
      '</h1>' +
      '<div class="empty-state"><div class="empty-state-title">' +
      t('calendar.error.title') +
      '</div><div class="empty-state-text">' +
      t('calendar.riprovaAdAprireCalendario') +
      '</div></div>';
  }
}

export function bindCalendarEvents(main: HTMLElement): void {
  // Rimuovi il vecchio handler se presente SULLO STESSO main.
  // Se il main è diverso (es. nuovo elemento in un nuovo test), non c'è nulla
  // da rimuovere — il vecchio handler era bound a un main ormai scartato.
  if (_calendarClickHandler && _calendarMain === main) {
    main.removeEventListener('click', _calendarClickHandler);
  }
  if (_calendarKeydownHandler && _calendarMain === main) {
    main.removeEventListener('keydown', _calendarKeydownHandler);
  }
  _calendarMain = main;

  const clickHandler = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'changeWeek') {
      // Guard contro NaN/Infinity (data-delta mancante).
      const delta = Number(actionEl.dataset.delta);
      if (!Number.isFinite(delta)) return;
      changeCalendarWeek(delta);
    } else if (action === 'resetWeek') {
      resetCalendarWeek();
    }
  };
  const keydownHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.getAttribute('role') === 'button' || target.tagName === 'BUTTON') {
      e.preventDefault();
      target.click();
    }
  };
  _calendarClickHandler = clickHandler;
  _calendarKeydownHandler = keydownHandler;
  main.addEventListener('click', clickHandler);
  main.addEventListener('keydown', keydownHandler);
}
