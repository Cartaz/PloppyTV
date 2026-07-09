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

export interface YearStats {
  year: number;
  totalEpisodes: number;
  totalMinutes: number;
  topShows: Array<{ showId: number; showName: string; image: string | null; watched: number }>;
  dominantGenre: string;
  longestSeason: { showName: string; season: number; episodes: number } | null;
}

/**
 * Calcola le statistiche per un anno specifico.
 * Un episodio conta se: watched === true AND airdate (stringa) inizia con l'anno.
 *
 * BUG-A14-01 (FIXED): `ep.watched` era truthy-checked (`ep.watched`), accettando
 * "false"/1/"yes" come watched (inconsistente con getWatchedCount che usa
 * `=== true`). Ora strict `=== true`.
 * BUG-A14-02 (FIXED): `ep.airdate.startsWith(...)` throwava TypeError se airdate
 * era un numero/oggetto (dati corrotti da import/storage malevolo). Ora guarda
 * `typeof === 'string'`.
 * BUG-A14-03 (FIXED): `totalMinutes += runtime` concatenava stringhe se runtime
 * era una stringa truthy (es. "30"): 0 + "30" = "30", "30" + 30 = "3030".
 * Corrompeva totalMinutes e tutte le stat derivate (ore, canvas display).
 * Ora valida `Number.isFinite`.
 * BUG-A14-04 (FIXED): `Object.keys(show.seasons)` throwava TypeError se seasons
 * era null/undefined/array. Ora guarda shape dell'oggetto.
 * BUG-A14-10 (FIXED): generi vuoti/non-stringa potevano diventare dominantGenre
 * (stringa vuota mostrata nell'HTML/canvas). Ora saltati.
 * BUG-A14-14 (FIXED): `year` non validato; NaN/0/negativo produceva stats
 * inconsistenti (es. `startsWith('0')` matchava date inesistenti, falsi
 * positivi). Ora ritorna stats vuote se year non è intero plausibile.
 */
export function computeYearStats(shows: Show[], year: number): YearStats {
  // BUG-A14-14: valida year. Se non è un intero plausibile, ritorna stats vuote.
  const validYear = Number.isInteger(year) && year > 1900 && year < 3000 ? year : 0;
  const empty: YearStats = {
    year,
    totalEpisodes: 0,
    totalMinutes: 0,
    topShows: [],
    dominantGenre: 'N/D',
    longestSeason: null,
  };
  if (!validYear || !Array.isArray(shows)) return empty;

  const yearStr = String(validYear);
  const genreCount: Record<string, number> = {};
  const showWatched: Record<number, { showId: number; showName: string; image: string | null; watched: number }> = {};
  let totalEpisodes = 0;
  let totalMinutes = 0;
  let longestSeason: { showName: string; season: number; episodes: number } | null = null;

  for (const show of shows) {
    if (!show || typeof show !== 'object') continue;
    // BUG-A14-04: guard contro seasons malformati (null/undefined/array/primitive).
    const seasons = show.seasons;
    if (!seasons || typeof seasons !== 'object' || Array.isArray(seasons)) continue;

    let showWatchedCount = 0;
    for (const seasonKey of Object.keys(seasons)) {
      const seasonNum = Number(seasonKey);
      if (!Number.isInteger(seasonNum) || seasonNum <= 0) continue;
      const eps = seasons[seasonNum];
      if (!Array.isArray(eps)) continue;

      // Conta episodi visti con airdate nell'anno
      let seasonWatchedInYear = 0;
      for (const ep of eps) {
        if (!ep) continue;
        // BUG-A14-01: strict === true (consistente con getWatchedCount in utils.ts).
        if (ep.watched !== true) continue;
        // BUG-A14-02: airdate deve essere una stringa (potrebbe essere numero/
        // oggetto in dati corrotti da import/storage malevolo).
        if (typeof ep.airdate !== 'string' || !ep.airdate.startsWith(yearStr)) continue;

        totalEpisodes++;
        showWatchedCount++;
        seasonWatchedInYear++;
        // BUG-A14-03: runtime deve essere un numero finito positivo. Se ep.runtime
        // è una stringa truthy (es. "30"), `totalMinutes += "30"` concatenava
        // stringhe, corrompendo totalMinutes e le stat derivate.
        const epRuntime =
          typeof ep.runtime === 'number' && Number.isFinite(ep.runtime) && ep.runtime > 0
            ? ep.runtime
            : typeof show.runtime === 'number' && Number.isFinite(show.runtime) && show.runtime > 0
              ? show.runtime
              : 45;
        totalMinutes += epRuntime;
      }

      // Stagione più longeva (per episodi visti nell'anno)
      if (seasonWatchedInYear > 0) {
        if (!longestSeason || seasonWatchedInYear > longestSeason.episodes) {
          longestSeason = {
            showName: typeof show.name === 'string' ? show.name : 'N/D',
            season: seasonNum,
            episodes: seasonWatchedInYear,
          };
        }
      }
    }

    if (showWatchedCount > 0) {
      const sid = typeof show.id === 'number' && Number.isFinite(show.id) ? show.id : 0;
      showWatched[sid] = {
        showId: sid,
        showName: typeof show.name === 'string' ? show.name : 'N/D',
        image: typeof show.image === 'string' ? show.image : null,
        watched: showWatchedCount,
      };
    }

    // Generi (basati sulle serie viste nell'anno)
    if (showWatchedCount > 0 && Array.isArray(show.genres)) {
      for (const g of show.genres) {
        // BUG-A14-10: salta generi non-stringa o vuoti/solo-whitespace
        // (una stringa vuota come dominantGenre veniva mostrata vuota nell'HTML).
        if (typeof g !== 'string' || g.trim().length === 0) continue;
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
 *
 * BUG-A14-05 (FIXED): `s.showName.length` throwava TypeError se showName era
 * null/undefined (dati corrotti). Ora coercisce a stringa.
 * BUG-A14-06 (FIXED): `canvas.toBlob` non era in try/catch. Se il canvas è
 * tainted (CORS da immagini cross-origin caricate senza crossOrigin="anonymous")
 * o il browser lancia SecurityError sincronamente, l'errore propagava uncaught
 * e nessun toast veniva mostrato. Ora try/catch + toast.
 * BUG-A14-07 (FIXED): `URL.revokeObjectURL` non era chiamata se `a.click()`
 * throwava → leak di blob URL. Ora try/finally garantisce revoke.
 * BUG-A14-08 (FIXED): `canvas.toBlob` potrebbe non esistere (browser very old
 * o env non-DOM). Ora check `typeof === 'function'` + toast fallback.
 * BUG-A14-09 (FIXED): filename usava `stats.year` senza validazione; NaN →
 * "ploppytv-NaN.png". Ora valida o fallback a "export".
 */
export function exportYearCard(stats: YearStats): void {
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
  } catch {
    showToast('Canvas non supportato', 'error');
    return;
  }
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
    // BUG-A14-05: coercisce showName a stringa. Se showName è null/undefined
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

  // BUG-A14-09: sanitize year per il filename. Se year è NaN/0/negativo (non
  // dovrebbe mai succedere dopo le fix di computeYearStats, ma defense-in-depth),
  // fallback a "export" invece di produrre "ploppytv-NaN.png".
  const safeYear =
    Number.isInteger(stats.year) && stats.year > 1900 && stats.year < 3000 ? String(stats.year) : 'export';
  const filename = 'ploppytv-' + safeYear + '.png';

  // BUG-A14-06: wrap toBlob in try/catch. Se il canvas è tainted (CORS da
  // immagini cross-origin — possibile se future modifiche aggiungono drawImage
  // di poster TVMaze senza crossOrigin="anonymous"), alcuni browser lanciano
  // SecurityError sincronamente invece di chiamare il callback con null.
  try {
    // BUG-A14-08: check toBlob availability (browser very old / env non-DOM).
    if (typeof canvas.toBlob !== 'function') {
      showToast('Canvas non supportato', 'error');
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        showToast('Errore export immagine', 'error');
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
        showToast('Errore export immagine', 'error');
      } finally {
        // BUG-A14-07: revoke sempre, anche se click throwa (leak prevention).
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
    // BUG-A14-06: SecurityError (tainted canvas) o altri errori sincroni da toBlob.
    console.error('[yearReview] toBlob threw:', e);
    showToast('Errore export immagine', 'error');
  }
}

// Stato: anno selezionato (default = anno corrente)
let _selectedYear: number = new Date().getFullYear();

export function renderYearReview(main: HTMLElement): void {
  const state = getState();

  // Raccogli anni disponibili (dagli airdate degli episodi watched)
  const yearSet = new Set<number>();
  // BUG-A14-12: guard state.shows (defense-in-depth — A2 fix garantisce array,
  // ma il consumer deve essere defensive contro dati corrotti).
  const shows = Array.isArray(state.shows) ? state.shows : [];
  for (const show of shows) {
    if (!show || typeof show !== 'object') continue;
    // BUG-A14-13: guard show.seasons (null/undefined/array → Object.values throw).
    const seasons = show.seasons;
    if (!seasons || typeof seasons !== 'object' || Array.isArray(seasons)) continue;
    for (const eps of Object.values(seasons)) {
      if (!Array.isArray(eps)) continue;
      for (const ep of eps) {
        if (!ep) continue;
        // BUG-A14-01: strict === true (consistente con computeYearStats/getWatchedCount).
        if (ep.watched !== true) continue;
        // BUG-A14-02: airdate deve essere una stringa (.slice throw se numero).
        if (typeof ep.airdate !== 'string') continue;
        const y = parseInt(ep.airdate.slice(0, 4), 10);
        if (Number.isFinite(y) && y > 1900 && y < 3000) yearSet.add(y);
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
      // BUG-A14-11: valida che y sia un intero plausibile, non solo finite.
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
