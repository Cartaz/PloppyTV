// Vista generica lista serie (watching / towatch / completed)

import { getState } from '../lib/store';
import { escapeHtml } from '../lib/utils';
import { showCardHtml, bindKeyboardNav } from './dashboard';

export function renderShowList(main: HTMLElement, list: 'watching' | 'towatch' | 'completed', title: string): void {
  const shows = getState().shows.filter((s) => s.list === list);
  let html = '<h1 class="page-title">' + escapeHtml(title) + '</h1>';
  if (shows.length === 0) {
    html +=
      '<div class="empty-state"><div class="empty-state-title">Nessuna serie</div><div class="empty-state-text">Non hai serie in questa lista.</div></div>';
  } else {
    html += '<div class="card-grid">' + shows.map(showCardHtml).join('') + '</div>';
  }
  main.innerHTML = html;
  // BUG-13-05 (a11y): show-card divs already carry role="button" tabindex="0"
  // (via showCardHtml in dashboard.ts). Wire the same keydown handler as the
  // dashboard so Enter/Space on a focused card opens the show. Safe no-op if
  // dashboard already bound it on the same `main` element (per-element guard).
  bindKeyboardNav(main);
}
