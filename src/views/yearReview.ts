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
// Nota: PloppyTV non traccia WHEN un episodio è stato guardato (solo se lo è).
// Per stimare le visioni dell'anno, usiamo l'airdate dell'episodio:
//   se airdate cade nell'anno selezionato E l'episodio è watched → conta.
// Questa è un'approssimazione ragionevole (la maggior parte degli utenti
// guarda gli episodi vicino all'airdate).

import { getState } from '../lib/store';
import { escapeHtml } from '../lib/utils';
import { imgTag } from '../components/img';
import { t } from '../lib/i18n';
import { showToast } from '../components/toast';
import type { Show } from '../types';

interface YearStats {
  year: number;
  totalEpisodes: number;
  totalMinutes: number;
  topShows: Array<{ showId: number; showName: string; image: string | null; watched: number }>;
  dominantGenre: string;
  longestSeason: { showName: string; season: number; episodes: number } | null;
}

/**
 * Calcola le statistiche per un anno specifico.
 * Un episodio conta se: watched === true AND airdate inizia con l'anno.
 */
function computeYearStats(shows: Show[], year: number): YearStats {
  const genreCount: Record<string, number> = {};
  const showWatched: Record<number, { showId: number; showName: string; image: string | null; watched: number }> = {};
  let totalEpisodes = 0;
  let totalMinutes = 0;
  let longestSeason: { showName: string; season: number; episodes: number } | null = null;

  for (const show of shows) {
    let showWatchedCount = 0;
    for (const seasonKey of Object.keys(show.seasons)) {
      const seasonNum = Number(seasonKey);
      if (!Number.isInteger(seasonNum) || seasonNum <= 0) continue;
      const eps = show.seasons[seasonNum];
      if (!Array.isArray(eps)) continue;

      // Conta episodi visti con airdate nell'anno
      let seasonWatchedInYear = 0;
      for (const ep of eps) {
        if (ep && ep.watched && ep.airdate && ep.airdate.startsWith(String(year))) {
          totalEpisodes++;
          showWatchedCount++;
          seasonWatchedInYear++;
          const runtime = ep.runtime || show.runtime || 45;
          totalMinutes += runtime;
        }
      }

      // Stagione più longeva (per episodi visti nell'anno)
      if (seasonWatchedInYear > 0) {
        if (!longestSeason || seasonWatchedInYear > longestSeason.episodes) {
          longestSeason = { showName: show.name, season: seasonNum, episodes: seasonWatchedInYear };
        }
      }
    }

    if (showWatchedCount > 0) {
      showWatched[show.id] = {
        showId: show.id,
        showName: show.name,
        image: show.image,
        watched: showWatchedCount,
      };
    }

    // Generi (basati sulle serie viste nell'anno)
    if (showWatchedCount > 0 && Array.isArray(show.genres)) {
      for (const g of show.genres) {
        genreCount[g] = (genreCount[g] || 0) + showWatchedCount;
      }
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
  };
}

/**
 * Genera la card condivisibile come canvas e scarica come PNG.
 */
function exportYearCard(stats: YearStats): void {
  const canvas = document.createElement('canvas');
  const W = 1080;
  const H = 1350;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    showToast('Canvas non supportato', 'error');
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
  ctx.fillText('Il tuo ' + stats.year + ' in TV', W / 2, 170);

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
  ctx.fillText('episodi visti', W / 2, 370);

  // Hours
  const hours = Math.floor(stats.totalMinutes / 60);
  ctx.fillStyle = '#ff6b35';
  ctx.font = 'bold 80px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.fillText(hours + ' ore', W / 2, 460);

  ctx.fillStyle = '#b8b8c8';
  ctx.font = '28px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.fillText('di visione totale', W / 2, 500);

  // Top 5 shows
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Top 5 serie', 80, 580);

  ctx.font = '28px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  stats.topShows.forEach((s, i) => {
    const y = 630 + i * 50;
    ctx.fillStyle = '#ff6b35';
    ctx.fillText(String(i + 1) + '.', 80, y);
    ctx.fillStyle = '#ffffff';
    const name = s.showName.length > 40 ? s.showName.slice(0, 37) + '...' : s.showName;
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
  ctx.fillText('Genere dominante', 80, 920);
  ctx.fillStyle = '#ff6b35';
  ctx.font = '32px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
  ctx.fillText(stats.dominantGenre, 80, 965);

  if (stats.longestSeason) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';
    ctx.fillText('Stagione più longeva', 80, 1050);
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
  ctx.fillText('Generato con PloppyTV', W / 2, 1280);

  // Download
  canvas.toBlob((blob) => {
    if (!blob) {
      showToast('Errore export immagine', 'error');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ploppytv-' + stats.year + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(t('yearReview.exported'), 'success');
  }, 'image/png');
}

// Stato: anno selezionato (default = anno corrente)
let _selectedYear: number = new Date().getFullYear();

export function renderYearReview(main: HTMLElement): void {
  const state = getState();

  // Raccogli anni disponibili (dagli airdate degli episodi watched)
  const yearSet = new Set<number>();
  for (const show of state.shows) {
    for (const eps of Object.values(show.seasons)) {
      if (!Array.isArray(eps)) continue;
      for (const ep of eps) {
        if (ep && ep.watched && ep.airdate) {
          const y = parseInt(ep.airdate.slice(0, 4), 10);
          if (Number.isFinite(y) && y > 1900 && y < 3000) yearSet.add(y);
        }
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

  // Big stats grid
  const hours = Math.floor(stats.totalMinutes / 60);
  const mins = stats.totalMinutes % 60;
  const timeLabel = hours > 0 ? hours + 'h' + (mins > 0 ? ' ' + mins + 'min' : '') : mins + 'min';

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
      if (Number.isFinite(y)) {
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
