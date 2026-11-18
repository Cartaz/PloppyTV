// Vista Year-in-Review (P2.8)
//
// "Il tuo ANNO in TV": pagina riassuntiva con:
//   - Top 5 serie più viste nell'anno
//   - Ore totali guardate nell'anno
//   - Genere dominante
//   - Stagione più longeva
//   - Episodi totali visti
//   - Card condivisibile come immagine (canvas export → download PNG)
//
// Un episodio visto conta nell'anno di `watchedAt` (quando è stato segnato
// come visto). Gli episodi segnati prima dello schema v3 non hanno la data:
// per quelli si usa l'anno di uscita come stima, e la vista lo segnala.

import { getState } from '../lib/store';
import { escapeHtml } from '../lib/utils';
import { imgTag } from '../components/img';
import { t, tn, formatDuration } from '../lib/i18n';
import { showToast } from '../components/toast';
import type { Episode, Show } from '../types';

/** Anno in cui l'episodio visto va contato, e se è una stima basata sull'airdate. */
function watchYear(ep: Episode): { year: number; estimated: boolean } | null {
  if (!ep.watched) return null;
  if (ep.watchedAt) return { year: new Date(ep.watchedAt).getFullYear(), estimated: false };
  const year = ep.airdate ? Number(ep.airdate.slice(0, 4)) : NaN;
  return Number.isInteger(year) ? { year, estimated: true } : null;
}

export interface YearStats {
  year: number;
  totalEpisodes: number;
  totalMinutes: number;
  topShows: Array<{ showId: number; showName: string; image: string | null; watched: number }>;
  dominantGenre: string;
  longestSeason: { showName: string; season: number; episodes: number } | null;
  /** Episodi contati con l'airdate perché segnati prima che si registrasse la data di visione. */
  estimatedEpisodes: number;
}

/**
 * Calcola le statistiche per un anno specifico.
 * Un episodio conta se: watched === true AND airdate (stringa) inizia con l'anno.
 */
export function computeYearStats(shows: Show[], year: number): YearStats {
  const genreCount: Record<string, number> = {};
  const showWatched: Record<number, { showId: number; showName: string; image: string | null; watched: number }> = {};
  let totalEpisodes = 0;
  let totalMinutes = 0;
  let estimatedEpisodes = 0;
  let longestSeason: { showName: string; season: number; episodes: number } | null = null;

  for (const show of shows) {
    let showWatchedCount = 0;
    for (const [seasonKey, eps] of Object.entries(show.seasons)) {
      let seasonWatchedInYear = 0;
      for (const ep of eps) {
        const when = watchYear(ep);
        if (!when || when.year !== year) continue;
        if (when.estimated) estimatedEpisodes++;
        totalEpisodes++;
        showWatchedCount++;
        seasonWatchedInYear++;
        totalMinutes += ep.runtime || show.runtime || 45;
      }
      if (seasonWatchedInYear > 0 && (!longestSeason || seasonWatchedInYear > longestSeason.episodes)) {
        longestSeason = { showName: show.name, season: Number(seasonKey), episodes: seasonWatchedInYear };
      }
    }

    if (showWatchedCount > 0) {
      showWatched[show.id] = { showId: show.id, showName: show.name, image: show.image, watched: showWatchedCount };
      for (const g of show.genres) genreCount[g] = (genreCount[g] || 0) + showWatchedCount;
    }
  }

  // Top 5 serie
  const topShows = Object.values(showWatched)
    .sort((a, b) => b.watched - a.watched)
    .slice(0, 5);

  // Genere dominante
  let dominantGenre = 'N/D';
  let maxGenreCount = 0;
  for (const [g, c] of Object.entries(genreCount)) {
    if (c > maxGenreCount) {
      maxGenreCount = c;
      dominantGenre = g;
    }
  }

  return {
    year,
    totalEpisodes,
    totalMinutes,
    topShows,
    dominantGenre,
    longestSeason,
    estimatedEpisodes,
  };
}

/**
 * Genera la card condivisibile come canvas e scarica come PNG.
 */
export function exportYearCard(stats: YearStats): void {
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
  } catch {
    showToast(t('yearReview.canvasSupportato'), 'error');
    return;
  }
  const W = 1080;
  const H = 1350;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    showToast(t('yearReview.canvasSupportato'), 'error');
    return;
  }

  // Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#0f0f14');
  bgGrad.addColorStop(0.5, '#1a1a24');
  bgGrad.addColorStop(1, '#0f0f14');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Accent bar top
  ctx.fillStyle = '#ff6b35';
  ctx.fillRect(0, 0, W, 8);

  // Title
  ctx.fillStyle = '#ff6b35';
  ctx.font = 'bold 56px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('PloppyTV', W / 2, 90);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 64px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.fillText(t('yearReview.cardTitle', { year: stats.year }), W / 2, 170);

  // Decorative line
  ctx.strokeStyle = '#ff6b35';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 100, 200);
  ctx.lineTo(W / 2 + 100, 200);
  ctx.stroke();

  // Big stats: total episodes
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 120px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.fillText(String(stats.totalEpisodes), W / 2, 320);

  ctx.fillStyle = '#b8b8c8';
  ctx.font = '32px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.fillText(t('detail.episodesWatched'), W / 2, 370);

  // Hours
  const hours = Math.floor(stats.totalMinutes / 60);
  ctx.fillStyle = '#ff6b35';
  ctx.font = 'bold 80px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.fillText(t('yearReview.hours', { h: hours }), W / 2, 460);

  ctx.fillStyle = '#b8b8c8';
  ctx.font = '28px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.fillText(t('yearReview.visioneTotale'), W / 2, 500);

  // Top 5 shows
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(t('yearReview.top5Serie'), 80, 580);

  ctx.font = '28px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  stats.topShows.forEach((s, i) => {
    const y = 630 + i * 50;
    ctx.fillStyle = '#ff6b35';
    ctx.fillText(String(i + 1) + '.', 80, y);
    ctx.fillStyle = '#ffffff';
    // Coercisce showName a stringa. Se showName è null/undefined
    // (dati corrotti), `.length` throwava TypeError crashando l'intero export
    // senza toast.
    const rawName = typeof s.showName === 'string' ? s.showName : String(s.showName ?? '');
    const name = rawName.length > 40 ? rawName.slice(0, 37) + '...' : rawName;
    ctx.fillText(name, 120, y);
    ctx.fillStyle = '#b8b8c8';
    ctx.textAlign = 'right';
    ctx.fillText(s.watched + ' ep', W - 80, y);
    ctx.textAlign = 'left';
  });

  // Genre + longest season
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(t('yearReview.dominantGenre'), 80, 920);
  ctx.fillStyle = '#ff6b35';
  ctx.font = '32px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.fillText(stats.dominantGenre, 80, 965);

  if (stats.longestSeason) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    ctx.fillText(t('yearReview.longestSeason'), 80, 1050);
    ctx.fillStyle = '#ff6b35';
    ctx.font = '32px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    ctx.fillText(
      stats.longestSeason.showName + ' S' + stats.longestSeason.season + ' (' + stats.longestSeason.episodes + ' ep)',
      80,
      1095,
    );
  }

  // Footer
  ctx.fillStyle = '#6e6e80';
  ctx.font = '24px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(t('yearReview.generatoPloppytv'), W / 2, 1280);

  // Sanitize year per il filename. Se year è NaN/0/negativo (non
  // dovrebbe mai succedere dopo le fix di computeYearStats, ma defense-in-depth),
  // fallback a "export" invece di produrre "ploppytv-NaN.png".
  const safeYear =
    Number.isInteger(stats.year) && stats.year > 1900 && stats.year < 3000 ? String(stats.year) : 'export';
  const filename = 'ploppytv-' + safeYear + '.png';

  // Wrap toBlob in try/catch. Se il canvas è tainted (CORS da
  // immagini cross-origin — possibile se future modifiche aggiungono drawImage
  // di poster TVMaze senza crossOrigin="anonymous"), alcuni browser lanciano
  // SecurityError sincronamente invece di chiamare il callback con null.
  try {
    // Check toBlob availability (browser very old / env non-DOM).
    if (typeof canvas.toBlob !== 'function') {
      showToast(t('yearReview.canvasSupportato'), 'error');
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        showToast(t('yearReview.erroreExportImmagine'), 'error');
        return;
      }
      let url: string | null = null;
      let downloadOk = false;
      try {
        url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        downloadOk = true;
      } catch (e) {
        console.error('[yearReview] export download failed:', e);
        showToast(t('yearReview.erroreExportImmagine'), 'error');
      } finally {
        // Revoke sempre, anche se click throwa (leak prevention).
        if (url) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore — best effort cleanup
          }
        }
      }
      if (downloadOk) {
        showToast(t('yearReview.exported'), 'success');
      }
    }, 'image/png');
  } catch (e) {
    // SecurityError (tainted canvas) o altri errori sincroni da toBlob.
    console.error('[yearReview] toBlob threw:', e);
    showToast(t('yearReview.erroreExportImmagine'), 'error');
  }
}

// Stato: anno selezionato (default = anno corrente)
let _selectedYear: number = new Date().getFullYear();

export function renderYearReview(main: HTMLElement): void {
  const state = getState();

  // Anni disponibili: quelli in cui risulta almeno un episodio visto.
  const yearSet = new Set<number>();
  for (const show of state.shows) {
    for (const eps of Object.values(show.seasons)) {
      for (const ep of eps) {
        const when = watchYear(ep);
        if (when) yearSet.add(when.year);
      }
    }
  }
  const years = Array.from(yearSet).sort((a, b) => b - a);

  // Se nessun episodio watched con airdate
  if (years.length === 0) {
    main.innerHTML =
      '<h1 class="page-title">' +
      escapeHtml(t('yearReview.title', { year: String(_selectedYear) })) +
      '</h1>' +
      '<div class="empty-state"><div class="empty-state-title">' +
      escapeHtml(t('yearReview.noData', { year: String(_selectedYear) })) +
      '</div></div>';
    return;
  }

  // Assicurati che l'anno selezionato sia valido
  if (!years.includes(_selectedYear)) {
    _selectedYear = years[0];
  }

  const stats = computeYearStats(state.shows, _selectedYear);

  let html = '<h1 class="page-title">' + escapeHtml(t('yearReview.title', { year: String(_selectedYear) })) + '</h1>';

  // Year selector
  html += '<div class="year-selector">';
  for (const y of years) {
    html +=
      '<button class="year-btn' + (y === _selectedYear ? ' active' : '') + '" data-year="' + y + '">' + y + '</button>';
  }
  html += '</div>';

  if (stats.totalEpisodes === 0) {
    html +=
      '<div class="empty-state"><div class="empty-state-title">' +
      escapeHtml(t('yearReview.noData', { year: String(_selectedYear) })) +
      '</div></div>';
    main.innerHTML = html;
    bindYearReviewEvents(main);
    return;
  }

  if (stats.estimatedEpisodes > 0) {
    html +=
      '<p class="page-subtitle year-estimated-hint">' +
      escapeHtml(tn('yearReview.estimatedHint', stats.estimatedEpisodes)) +
      '</p>';
  }

  // Big stats grid
  const timeLabel = formatDuration(stats.totalMinutes);

  html += '<div class="year-stats-grid">';
  html +=
    '<div class="year-stat-card"><div class="year-stat-value">' +
    stats.totalEpisodes +
    '</div><div class="year-stat-label">' +
    escapeHtml(t('yearReview.totalEpisodes')) +
    '</div></div>';
  html +=
    '<div class="year-stat-card"><div class="year-stat-value">' +
    escapeHtml(timeLabel) +
    '</div><div class="year-stat-label">' +
    escapeHtml(t('yearReview.totalHours')) +
    '</div></div>';
  html +=
    '<div class="year-stat-card"><div class="year-stat-value">' +
    escapeHtml(stats.dominantGenre) +
    '</div><div class="year-stat-label">' +
    escapeHtml(t('yearReview.dominantGenre')) +
    '</div></div>';
  if (stats.longestSeason) {
    html +=
      '<div class="year-stat-card"><div class="year-stat-value">' +
      stats.longestSeason.episodes +
      '</div><div class="year-stat-label">' +
      escapeHtml(t('yearReview.longestSeason')) +
      '<br><small>' +
      escapeHtml(stats.longestSeason.showName + ' S' + stats.longestSeason.season) +
      '</small></div></div>';
  }
  html += '</div>';

  // Top 5 series
  html += '<div class="section"><h2 class="section-title">' + escapeHtml(t('yearReview.topSeries')) + '</h2>';
  html += '<div class="year-top-list">';
  stats.topShows.forEach((s, i) => {
    const imgHtml = s.image
      ? imgTag(s.image, s.showName, '', 'width:48px;height:72px;object-fit:cover;border-radius:6px;')
      : '<div class="year-top-placeholder"></div>';
    html +=
      '<div class="year-top-item" data-action="openShow" data-show-id="' +
      s.showId +
      '" role="button" tabindex="0">' +
      '<div class="year-top-rank">' +
      (i + 1) +
      '</div>' +
      imgHtml +
      '<div class="year-top-info"><div class="year-top-name">' +
      escapeHtml(s.showName) +
      '</div><div class="year-top-meta">' +
      s.watched +
      ' episodi</div></div>' +
      '</div>';
  });
  html += '</div></div>';

  // Share button
  html +=
    '<div class="section"><button class="btn btn-primary" id="yearShareBtn">' +
    escapeHtml(t('yearReview.share')) +
    '</button></div>';

  main.innerHTML = html;
  bindYearReviewEvents(main);
}

function bindYearReviewEvents(main: HTMLElement): void {
  // Year buttons
  main.querySelectorAll('.year-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const y = Number((btn as HTMLElement).dataset.year);
      // Valida che y sia un intero plausibile, non solo finite.
      // Number.isFinite(0) === true e Number.isFinite(-5) === true, ma anno 0
      // o negativo produrrebbe stats vuote e label "Nessun dato per il 0".
      if (Number.isInteger(y) && y > 1900 && y < 3000) {
        _selectedYear = y;
        renderYearReview(main);
      }
    });
  });

  // Share button
  const shareBtn = main.querySelector('#yearShareBtn') as HTMLButtonElement | null;
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      const state = getState();
      const stats = computeYearStats(state.shows, _selectedYear);
      exportYearCard(stats);
    });
  }
}
