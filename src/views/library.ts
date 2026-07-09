// Vista Library: search avanzata nella libreria dell'utente (P2.4)
//
// Filtri disponibili:
//   - Genere (dropdown da generi presenti nelle serie dell'utente)
//   - Status (watching / towatch / completed / tutti)
//   - Rating minimo (0-5, basato su rating medio stagione o episodio)
//   - Network (dropdown)
//   - Anno premiere (dropdown)
//   - Tag (dropdown da tag utente)
//   - Ricerca testuale libera sul nome serie
//
// Design:
//   - I filtri sono cumulativi (AND).
//   - "Cancella filtri" resetta tutto.
//   - I risultati sono reattivi: cambiano al change dei filtri.

import { getState } from '../lib/store';
import { escapeHtml, escapeAttr } from '../lib/utils';
import { showCardHtml } from './dashboard';
import { getAllUserTags } from '../lib/shows';
import { t } from '../lib/i18n';
import type { Show } from '../types';

// Stato filtri (persiste durante la sessione, non in localStorage)
interface FilterState {
  text: string;
  genre: string;
  status: string;
  minRating: number;
  network: string;
  year: string;
  tag: string;
}

let _filters: FilterState = {
  text: '',
  genre: '',
  status: '',
  minRating: 0,
  network: '',
  year: '',
  tag: '',
};

/**
 * Calcola il rating medio di una serie (media di tutti gli episodi rated).
 */
function showAvgRating(show: { seasons?: Record<number, Array<{ rating?: number }>> }): number {
  if (!show.seasons) return 0;
  let sum = 0;
  let count = 0;
  for (const eps of Object.values(show.seasons)) {
    if (!Array.isArray(eps)) continue;
    for (const ep of eps) {
      if (ep && typeof ep.rating === 'number' && ep.rating >= 1) {
        sum += ep.rating;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Raccoglie tutti i generi unici dalle serie dell'utente.
 */
function collectGenres(shows: Array<{ genres: string[] }>): string[] {
  const set = new Set<string>();
  for (const s of shows) {
    if (Array.isArray(s.genres)) for (const g of s.genres) set.add(g);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Raccoglie tutti i network unici.
 */
function collectNetworks(shows: Array<{ network: string }>): string[] {
  const set = new Set<string>();
  for (const s of shows) {
    if (s.network && s.network !== 'N/D') set.add(s.network);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Raccoglie tutti gli anni premiere unici.
 */
function collectYears(shows: Array<{ premiered: string | null }>): string[] {
  const set = new Set<string>();
  for (const s of shows) {
    if (s.premiered && /^\d{4}/.test(s.premiered)) {
      set.add(s.premiered.slice(0, 4));
    }
  }
  return Array.from(set).sort((a, b) => b.localeCompare(a)); // più recenti prima
}

function applyFilters(shows: Show[]): Show[] {
  return shows.filter((s) => {
    // Text search
    if (_filters.text) {
      const q = _filters.text.toLowerCase();
      if (!s.name.toLowerCase().includes(q)) return false;
    }
    // Genre
    if (_filters.genre && !(s.genres || []).includes(_filters.genre)) return false;
    // Status
    if (_filters.status && s.list !== _filters.status) return false;
    // Min rating
    if (_filters.minRating > 0) {
      const avg = showAvgRating(s);
      if (avg < _filters.minRating) return false;
    }
    // Network
    if (_filters.network && s.network !== _filters.network) return false;
    // Year
    if (_filters.year) {
      if (!s.premiered || !s.premiered.startsWith(_filters.year)) return false;
    }
    // Tag
    if (_filters.tag && !(s.tags || []).some((tg) => tg.toLowerCase() === _filters.tag.toLowerCase())) return false;
    return true;
  });
}

function optionHtml(value: string, label: string, current: string): string {
  return '<option value="' + escapeAttr(value) + '"' + (value === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
}

export function renderLibrary(main: HTMLElement): void {
  const state = getState();
  const allShows = state.shows;
  const genres = collectGenres(allShows);
  const networks = collectNetworks(allShows);
  const years = collectYears(allShows);
  const tags = getAllUserTags();

  // Se non ci sono serie, mostra empty state
  if (allShows.length === 0) {
    main.innerHTML =
      '<h1 class="page-title">' +
      escapeHtml(t('library.title')) +
      '</h1>' +
      '<div class="empty-state"><div class="empty-state-title">' +
      escapeHtml(t('library.empty')) +
      '</div><div class="empty-state-text">' +
      escapeHtml(t('library.empty.desc')) +
      '</div></div>';
    return;
  }

  let html = '<h1 class="page-title">' + escapeHtml(t('library.title')) + '</h1>';

  // Filter bar
  html += '<div class="library-filters">';
  // Text search
  html +=
    '<div class="filter-group">' +
    '<input type="text" id="libTextFilter" class="filter-input" placeholder="' +
    escapeAttr(t('search.placeholder')) +
    '" value="' +
    escapeAttr(_filters.text) +
    '" autocomplete="off">' +
    '</div>';

  // Genre dropdown
  html += '<div class="filter-group"><label>' + escapeHtml(t('library.filter.genre')) + '</label><select id="libGenreFilter" class="filter-select">';
  html += optionHtml('', t('library.filter.any'), _filters.genre);
  for (const g of genres) html += optionHtml(g, g, _filters.genre);
  html += '</select></div>';

  // Status dropdown
  html += '<div class="filter-group"><label>' + escapeHtml(t('library.filter.status')) + '</label><select id="libStatusFilter" class="filter-select">';
  html += optionHtml('', t('library.filter.any'), _filters.status);
  html += optionHtml('watching', t('nav.watching'), _filters.status);
  html += optionHtml('towatch', t('nav.towatch'), _filters.status);
  html += optionHtml('completed', t('nav.completed'), _filters.status);
  html += '</select></div>';

  // Min rating dropdown
  html += '<div class="filter-group"><label>' + escapeHtml(t('library.filter.rating')) + '</label><select id="libRatingFilter" class="filter-select">';
  html += optionHtml('0', t('library.filter.any'), String(_filters.minRating));
  for (let i = 1; i <= 5; i++) {
    html += optionHtml(String(i), i + '★+', String(_filters.minRating));
  }
  html += '</select></div>';

  // Network dropdown
  if (networks.length > 0) {
    html += '<div class="filter-group"><label>' + escapeHtml(t('library.filter.network')) + '</label><select id="libNetworkFilter" class="filter-select">';
    html += optionHtml('', t('library.filter.any'), _filters.network);
    for (const n of networks) html += optionHtml(n, n, _filters.network);
    html += '</select></div>';
  }

  // Year dropdown
  if (years.length > 0) {
    html += '<div class="filter-group"><label>' + escapeHtml(t('library.filter.year')) + '</label><select id="libYearFilter" class="filter-select">';
    html += optionHtml('', t('library.filter.any'), _filters.year);
    for (const y of years) html += optionHtml(y, y, _filters.year);
    html += '</select></div>';
  }

  // Tag dropdown
  if (tags.length > 0) {
    html += '<div class="filter-group"><label>' + escapeHtml(t('library.filter.tag')) + '</label><select id="libTagFilter" class="filter-select">';
    html += optionHtml('', t('library.filter.any'), _filters.tag);
    for (const tg of tags) html += optionHtml(tg, tg, _filters.tag);
    html += '</select></div>';
  }

  // Clear button
  html += '<button class="btn btn-secondary btn-sm" id="libClearFilters">' + escapeHtml(t('library.filter.clear')) + '</button>';
  html += '</div>'; // .library-filters

  // Results
  const filtered = applyFilters(allShows);
  html += '<div class="library-results-count">' + escapeHtml(t('library.results', { count: filtered.length })) + '</div>';

  if (filtered.length === 0) {
    html +=
      '<div class="empty-state"><div class="empty-state-title">' +
      escapeHtml(t('library.noMatch')) +
      '</div></div>';
  } else {
    html += '<div class="card-grid">' + filtered.map(showCardHtml).join('') + '</div>';
  }

  main.innerHTML = html;

  // Bind filter events
  bindLibraryEvents(main);
}

function bindLibraryEvents(main: HTMLElement): void {
  const textInput = main.querySelector('#libTextFilter') as HTMLInputElement | null;
  const genreSel = main.querySelector('#libGenreFilter') as HTMLSelectElement | null;
  const statusSel = main.querySelector('#libStatusFilter') as HTMLSelectElement | null;
  const ratingSel = main.querySelector('#libRatingFilter') as HTMLSelectElement | null;
  const networkSel = main.querySelector('#libNetworkFilter') as HTMLSelectElement | null;
  const yearSel = main.querySelector('#libYearFilter') as HTMLSelectElement | null;
  const tagSel = main.querySelector('#libTagFilter') as HTMLSelectElement | null;
  const clearBtn = main.querySelector('#libClearFilters') as HTMLButtonElement | null;

  let textDebounce: ReturnType<typeof setTimeout> | null = null;

  if (textInput) {
    textInput.addEventListener('input', () => {
      if (textDebounce) clearTimeout(textDebounce);
      textDebounce = setTimeout(() => {
        _filters.text = textInput.value.trim();
        renderLibrary(main);
      }, 200);
    });
  }
  if (genreSel) {
    genreSel.addEventListener('change', () => {
      _filters.genre = genreSel.value;
      renderLibrary(main);
    });
  }
  if (statusSel) {
    statusSel.addEventListener('change', () => {
      _filters.status = statusSel.value;
      renderLibrary(main);
    });
  }
  if (ratingSel) {
    ratingSel.addEventListener('change', () => {
      _filters.minRating = Number(ratingSel.value) || 0;
      renderLibrary(main);
    });
  }
  if (networkSel) {
    networkSel.addEventListener('change', () => {
      _filters.network = networkSel.value;
      renderLibrary(main);
    });
  }
  if (yearSel) {
    yearSel.addEventListener('change', () => {
      _filters.year = yearSel.value;
      renderLibrary(main);
    });
  }
  if (tagSel) {
    tagSel.addEventListener('change', () => {
      _filters.tag = tagSel.value;
      renderLibrary(main);
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      _filters = { text: '', genre: '', status: '', minRating: 0, network: '', year: '', tag: '' };
      renderLibrary(main);
    });
  }
}
