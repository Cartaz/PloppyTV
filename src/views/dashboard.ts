// Vista Dashboard

import type { Show } from '../types';
import { getState } from '../lib/store';
import { getWatchedCount, findNextEpisode, escapeHtml, escapeAttr } from '../lib/utils';
import { imgTag } from '../components/img';

function showCardHtml(show: Show): string {
  const watched = getWatchedCount(show);
  // BUG-13-01: clamp progress to [0, 100] (defense-in-depth, matches stats.ts H19).
  // For corrupt/imported data (watched > totalEpisodes), without the clamp we'd
  // emit style="width:166%" — visually clipped by .show-card but semantically
  // misleading.
  const progress = show.totalEpisodes > 0 ? Math.max(0, Math.min(100, (watched / show.totalEpisodes) * 100)) : 0;
  const isCompleted = show.list === 'completed' || (show.totalEpisodes > 0 && watched >= show.totalEpisodes);
  return (
    '<div class="show-card" role="button" tabindex="0" aria-label="' +
    escapeAttr(show.name) +
    '" data-action="openShow" data-show-id="' +
    escapeAttr(String(show.id)) +
    '">' +
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

/**
 * BUG-13-05 (a11y): clickable cards (show-card, continue-card, section-link)
 * are <div>/<span> elements with data-action. They now carry role="button"
 * tabindex="0" so they are focusable + announced as buttons to assistive tech.
 * This helper installs a single keydown listener (guarded per-element via
 * dataset.kbdBound) that converts Enter/Space on a focused [data-action]
 * element into a click — letting keyboard users activate the same actions
 * mouse users do via the global click delegation in renderer.ts.
 *
 * Safe to call from any view render: the listener is added at most once per
 * `main` element, regardless of how many views render into it.
 */
export function bindKeyboardNav(main: HTMLElement): void {
  if (main.dataset.kbdBound === '1') return;
  main.dataset.kbdBound = '1';
  main.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    // Only fire when the focused element IS the action element (the div/span
    // with role="button"). Otherwise Enter/Space on inner non-action nodes
    // (e.g. the <img> inside a card) would incorrectly trigger navigation.
    if (target !== actionEl) return;
    e.preventDefault();
    actionEl.click();
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
    bindKeyboardNav(main);
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

  const continueWatching = watching.filter((s) => getWatchedCount(s) < s.totalEpisodes).slice(0, 8);
  if (continueWatching.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Continua a guardare</h2></div><div class="continue-grid">';
    for (const show of continueWatching) {
      const watched = getWatchedCount(show);
      const nextEp = findNextEpisode(show);
      // BUG-13-03: defensive guard — findNextEpisode does not filter ep.num>0
      // (it filters only season keys). normalizeShow filters num>0 at ingress,
      // but a directly-mutated state could hold num=0 episodes; suppress the
      // "Prossimo: Stagione N, Ep 0" display in that case and fall back to the
      // "X/Y episodi" line.
      const hasNext = nextEp && nextEp.num > 0;
      html +=
        '<div class="continue-card" role="button" tabindex="0" aria-label="' +
        escapeAttr(show.name) +
        '" data-action="openShow" data-show-id="' +
        escapeAttr(String(show.id)) +
        '">' +
        imgTag(show.image, show.name, 'continue-card-poster') +
        '<div class="continue-card-body"><div>' +
        '<div class="continue-card-name">' +
        escapeHtml(show.name) +
        '</div>' +
        (hasNext
          ? '<div class="continue-card-ep">Prossimo: Stagione ' + nextEp!.season + ', Ep ' + nextEp!.num + '</div>'
          : '<div class="continue-card-ep">' + watched + '/' + show.totalEpisodes + ' episodi</div>') +
        '</div><div class="continue-card-btn">Continua</div></div></div>';
    }
    html += '</div></div>';
  }

  if (watching.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Sto guardando</h2><span class="section-link" role="button" tabindex="0" data-action="switchView" data-view="watching">Vedi tutte</span></div>';
    html += '<div class="card-grid">' + watching.slice(0, 12).map(showCardHtml).join('') + '</div></div>';
  }
  if (towatch.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Da vedere</h2><span class="section-link" role="button" tabindex="0" data-action="switchView" data-view="towatch">Vedi tutte</span></div>';
    html += '<div class="card-grid">' + towatch.slice(0, 12).map(showCardHtml).join('') + '</div></div>';
  }
  if (completed.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Completate</h2><span class="section-link" role="button" tabindex="0" data-action="switchView" data-view="completed">Vedi tutte</span></div>';
    html += '<div class="card-grid">' + completed.slice(0, 12).map(showCardHtml).join('') + '</div></div>';
  }
  main.innerHTML = html;
  bindKeyboardNav(main);
}

export { showCardHtml };
