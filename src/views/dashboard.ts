// Vista Dashboard

import type { Show } from '../types';
import { getState } from '../lib/store';
import { getWatchedCount, findNextEpisode, escapeHtml, escapeAttr } from '../lib/utils';
import { imgTag } from '../components/img';
import { getRandomGoldEpisode } from '../lib/shows';
import { openShow } from '../lib/store';
import { showToast } from '../components/toast';

function showCardHtml(show: Show): string {
  const watched = getWatchedCount(show);
  // Clamp a [0, 100] per gestire watched > totalEpisodes (dati corrotti).
  const rawProgress = show.totalEpisodes > 0 ? (watched / show.totalEpisodes) * 100 : 0;
  const progress = Math.max(0, Math.min(100, rawProgress));
  const isCompleted = show.list === 'completed' || (show.totalEpisodes > 0 && watched >= show.totalEpisodes);
  return (
    '<div class="show-card" data-action="openShow" data-show-id="' +
    escapeAttr(show.id) +
    '" role="button" tabindex="0">' +
    (show.image
      ? imgTag(show.image, show.name, 'show-card-poster')
      : '<div class="show-card-placeholder">' + escapeHtml(show.name) + '</div>') +
    '<div class="show-card-info"><div class="show-card-name">' +
    escapeHtml(show.name) +
    '</div>' +
    '<div class="show-card-meta">' +
    watched +
    '/' +
    show.totalEpisodes +
    ' ep</div></div>' +
    '<div class="show-card-progress"><div class="show-card-progress-bar' +
    (isCompleted ? ' completed' : '') +
    '" style="width:' +
    progress +
    '%"></div></div>' +
    '</div>'
  );
}

// Bound keydown listener su main — singleton per evitare accumulation.
const _dashboardKeydownBound = new WeakSet<HTMLElement>();

/**
 * Registra il keydown listener (Enter/Space → click) per gli elementi
 * con role="button" all'interno di main, + il click listener del
 * #randomGoldBtn (se presente). Idempotente per il keydown (WeakSet),
 * ma il goldBtn viene (re)boundato ad ogni chiamata: l'elemento è
 * ricreato dal nuovo innerHTML ad ogni render, quindi il vecchio
 * listener è GC'd con il vecchio nodo — nessuna accumulation.
 */
export function bindKeydown(main: HTMLElement): void {
  if (!_dashboardKeydownBound.has(main)) {
    _dashboardKeydownBound.add(main);
    main.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      // Triggera click solo su elementi con role=button (show-card, continue-card, section-link).
      if (target.getAttribute('role') === 'button') {
        ev.preventDefault();
        target.click();
      }
    });
  }

  // Il goldBtn va (re)boundato ad ogni render — è un nuovo
  // elemento ogni volta (innerHTML wipe). Il guard WeakSet protegge solo
  // il keydown listener (che è su main, persistente).
  const goldBtn = main.querySelector('#randomGoldBtn') as HTMLElement | null;
  if (goldBtn) {
    goldBtn.addEventListener('click', () => {
      const ep = getRandomGoldEpisode();
      if (!ep) {
        showToast('Non hai ancora episodi con rating 5★. Dai 5 stelle ai tuoi preferiti!', 'warning');
        return;
      }
      // Apri il dettaglio della serie per far rivedere l'episodio
      openShow(ep.show.id);
      // Ep.ep.num non è validato da getRandomGoldEpisode
      // (filtra solo rating/watched). Su stato corrotto potrebbe essere
      // una stringa malevola → interpolazione raw in toast era safe
      // (textContent), ma coerciamo a number per consistenza col hint HTML.
      const epNum = Number(ep.ep.num) || 0;
      showToast(
        'Episodio oro: ' + ep.show.name + ' S' + ep.season + 'E' + epNum + (ep.ep.name ? ' — ' + ep.ep.name : ''),
        'success',
      );
    });
  }
}

export function renderDashboard(main: HTMLElement): void {
  const state = getState();
  const watching = state.shows.filter((s) => s.list === 'watching');
  const towatch = state.shows.filter((s) => s.list === 'towatch');
  const completed = state.shows.filter((s) => s.list === 'completed');
  const totalShows = state.shows.length;
  const totalWatched = state.shows.reduce((sum, s) => sum + getWatchedCount(s), 0);

  let html = '<h1 class="page-title">Dashboard</h1>';

  if (totalShows === 0) {
    html +=
      '<div class="empty-state">' +
      '<svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' +
      '<div class="empty-state-title">Benvenuto in PloppyTV!</div>' +
      '<div class="empty-state-text">Non hai ancora aggiunto nessuna serie. Usa la barra di ricerca in alto per trovare le tue serie TV preferite.</div>' +
      '</div>';
    main.innerHTML = html;
    bindKeydown(main);
    return;
  }

  html +=
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-value">' +
    totalShows +
    '</div><div class="stat-label">Serie tracciate</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    totalWatched +
    '</div><div class="stat-label">Episodi visti</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    watching.length +
    '</div><div class="stat-label">In corso</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    completed.length +
    '</div><div class="stat-label">Completate</div></div>' +
    '</div>';

  // continueWatching: include solo show con episodi da guardare (watched < totalEpisodes).
  const continueWatching = watching
    .filter((s) => s.totalEpisodes > 0 && getWatchedCount(s) < s.totalEpisodes)
    .slice(0, 8);
  if (continueWatching.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Continua a guardare</h2></div><div class="continue-grid">';
    for (const show of continueWatching) {
      const watched = getWatchedCount(show);
      const nextEp = findNextEpisode(show);
      html +=
        '<div class="continue-card" data-action="openShow" data-show-id="' +
        escapeAttr(show.id) +
        '" role="button" tabindex="0">' +
        imgTag(show.image, show.name, 'continue-card-poster') +
        '<div class="continue-card-body"><div>' +
        '<div class="continue-card-name">' +
        escapeHtml(show.name) +
        '</div>' +
        // Mostra "Prossimo" solo se nextEp ha num > 0.
        (nextEp && nextEp.num > 0
          ? '<div class="continue-card-ep">Prossimo: Stagione ' + nextEp.season + ', Ep ' + nextEp.num + '</div>'
          : '<div class="continue-card-ep">' + watched + '/' + show.totalEpisodes + ' episodi</div>') +
        '</div><div class="continue-card-btn">Continua</div></div></div>';
    }
    html += '</div></div>';
  }

  // P2.5: Random gold episode button (solo se ci sono episodi 5★)
  const goldEp = getRandomGoldEpisode();
  if (goldEp) {
    // Ep.ep.num non è validato da getRandomGoldEpisode; su stato
    // corrotto potrebbe essere una stringa malevola. Coerciamo a number
    // prima di interpolare in HTML (XSS defense-in-depth).
    const goldEpNum = Number(goldEp.ep.num) || 0;
    html +=
      '<div class="section random-gold-section">' +
      '<div class="random-gold-card" id="randomGoldBtn" role="button" tabindex="0">' +
      '<div class="random-gold-icon">★</div>' +
      '<div class="random-gold-info">' +
      '<div class="random-gold-title">Rivedi un episodio oro</div>' +
      '<div class="random-gold-desc">Un episodio 5★ a caso dalla tua libreria</div>' +
      '<div class="random-gold-hint">' +
      escapeHtml(goldEp.show.name) +
      ' — S' +
      goldEp.season +
      'E' +
      goldEpNum +
      '</div>' +
      '</div>' +
      '<div class="random-gold-action">Sorprendimi</div>' +
      '</div>' +
      '</div>';
  }

  if (watching.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Sto guardando</h2><span class="section-link" data-action="switchView" data-view="watching" role="button" tabindex="0">Vedi tutte</span></div>';
    html += '<div class="card-grid">' + watching.slice(0, 12).map(showCardHtml).join('') + '</div></div>';
  }
  if (towatch.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Da vedere</h2><span class="section-link" data-action="switchView" data-view="towatch" role="button" tabindex="0">Vedi tutte</span></div>';
    html += '<div class="card-grid">' + towatch.slice(0, 12).map(showCardHtml).join('') + '</div></div>';
  }
  if (completed.length > 0) {
    html +=
      '<div class="section"><div class="section-header"><h2 class="section-title">Completate</h2><span class="section-link" data-action="switchView" data-view="completed" role="button" tabindex="0">Vedi tutte</span></div>';
    html += '<div class="card-grid">' + completed.slice(0, 12).map(showCardHtml).join('') + '</div></div>';
  }
  main.innerHTML = html;
  bindKeydown(main);
}

export { showCardHtml };
