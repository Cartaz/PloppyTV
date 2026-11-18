// Vista generica lista serie (watching / towatch / completed)
// P2.3: filtro per tag personalizzabili

import { getState } from '../lib/store';
import { escapeHtml, escapeAttr } from '../lib/utils';
import { t } from '../lib/i18n';
import { showCardHtml, bindKeydown } from './dashboard';
import { getAllUserTags } from '../lib/shows';

// Stato filtro tag (persiste durante la sessione, ma resetta al cambio lista)
let _activeTag: string = '';
// Traccia la lista precedente per resettare _activeTag al cambio.
let _previousList: 'watching' | 'towatch' | 'completed' | '' = '';

export function renderShowList(main: HTMLElement, list: 'watching' | 'towatch' | 'completed', title: string): void {
  // Reset _activeTag quando l'utente cambia lista. Prima il
  // filter persisteva across le liste, intrappolando l'utente se il tag
  // non esisteva nella nuova lista (nessun chip "Tutti" renderizzato).
  if (_previousList !== list) {
    _activeTag = '';
    _previousList = list;
  }

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

  // Mostra la tag-filter-bar se ci sono tag nella lista OPPURE
  // se c'è un _activeTag set (così l'utente può sempre clearare via "Tutti",
  // anche se il tag attivo non esiste più in nessuna serie — es. rimosso
  // dall'utente o serie eliminata).
  if (tagsInList.length > 0 || _activeTag !== '') {
    html += '<div class="tag-filter-bar">';
    html +=
      '<button class="tag-filter-chip' +
      (_activeTag === '' ? ' active' : '') +
      '" data-tag="">' +
      escapeHtml(t('common.all')) +
      '</button>';
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
      '<div class="empty-state"><div class="empty-state-title">' +
      escapeHtml(t('library.empty')) +
      '</div><div class="empty-state-text">' +
      (_activeTag ? escapeHtml(t('library.noTagMatch', { tag: _activeTag })) : escapeHtml(t('library.empty.desc'))) +
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

  // Bind keydown (Enter/Space su role="button") — deferred a
  // bindKeydown della dashboard, che è idempotente (WeakSet). Così la
  // tastiera funziona anche se l'utente atterra qui senza prima passare
  // dalla dashboard.
  bindKeydown(main);
}
