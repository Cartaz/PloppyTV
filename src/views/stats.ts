// Vista statistiche: usa Web Worker per il calcolo
//
// FIXES applicati:
//  - BUG-A13-01: dopo l'await del worker, verifica che currentView sia ancora
//    'stats' e currentShowId sia null. Se l'utente ha cambiato vista o aperto
//    un detail mentre il worker calcolava, il risultato stale NON sovrascrive
//    il DOM della nuova vista (race cross-view).
//  - BUG-A13-03: NaN/non-number handling per totalProgress, item.pct, genre
//    pct, episodes/shows/watched/totalEpisodes. NaN → 0 (non "NaN%"),
//    Infinity → clamp 100/0, stringhe/undefined → 0.
//  - BUG-A13-05: guard Array.isArray su topGenres/topShows (worker/corrupted data).
//  - BUG-A13-06: item.image validato come stringa prima di passarlo a imgTag
//    (defense-in-depth contro image non-string truthy come 42/{} che
//    produrrebbe <img src="42"> invalido).

import { getState } from '../lib/store';
import { computeStatsAsync } from '../worker/client';
import { escapeHtml, escapeAttr } from '../lib/utils';
import { imgTag } from '../components/img';
import type { StatsResult } from '../types';

/**
 * BUG-A13-03: clampa una percentuale a [0, 100].
 * - NaN / non-number → 0 (evita "NaN%" nell'UI e width:NaN% nel CSS).
 * - +Infinity → 100, -Infinity → 0 (consistenti con il clamp preesistente).
 * - `round` true → Math.round (per bar widths senza fractional CSS).
 */
function safeClampPct(v: unknown, round: boolean): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  if (!Number.isFinite(v)) return v > 0 ? 100 : 0;
  const c = Math.max(0, Math.min(100, v));
  return round ? Math.round(c) : c;
}

/**
 * BUG-A13-03: coerce un valore di count a number non-negativo finito.
 * NaN/Infinity/negative/non-number → 0.
 */
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
  if (!stats || typeof stats !== 'object') {
    main.innerHTML =
      '<h1 class="page-title">Statistiche</h1>' +
      '<div class="empty-state"><div class="empty-state-title">Nessun dato</div><div class="empty-state-text">Aggiungi serie TV per visualizzare le statistiche.</div></div>';
    return;
  }
  if (stats.totalShows === 0) {
    main.innerHTML =
      '<h1 class="page-title">Statistiche</h1>' +
      '<div class="empty-state"><div class="empty-state-title">Nessun dato</div><div class="empty-state-text">Aggiungi serie TV per visualizzare le statistiche.</div></div>';
    return;
  }

  // H19: clamp totalProgress a [0, 100] anche lato view (defense-in-depth).
  // Il worker clampa già, ma se per qualche motivo arrivasse un valore > 100
  // l'UI mostrerebbe "140%" e una barra overflowing.
  // BUG-A13-03: safeClampPct gestisce anche NaN/non-number (→ 0 invece di "NaN%").
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
  // BUG-A13-05: guard Array.isArray (worker/corrupted data).
  const topGenres = Array.isArray(stats.topGenres) ? stats.topGenres : [];
  // BUG-17-05: maxCount fallback a 1 se 0/NaN per evitare division-by-zero e pct >100.
  const maxCount = topGenres.length > 0 ? safeCount(topGenres[0].episodes) || 1 : 1;
  if (topGenres.length === 0 || topGenres.every((g) => safeCount(g && g.episodes) === 0)) {
    html += '<p style="color:var(--text-muted);">Nessun dato. Segna alcuni episodi come visti.</p>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:12px;">';
    for (const { genre, episodes, shows } of topGenres) {
      // BUG-17-04: Math.round per evitare fractional widths nel CSS.
      // BUG-17-05: clamp a [0, 100] per evitare barre >100% se maxCount è 0/inconsistente.
      // BUG-A13-03: safeCount su episodes per gestire NaN/Infinity/stringhe.
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
  // BUG-A13-05: guard Array.isArray (worker/corrupted data).
  const topShows = Array.isArray(stats.topShows) ? stats.topShows : [];
  if (topShows.length === 0) {
    html += '<p style="color:var(--text-muted);">Nessun dato.</p>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:8px;">';
    for (const item of topShows) {
      if (!item || typeof item !== 'object') continue; // BUG-A13-05: skip entry non-object
      // BUG-A13-06: valida item.image come stringa prima di passarlo a imgTag
      // (defense-in-depth contro image non-string truthy come 42/{} che
      // produrrebbe <img src="42"> invalido).
      const imgHtml =
        typeof item.image === 'string' && item.image
          ? imgTag(item.image, item.showName, '', 'width:40px;height:60px;object-fit:cover;border-radius:4px;')
          : '';
      // H19: clamp pct lato view (defense-in-depth)
      // BUG-A13-03: safeClampPct gestisce NaN/non-number (→ 0 invece di NaN%).
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

// BUG-17-02: render token — last-STARTED render wins (non last-resolved).
let _statsRenderToken = 0;

export async function renderStats(main: HTMLElement): Promise<void> {
  const myToken = ++_statsRenderToken;
  // BUG-A13-01: capture the view/show state at the START of the render. We only
  // enforce the cross-view race check if we were actually on 'stats' with no
  // show detail open at the start — this preserves compatibility with tests
  // that call renderStats directly without setting currentView, and with
  // stores that don't expose currentView (mocked, e.g. probe_stats.test.ts).
  const startView = getState().currentView;
  const startShowId = getState().currentShowId;
  const wasStatsActive = startView === 'stats' && startShowId === null;
  renderStatsSkeleton(main);
  try {
    const stats = await computeStatsAsync(getState().shows);
    // BUG-17-02: discard if a newer render has started.
    if (myToken !== _statsRenderToken) return;
    // BUG-A13-01: cross-view race protection. Il token qui sopra protegge solo
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
    // BUG-A13-01: stessa protezione cross-view nel path di errore.
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
