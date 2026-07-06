// Vista dettaglio show con episodi

import { getState, switchSeason } from '../lib/store';
import { safeId, escapeHtml, escapeAttr, getWatchedCount, formatDate } from '../lib/utils';
import { moveShowToList, removeShow, toggleEpisode, markSeasonWatched, refreshShowEpisodes, showNeedsEpisodeNames } from '../lib/shows';

export function renderShowDetail(main: HTMLElement): void {
  const state = getState();
  const showId = safeId(state.currentShowId);
  const show = state.shows.find((s) => s.id === showId);
  if (!show) {
    state.currentShowId = null;
    import('./dashboard').then(({ renderDashboard }) => renderDashboard(main));
    return;
  }
  if (!show.seasons || typeof show.seasons !== 'object' || Array.isArray(show.seasons)) show.seasons = {};

  const seasons = Object.keys(show.seasons)
    .filter((k) => !isNaN(parseInt(k, 10)))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  if (seasons.length === 0) {
    state.currentSeason = null;
  } else if (!seasons.includes(String(state.currentSeason))) {
    state.currentSeason = parseInt(seasons[0], 10);
  }

  const watched = getWatchedCount(show);
  const progress = show.totalEpisodes > 0 ? (watched / show.totalEpisodes) * 100 : 0;
  const isCompleted = show.list === 'completed' || (show.totalEpisodes > 0 && watched >= show.totalEpisodes);
  const statusLower = String(show.status || '').toLowerCase();
  const statusClass = statusLower.includes('running') || statusLower.includes('in corso') ? 'status-running' : 'status-ended';

  let html =
    '<button class="btn btn-secondary" data-action="closeShow" style="margin-bottom:20px;">' +
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>' +
    'Torna indietro</button>';

  html += '<div class="detail-header">';
  // Poster principale: prova original (alta qualità), fallback su medium, poi placeholder.
  // show.image è già la versione medium (vedi getPosterUrl); bigImg è la original.
  const bigImg = show.image ? show.image.replace('medium', 'original') : null;
  if (bigImg && show.image && bigImg !== show.image) {
    // Catena: original -> medium -> placeholder
    html += '<img class="detail-poster" src="' + escapeAttr(bigImg) + '" alt="' + escapeAttr(show.name) + '" loading="eager" decoding="async" data-fallback="Immagine non disponibile" data-fallback-cls="detail-poster-placeholder" data-fallback-src="' + escapeAttr(show.image) + '">';
  } else if (show.image) {
    // Solo medium disponibile
    html += '<img class="detail-poster" src="' + escapeAttr(show.image) + '" alt="' + escapeAttr(show.name) + '" loading="eager" decoding="async" data-fallback="Immagine non disponibile" data-fallback-cls="detail-poster-placeholder">';
  } else {
    html += '<div class="detail-poster-placeholder">Immagine non disponibile</div>';
  }
  html +=
    '<div class="detail-info">' +
    '<h1 class="detail-name">' + escapeHtml(show.name) + '</h1>' +
    '<div class="detail-meta">' +
    '<span><span class="status-badge ' + statusClass + '">' + escapeHtml(show.status) + '</span></span>' +
    (show.premiered ? '<span>' + formatDate(show.premiered) + '</span>' : '') +
    '<span>' + escapeHtml(show.network) + '</span>' +
    '<span>' + show.totalSeasons + ' stagioni</span>' +
    '<span>' + show.totalEpisodes + ' episodi</span>' +
    '</div>' +
    '<div class="detail-genres">' + show.genres.map((g) => '<span class="genre-tag">' + escapeHtml(g) + '</span>').join('') + '</div>' +
    '<div class="detail-progress-block' + (isCompleted ? ' completed' : '') + '">' +
    '<div class="detail-progress-meta">' +
    '<span>' + watched + ' / ' + show.totalEpisodes + ' episodi visti</span>' +
    '<span>' + Math.round(progress) + '%</span></div>' +
    '<div class="detail-progress-track">' +
    '<div class="detail-progress-fill" style="width:' + progress + '%"></div></div></div>';

  if (show.summary) {
    html += '<div class="detail-summary">' + show.summary.split('\n').map((p) => '<p>' + escapeHtml(p) + '</p>').join('') + '</div>';
  }

  html += '<div class="detail-actions">';
  if (show.list !== 'watching') html += '<button class="btn btn-primary" data-action="moveShow" data-show-id="' + show.id + '" data-list="watching">In corso</button>';
  if (show.list !== 'towatch') html += '<button class="btn btn-secondary" data-action="moveShow" data-show-id="' + show.id + '" data-list="towatch">Da vedere</button>';
  if (show.list !== 'completed') html += '<button class="btn btn-secondary" data-action="moveShow" data-show-id="' + show.id + '" data-list="completed">Completata</button>';
  html += '<button class="btn btn-secondary" data-action="refreshShow" data-show-id="' + show.id + '" title="Aggiorna episodi e metadati da TVMaze">Aggiorna dati</button>';
  html += '<button class="btn btn-danger" data-action="removeShow" data-show-id="' + show.id + '" data-show-name="' + escapeAttr(show.name) + '">Rimuovi</button></div></div></div>';

  if (seasons.length === 0) {
    html += '<div class="empty-state"><div class="empty-state-title">Nessun episodio disponibile</div><div class="empty-state-text">Questa serie non ha episodi registrati.</div></div>';
    main.innerHTML = html;
    return;
  }

  html += '<div class="season-tabs">';
  for (const s of seasons) {
    html += '<div class="season-tab ' + (parseInt(s, 10) === state.currentSeason ? 'active' : '') + '" data-action="switchSeason" data-season="' + parseInt(s, 10) + '">Stagione ' + s + '</div>';
  }
  html += '</div>';

  if (state.currentSeason != null) {
    html +=
      '<div class="season-actions">' +
      '<button class="btn btn-secondary btn-sm" data-action="markSeason" data-show-id="' + show.id + '" data-season="' + state.currentSeason + '" data-watched="1">Segna tutti come visti</button>' +
      '<button class="btn btn-secondary btn-sm" data-action="markSeason" data-show-id="' + show.id + '" data-season="' + state.currentSeason + '" data-watched="0">Segna tutti come non visti</button>' +
      '</div>';
    const eps = show.seasons[state.currentSeason] || [];
    // Calcola runtime medio se presente (per info bonus)
    html += '<div class="episode-list">';
    for (const ep of eps) {
      const epTitle = ep.name
        ? escapeHtml(ep.name)
        : '<span style="color:var(--text-muted);font-style:italic;">Episodio ' + ep.num + '</span>';
      const epNumberLabel = 'S' + state.currentSeason + 'E' + ep.num;
      const runtimeLabel = ep.runtime ? ' • ' + ep.runtime + ' min' : '';
      html +=
        '<div class="episode-item ' + (ep.watched ? 'watched' : '') + '" data-action="toggleEpisode" data-show-id="' + show.id + '" data-season="' + state.currentSeason + '" data-ep="' + ep.num + '" style="cursor:pointer;">' +
        '<div class="episode-checkbox ' + (ep.watched ? 'checked' : '') + '"></div>' +
        '<div class="episode-info">' +
        '<div class="episode-name">' + epTitle + '</div>' +
        '<div class="episode-meta">' + epNumberLabel + (ep.airdate ? ' • ' + formatDate(ep.airdate) : '') + runtimeLabel + '</div>' +
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

// Bind eventi via event delegation sul main content
export function bindShowDetailEvents(main: HTMLElement): void {
  main.addEventListener('click', (e) => {
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
  });
}
