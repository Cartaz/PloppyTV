// Vista Discover: caroselli per genere, popolari + ultimi arrivi

import type { TvmazeShow } from '../types';
import { getState, setDiscoverTab } from '../lib/store';
import {
  invalidateDiscoverCache,
  resetDiscoverPreload,
  getDiscoverPromise,
  findShowInDiscoverGroups,
  type DiscoverGroups,
} from '../lib/discover';
import { addShowToList } from '../lib/shows';
import { GENRE_CAROUSELS } from '../lib/constants';
import { escapeHtml, escapeAttr, getPosterUrl, parseISODateLocal, stripHtml, safeId } from '../lib/utils';
import { showToast } from '../components/toast';
import { showModal } from '../components/modal';

let _popularCache: DiscoverGroups | null = null;
let _recentCache: DiscoverGroups | null = null;
let _popularLoading = false;
let _recentLoading = false;

let _boundDiscover = false;
let _clickHandler: ((e: MouseEvent) => void) | null = null;
let _keyHandler: ((e: KeyboardEvent) => void) | null = null;
let _resizeHandler: (() => void) | null = null;
let _mainEl: HTMLElement | null = null;

// BUG-15-02 (High): invalidation token per loadTab. Ogni chiamata cattura un
// token; dopo l'await, se il token è cambiato (chiamata più recente ha
// sostituito questa), NON scriviamo innerHTML. Previene il caso in cui una
// loadTab lenta renderizza su un discoverContent ormai staccato.
let _loadTabToken = 0;

/**
 * Reset della guardia + rimozione listener accumulati. FIX H1/BUG-15-01:
 * prima di questo fix, resetBoundGuard resettava solo il flag lasciando i
 * listener click su `main` accumularsi ad ogni re-render.
 */
export function resetBoundGuard(): void {
  if (_clickHandler && _mainEl) _mainEl.removeEventListener('click', _clickHandler);
  if (_keyHandler && _mainEl) _mainEl.removeEventListener('keydown', _keyHandler);
  if (_resizeHandler) window.removeEventListener('resize', _resizeHandler);
  _clickHandler = null;
  _keyHandler = null;
  _resizeHandler = null;
  _mainEl = null;
  _boundDiscover = false;
}

function renderGenreCarousel(genre: string, shows: TvmazeShow[]): string {
  // Carousel ID stabile (no Math.random) per essere riferito deterministicamente
  const carouselId = 'carousel-' + genre.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  let html = '<div class="genre-carousel">';
  html += '<div class="carousel-header">';
  html +=
    '<div><span class="carousel-title">' +
    escapeHtml(genre) +
    '</span><span class="carousel-count">' +
    shows.length +
    ' serie</span></div>';
  html += '<div class="carousel-nav">';
  html +=
    '<button class="carousel-nav-btn" data-action="scrollCarousel" data-carousel="' +
    carouselId +
    '" data-dir="-1" aria-label="Precedente">‹</button>';
  html +=
    '<button class="carousel-nav-btn" data-action="scrollCarousel" data-carousel="' +
    carouselId +
    '" data-dir="1" aria-label="Successivo">›</button>';
  html += '</div></div>';
  html += '<div class="carousel-track" id="' + carouselId + '">';
  for (const show of shows) {
    const img = getPosterUrl(show);
    const year = show.premiered
      ? parseISODateLocal(show.premiered)
        ? parseISODateLocal(show.premiered)!.getFullYear()
        : ''
      : '';
    const isAdded = getState().shows.find((s) => s.id === show.id);
    // H17 a11y: carousel-card è un div clickable — role="button" + tabindex="0"
    // + aria-label per renderlo focusable e operabile da tastiera. Il keydown
    // handler in bindDiscoverEvents converte Enter/Space in click.
    html +=
      '<div class="carousel-card" role="button" tabindex="0" aria-label="Anteprima: ' +
      escapeAttr(show.name) +
      '" data-action="previewDiscover" data-show-id="' +
      show.id +
      '">';
    if (isAdded) html += '<div class="carousel-card-badge">Aggiunta</div>';
    if (img) {
      html +=
        '<img class="carousel-card-poster" src="' +
        escapeAttr(img) +
        '" alt="' +
        escapeAttr(show.name) +
        '" loading="lazy" decoding="async" data-fallback="' +
        escapeAttr(show.name) +
        '" data-fallback-cls="carousel-card-placeholder">';
    } else {
      html += '<div class="carousel-card-placeholder">' + escapeHtml(show.name) + '</div>';
    }
    html += '<div class="carousel-card-body">';
    html += '<div class="carousel-card-name">' + escapeHtml(show.name) + '</div>';
    html += '<div class="carousel-card-meta">' + (year || 'N/D') + '</div>';
    html += '</div></div>';
  }
  html += '</div></div>';
  return html;
}

function updateCarouselNavState(track: HTMLElement): void {
  const carousel = track.closest('.genre-carousel');
  if (!carousel) return;
  const navBtns = carousel.querySelectorAll<HTMLButtonElement>('.carousel-nav-btn');
  if (navBtns.length < 2) return;
  const prevBtn = navBtns[0];
  const nextBtn = navBtns[1];
  const maxScroll = track.scrollWidth - track.clientWidth;
  prevBtn.disabled = track.scrollLeft <= 2;
  nextBtn.disabled = track.scrollLeft >= maxScroll - 2;
}

function renderDiscoverContent(groups: DiscoverGroups | null): string {
  if (!groups) {
    return '<div class="empty-state"><div class="empty-state-title">Nessuna serie disponibile</div><div class="empty-state-text">Riprova più tardi.</div></div>';
  }
  let html = '';
  for (const genre of GENRE_CAROUSELS) {
    const groupShows = groups[genre] || [];
    if (groupShows.length === 0) continue;
    html += renderGenreCarousel(genre, groupShows);
  }
  if (groups._other && groups._other.length > 0) {
    html += renderGenreCarousel('Altro', groups._other);
  }
  return html;
}

function renderDiscoverError(err: { name?: string }): string {
  let msg = 'Errore caricamento. Riprova.';
  if (err.name === 'NetworkError') msg = 'Connessione internet non disponibile.';
  else if (err.name === 'TimeoutError') msg = 'Timeout caricamento.';
  else if (err.name === 'ParseError') msg = 'Risposta API non valida. Riprova.';
  return (
    '<div class="empty-state"><div class="empty-state-title">' +
    escapeHtml(msg) +
    '</div>' +
    '<div class="empty-state-text"><button class="btn btn-primary" data-action="retryDiscover">Riprova</button></div></div>'
  );
}

/**
 * Carica il tab richiesto. CRITICAL FIX (H15): dopo l'await verifichiamo
 * che `getState()._discoverTab` sia ancora il tab che stavamo caricando;
 * se l'utente ha switchato tab durante il fetch, scartiamo il risultato
 * per non sovrascrivere la vista del nuovo tab.
 *
 * FIX BUG-15-02: aggiungiamo un invalidation token (_loadTabToken). Se una
 * loadTab più recente sostituisce questa (es. perché un re-render ha
 * chiamato loadTab dopo che una loadTab manuale era in flight), la vecchia
 * non scrive innerHTML sul discoverContent (che potrebbe essere staccato).
 */
async function loadTab(tab: 'popular' | 'recent'): Promise<void> {
  const myToken = ++_loadTabToken;
  const el = document.getElementById('discoverContent');
  if (!el) return;
  if (tab === 'popular') {
    if (_popularCache) {
      el.innerHTML = renderDiscoverContent(_popularCache);
      bindCarousels(el);
      return;
    }
    if (_popularLoading) return;
    _popularLoading = true;
    el.innerHTML = '<div class="loading"><div class="spinner"></div>Caricamento serie...</div>';
    try {
      _popularCache = await getDiscoverPromise('popular');
      // H15 + BUG-15-02: scarta se l'utente ha cambiato tab durante il fetch
      // oppure se un'altra loadTab ha sostituito questa.
      if (getState()._discoverTab !== 'popular') return;
      if (_loadTabToken !== myToken) return;
      el.innerHTML = renderDiscoverContent(_popularCache);
      bindCarousels(el);
    } catch (e) {
      if (getState()._discoverTab !== 'popular') return;
      if (_loadTabToken !== myToken) return;
      el.innerHTML = renderDiscoverError(e as { name?: string });
    } finally {
      _popularLoading = false;
    }
  } else {
    if (_recentCache) {
      el.innerHTML = renderDiscoverContent(_recentCache);
      bindCarousels(el);
      return;
    }
    if (_recentLoading) return;
    _recentLoading = true;
    el.innerHTML = '<div class="loading"><div class="spinner"></div>Caricamento serie...</div>';
    try {
      _recentCache = await getDiscoverPromise('recent');
      // H15 + BUG-15-02: scarta se l'utente ha cambiato tab durante il fetch
      // oppure se un'altra loadTab ha sostituito questa.
      if (getState()._discoverTab !== 'recent') return;
      if (_loadTabToken !== myToken) return;
      el.innerHTML = renderDiscoverContent(_recentCache);
      bindCarousels(el);
    } catch (e) {
      if (getState()._discoverTab !== 'recent') return;
      if (_loadTabToken !== myToken) return;
      el.innerHTML = renderDiscoverError(e as { name?: string });
    } finally {
      _recentLoading = false;
    }
  }
}

function bindCarousels(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>('.carousel-track').forEach((track) => {
    updateCarouselNavState(track);
    track.addEventListener('scroll', () => updateCarouselNavState(track), { passive: true });
  });
}

export function renderDiscover(main: HTMLElement): void {
  const state = getState();
  let html = '<h1 class="page-title">Scopri</h1>';
  html += '<p class="page-subtitle">Esplora le serie TV più popolari e i nuovi arrivi.</p>';

  html += '<div class="discover-tabs" role="tablist">';
  html +=
    '<button class="discover-tab ' +
    (state._discoverTab === 'popular' ? 'active' : '') +
    '" data-action="switchDiscoverTab" data-tab="popular" role="tab">Popolari</button>';
  html +=
    '<button class="discover-tab ' +
    (state._discoverTab === 'recent' ? 'active' : '') +
    '" data-action="switchDiscoverTab" data-tab="recent" role="tab">Ultimi arrivi</button>';
  html += '</div>';

  if (state._storageDisabled) {
    html +=
      '<div class="empty-state"><div class="empty-state-title">Funzione non disponibile</div><div class="empty-state-text">La cache non è disponibile in modalità privata.</div></div>';
    main.innerHTML = html;
    return;
  }

  html += '<div id="discoverContent"><div class="loading"><div class="spinner"></div>Caricamento...</div></div>';
  html +=
    '<div style="text-align:center;margin-top:16px;"><button class="btn btn-secondary btn-sm" data-action="refreshDiscover">Aggiorna lista</button></div>';
  main.innerHTML = html;

  loadTab(state._discoverTab);
}

export function bindDiscoverEvents(main: HTMLElement): void {
  if (_boundDiscover) return;
  _boundDiscover = true;
  _mainEl = main;

  _clickHandler = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'switchDiscoverTab') {
      const tab = actionEl.dataset.tab as 'popular' | 'recent';
      if (!tab) return;
      // FIX BUG-15-02/BUG-15-03: rimossi i manual DOM ops (class toggle,
      // innerHTML loading, MANUAL loadTab) che operavano su elementi
      // staccati dal prossimo re-render. setDiscoverTab emette emitChange
      // → il renderer rifà renderDiscover → loadTab(tab) con il tab fresco.
      setDiscoverTab(tab);
      return;
    }

    if (action === 'refreshDiscover') {
      const state = getState();
      if (state._discoverTab === 'popular') {
        invalidateDiscoverCache('popular');
        resetDiscoverPreload('popular');
        _popularCache = null;
      } else {
        invalidateDiscoverCache('recent');
        resetDiscoverPreload('recent');
        _recentCache = null;
      }
      loadTab(state._discoverTab);
      return;
    }

    if (action === 'retryDiscover') {
      const state = getState();
      loadTab(state._discoverTab);
      return;
    }

    if (action === 'scrollCarousel') {
      const id = actionEl.dataset.carousel;
      const dir = Number(actionEl.dataset.dir);
      const track = document.getElementById(id || '');
      if (!track) return;
      // BUG-15-05 (Low, left as-is): cardWidth è un magic number 160+12=172
      // che deve matchare il CSS .carousel-card. Documentato nel report.
      const cardWidth = 160 + 12;
      track.scrollBy({ left: cardWidth * 3 * dir, behavior: 'smooth' });
      return;
    }

    const showId = safeId(actionEl.dataset.showId);
    if (!showId) return;

    // BUG-15-06 (Low): rimosso il dead branch `action === 'openDiscover' ||`
    // — nessun writer imposta data-action="openDiscover" in src/.
    if (action === 'previewDiscover') {
      previewDiscover(showId);
    } else if (action === 'addDiscover') {
      const list = actionEl.dataset.list as 'towatch' | 'watching';
      if (list) addDiscoverShow(showId, list);
    }
  };

  _keyHandler = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    if (actionEl !== target && !actionEl.contains(target)) return;
    e.preventDefault();
    actionEl.click();
  };

  // BUG-15-09 (Low): aggiorna lo stato disabled dei nav button di tutti i
  // carousel-track su window resize (prima non erano ricalcolati). Il
  // listener è tracciato e rimosso in resetBoundGuard per evitare accumulo.
  _resizeHandler = (): void => {
    document.querySelectorAll<HTMLElement>('.carousel-track').forEach((track) => {
      updateCarouselNavState(track);
    });
  };
  window.addEventListener('resize', _resizeHandler);

  main.addEventListener('click', _clickHandler);
  main.addEventListener('keydown', _keyHandler);
}

function previewDiscover(showId: number): void {
  const found = findShowInDiscoverGroups(showId, [_popularCache, _recentCache]);
  if (!found) {
    showToast('Serie non trovata', 'error');
    return;
  }
  const isAdded = getState().shows.find((s) => s.id === found.id);
  const year = found.premiered
    ? parseISODateLocal(found.premiered)
      ? parseISODateLocal(found.premiered)!.getFullYear()
      : 'N/D'
    : 'N/D';
  const network = (found.network && found.network.name) || (found.webChannel && found.webChannel.name) || 'N/D';
  const rating = found.rating && found.rating.average ? found.rating.average + '/10' : 'N/D';
  const img = getPosterUrl(found);
  const summary = stripHtml(found.summary);

  let body = '<div class="discover-preview-header">';
  if (img) {
    body +=
      '<img class="discover-preview-poster" src="' +
      escapeAttr(img) +
      '" alt="' +
      escapeAttr(found.name) +
      '" data-fallback="" >';
  }
  body += '<div class="discover-preview-info">';
  body += '<div class="discover-preview-name">' + escapeHtml(found.name) + '</div>';
  body += '<div class="discover-preview-meta">' + year + ' • ' + escapeHtml(network) + ' • Rating ' + rating + '</div>';
  if (Array.isArray(found.genres) && found.genres.length > 0) {
    body +=
      '<div class="discover-preview-genres">' +
      found.genres.map((g) => '<span class="genre-tag">' + escapeHtml(g) + '</span>').join('') +
      '</div>';
  }
  body += '</div></div>';
  if (summary) {
    body +=
      '<div class="discover-preview-summary">' +
      escapeHtml(summary.slice(0, 600)) +
      (summary.length > 600 ? '...' : '') +
      '</div>';
  }
  if (found.status) {
    body +=
      '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);">Stato: ' +
      escapeHtml(found.status) +
      (found.runtime ? ' • ' + found.runtime + ' min/ep' : '') +
      '</div>';
  }

  const actions = isAdded
    ? [{ label: 'Chiudi' }]
    : [
        { label: 'Chiudi' },
        { label: 'Da vedere', style: 'btn-secondary' as const, onClick: () => addDiscoverShow(found.id, 'towatch') },
        { label: 'In corso', style: 'btn-primary' as const, onClick: () => addDiscoverShow(found.id, 'watching') },
      ];
  showModal(found.name || 'Senza titolo', body, actions);
}

async function addDiscoverShow(showId: number, list: 'towatch' | 'watching'): Promise<void> {
  const found = findShowInDiscoverGroups(showId, [_popularCache, _recentCache]);
  if (!found) {
    showToast('Serie non trovata nella cache, usa la ricerca', 'error');
    return;
  }
  await addShowToList(found, list);
  // FIX BUG-15-04 (Medium): rimosso il direct `renderDiscover(main)` call.
  // addShowToList → replaceShow → emitChange → renderer (RAF) già re-rendera
  // la vista discover con i badge "Aggiunta" aggiornati. Il direct call era
  // ridondante e causava double-render (+ listener accumulation pre-fix).
  // Se currentView !== 'discover' (es. utente ha cambiato vista), non c'è
  // nulla da aggiornare qui.
}
