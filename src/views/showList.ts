// Vista generica lista serie (watching / towatch / completed)
// P2.3: filtro per tag personalizzabili
//
// FIXES applicati:
//  - BUG-A10-02 [MEDIUM]: _activeTag era state module-level che persisteva
//    across list switches. Se l'utente filtrava per tag "drama" nella
//    lista "watching" e poi switchava a "completed" (che non contiene
//    quel tag), la tag-filter-bar spariva (tagsInList vuoto), l'empty-state
//    mostrava "Nessuna serie con il tag drama" e l'utente era intrappolato
//    senza UI per clearare il filtro. Fix: (a) reset _activeTag quando
//    `list` cambia; (b) renderizza sempre il chip "Tutti" quando c'è un
//    _activeTag set (anche se tagsInList è vuoto), così l'utente può
//    sempre clearare.
//  - BUG-A10-03 [MEDIUM]: la navigazione via tastiera (Enter/Space su
//    role="button") era rotta se l'utente atterrava su una lista senza
//    prima renderizzare la dashboard (es. currentView restaurato da
//    storage). Root cause: bindKeydown era chiamato solo da renderDashboard.
//    Fix: importato bindKeydown da dashboard.ts e richiamato qui.

import { getState } from '../lib/store';
import { escapeHtml, escapeAttr } from '../lib/utils';
import { showCardHtml, bindKeydown } from './dashboard';
import { getAllUserTags } from '../lib/shows';

// Stato filtro tag (persiste durante la sessione, ma resetta al cambio lista)
let _activeTag: string = '';
// BUG-A10-02: traccia la lista precedente per resettare _activeTag al cambio.
let _previousList: 'watching' | 'towatch' | 'completed' | '' = '';

/**
 * Resetta lo stato interno della vista (solo per testing). NON usare in prod.
 */
export function _resetShowListStateForTesting(): void {
  _activeTag = '';
  _previousList = '';
}

export function renderShowList(main: HTMLElement, list: 'watching' | 'towatch' | 'completed', title: string): void {
  // BUG-A10-02: reset _activeTag quando l'utente cambia lista. Prima il
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

  // BUG-A10-02: mostra la tag-filter-bar se ci sono tag nella lista OPPURE
  // se c'è un _activeTag set (così l'utente può sempre clearare via "Tutti",
  // anche se il tag attivo non esiste più in nessuna serie — es. rimosso
  // dall'utente o serie eliminata).
  if (tagsInList.length > 0 || _activeTag !== '') {
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

  // BUG-A10-03: bind keydown (Enter/Space su role="button") — deferred a
  // bindKeydown della dashboard, che è idempotente (WeakSet). Così la
  // tastiera funziona anche se l'utente atterra qui senza prima passare
  // dalla dashboard.
  bindKeydown(main);
}
