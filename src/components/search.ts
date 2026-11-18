// Search box: input -> API TVMaze, fallback fuzzy, keyboard nav

import type { ListName, TvmazeSearchResult } from '../types';
import { searchShows, apiErrorMessage } from '../lib/api';
import { MAX_QUERY_LENGTH } from '../lib/constants';
import { escapeHtml, escapeAttr, getPosterUrl, parseISODateLocal } from '../lib/utils';
import { addShowToList } from '../lib/shows';
import { showToast } from './toast';
import { t } from '../lib/i18n';

let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSearchResults: TvmazeSearchResult[] = [];
let searchSeq = 0;
let searchAbortController: AbortController | null = null;
let searchSelectedIdx = -1;

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
        // Role=option, aria-selected=false sui result items.
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
        '" data-list="watching">' +
        t('nav.watching') +
        '</button>' +
        '<button class="btn btn-secondary btn-sm" data-idx="' +
        idx +
        '" data-list="towatch">' +
        t('nav.towatch') +
        '</button>' +
        '<button class="btn btn-secondary btn-sm" data-idx="' +
        idx +
        '" data-list="completed">' +
        t('search.completata') +
        '</button>' +
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

/** Toggle aria-expanded sull'input. */
function setExpanded(expanded: boolean): void {
  if (_searchInput) {
    _searchInput.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

/** Clear completo di DOM + stato + abort. */
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
  if (searchAbortController) searchAbortController.abort();
  searchAbortController = new AbortController();
  const mySeq = ++searchSeq;
  const signal = searchAbortController.signal;

  if (!_searchResults) return;
  _searchResults.innerHTML = '<div class="loading"><div class="spinner"></div>' + t('search.searching') + '</div>';
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
              t('search.noResultsAlt', { query, alt: altQuery }),
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
          // Propaga l'errore del fallback al outer catch.
          throw e2;
        }
      }
      _searchResults.innerHTML =
        '<div class="search-no-results">' + t('search.notFoundHint', { query: escapeHtml(query) }) + '</div>';
      lastSearchResults = [];
      return;
    }

    const html = renderSearchResultsHTML(results);
    if (html) {
      _searchResults.innerHTML = html;
    } else {
      _searchResults.innerHTML =
        '<div class="search-no-results">' + t('search.noResults', { query: escapeHtml(query) }) + '</div>';
      lastSearchResults = [];
    }
  } catch (e: unknown) {
    if ((e as { name?: string }).name === 'AbortError') return;
    if (mySeq !== searchSeq) return;
    _searchResults.innerHTML = '<div class="search-no-results">' + escapeHtml(apiErrorMessage(e, 'search')) + '</div>';
    lastSearchResults = [];
  }
}

async function selectSearchResult(idx: number, list: ListName): Promise<void> {
  if (!lastSearchResults[idx]) return;
  const show = lastSearchResults[idx].show;
  if (!show) {
    showToast(t('search.datiSerieValidi'), 'error');
    return;
  }
  // CRITICAL (H11): abortisce la ricerca in-flight + incrementa seq.
  // Catturiamo searchSeq PRIMA che invalidateCurrentSearch lo
  // incrementi. Dopo l'await, se searchSeq è cambiato (l'utente ha digitato
  // durante l'await di addShowToList), NON dobbiamo clearare l'input —
  // l'utente ha iniziato una nuova ricerca e clearing cancellerebbe la sua
  // query mentre i nuovi risultati verrebbero renderizzati su un input
  // (erroneamente) vuoto.
  const seqBefore = searchSeq;
  invalidateCurrentSearch();
  // NON clearare l'input qui — aspetta il risultato di addShowToList.
  // Se addShowToList fallisce (es. già in lista), l'utente può riprovare.
  if (_searchResults) {
    _searchResults.classList.remove('active');
    _searchResults.innerHTML = '';
  }
  lastSearchResults = [];
  searchSelectedIdx = -1;
  setExpanded(false);
  try {
    // Defense-in-depth — addShowToList ha il suo try/catch e
    // non dovrebbe mai lanciare, ma se lo fa (bug futuro o input anomalo)
    // non vogliamo un unhandled rejection. Mostriamo un toast e bail.
    const result = await addShowToList(show, list);
    // Clear input solo se addShowToList ha avuto successo (truthy).
    // AND solo se l'utente non ha digitato durante l'await
    // (searchSeq deve essere ancora seqBefore + 1, ovvero solo l'incremento
    // di invalidateCurrentSearch — nessun input handler ha incrementato
    // ulteriormente, nessun doSearch è partito).
    if (result && _searchInput && searchSeq === seqBefore + 1) {
      _searchInput.value = '';
    }
  } catch (e) {
    console.error('[search] selectSearchResult error:', e);
    showToast(t('search.erroreAggiuntaSerie'), 'error');
  }
}

function updateSearchSelection(items: NodeListOf<Element>): void {
  // Toggle anche aria-selected, non solo la classe.
  items.forEach((el, i) => {
    const selected = i === searchSelectedIdx;
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

/** Collega la ricerca al DOM. Ritorna la funzione che rimuove il listener globale. */
export function initSearch(): () => void {
  _searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
  _searchResults = document.getElementById('searchResults');
  if (!_searchInput || !_searchResults) return () => {};

  // ARIA combobox/listbox attributes.
  _searchInput.setAttribute('role', 'combobox');
  _searchInput.setAttribute('aria-expanded', 'false');
  _searchInput.setAttribute('aria-autocomplete', 'list');
  _searchInput.setAttribute('aria-controls', 'searchResults');
  _searchResults.setAttribute('role', 'listbox');
  _searchResults.setAttribute('aria-label', t('search.risultatiRicerca'));

  _searchInput.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    const query = _searchInput!.value.trim();
    if (query.length < 2) {
      clearSearchState();
      return;
    }
    if (query.length > MAX_QUERY_LENGTH) {
      // Branch > MAX_QUERY_LENGTH deve abortire la search in-flight
      invalidateCurrentSearch();
      _searchResults!.innerHTML =
        '<div class="search-no-results" role="status">' + t('search.tooLong', { max: MAX_QUERY_LENGTH }) + '</div>';
      _searchResults!.classList.add('active');
      setExpanded(true);
      return;
    }
    // Abortisce la search precedente prima di schedulare la nuova.
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
      // Clear completo (DOM + stato + abort).
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
    // Il clic sulla riga seleziona soltanto: l'aggiunta richiede uno dei
    // pulsanti lista (o Invio), così un clic involontario non modifica i dati.
    const item = target.closest('.search-result-item') as HTMLElement | null;
    if (item) {
      const items = _searchResults!.querySelectorAll('.search-result-item');
      searchSelectedIdx = Array.prototype.indexOf.call(items, item);
      updateSearchSelection(items);
    }
  });

  // Click fuori dalla ricerca: chiude i risultati.
  const docClickHandler = (e: MouseEvent): void => {
    if (!(e.target as HTMLElement).closest('.search-wrap')) clearSearchState();
  };
  document.addEventListener('click', docClickHandler);
  return () => document.removeEventListener('click', docClickHandler);
}
