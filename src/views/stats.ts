// Vista statistiche: usa Web Worker per il calcolo

import { getState } from '../lib/store';
import { computeStatsAsync } from '../worker/client';
import { escapeHtml, escapeAttr } from '../lib/utils';
import { imgTag } from '../components/img';
import type { StatsResult } from '../types';

function safeClampPct(v: unknown, round: boolean): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  if (!Number.isFinite(v)) return v > 0 ? 100 : 0;
  const c = Math.max(0, Math.min(100, v));
  return round ? Math.round(c) : c;
}

function safeCount(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return v;
}

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

  // Clamp totalProgress a [0, 100] anche lato view (defense-in-depth).
  // Il worker clampa già, ma se per qualche motivo arrivasse un valore > 100
  // l'UI mostrerebbe "140%" e una barra overflowing.
  // safeClampPct gestisce anche NaN/non-number (→ 0 invece di "NaN%").
  const totalProgress = safeClampPct(stats.totalProgress, false);
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
  const topGenres = stats.topGenres;
  // maxCount fallback a 1 se 0/NaN per evitare division-by-zero e pct >100.
  const maxCount = topGenres.length > 0 ? safeCount(topGenres[0].episodes) || 1 : 1;
  if (topGenres.length === 0 || topGenres.every((g) => safeCount(g.episodes) === 0)) {
    html += '<p style="color:var(--text-muted);">Nessun dato. Segna alcuni episodi come visti.</p>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:12px;">';
    for (const { genre, episodes, shows } of topGenres) {
      // Math.round per evitare fractional widths nel CSS.
      // Clamp a [0, 100] per evitare barre >100% se maxCount è 0/inconsistente.
      // safeCount su episodes per gestire NaN/Infinity/stringhe.
      const safeEps = safeCount(episodes);
      const rawPct = maxCount > 0 ? (safeEps / maxCount) * 100 : 0;
      const pct = safeClampPct(rawPct, true);
      html +=
        '<div><div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:4px;">' +
        '<span>' +
        escapeHtml(genre) +
        '</span>' +
        '<span style="color:var(--text-muted);">' +
        safeEps +
        ' ep • ' +
        safeCount(shows) +
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
  const topShows = stats.topShows;
  if (topShows.length === 0) {
    html += '<p style="color:var(--text-muted);">Nessun dato.</p>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:8px;">';
    for (const item of topShows) {
      // Valida item.image come stringa prima di passarlo a imgTag
      // (defense-in-depth contro image non-string truthy come 42/{} che
      // produrrebbe <img src="42"> invalido).
      const imgHtml =
        typeof item.image === 'string' && item.image
          ? imgTag(item.image, item.showName, '', 'width:40px;height:60px;object-fit:cover;border-radius:4px;')
          : '';
      // Clamp pct lato view (defense-in-depth)
      // safeClampPct gestisce NaN/non-number (→ 0 invece di NaN%).
      const pct = safeClampPct(item.pct, true);
      html +=
        '<div class="episode-item" data-action="openShow" data-show-id="' +
        escapeAttr(item.showId) +
        '" style="cursor:pointer;">' +
        imgHtml +
        '<div class="episode-info"><div class="episode-name">' +
        escapeHtml(item.showName) +
        '</div>' +
        '<div class="episode-meta">' +
        safeCount(item.watched) +
        '/' +
        safeCount(item.totalEpisodes) +
        ' episodi • ' +
        pct +
        '%</div></div></div>';
    }
    html += '</div>';
  }
  html += '</div>';

  main.innerHTML = html;
}

// Render token — last-STARTED render wins (non last-resolved).
let _statsRenderToken = 0;

export async function renderStats(main: HTMLElement): Promise<void> {
  const myToken = ++_statsRenderToken;
  // Capture the view/show state at the START of the render. We only
  // enforce the cross-view race check if we were actually on 'stats' with no
  // show detail open at the start — this preserves compatibility with tests
  // that call renderStats directly without setting currentView, and with
  // stores that don't expose currentView (mocked).
  const startView = getState().currentView;
  const startShowId = getState().currentShowId;
  const wasStatsActive = startView === 'stats' && startShowId === null;
  renderStatsSkeleton(main);
  try {
    const stats = await computeStatsAsync(getState().shows);
    // Discard if a newer render has started.
    if (myToken !== _statsRenderToken) return;
    // Cross-view race protection. Il token qui sopra protegge solo
    // contro nuove renderStats (stessa vista). Se l'utente ha cambiato vista o
    // aperto un detail mentre il worker calcolava, _statsRenderToken non è stato
    // incrementato, ma applicare il risultato stale sovrascriverebbe il DOM
    // della nuova vista.
    if (wasStatsActive) {
      const postState = getState();
      if (postState.currentView !== 'stats') return;
      if (postState.currentShowId !== null) return;
    }
    renderStatsContent(main, stats);
  } catch (e) {
    if (myToken !== _statsRenderToken) return;
    // Stessa protezione cross-view nel path di errore.
    if (wasStatsActive) {
      const postState = getState();
      if (postState.currentView !== 'stats') return;
      if (postState.currentShowId !== null) return;
    }
    console.error('[stats] error:', e);
    main.innerHTML =
      '<h1 class="page-title">Statistiche</h1>' +
      '<div class="empty-state"><div class="empty-state-title">Errore caricamento</div><div class="empty-state-text">Riprova.</div></div>';
  }
}
