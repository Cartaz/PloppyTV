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
  setEpisodeRating,
  setEpisodeNote,
  addShowTag,
  removeShowTag,
} from '../lib/shows';
import { showModal, closeModal } from '../components/modal';
import { showToast } from '../components/toast';
import { MAX_EPISODE_RATING, MAX_EPISODE_NOTE_LENGTH, MAX_TAG_LENGTH } from '../lib/constants';

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

// ===== P2 helper: star rating HTML per episodio =====
function starRatingHtml(showId: number, season: number, epNum: number, rating: number | undefined): string {
  let html =
    '<span class="ep-rating" role="group" aria-label="Rating episodio" ' +
    'data-action="rateEpisode" data-show-id="' +
    showId +
    '" data-season="' +
    season +
    '" data-ep="' +
    epNum +
    '">';
  for (let i = 1; i <= MAX_EPISODE_RATING; i++) {
    const filled = rating !== undefined && i <= rating;
    html +=
      '<span class="star' +
      (filled ? ' filled' : '') +
      '" data-star="' +
      i +
      '" role="button" tabindex="0" aria-label="' +
      i +
      ' stelle">★</span>';
  }
  html += '</span>';
  return html;
}

// ===== P2 helper: nota episodio HTML =====
function noteBtnHtml(showId: number, season: number, epNum: number, hasNote: boolean): string {
  return (
    '<button class="ep-note-btn' +
    (hasNote ? ' has-note' : '') +
    '" data-action="editNote" data-show-id="' +
    showId +
    '" data-season="' +
    season +
    '" data-ep="' +
    epNum +
    '" title="' +
    (hasNote ? 'Modifica nota' : 'Aggiungi nota') +
    '">' +
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
    (hasNote ? '<span class="ep-note-dot"></span>' : '') +
    '</button>'
  );
}

// ===== P2 helper: tag management HTML =====
function tagsSectionHtml(show: { id: number; tags?: string[] }): string {
  const tags = show.tags ?? [];
  let html = '<div class="detail-tags-section">';
  html += '<div class="detail-tags-label">Tag:</div>';
  html += '<div class="detail-tags-list">';
  for (const t of tags) {
    html +=
      '<span class="user-tag">' +
      escapeHtml(t) +
      '<button class="tag-remove" data-action="removeTag" data-show-id="' +
      show.id +
      '" data-tag="' +
      escapeAttr(t) +
      '" aria-label="Rimuovi tag ' +
      escapeAttr(t) +
      '">×</button></span>';
  }
  html += '<button class="tag-add-btn" data-action="addTag" data-show-id="' + show.id + '">+ Aggiungi tag</button>';
  html += '</div></div>';
  return html;
}

// ===== P2 helper: media rating stagione =====
function seasonAvgRating(eps: Array<{ rating?: number }>): string {
  const rated = eps.filter((e) => e && typeof e.rating === 'number');
  if (rated.length === 0) return '';
  const sum = rated.reduce((s, e) => s + (e.rating ?? 0), 0);
  const avg = sum / rated.length;
  return ' · ⌀ ' + avg.toFixed(1) + '★ (' + rated.length + ')';
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

  // P2.3: sezione tag personalizzabili
  html += tagsSectionHtml(show);

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
    // P2.1: media rating stagione nella sezione actions
    const avgLabel = seasonAvgRating(eps);
    if (avgLabel) {
      html += '<div class="season-rating-avg">Rating medio stagione' + avgLabel + '</div>';
    }
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
      const hasNote = typeof ep.note === 'string' && ep.note.length > 0;
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
        // P2.1: stelle rating + P2.2: pulsante nota
        '<div class="episode-extras">' +
        starRatingHtml(show.id, state.currentSeason, ep.num, ep.rating) +
        noteBtnHtml(show.id, state.currentSeason, ep.num, hasNote) +
        '</div>' +
        (hasNote ? '<div class="episode-note-preview">' + escapeHtml(ep.note!) + '</div>' : '') +
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
      // P2: evita il toggle se il click origina da stelle/note/tag (elementi con data-action propri)
      // — closest() ha già trovato il nearest data-action, quindi se siamo qui
      //   il click è davvero sull'episode-item (non su un figlio con data-action).
      toggleEpisode(showId, Number(actionEl.dataset.season), Number(actionEl.dataset.ep));
    } else if (action === 'markSeason') {
      markSeasonWatched(showId, Number(actionEl.dataset.season), actionEl.dataset.watched === '1');
    } else if (action === 'refreshShow') {
      void refreshShowEpisodes(showId);
    } else if (action === 'rateEpisode') {
      // P2.1: click su una stella → imposta rating
      e.stopPropagation();
      const starEl = target.closest('[data-star]') as HTMLElement | null;
      if (!starEl) return;
      const starVal = Number(starEl.dataset.star);
      const season = Number(actionEl.dataset.season);
      const ep = Number(actionEl.dataset.ep);
      // Recupera il rating corrente per toggle: se clicchi la stessa stella, rimuovi.
      const state = getState();
      const show = state.shows.find((s) => s.id === showId);
      const currentRating = show?.seasons?.[season]?.find((e2) => e2.num === ep)?.rating;
      if (currentRating === starVal) {
        setEpisodeRating(showId, season, ep, 0); // rimuovi
      } else {
        setEpisodeRating(showId, season, ep, starVal);
      }
    } else if (action === 'editNote') {
      // P2.2: apri modale editor nota
      e.stopPropagation();
      const season = Number(actionEl.dataset.season);
      const ep = Number(actionEl.dataset.ep);
      openNoteEditor(showId, season, ep);
    } else if (action === 'addTag') {
      // P2.3: apri modale aggiunta tag
      openAddTagModal(showId);
    } else if (action === 'removeTag') {
      // P2.3: rimuovi tag
      const tag = actionEl.dataset.tag || '';
      if (tag) removeShowTag(showId, tag);
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

// ===== P2.2: Modale editor nota episodio =====
function openNoteEditor(showId: number, season: number, epNum: number): void {
  const state = getState();
  const show = state.shows.find((s) => s.id === showId);
  if (!show || !show.seasons[season]) return;
  const ep = show.seasons[season].find((e) => e.num === epNum);
  if (!ep) return;
  const epName = ep.name || 'Episodio ' + epNum;
  const currentNote = ep.note ?? '';

  const bodyHtml =
    '<p style="margin-bottom:10px;color:var(--text-secondary);font-size:13px;">' +
    escapeHtml(show.name) +
    ' — S' +
    season +
    'E' +
    epNum +
    ': ' +
    escapeHtml(epName) +
    '</p>' +
    '<textarea id="noteTextarea" class="note-textarea" maxlength="' +
    MAX_EPISODE_NOTE_LENGTH +
    '" placeholder="Scrivi una nota privata per questo episodio... (max ' +
    MAX_EPISODE_NOTE_LENGTH +
    ' caratteri)">' +
    escapeHtml(currentNote) +
    '</textarea>' +
    '<div id="noteCharCount" style="text-align:right;font-size:12px;color:var(--text-muted);margin-top:4px;">' +
    currentNote.length +
    '/' +
    MAX_EPISODE_NOTE_LENGTH +
    '</div>';

  showModal('Nota episodio', bodyHtml, [
    { label: 'Annulla' },
    {
      label: 'Salva',
      style: 'btn-primary',
      onClick: () => {
        const ta = document.getElementById('noteTextarea') as HTMLTextAreaElement | null;
        if (!ta) return;
        setEpisodeNote(showId, season, epNum, ta.value);
        showToast('Nota salvata', 'success');
      },
    },
  ]);

  // Aggiorna il contatore caratteri in tempo reale
  setTimeout(() => {
    const ta = document.getElementById('noteTextarea') as HTMLTextAreaElement | null;
    const counter = document.getElementById('noteCharCount');
    if (ta && counter) {
      ta.focus();
      ta.addEventListener('input', () => {
        counter.textContent = ta.value.length + '/' + MAX_EPISODE_NOTE_LENGTH;
      });
    }
  }, 50);
}

// ===== P2.3: Modale aggiunta tag =====
function openAddTagModal(showId: number): void {
  const state = getState();
  const show = state.shows.find((s) => s.id === showId);
  if (!show) return;

  // Suggerisci tag già usati in altre serie (autocomplete visivo)
  const allTags = new Set<string>();
  for (const s of state.shows) {
    if (s.tags && s.id !== showId) for (const t of s.tags) allTags.add(t);
  }
  const suggestions = Array.from(allTags)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 12);

  let suggestionsHtml = '';
  if (suggestions.length > 0) {
    suggestionsHtml =
      '<div style="margin-top:12px;font-size:12px;color:var(--text-muted);margin-bottom:6px;">Suggerimenti:</div>' +
      '<div class="tag-suggestions">' +
      suggestions
        .map((t) => '<button class="tag-suggestion" data-tag="' + escapeAttr(t) + '">' + escapeHtml(t) + '</button>')
        .join('') +
      '</div>';
  }

  const bodyHtml =
    '<input type="text" id="tagInput" class="tag-input" maxlength="' +
    MAX_TAG_LENGTH +
    '" placeholder="Es. da rivedere, con Alice, estate 2026..." autocomplete="off">' +
    suggestionsHtml;

  showModal('Aggiungi tag a "' + show.name + '"', bodyHtml, [
    { label: 'Annulla' },
    {
      label: 'Aggiungi',
      style: 'btn-primary',
      onClick: () => {
        const input = document.getElementById('tagInput') as HTMLInputElement | null;
        if (!input) return;
        const tag = input.value.trim();
        if (tag.length === 0) return;
        if (addShowTag(showId, tag)) {
          showToast('Tag aggiunto', 'success');
        }
      },
    },
  ]);

  // Setup: focus + click sui suggerimenti + Enter per confermare
  setTimeout(() => {
    const input = document.getElementById('tagInput') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const tag = input.value.trim();
          if (tag.length > 0) {
            if (addShowTag(showId, tag)) {
              closeModal();
              showToast('Tag aggiunto', 'success');
            }
          }
        }
      });
    }
    // Click sui suggerimenti → riempie l'input
    document.querySelectorAll('.tag-suggestion').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = (btn as HTMLElement).dataset.tag || '';
        if (input) input.value = t;
        input?.focus();
      });
    });
  }, 50);
}
