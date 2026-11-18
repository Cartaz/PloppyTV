// Vista Discover: caroselli per genere, popolari + ultimi arrivi

import type { TvmazeShow } from '../types';
import { getState, setDiscoverTab } from '../lib/store';
import {
  invalidateDiscoverCache,
  resetDiscoverLoad,
  loadDiscover,
  findShowInDiscoverGroups,
  type DiscoverGroups,
} from '../lib/discover';
import { addShowToList } from '../lib/shows';
import { apiErrorMessage } from '../lib/api';
import { GENRE_CAROUSELS } from '../lib/constants';
import { escapeHtml, escapeAttr, getPosterUrl, parseISODateLocal, stripHtml, safeId } from '../lib/utils';
import { showToast } from '../components/toast';
import { showModal } from '../components/modal';
import { t, showStatusLabel } from '../lib/i18n';

type DiscoverTab = 'popular' | 'recent';
const _cache: Record<DiscoverTab, DiscoverGroups | null> = { popular: null, recent: null };
const _loading: Record<DiscoverTab, boolean> = { popular: false, recent: false };

let _discoverClickHandler: ((e: MouseEvent) => void) | null = null;
let _discoverKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let _discoverResizeHandler: (() => void) | null = null;
let _discoverMain: HTMLElement | null = null;

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
    '" data-dir="-1" aria-label="' +
    t('discover.previous') +
    '">‹</button>';
  html +=
    '<button class="carousel-nav-btn" data-action="scrollCarousel" data-carousel="' +
    carouselId +
    '" data-dir="1" aria-label="' +
    t('discover.next') +
    '">›</button>';
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
    html +=
      '<div class="carousel-card" data-action="previewDiscover" data-show-id="' +
      escapeAttr(show.id) +
      '" role="button" tabindex="0" aria-label="Anteprima ' +
      escapeAttr(show.name) +
      '">';
    if (isAdded) html += '<div class="carousel-card-badge">' + t('discover.addedBadge') + '</div>';
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
    return (
      '<div class="empty-state"><div class="empty-state-title">' +
      t('discover.emptyTitle') +
      '</div><div class="empty-state-text">' +
      t('discover.emptyText') +
      '</div></div>'
    );
  }
  let html = '';
  for (const genre of GENRE_CAROUSELS) {
    const groupShows = groups[genre] || [];
    if (groupShows.length === 0) continue;
    html += renderGenreCarousel(genre, groupShows);
  }
  if (groups._other && groups._other.length > 0) {
    html += renderGenreCarousel(t('discover.otherGenre'), groups._other);
  }
  return html;
}

function renderDiscoverError(err: unknown): string {
  return (
    '<div class="empty-state"><div class="empty-state-title">' +
    escapeHtml(apiErrorMessage(err, 'discover')) +
    '</div>' +
    '<div class="empty-state-text"><button class="btn btn-primary" data-action="retryDiscover">' +
    t('discover.retry') +
    '</button></div></div>'
  );
}

/**
 * Carica il tab richiesto. dopo l'await verifichiamo
 * che `getState()._discoverTab` sia ancora il tab che stavamo caricando;
 * se l'utente ha switchato tab durante il fetch, scartiamo il risultato
 * per non sovrascrivere la vista del nuovo tab.
 */
async function loadTab(tab: DiscoverTab): Promise<void> {
  const el = document.getElementById('discoverContent');
  if (!el) return;
  const cached = _cache[tab];
  if (cached) {
    el.innerHTML = renderDiscoverContent(cached);
    bindCarousels(el);
    return;
  }
  if (_loading[tab]) return;
  _loading[tab] = true;
  el.innerHTML = '<div class="loading"><div class="spinner"></div>' + t('discover.loadingShows') + '</div>';
  try {
    const groups = await loadDiscover(tab);
    _cache[tab] = groups;
    if (getState()._discoverTab !== tab) return;
    el.innerHTML = renderDiscoverContent(groups);
    bindCarousels(el);
  } catch (e) {
    if (getState()._discoverTab !== tab) return;
    el.innerHTML = renderDiscoverError(e);
  } finally {
    _loading[tab] = false;
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
  let html = '<h1 class="page-title">' + t('discover.title') + '</h1>';
  html += '<p class="page-subtitle">' + t('discover.subtitle') + '</p>';

  html += '<div class="discover-tabs" role="tablist">';
  html +=
    '<button class="discover-tab ' +
    (state._discoverTab === 'popular' ? 'active' : '') +
    '" data-action="switchDiscoverTab" data-tab="popular" role="tab">' +
    t('discover.popular') +
    '</button>';
  html +=
    '<button class="discover-tab ' +
    (state._discoverTab === 'recent' ? 'active' : '') +
    '" data-action="switchDiscoverTab" data-tab="recent" role="tab">' +
    t('discover.recentTab') +
    '</button>';
  html += '</div>';

  if (state._storageDisabled) {
    html +=
      '<div class="empty-state"><div class="empty-state-title">' +
      t('discover.unavailableTitle') +
      '</div><div class="empty-state-text">' +
      t('discover.unavailableText') +
      '</div></div>';
    main.innerHTML = html;
    return;
  }

  html +=
    '<div id="discoverContent"><div class="loading"><div class="spinner"></div>' +
    t('discover.loading') +
    '</div></div>';
  html +=
    '<div style="text-align:center;margin-top:16px;"><button class="btn btn-secondary btn-sm" data-action="refreshDiscover">' +
    t('discover.refresh') +
    '</button></div>';
  main.innerHTML = html;

  loadTab(state._discoverTab);
}

export function bindDiscoverEvents(main: HTMLElement): void {
  // Rimuovi il vecchio handler se presente SULLO STESSO main.
  if (_discoverClickHandler && _discoverMain === main) {
    main.removeEventListener('click', _discoverClickHandler);
  }
  if (_discoverKeydownHandler && _discoverMain === main) {
    main.removeEventListener('keydown', _discoverKeydownHandler);
  }
  if (_discoverResizeHandler) {
    window.removeEventListener('resize', _discoverResizeHandler);
  }
  _discoverMain = main;

  const clickHandler = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'switchDiscoverTab') {
      const tab = actionEl.dataset.tab as 'popular' | 'recent';
      if (!tab) return;
      // Non chiamare loadTab manualmente, non toccare DOM old.
      // emitChange → RAF → re-render → renderDiscover chiama loadTab.
      setDiscoverTab(tab);
      return;
    }

    if (action === 'refreshDiscover') {
      const tab = getState()._discoverTab;
      invalidateDiscoverCache(tab);
      resetDiscoverLoad(tab);
      _cache[tab] = null;
      loadTab(tab);
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
      const cardWidth = 160 + 12;
      track.scrollBy({ left: cardWidth * 3 * dir, behavior: 'smooth' });
      return;
    }

    const showId = safeId(actionEl.dataset.showId);
    if (!showId) return;

    if (action === 'openDiscover' || action === 'previewDiscover') {
      previewDiscover(showId);
    } else if (action === 'addDiscover') {
      const list = actionEl.dataset.list as 'towatch' | 'watching';
      if (list) addDiscoverShow(showId, list);
    }
  };
  // Keydown Enter/Space su elementi con role=button.
  const keydownHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.getAttribute('role') === 'button') {
      e.preventDefault();
      target.click();
    }
  };
  // Resize listener: aggiorna nav state di tutti i track.
  const resizeHandler = () => {
    document.querySelectorAll<HTMLElement>('.carousel-track').forEach((track) => {
      updateCarouselNavState(track);
    });
  };
  _discoverClickHandler = clickHandler;
  _discoverKeydownHandler = keydownHandler;
  _discoverResizeHandler = resizeHandler;
  main.addEventListener('click', clickHandler);
  main.addEventListener('keydown', keydownHandler);
  window.addEventListener('resize', resizeHandler, { passive: true });
}

function previewDiscover(showId: number): void {
  const found = findShowInDiscoverGroups(showId, [_cache.popular, _cache.recent]);
  if (!found) {
    showToast(t('discover.notFound'), 'error');
    return;
  }
  const isAdded = getState().shows.find((s) => s.id === found.id);
  const year = found.premiered
    ? parseISODateLocal(found.premiered)
      ? parseISODateLocal(found.premiered)!.getFullYear()
      : 'N/D'
    : 'N/D';
  const network = (found.network && found.network.name) || (found.webChannel && found.webChannel.name) || 'N/D';
  // Rating.average was interpolated RAW in the modal HTML body.
  // The TS type says `number | null`, but the cache comes from JSON.parse(localStorage)
  // and could hold a string with HTML (e.g. "<img src=x onerror=alert(1)>"). Setting
  // innerHTML on the modal body would execute the payload. Coerce to a finite number;
  // reject anything else as 'N/D'.
  // The old truthy check `found.rating.average` excluded the
  // valid value 0 — a show with average rating 0 displayed "N/D" instead of "0/10".
  const ratingAvgRaw = found.rating ? found.rating.average : null;
  const rating = typeof ratingAvgRaw === 'number' && Number.isFinite(ratingAvgRaw) ? ratingAvgRaw + '/10' : 'N/D';
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
  body +=
    '<div class="discover-preview-meta">' +
    year +
    ' • ' +
    escapeHtml(network) +
    t('discover.ratingLabel') +
    rating +
    '</div>';
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
    // found.runtime was interpolated RAW in the modal HTML body.
    // A corrupted cache holding a non-numeric string (e.g. "<img src=x onerror=...>")
    // would execute when set via innerHTML. Coerce to a finite number; omit otherwise.
    const runtimeNum = typeof found.runtime === 'number' && Number.isFinite(found.runtime) ? found.runtime : null;
    body +=
      '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);">' +
      t('discover.statusLabel') +
      escapeHtml(showStatusLabel(found.status)) +
      (runtimeNum != null ? ' • ' + runtimeNum + ' min/ep' : '') +
      '</div>';
  }

  const actions = isAdded
    ? [{ label: t('actions.close') }]
    : [
        { label: t('actions.close') },
        {
          label: t('stats.towatch'),
          style: 'btn-secondary' as const,
          onClick: () => addDiscoverShow(found.id, 'towatch'),
        },
        {
          label: t('stats.watching'),
          style: 'btn-primary' as const,
          onClick: () => addDiscoverShow(found.id, 'watching'),
        },
      ];
  showModal(found.name || t('discover.untitled'), body, actions);
}

async function addDiscoverShow(showId: number, list: 'towatch' | 'watching'): Promise<void> {
  const found = findShowInDiscoverGroups(showId, [_cache.popular, _cache.recent]);
  if (!found) {
    showToast(t('discover.notInCache'), 'error');
    return;
  }
  await addShowToList(found, list);
  // Non chiamare renderDiscover direttamente — il replaceShow
  // in shows.ts triggera già emitChange → RAF → re-render via renderer.
  // Una seconda chiamata qui causerebbe doppio render e potenziale race.
}
