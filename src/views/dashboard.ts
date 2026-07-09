// Vista Dashboard
//
// FIXES applicati:
//  - BUG-13-01: progress bar clamped a [0, 100] (no >100% su dati corrotti).
//  - BUG-13-03: continue-card mostra "Prossimo" solo se nextEp.num > 0.
//  - BUG-13-04: data-show-id escapato via escapeAttr (defense-in-depth).
//  - BUG-13-05: a11y — show-card/continue-card/section-link hanno role=button,
//    tabindex=0, e keydown listener (Enter/Space) che triggera click.
//    Il keydown listener è bound una sola volta per main (no accumulation).

import type { Show } from '../types';
import { getState } from '../lib/store';
import { getWatchedCount, findNextEpisode, escapeHtml, escapeAttr } from '../lib/utils';
import { imgTag } from '../components/img';

function showCardHtml(show: Show): string {
  const watched = getWatchedCount(show);
  // BUG-13-01: clamp a [0, 100] per gestire watched > totalEpisodes (dati corrotti).
  const rawProgress = show.totalEpisodes > 0 ? (watched / show.totalEpisodes) * 100 : 0;
  const progress = Math.max(0, Math.min(100, rawProgress));
  const isCompleted = show.list === 'completed' || (show.totalEpisodes > 0 && watched >= show.totalEpisodes);
  return (
    '<div class="show-card" data-action="openShow" data-show-id="' +
    escapeAttr(show.id) +
    '" role="button" tabindex="0">' +
    (show.image
      ? imgTag(show.image, show.name, 'show-card-poster')
      : '<div class="show-card-placeholder">' + escapeHtml(show.name) + '</div>') +
    '<div class="show-card-info"><div class="show-card-name">' +
    escapeHtml(show.name) +
    '</div>' +
    '<div class="show-card-meta">' +
    watched +
    '/' +
    show.totalEpisodes +
    ' ep</div></div>' +
    '<div class="show-card-progress"><div class="show-card-progress-bar' +
    (isCompleted ? ' completed' : '') +
    '" style="width:' +
    progress +
    '%"></div></div>' +
    '</div>'
  );
}

// Bound keydown listener su main — singleton per evitare accumulation.
const _dashboardKeydownBound = new WeakSet<HTMLElement>();

function bindKeydown(main: HTMLElement): void {
  if (_dashboardKeydownBound.has(main)) return;
  _dashboardKeydownBound.add(main);
  main.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    // Triggera click solo su elementi con role=button (show-card, continue-card, section-link).
    if (target.getAttribute('role') === 'button') {
      ev.preventDefault();
      target.click();
    }
  });
}

export function renderDashboard(main: HTMLElement): void {
  const state = getState();
  const watching = state.shows.filter((s) => s.list === 'watching');
  const towatch = state.shows.filter((s) => s.list === 'towatch');
  const completed = state.shows.filter((s) => s.list === 'completed');
  const totalShows = state.shows.length;
  const totalWatched = state.shows.reduce((sum, s) => sum + getWatchedCount(s), 0);

  let html = '<h1 class="page-title">Dashboard</h1>';

  if (totalShows === 0) {
    html +=
      '<div class="empty-state">' +
      '<svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' +
      '<div class="empty-state-title">Benvenuto in PloppyTV!</div>' +
      '<div class="empty-state-text">Non hai ancora aggiunto nessuna serie. Usa la barra di ricerca in alto per trovare le tue serie TV preferite.</div>' +
      '</div>';
    main.innerHTML = html;
    bindKeydown(main);
    return;
  }

  html +=
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-value">' +
    totalShows +
    '</div><div class="stat-label">Serie tracciate</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    totalWatched +
    '</div><div class="stat-label">Episodi visti</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    watching.length +
    '</div><div class="stat-label">In corso</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    completed.length +
    '</div><div class="stat-label">Completate</div></div>' +
    '</div>';

  // continueWatching: include solo show con episodi da guardare (watched < totalEpisodes).
  const continueWatching = watching
    .filter((s) => s.totalEpisodes > 0 && getWatchedCount(s) < s.totalEpisodes)
    .slice(0, 8);
  if (continueWatching.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Continua a guardare</h2></div><div class="continue-grid">';
    for (const show of continueWatching) {
      const watched = getWatchedCount(show);
      const nextEp = findNextEpisode(show);
      html +=
        '<div class="continue-card" data-action="openShow" data-show-id="' +
        escapeAttr(show.id) +
        '" role="button" tabindex="0">' +
        imgTag(show.image, show.name, 'continue-card-poster') +
        '<div class="continue-card-body"><div>' +
        '<div class="continue-card-name">' +
        escapeHtml(show.name) +
        '</div>' +
        // BUG-13-03: mostra "Prossimo" solo se nextEp ha num > 0.
        (nextEp && nextEp.num > 0
          ? '<div class="continue-card-ep">Prossimo: Stagione ' + nextEp.season + ', Ep ' + nextEp.num + '</div>'
          : '<div class="continue-card-ep">' + watched + '/' + show.totalEpisodes + ' episodi</div>') +
        '</div><div class="continue-card-btn">Continua</div></div></div>';
    }
    html += '</div></div>';
  }

  if (watching.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Sto guardando</h2><span class="section-link" data-action="switchView" data-view="watching" role="button" tabindex="0">Vedi tutte</span></div>';
    html += '<div class="card-grid">' + watching.slice(0, 12).map(showCardHtml).join('') + '</div></div>';
  }
  if (towatch.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Da vedere</h2><span class="section-link" data-action="switchView" data-view="towatch" role="button" tabindex="0">Vedi tutte</span></div>';
    html += '<div class="card-grid">' + towatch.slice(0, 12).map(showCardHtml).join('') + '</div></div>';
  }
  if (completed.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Completate</h2><span class="section-link" data-action="switchView" data-view="completed" role="button" tabindex="0">Vedi tutte</span></div>';
    html += '<div class="card-grid">' + completed.slice(0, 12).map(showCardHtml).join('') + '</div></div>';
  }
  main.innerHTML = html;
  bindKeydown(main);
}

export { showCardHtml };
