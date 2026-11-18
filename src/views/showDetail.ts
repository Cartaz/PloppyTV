// Vista dettaglio show con episodi

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
import { t, showStatusLabel } from '../lib/i18n';

let _showDetailClickHandler: ((e: MouseEvent) => void) | null = null;
let _showDetailKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
let _showDetailMain: HTMLElement | null = null;

// ===== P2 helper: star rating HTML per episodio =====
function starRatingHtml(showId: number, season: number, epNum: number, rating: number | undefined): string {
  let html =
    '<span class="ep-rating" role="group" aria-label="' +
    t('detail.ratingGroup') +
    '" ' +
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
    (hasNote ? t('notes.editNote') : t('notes.addNote')) +
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
  html += '<div class="detail-tags-label">' + t('detail.tagsLabel') + '</div>';
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
  html +=
    '<button class="tag-add-btn" data-action="addTag" data-show-id="' +
    show.id +
    '">' +
    t('detail.addTag') +
    '</button>';
  html += '</div></div>';
  return html;
}

// ===== P2 helper: media rating stagione =====
function seasonAvgRating(eps: Array<{ rating?: number }>): string {
  const rated = eps.filter((e) => (e.rating ?? 0) > 0);
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
    // Usa closeShow() invece di mutare currentShowId direttamente,
    // così emitChange viene triggerato e la nav si aggiorna.
    closeShow();
    return;
  }

  // Filter season keys con regex /^\d+$/ (stretta, no "1.5").
  const seasons = Object.keys(show.seasons)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  if (seasons.length === 0) {
    state.currentSeason = null;
  } else if (!seasons.includes(String(state.currentSeason))) {
    state.currentSeason = parseInt(seasons[0], 10);
  }

  const watched = getWatchedCount(show);
  // Clamp progress a [0, 100] per gestire watched > totalEpisodes.
  const rawProgress = show.totalEpisodes > 0 ? (watched / show.totalEpisodes) * 100 : 0;
  const progress = Math.max(0, Math.min(100, rawProgress));
  const isCompleted = show.list === 'completed' || (show.totalEpisodes > 0 && watched >= show.totalEpisodes);
  const statusClass = show.status === 'Running' ? 'status-running' : 'status-ended';

  let html =
    '<button class="btn btn-secondary" data-action="closeShow" style="margin-bottom:20px;">' +
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>' +
    t('actions.back') +
    '</button>';

  html += '<div class="detail-header">';
  // Poster: l'URL medium del CDN TVMaze (quello salvato). La variante
  // "original_untouched" pesa >1 MB; "original_portrait" non esiste (404).
  if (show.image) {
    html +=
      '<img class="detail-poster" src="' +
      escapeAttr(show.image) +
      '" alt="' +
      escapeAttr(show.name) +
      '" loading="eager" decoding="async" data-fallback="' +
      escapeAttr(t('detail.imageUnavailable')) +
      '" data-fallback-cls="detail-poster-placeholder">';
  } else {
    html += '<div class="detail-poster-placeholder">' + t('detail.imageUnavailable') + '</div>';
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
    escapeHtml(showStatusLabel(show.status)) +
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
    t('detail.watchedOf', { watched, total: show.totalEpisodes }) +
    '</span>' +
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
      '" data-list="watching">' +
      t('nav.watching') +
      '</button>';
  if (show.list !== 'towatch')
    html +=
      '<button class="btn btn-secondary" data-action="moveShow" data-show-id="' +
      show.id +
      '" data-list="towatch">' +
      t('nav.towatch') +
      '</button>';
  if (show.list !== 'completed')
    html +=
      '<button class="btn btn-secondary" data-action="moveShow" data-show-id="' +
      show.id +
      '" data-list="completed">' +
      t('search.addCompleted') +
      '</button>';
  html +=
    '<button class="btn btn-secondary" data-action="refreshShow" data-show-id="' +
    show.id +
    '" title="' +
    t('detail.refreshTitle') +
    '">' +
    t('detail.refreshData') +
    '</button>';
  html +=
    '<button class="btn btn-danger" data-action="removeShow" data-show-id="' +
    show.id +
    '" data-show-name="' +
    escapeAttr(show.name) +
    '">' +
    t('actions.remove') +
    '</button></div></div></div>';

  if (seasons.length === 0) {
    html +=
      '<div class="empty-state"><div class="empty-state-title">' +
      t('detail.noEpisodes') +
      '</div><div class="empty-state-text">' +
      t('detail.noEpisodes.desc') +
      '</div></div>';
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
      '">' +
      t('detail.season', { n: s }) +
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
      '" data-watched="1">' +
      t('detail.markAllWatched') +
      '</button>' +
      '<button class="btn btn-secondary btn-sm" data-action="markSeason" data-show-id="' +
      show.id +
      '" data-season="' +
      state.currentSeason +
      '" data-watched="0">' +
      t('detail.markAllUnwatched') +
      '</button>' +
      '</div>';
    const epsArr = show.seasons[state.currentSeason] ?? [];
    // P2.1: media rating stagione nella sezione actions
    const avgLabel = seasonAvgRating(epsArr);
    if (avgLabel) {
      html += '<div class="season-rating-avg">' + t('detail.seasonAvgRating') + avgLabel + '</div>';
    }
    html += '<div class="episode-list">';
    // Ordine per numero: dopo refresh o import gli episodi possono essere salvati fuori ordine.
    const sortedEps = [...epsArr].sort((a, b) => a.num - b.num);
    for (const ep of sortedEps) {
      const epTitle = ep.name
        ? escapeHtml(ep.name)
        : '<span style="color:var(--text-muted);font-style:italic;">' + t('detail.episode', { n: ep.num }) + '</span>';
      const epNumberLabel = 'S' + state.currentSeason + 'E' + ep.num;
      const runtimeLabel = ep.runtime ? ' • ' + ep.runtime + ' min' : '';
      const ariaLabel = ep.name
        ? escapeAttr(ep.name + ' (' + epNumberLabel + ')')
        : escapeAttr(t('detail.episode', { n: ep.num }) + ' (' + epNumberLabel + ')');
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

// Bind eventi via event delegation sul main content. Idempotente: rimuove
// l'handler del render precedente prima di aggiungere quello nuovo.
export function bindShowDetailEvents(main: HTMLElement): void {
  // removeEventListener del vecchio handler (solo se stesso stesso main).
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
  const ep = show?.seasons[season]?.find((e) => e.num === epNum);
  if (!show || !ep) return;
  const epName = ep.name || t('detail.episode', { n: epNum });
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

  showModal(t('notes.title'), bodyHtml, [
    { label: t('actions.cancel') },
    {
      label: t('actions.save'),
      style: 'btn-primary',
      keepOpen: true,
      onClick: () => {
        const ta = document.getElementById('noteTextarea') as HTMLTextAreaElement | null;
        if (!ta) return;
        if (setEpisodeNote(showId, season, epNum, ta.value)) {
          closeModal();
          showToast(t('notes.saved'), 'success');
        }
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
    if (s.id !== showId) for (const t of s.tags ?? []) allTags.add(t);
  }
  const suggestions = Array.from(allTags)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 12);

  let suggestionsHtml = '';
  if (suggestions.length > 0) {
    suggestionsHtml =
      '<div style="margin-top:12px;font-size:12px;color:var(--text-muted);margin-bottom:6px;">' +
      t('detail.suggestions') +
      '</div>' +
      '<div class="tag-suggestions">' +
      suggestions
        .map((t) => '<button class="tag-suggestion" data-tag="' + escapeAttr(t) + '">' + escapeHtml(t) + '</button>')
        .join('') +
      '</div>';
  }

  const bodyHtml =
    '<input type="text" id="tagInput" class="tag-input" maxlength="' +
    MAX_TAG_LENGTH +
    '" placeholder="' +
    t('tags.placeholder') +
    '" autocomplete="off">' +
    suggestionsHtml;

  showModal(t('detail.addTagTitle', { name: show.name }), bodyHtml, [
    { label: t('actions.cancel') },
    {
      label: t('actions.add'),
      style: 'btn-primary',
      // keepOpen=true + closeModal manuale on success.
      // Prima il modal si chiudeva SEMPRE (anche su fallimento: tag duplicato,
      // max raggiunto, errore storage), costringendo l'utente a riaprirlo per
      // riprovare. Ora il modal resta aperto su fallimento (addShowTag mostra
      // già un toast di errore) e si chiude solo su successo.
      keepOpen: true,
      onClick: () => {
        const input = document.getElementById('tagInput') as HTMLInputElement | null;
        if (!input) return;
        const tag = input.value.trim();
        if (tag.length === 0) return;
        if (addShowTag(showId, tag)) {
          closeModal();
          showToast(t('tags.added'), 'success');
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
              showToast(t('tags.added'), 'success');
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
