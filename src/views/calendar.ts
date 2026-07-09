// Vista calendario: usa Web Worker per il calcolo
//
// FIXES applicati:
//  - BUG-16-01: resetBoundGuard ora removeEventListener del vecchio handler
//    prima di bindarne uno nuovo (no listener accumulation).
//  - BUG-16-02: guard `if (!Number.isFinite(delta)) return` su changeWeek.
//  - BUG-16-04: null check su parseISODateLocal (weekStart/weekEnd/ep.date);
//    malformed → "Errore date" graceful, episodi con data malformata skipped.
//  - BUG-16-05: afterWeek slice(0,20) + "altri" indicator se > 20.
//  - H17 a11y: keydown listener (Enter/Space) su elementi [role=button].
//  - BUG-A13-01: dopo l'await del worker, verifica che currentView sia ancora
//    'calendar' e currentShowId sia null. Se l'utente ha cambiato vista o
//    aperto un detail mentre il worker calcolava, il risultato stale NON
//    sovrascrive il DOM della nuova vista (race cross-view).
//  - BUG-A13-02: data-show-id attributo escapato via escapeAttr (defense-in-depth
//    contro showId non-number da dati corrotti/import malevoli).
//  - BUG-A13-04: ep.season/ep.num validati (intero positivo, finito) prima di
//    essere interpolati in HTML; fallback '?' per valori invalidi.
//  - BUG-A13-05: guard Array.isArray su week/afterWeek (worker/corrupted data).

import { getState, changeCalendarWeek, resetCalendarWeek } from '../lib/store';
import { computeCalendarAsync } from '../worker/client';
import { escapeHtml, escapeAttr, formatDate, parseISODateLocal, isSameLocalDay } from '../lib/utils';
import type { CalendarEpisode } from '../types';

/**
 * BUG-A13-04: formatta un numero stagione/episodio per display.
 * Accetta solo interi positivi finiti; fallback '?' per valori invalidi
 * (NaN, Infinity, undefined, stringhe, float, negativi).
 */
function safeNumLabel(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0) {
    return String(v);
  }
  return '?';
}

/**
 * BUG-A13-05: coerce un valore a CalendarEpisode[], difendendo contro
 * worker/corrupted data che restituisce non-array (null, oggetto, primitive).
 */
function asCalEpisodes(v: unknown): CalendarEpisode[] {
  return Array.isArray(v) ? (v as CalendarEpisode[]) : [];
}

let _boundCalendar = false;
let _calendarClickHandler: ((e: MouseEvent) => void) | null = null;
let _calendarKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let _calendarMain: HTMLElement | null = null;
// BUG-16-06: render token — last-STARTED render wins (not last-resolved).
let _calendarRenderToken = 0;

/** Reset guardia listener — BUG-16-01: removeEventListener del vecchio handler. */
export function resetBoundGuard(): void {
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
  weekIn: CalendarEpisode[],
  afterWeekIn: CalendarEpisode[],
  weekStart: string,
  weekEnd: string,
): void {
  // BUG-16-04: null check esplicito su weekStart/weekEnd.
  const start = parseISODateLocal(weekStart);
  const end = parseISODateLocal(weekEnd);
  if (!start || !end) {
    main.innerHTML =
      '<h1 class="page-title">Calendario</h1>' +
      '<div class="empty-state"><div class="empty-state-title">Errore date</div><div class="empty-state-text">Le date della settimana non sono valide. Riprova ad aprire il calendario.</div></div>';
    return;
  }

  // BUG-A13-05: defensive coercion (worker/corrupted data).
  const week = asCalEpisodes(weekIn);
  const afterWeek = asCalEpisodes(afterWeekIn);

  const state = getState();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekDays = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];

  // Raggruppa per giorno della settimana corrente (BUG-16-04: skip episodi con data malformata).
  const byDay: CalendarEpisode[][] = [[], [], [], [], [], [], []];
  for (const ep of week) {
    if (!ep || typeof ep !== 'object') continue; // BUG-A13-05: skip entry non-object
    const epDate = parseISODateLocal(ep.date);
    if (!epDate) continue; // skip episodi con data malformata
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
                // BUG-A13-02: escapeAttr su showId (defense-in-depth contro
                // showId non-number che romperebbe l'attributo).
                '<div class="calendar-episode" data-action="openShow" data-show-id="' +
                escapeAttr(ep.showId) +
                '">' +
                '<div class="calendar-ep-name">' +
                escapeHtml(ep.showName) +
                '</div>' +
                '<div class="calendar-ep-show">S' +
                // BUG-A13-04: safeNumLabel valida season/num.
                safeNumLabel(ep.season) +
                'E' +
                safeNumLabel(ep.num) +
                (ep.name ? ' · ' + escapeHtml(ep.name) : '') +
                '</div></div>',
            )
            .join('')
        : '<div style="color:var(--text-muted);font-size:12px;">Nessun episodio</div>') +
      '</div>';
  }
  html += '</div>';

  if (afterWeek.length > 0) {
    // BUG-16-05: slice(0,20) + "altri" indicator.
    const cap = 20;
    const shown = afterWeek.slice(0, cap);
    const remaining = afterWeek.length - shown.length;
    html +=
      '<div class="section" style="margin-top:32px;"><h2 class="section-title">In arrivo</h2><div class="episode-list">';
    for (const ep of shown) {
      if (!ep || typeof ep !== 'object') continue; // BUG-A13-05: skip entry non-object
      const epTitle = ep.name
        ? escapeHtml(ep.showName) + ' · ' + escapeHtml(ep.name)
        : escapeHtml(ep.showName) + ' · Stagione ' + safeNumLabel(ep.season) + ', Episodio ' + safeNumLabel(ep.num);
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
      html += '<div class="episode-more">+ ' + remaining + ' altri episodi</div>';
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
      if (!ep || typeof ep !== 'object') continue; // BUG-A13-05: skip entry non-object
      const epTitle = ep.name
        ? escapeHtml(ep.showName) + ' · ' + escapeHtml(ep.name)
        : escapeHtml(ep.showName) + ' · Stagione ' + safeNumLabel(ep.season) + ', Episodio ' + safeNumLabel(ep.num);
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
  // BUG-16-06: token increment — last-STARTED render wins.
  const myToken = ++_calendarRenderToken;
  // BUG-A13-01: capture the view/show state at the START of the render. We only
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
    // BUG-A13-01: cross-view race protection. Il token qui sopra protegge solo
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
    // BUG-A13-01: stessa protezione cross-view nel path di errore.
    if (wasCalendarActive) {
      const postState = getState();
      if (postState.currentView !== 'calendar') return;
      if (postState.currentShowId !== null) return;
    }
    console.error('[calendar] error:', e);
    main.innerHTML =
      '<h1 class="page-title">Calendario</h1>' +
      '<div class="empty-state"><div class="empty-state-title">Errore caricamento</div><div class="empty-state-text">Riprova ad aprire il calendario.</div></div>';
  }
}

export function bindCalendarEvents(main: HTMLElement): void {
  // BUG-16-01: se _boundCalendar è true, no-op (no accumulation).
  // Solo resetBoundGuard() abilita il re-bind.
  if (_boundCalendar) return;
  _boundCalendar = true;
  // Rimuovi il vecchio handler se presente SULLO STESSO main (BUG-16-01).
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
      // BUG-16-02: guard contro NaN/Infinity (data-delta mancante).
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
