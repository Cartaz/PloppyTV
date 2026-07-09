// Search box: input -> API TVMaze, fallback fuzzy, keyboard nav
//
// FIXES applicati:
//  - BUG-10-02: Escape cleara lastSearchResults/DOM + abortisce in-flight.
//  - BUG-10-03: click outside cleara DOM/lastSearchResults.
//  - BUG-10-05: selectSearchResult retain input quando addShowToList fallisce.
//  - BUG-10-07: fallback altQuery error (Network/Timeout) propaga al outer catch.
//  - BUG-20-08: ARIA combobox/listbox/option/aria-selected/aria-expanded.

import type { ListName, TvmazeSearchResult } from '../types';
import { searchShows, ApiError } from '../lib/api';
import { MAX_QUERY_LENGTH, MIN_SEARCH_INTERVAL_MS } from '../lib/constants';
import { escapeHtml, escapeAttr, getPosterUrl, parseISODateLocal } from '../lib/utils';
import { addShowToList } from '../lib/shows';
import { showToast } from './toast';

let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSearchResults: TvmazeSearchResult[] = [];
let searchSeq = 0;
let searchAbortController: AbortController | null = null;
let searchSelectedIdx = -1;
let lastSearchTime = 0;

let _searchInput: HTMLInputElement | null = null;
let _searchResults: HTMLElement | null = null;

function renderSearchResultsHTML(results: TvmazeSearchResult[] | null, fallbackNote?: string): string | null {
  lastSearchResults = (results || []).filter((r): r is TvmazeSearchResult => !!r && !!r.show);
  searchSelectedIdx = -1;
  if (lastSearchResults.length === 0) return null;
  let html = '';
  if (fallbackNote) {
    html +=
      '<div style="padding:8px 12px;background:var(--accent-dim);color:var(--accent);font-size:12px;border-bottom:1px solid var(--border);">' +
      escapeHtml(fallbackNote) +
      '</div>';
  }
  html += lastSearchResults
    .slice(0, 10)
    .map((r, idx) => {
      const show = r.show;
      const img = getPosterUrl(show);
      const year = show.premiered
        ? parseISODateLocal(show.premiered)
          ? parseISODateLocal(show.premiered)!.getFullYear()
          : 'N/D'
        : 'N/D';
      const network = (show.network && show.network.name) || (show.webChannel && show.webChannel.name) || 'N/D';
      return (
        // BUG-20-08: role=option, aria-selected=false sui result items.
        '<div class="search-result-item" role="option" aria-selected="false" data-idx="' +
        idx +
        '">' +
        (img
          ? '<img class="search-result-img" src="' + escapeAttr(img) + '" alt="" loading="lazy">'
          : '<div class="search-result-img" style="display:flex;align-items:center;justify-content:center;">N/D</div>') +
        '<div class="search-result-info">' +
        '<div class="search-result-name">' +
        escapeHtml(show.name) +
        '</div>' +
        '<div class="search-result-meta">' +
        year +
        ' • ' +
        escapeHtml(network) +
        '</div>' +
        '<div class="search-result-actions">' +
        '<button class="btn btn-primary btn-sm" data-idx="' +
        idx +
        '" data-list="watching">In corso</button>' +
        '<button class="btn btn-secondary btn-sm" data-idx="' +
        idx +
        '" data-list="towatch">Da vedere</button>' +
        '<button class="btn btn-secondary btn-sm" data-idx="' +
        idx +
        '" data-list="completed">Completata</button>' +
        '</div></div></div>'
      );
    })
    .join('');
  return html;
}

/**
 * Abortisce la ricerca corrente (se in flight) e incrementa `searchSeq`
 * in modo che eventuali risposte stale vengano scartate.
 */
function invalidateCurrentSearch(): void {
  if (searchAbortController) {
    searchAbortController.abort();
    searchAbortController = null;
  }
  searchSeq++;
  if (searchTimeout) {
    clearTimeout(searchTimeout);
    searchTimeout = null;
  }
}

/** BUG-20-08: toggle aria-expanded sull'input. */
function setExpanded(expanded: boolean): void {
  if (_searchInput) {
    _searchInput.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

/** BUG-10-02/03: clear completo di DOM + stato + abort. */
function clearSearchState(): void {
  invalidateCurrentSearch();
  if (_searchResults) {
    _searchResults.classList.remove('active');
    _searchResults.innerHTML = '';
  }
  lastSearchResults = [];
  searchSelectedIdx = -1;
  setExpanded(false);
}

async function doSearch(query: string): Promise<void> {
  const now = Date.now();
  if (now - lastSearchTime < MIN_SEARCH_INTERVAL_MS) {
    searchTimeout = setTimeout(() => doSearch(query), MIN_SEARCH_INTERVAL_MS - (now - lastSearchTime));
    return;
  }
  lastSearchTime = now;

  if (searchAbortController) searchAbortController.abort();
  searchAbortController = new AbortController();
  const mySeq = ++searchSeq;
  const signal = searchAbortController.signal;

  if (!_searchResults) return;
  _searchResults.innerHTML = '<div class="loading"><div class="spinner"></div>Ricerca in corso...</div>';
  _searchResults.classList.add('active');
  setExpanded(true);

  try {
    const results = await searchShows(query, signal);
    if (mySeq !== searchSeq) return;

    if (!results || results.length === 0) {
      const words = query
        .split(/\s+/)
        .filter((w) => w.length >= 3)
        .sort((a, b) => b.length - a.length);
      if (words.length > 0 && words[0].toLowerCase() !== query.toLowerCase()) {
        const altQuery = words[0];
        try {
          const altResults = await searchShows(altQuery, signal);
          if (mySeq !== searchSeq) return;
          if (altResults && altResults.length > 0) {
            const qLower = query.toLowerCase();
            const filtered = altResults.filter(
              (r) => r && r.show && r.show.name && r.show.name.toLowerCase().includes(qLower),
            );
            const html = renderSearchResultsHTML(
              filtered.length > 0 ? filtered : altResults.slice(0, 10),
              'Nessun risultato per "' + query + '". Risultati simili per "' + altQuery + '":',
            );
            if (html) {
              _searchResults.innerHTML = html;
              return;
            }
          }
        } catch (e2) {
          const err = e2 as { name?: string };
          if (err.name === 'AbortError') return;
          if (mySeq !== searchSeq) return;
          // BUG-10-07: propaga l'errore del fallback al outer catch.
          throw e2;
        }
      }
      _searchResults.innerHTML =
        '<div class="search-no-results">Nessuna serie trovata per "' +
        escapeHtml(query) +
        '". Prova con meno parole o la parola principale.</div>';
      lastSearchResults = [];
      return;
    }

    const html = renderSearchResultsHTML(results);
    if (html) {
      _searchResults.innerHTML = html;
    } else {
      _searchResults.innerHTML =
        '<div class="search-no-results">Nessuna serie trovata per "' + escapeHtml(query) + '".</div>';
      lastSearchResults = [];
    }
  } catch (e: unknown) {
    const err = e as { name?: string; status?: number };
    if (err.name === 'AbortError') return;
    if (mySeq !== searchSeq) return;
    let msg = 'Errore nella ricerca. Riprova.';
    if (err.name === 'TimeoutError') msg = 'Ricerca timeout. Verifica la connessione.';
    else if (err.name === 'NetworkError') msg = 'Connessione internet non disponibile.';
    else if (err.status === 429) msg = 'Troppe ricerche. Attendi qualche secondo.';
    else if (err.name === 'ParseError' || err.name === 'SyntaxError') msg = 'Risposta API non valida. Riprova.';
    _searchResults.innerHTML = '<div class="search-no-results">' + escapeHtml(msg) + '</div>';
    lastSearchResults = [];
  }
}

async function selectSearchResult(idx: number, list: ListName): Promise<void> {
  if (!lastSearchResults[idx]) return;
  const show = lastSearchResults[idx].show;
  if (!show) {
    showToast('Dati serie non validi', 'error');
    return;
  }
  // CRITICAL (H11): abortisce la ricerca in-flight + incrementa seq.
  invalidateCurrentSearch();
  // BUG-10-05: NON clearare l'input qui — aspetta il risultato di addShowToList.
  // Se addShowToList fallisce (es. già in lista), l'utente può riprovare.
  if (_searchResults) {
    _searchResults.classList.remove('active');
    _searchResults.innerHTML = '';
  }
  lastSearchResults = [];
  searchSelectedIdx = -1;
  setExpanded(false);
  const result = await addShowToList(show, list);
  // BUG-10-05: clear input solo se addShowToList ha avuto successo (truthy).
  if (result && _searchInput) {
    _searchInput.value = '';
  }
}

function updateSearchSelection(items: NodeListOf<Element>): void {
  // BUG-20-08: toggle anche aria-selected, non solo la classe.
  items.forEach((el, i) => {
    const selected = i === searchSelectedIdx;
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

export function initSearch(): void {
  _searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
  _searchResults = document.getElementById('searchResults');
  if (!_searchInput || !_searchResults) return;

  // BUG-20-08: ARIA combobox/listbox attributes.
  _searchInput.setAttribute('role', 'combobox');
  _searchInput.setAttribute('aria-expanded', 'false');
  _searchInput.setAttribute('aria-autocomplete', 'list');
  _searchInput.setAttribute('aria-controls', 'searchResults');
  _searchResults.setAttribute('role', 'listbox');
  _searchResults.setAttribute('aria-label', 'Risultati di ricerca');

  _searchInput.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    const query = _searchInput!.value.trim();
    if (query.length < 2) {
      clearSearchState();
      return;
    }
    if (query.length > MAX_QUERY_LENGTH) {
      // H10: branch > MAX_QUERY_LENGTH deve abortire la search in-flight
      invalidateCurrentSearch();
      _searchResults!.innerHTML =
        '<div class="search-no-results" role="status">Query troppo lunga (max ' +
        MAX_QUERY_LENGTH +
        ' caratteri)</div>';
      _searchResults!.classList.add('active');
      setExpanded(true);
      return;
    }
    // H10: abortisce la search precedente prima di schedulare la nuova.
    if (searchAbortController) {
      searchAbortController.abort();
      searchAbortController = null;
    }
    searchSeq++;
    searchTimeout = setTimeout(() => doSearch(query), 350);
  });

  _searchInput.addEventListener('keydown', (e) => {
    const items = _searchResults!.querySelectorAll('.search-result-item');
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchSelectedIdx >= 0 && items[searchSelectedIdx]) {
        const btn = items[searchSelectedIdx].querySelector('.btn-primary') as HTMLButtonElement | null;
        btn?.click();
      } else if (items.length > 0) {
        const btn = items[0].querySelector('.btn-primary') as HTMLButtonElement | null;
        btn?.click();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchSelectedIdx = Math.min(searchSelectedIdx + 1, items.length - 1);
      updateSearchSelection(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      searchSelectedIdx = Math.max(searchSelectedIdx - 1, -1);
      updateSearchSelection(items);
    } else if (e.key === 'Escape') {
      // BUG-10-02: clear completo (DOM + stato + abort).
      clearSearchState();
      _searchInput!.blur();
    }
  });

  // Event delegation sui risultati (più performante di onclick inline)
  _searchResults.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('button[data-idx]') as HTMLButtonElement | null;
    if (btn) {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      const list = btn.dataset.list as ListName;
      if (list) selectSearchResult(idx, list);
      return;
    }
    const item = target.closest('.search-result-item') as HTMLElement | null;
    if (item) {
      const idx = Number(item.dataset.idx);
      selectSearchResult(idx, 'watching');
    }
  });

  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.search-wrap')) {
      // BUG-10-03: clear completo anche su click outside.
      clearSearchState();
    }
  });
}

export { ApiError };
