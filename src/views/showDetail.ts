// Vista dettaglio show con episodi
//
// FIXES applicati:
//  - BUG-14-01: resetBoundGuard + bindShowDetailEvents — removeEventListener
//    del vecchio handler prima di bindarne uno nuovo (no accumulation).
//  - BUG-14-02: progress bar clamped a [0, 100] (no >100% su dati corrotti).
//  - BUG-14-03: bigImg URL replace usa regex /\/medium_(portrait|landscape)\//
//    invece di string.replace('medium', ...) (no match su filename "medium").
//  - BUG-14-04: filter season keys con regex /^\d+$/ (stretta, no "1.5").
//  - H17 a11y: episode-item e season-tab hanno role/tabindex/aria-*;
//    keydown listener (Enter/Space) triggera click.

import { getState, switchSeason, closeShow } from '../lib/store';
import { safeId, escapeHtml, escapeAttr, getWatchedCount, formatDate } from '../lib/utils';
import {
  moveShowToList,
  removeShow,
  toggleEpisode,
  markSeasonWatched,
  refreshShowEpisodes,
  showNeedsEpisodeNames,
} from '../lib/shows';

let _boundShowDetail = false;
let _showDetailClickHandler: ((e: MouseEvent) => void) | null = null;
let _showDetailKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let _showDetailMain: HTMLElement | null = null;

/**
 * Resetta la guardia di idempotenza. Deve essere chiamato dal renderer
 * PRIMA di bindShowDetailEvents per evitare accumulo di listener ad ogni
 * re-render. Vedi bug C5/T1.
 */
export function resetBoundGuard(): void {
  _boundShowDetail = false;
}

export function renderShowDetail(main: HTMLElement): void {
  const state = getState();
  const showId = safeId(state.currentShowId);
  const show = state.shows.find((s) => s.id === showId);
  if (!show) {
    // H13: usa closeShow() invece di mutare currentShowId direttamente,
    // così emitChange viene triggerato e la nav si aggiorna.
    closeShow();
    return;
  }
  if (!show.seasons || typeof show.seasons !== 'object' || Array.isArray(show.seasons)) show.seasons = {};

  // BUG-14-04: filter season keys con regex /^\d+$/ (stretta, no "1.5").
  const seasons = Object.keys(show.seasons)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  if (seasons.length === 0) {
    state.currentSeason = null;
  } else if (!seasons.includes(String(state.currentSeason))) {
    state.currentSeason = parseInt(seasons[0], 10);
  }

  const watched = getWatchedCount(show);
  // BUG-14-02: clamp progress a [0, 100] per gestire watched > totalEpisodes.
  const rawProgress = show.totalEpisodes > 0 ? (watched / show.totalEpisodes) * 100 : 0;
  const progress = Math.max(0, Math.min(100, rawProgress));
  const isCompleted = show.list === 'completed' || (show.totalEpisodes > 0 && watched >= show.totalEpisodes);
  const statusLower = String(show.status || '').toLowerCase();
  const statusClass =
    statusLower.includes('running') || statusLower.includes('in corso') ? 'status-running' : 'status-ended';

  let html =
    '<button class="btn btn-secondary" data-action="closeShow" style="margin-bottom:20px;">' +
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>' +
    'Torna indietro</button>';

  html += '<div class="detail-header">';
  // Poster principale: prova original (alta qualità), fallback su medium, poi placeholder.
  // BUG-14-03: regex /\/medium_(portrait|landscape)\// matcha solo path-segment TVMaze.
  const bigImg = show.image ? show.image.replace(/\/medium_(portrait|landscape)\//, '/original_$1/') : null;
  if (bigImg && show.image && bigImg !== show.image) {
    // Catena: original -> medium -> placeholder
    html +=
      '<img class="detail-poster" src="' +
      escapeAttr(bigImg) +
      '" alt="' +
      escapeAttr(show.name) +
      '" loading="eager" decoding="async" data-fallback="Immagine non disponibile" data-fallback-cls="detail-poster-placeholder" data-fallback-src="' +
      escapeAttr(show.image) +
      '">';
  } else if (show.image) {
    // Solo medium disponibile
    html +=
      '<img class="detail-poster" src="' +
      escapeAttr(show.image) +
      '" alt="' +
      escapeAttr(show.name) +
      '" loading="eager" decoding="async" data-fallback="Immagine non disponibile" data-fallback-cls="detail-poster-placeholder">';
  } else {
    html += '<div class="detail-poster-placeholder">Immagine non disponibile</div>';
  }
  html +=
    '<div class="detail-info">' +
    '<h1 class="detail-name">' +
    escapeHtml(show.name) +
    '</h1>' +
    '<div class="detail-meta">' +
    '<span><span class="status-badge ' +
    statusClass +
    '">' +
    escapeHtml(show.status) +
    '</span></span>' +
    (show.premiered ? '<span>' + formatDate(show.premiered) + '</span>' : '') +
    '<span>' +
    escapeHtml(show.network) +
    '</span>' +
    '<span>' +
    show.totalSeasons +
    ' stagioni</span>' +
    '<span>' +
    show.totalEpisodes +
    ' episodi</span>' +
    '</div>' +
    '<div class="detail-genres">' +
    show.genres.map((g) => '<span class="genre-tag">' + escapeHtml(g) + '</span>').join('') +
    '</div>' +
    '<div class="detail-progress-block' +
    (isCompleted ? ' completed' : '') +
    '">' +
    '<div class="detail-progress-meta">' +
    '<span>' +
    watched +
    ' / ' +
    show.totalEpisodes +
    ' episodi visti</span>' +
    '<span>' +
    Math.round(progress) +
    '%</span></div>' +
    '<div class="detail-progress-track">' +
    '<div class="detail-progress-fill" style="width:' +
    progress +
    '%"></div></div></div>';

  if (show.summary) {
    html +=
      '<div class="detail-summary">' +
      show.summary
        .split('\n')
        .map((p) => '<p>' + escapeHtml(p) + '</p>')
        .join('') +
      '</div>';
  }

  html += '<div class="detail-actions">';
  if (show.list !== 'watching')
    html +=
      '<button class="btn btn-primary" data-action="moveShow" data-show-id="' +
      show.id +
      '" data-list="watching">In corso</button>';
  if (show.list !== 'towatch')
    html +=
      '<button class="btn btn-secondary" data-action="moveShow" data-show-id="' +
      show.id +
      '" data-list="towatch">Da vedere</button>';
  if (show.list !== 'completed')
    html +=
      '<button class="btn btn-secondary" data-action="moveShow" data-show-id="' +
      show.id +
      '" data-list="completed">Completata</button>';
  html +=
    '<button class="btn btn-secondary" data-action="refreshShow" data-show-id="' +
    show.id +
    '" title="Aggiorna episodi e metadati da TVMaze">Aggiorna dati</button>';
  html +=
    '<button class="btn btn-danger" data-action="removeShow" data-show-id="' +
    show.id +
    '" data-show-name="' +
    escapeAttr(show.name) +
    '">Rimuovi</button></div></div></div>';

  if (seasons.length === 0) {
    html +=
      '<div class="empty-state"><div class="empty-state-title">Nessun episodio disponibile</div><div class="empty-state-text">Questa serie non ha episodi registrati.</div></div>';
    main.innerHTML = html;
    return;
  }

  html += '<div class="season-tabs" role="tablist">';
  for (const s of seasons) {
    const isActive = parseInt(s, 10) === state.currentSeason;
    html +=
      '<div class="season-tab ' +
      (isActive ? 'active' : '') +
      '" role="tab" tabindex="0" aria-selected="' +
      (isActive ? 'true' : 'false') +
      '" data-action="switchSeason" data-season="' +
      parseInt(s, 10) +
      '">Stagione ' +
      s +
      '</div>';
  }
  html += '</div>';

  if (state.currentSeason != null) {
    html +=
      '<div class="season-actions">' +
      '<button class="btn btn-secondary btn-sm" data-action="markSeason" data-show-id="' +
      show.id +
      '" data-season="' +
      state.currentSeason +
      '" data-watched="1">Segna tutti come visti</button>' +
      '<button class="btn btn-secondary btn-sm" data-action="markSeason" data-show-id="' +
      show.id +
      '" data-season="' +
      state.currentSeason +
      '" data-watched="0">Segna tutti come non visti</button>' +
      '</div>';
    const eps = show.seasons[state.currentSeason] || [];
    html += '<div class="episode-list">';
    for (const ep of eps) {
      const epTitle = ep.name
        ? escapeHtml(ep.name)
        : '<span style="color:var(--text-muted);font-style:italic;">Episodio ' + ep.num + '</span>';
      const epNumberLabel = 'S' + state.currentSeason + 'E' + ep.num;
      const runtimeLabel = ep.runtime ? ' • ' + ep.runtime + ' min' : '';
      const ariaLabel = ep.name
        ? escapeAttr(ep.name + ' (' + epNumberLabel + ')')
        : escapeAttr('Episodio ' + ep.num + ' (' + epNumberLabel + ')');
      html +=
        '<div class="episode-item ' +
        (ep.watched ? 'watched' : '') +
        '" data-action="toggleEpisode" data-show-id="' +
        show.id +
        '" data-season="' +
        state.currentSeason +
        '" data-ep="' +
        ep.num +
        '" role="button" tabindex="0" aria-label="' +
        ariaLabel +
        '" style="cursor:pointer;">' +
        '<div class="episode-checkbox ' +
        (ep.watched ? 'checked' : '') +
        '"></div>' +
        '<div class="episode-info">' +
        '<div class="episode-name">' +
        epTitle +
        '</div>' +
        '<div class="episode-meta">' +
        epNumberLabel +
        (ep.airdate ? ' • ' + formatDate(ep.airdate) : '') +
        runtimeLabel +
        '</div>' +
        '</div></div>';
    }
    html += '</div>';
  }
  main.innerHTML = html;

  // Auto-refresh in background se mancano i nomi episodi (serie vecchie)
  if (showNeedsEpisodeNames(show)) {
    void refreshShowEpisodes(show.id, { silent: true });
  }
}

// Bind eventi via event delegation sul main content.
// CRITICAL FIX (C5/T1 + BUG-14-01): guardia _boundShowDetail + removeEventListener
// del vecchio handler prima di bindarne uno nuovo. Il renderer chiama
// resetBoundGuard() prima del bind, così ad ogni cambio vista la guardia è
// false e il listener viene aggiunto una sola volta per quella vista.
export function bindShowDetailEvents(main: HTMLElement): void {
  if (_boundShowDetail) return;
  _boundShowDetail = true;
  // BUG-14-01: removeEventListener del vecchio handler (solo se stesso stesso main).
  if (_showDetailClickHandler && _showDetailMain === main) {
    main.removeEventListener('click', _showDetailClickHandler);
  }
  if (_showDetailKeydownHandler && _showDetailMain === main) {
    main.removeEventListener('keydown', _showDetailKeydownHandler);
  }
  _showDetailMain = main;

  const clickHandler = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const showId = Number(actionEl.dataset.showId);
    if (action === 'switchSeason') {
      switchSeason(Number(actionEl.dataset.season));
    } else if (action === 'moveShow') {
      const list = actionEl.dataset.list as 'watching' | 'towatch' | 'completed';
      if (list) moveShowToList(showId, list);
    } else if (action === 'removeShow') {
      const name = actionEl.dataset.showName || '';
      removeShow(showId, name);
    } else if (action === 'toggleEpisode') {
      toggleEpisode(showId, Number(actionEl.dataset.season), Number(actionEl.dataset.ep));
    } else if (action === 'markSeason') {
      markSeasonWatched(showId, Number(actionEl.dataset.season), actionEl.dataset.watched === '1');
    } else if (action === 'refreshShow') {
      void refreshShowEpisodes(showId);
    }
  };
  // H17 a11y: keydown Enter/Space su elementi con role=button o role=tab.
  const keydownHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const role = target.getAttribute('role');
    if (role === 'button' || role === 'tab') {
      e.preventDefault();
      target.click();
    }
  };
  _showDetailClickHandler = clickHandler;
  _showDetailKeydownHandler = keydownHandler;
  main.addEventListener('click', clickHandler);
  main.addEventListener('keydown', keydownHandler);
}
