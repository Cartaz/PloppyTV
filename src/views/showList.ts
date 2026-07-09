// Vista generica lista serie (watching / towatch / completed)
// P2.3: filtro per tag personalizzabili

import { getState } from '../lib/store';
import { escapeHtml, escapeAttr } from '../lib/utils';
import { showCardHtml } from './dashboard';
import { getAllUserTags } from '../lib/shows';

// Stato filtro tag (persiste durante la sessione)
let _activeTag: string = '';

export function renderShowList(main: HTMLElement, list: 'watching' | 'towatch' | 'completed', title: string): void {
  let shows = getState().shows.filter((s) => s.list === list);

  // Se c'è un tag attivo, filtra
  if (_activeTag) {
    shows = shows.filter((s) => (s.tags || []).some((t) => t.toLowerCase() === _activeTag.toLowerCase()));
  }

  let html = '<h1 class="page-title">' + escapeHtml(title) + '</h1>';

  // Tag filter bar (solo se ci sono tag nell'utente)
  const allTags = getAllUserTags();
  const tagsInList = allTags.filter((tag) =>
    getState().shows.some((s) => s.list === list && (s.tags || []).some((t) => t.toLowerCase() === tag.toLowerCase())),
  );

  if (tagsInList.length > 0) {
    html += '<div class="tag-filter-bar">';
    html += '<button class="tag-filter-chip' + (_activeTag === '' ? ' active' : '') + '" data-tag="">Tutti</button>';
    for (const tag of tagsInList) {
      html +=
        '<button class="tag-filter-chip' +
        (_activeTag.toLowerCase() === tag.toLowerCase() ? ' active' : '') +
        '" data-tag="' +
        escapeAttr(tag) +
        '">' +
        escapeHtml(tag) +
        '</button>';
    }
    html += '</div>';
  }

  if (shows.length === 0) {
    html +=
      '<div class="empty-state"><div class="empty-state-title">Nessuna serie</div><div class="empty-state-text">' +
      (_activeTag
        ? 'Nessuna serie con il tag "' + escapeHtml(_activeTag) + '" in questa lista.'
        : 'Non hai serie in questa lista.') +
      '</div></div>';
  } else {
    html += '<div class="card-grid">' + shows.map(showCardHtml).join('') + '</div>';
  }
  main.innerHTML = html;

  // Bind tag filter clicks
  main.querySelectorAll('.tag-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      _activeTag = (chip as HTMLElement).dataset.tag || '';
      renderShowList(main, list, title);
    });
  });
}
