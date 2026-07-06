// Vista statistiche: usa Web Worker per il calcolo

import { getState } from '../lib/store';
import { computeStatsAsync } from '../worker/client';
import { escapeHtml } from '../lib/utils';
import { imgTag } from '../components/img';
import type { StatsResult } from '../types';

function renderStatsSkeleton(main: HTMLElement): void {
  main.innerHTML =
    '<h1 class="page-title">Statistiche</h1>' +
    '<div class="loading"><div class="spinner"></div>Calcolando statistiche...</div>';
}

function renderStatsContent(main: HTMLElement, stats: StatsResult): void {
  if (stats.totalShows === 0) {
    main.innerHTML =
      '<h1 class="page-title">Statistiche</h1>' +
      '<div class="empty-state"><div class="empty-state-title">Nessun dato</div><div class="empty-state-text">Aggiungi serie TV per visualizzare le statistiche.</div></div>';
    return;
  }

  let html = '<h1 class="page-title">Statistiche</h1>';
  html +=
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-value">' + stats.totalShows + '</div><div class="stat-label">Serie tracciate</div></div>' +
    '<div class="stat-card"><div class="stat-value">' + stats.totalWatched + '</div><div class="stat-label">Episodi visti</div></div>' +
    '<div class="stat-card"><div class="stat-value">' + stats.timeLabel + '</div><div class="stat-label">Tempo totale</div></div>' +
    '<div class="stat-card"><div class="stat-value">' + stats.completedShows + '</div><div class="stat-label">Completate</div></div>' +
    '<div class="stat-card"><div class="stat-value">' + stats.watchingShows + '</div><div class="stat-label">In corso</div></div>' +
    '<div class="stat-card"><div class="stat-value">' + stats.towatchShows + '</div><div class="stat-label">Da vedere</div></div>' +
    '<div class="stat-card"><div class="stat-value">' + stats.totalProgress + '%</div><div class="stat-label">Progresso totale</div></div>' +
    '</div>';

  // Generi
  html += '<div class="section"><h2 class="section-title" style="margin-bottom:16px;">Generi più visti</h2>';
  const maxCount = stats.topGenres.length > 0 ? (stats.topGenres[0].episodes || 1) : 1;
  if (stats.topGenres.length === 0 || stats.topGenres.every((g) => g.episodes === 0)) {
    html += '<p style="color:var(--text-muted);">Nessun dato. Segna alcuni episodi come visti.</p>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:12px;">';
    for (const { genre, episodes, shows } of stats.topGenres) {
      const pct = maxCount > 0 ? (episodes / maxCount * 100) : 0;
      html +=
        '<div><div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px;">' +
        '<span>' + escapeHtml(genre) + '</span>' +
        '<span style="color:var(--text-muted);">' + episodes + ' ep • ' + shows + ' serie</span></div>' +
        '<div style="height:8px;background:var(--bg-card);border-radius:4px;overflow:hidden;">' +
        '<div style="height:100%;width:' + pct + '%;background:var(--accent);"></div></div></div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Top serie
  html += '<div class="section"><h2 class="section-title" style="margin-bottom:16px;">Top serie per completamento</h2>';
  if (stats.topShows.length === 0) {
    html += '<p style="color:var(--text-muted);">Nessun dato.</p>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:8px;">';
    for (const item of stats.topShows) {
      const imgHtml = item.image ? imgTag(item.image, item.showName, '', 'width:40px;height:60px;object-fit:cover;border-radius:4px;') : '';
      html +=
        '<div class="episode-item" data-action="openShow" data-show-id="' + item.showId + '" style="cursor:pointer;">' +
        imgHtml +
        '<div class="episode-info"><div class="episode-name">' + escapeHtml(item.showName) + '</div>' +
        '<div class="episode-meta">' + item.watched + '/' + item.totalEpisodes + ' episodi • ' + Math.round(item.pct) + '%</div></div></div>';
    }
    html += '</div>';
  }
  html += '</div>';

  main.innerHTML = html;
}

export async function renderStats(main: HTMLElement): Promise<void> {
  renderStatsSkeleton(main);
  try {
    const stats = await computeStatsAsync(getState().shows);
    renderStatsContent(main, stats);
  } catch (e) {
    console.error('[stats] error:', e);
    main.innerHTML =
      '<h1 class="page-title">Statistiche</h1>' +
      '<div class="empty-state"><div class="empty-state-title">Errore caricamento</div><div class="empty-state-text">Riprova.</div></div>';
  }
}
