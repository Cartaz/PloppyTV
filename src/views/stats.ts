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

  // H19: clamp totalProgress a [0, 100] anche lato view (defense-in-depth).
  // Il worker clampa già, ma se per qualche motivo arrivasse un valore > 100
  // l'UI mostrerebbe "140%" e una barra overflowing.
  const totalProgress = Math.max(0, Math.min(100, stats.totalProgress));
  const totalProgressComplete = totalProgress >= 100;

  let html = '<h1 class="page-title">Statistiche</h1>';
  html +=
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-value">' +
    stats.totalShows +
    '</div><div class="stat-label">Serie tracciate</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    stats.totalWatched +
    '</div><div class="stat-label">Episodi visti</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    escapeHtml(stats.timeLabel) +
    '</div><div class="stat-label">Tempo totale</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    stats.completedShows +
    '</div><div class="stat-label">Completate</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    stats.watchingShows +
    '</div><div class="stat-label">In corso</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    stats.towatchShows +
    '</div><div class="stat-label">Da vedere</div></div>' +
    '<div class="stat-card"><div class="stat-value">' +
    totalProgress +
    '%</div><div class="stat-label">Progresso totale</div></div>' +
    '</div>';

  // Barra di progresso totale: 100% → verde (commit ba32535)
  html +=
    '<div class="section"><div style="height:12px;background:var(--bg-card);border-radius:6px;overflow:hidden;">' +
    '<div style="height:100%;width:' +
    totalProgress +
    '%;background:' +
    (totalProgressComplete ? 'var(--success, #4ade80)' : 'var(--accent)') +
    ';transition:width .3s;"></div></div></div>';

  // Generi
  html += '<div class="section"><h2 class="section-title" style="margin-bottom:16px;">Generi più visti</h2>';
  const maxCount = stats.topGenres.length > 0 ? stats.topGenres[0].episodes || 1 : 1;
  if (stats.topGenres.length === 0 || stats.topGenres.every((g) => g.episodes === 0)) {
    html += '<p style="color:var(--text-muted);">Nessun dato. Segna alcuni episodi come visti.</p>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:12px;">';
    for (const { genre, episodes, shows } of stats.topGenres) {
      const pct = maxCount > 0 ? (episodes / maxCount) * 100 : 0;
      html +=
        '<div><div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px;">' +
        '<span>' +
        escapeHtml(genre) +
        '</span>' +
        '<span style="color:var(--text-muted);">' +
        episodes +
        ' ep • ' +
        shows +
        ' serie</span></div>' +
        '<div style="height:8px;background:var(--bg-card);border-radius:4px;overflow:hidden;">' +
        '<div style="height:100%;width:' +
        pct +
        '%;background:var(--accent);"></div></div></div>';
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
      const imgHtml = item.image
        ? imgTag(item.image, item.showName, '', 'width:40px;height:60px;object-fit:cover;border-radius:4px;')
        : '';
      // H19: clamp pct lato view (defense-in-depth)
      const pct = Math.max(0, Math.min(100, Math.round(item.pct)));
      html +=
        '<div class="episode-item" data-action="openShow" data-show-id="' +
        item.showId +
        '" style="cursor:pointer;">' +
        imgHtml +
        '<div class="episode-info"><div class="episode-name">' +
        escapeHtml(item.showName) +
        '</div>' +
        '<div class="episode-meta">' +
        item.watched +
        '/' +
        item.totalEpisodes +
        ' episodi • ' +
        pct +
        '%</div></div></div>';
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
