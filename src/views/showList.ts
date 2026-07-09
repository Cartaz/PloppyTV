// Vista generica lista serie (watching / towatch / completed)

import { getState } from '../lib/store';
import { escapeHtml } from '../lib/utils';
import { showCardHtml } from './dashboard';

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
}
