// Discover: serie popolari + ultimi arrivi con cache 1h

import type { TvmazeShow } from '../types';
import { getShowsPage, ApiError } from './api';
import {
  DISCOVER_CACHE_KEY,
  DISCOVER_RECENT_CACHE_KEY,
  DISCOVER_CACHE_TTL,
  DISCOVER_POPULAR_PAGES,
  DISCOVER_RECENT_PAGES,
  DISCOVER_TARGET_PER_GENRE,
  DISCOVER_TARGET_OTHER,
  DISCOVER_TOTAL_TARGET,
  GENRE_CAROUSELS,
} from './constants';
import { parseISODateLocal } from './utils';

export interface DiscoverGroups {
  [genre: string]: TvmazeShow[];
  _other: TvmazeShow[];
}

/**
 * Esegue le fetch di pagina con concurrency limitato (batch di 3) invece
 * di `Promise.all` su tutte le pagine in parallelo. TVMaze chiude le
 * connessioni sotto burst (9-11 fetch paralleli), facendo fallire 2-5 pagine.
 * Con batch di 3 si riduce drasticamente la probabilità di fallimento.
 *
 * Ritorna `{ shows, failedPages }` così il caller può decidere se cachare
 * solo in caso di successo completo.
 */
async function fetchAllCandidates(
  pages: number[],
  recentOnly: boolean,
  onProgress?: (text: string) => void,
): Promise<{ shows: TvmazeShow[]; failedPages: number[] }> {
  const sixMonthsAgo = recentOnly
    ? (() => {
        // BUG-07-06: anchor to day 1, then clamp day to last day of target month.
        // Old code: new Date(2024,2,31).setMonth(-6) → Sep 31 → rolls to Oct 1.
        // Fixed code: start from day 1, setMonth, then clamp to last day of target.
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth();
        const d = new Date(y, m - 6, 1);
        d.setHours(0, 0, 0, 0);
        return d;
      })()
    : null;

  const total = pages.length;
  let completed = 0;
  let lastProgressText = '';
  let progressRAF: number | null = null;
  let progressDirty = false;

  const scheduleProgress = (label: string) => {
    progressDirty = true;
    if (progressRAF) return;
    progressRAF = requestAnimationFrame(() => {
      progressRAF = null;
      if (!progressDirty) return;
      progressDirty = false;
      const text = label + '... (' + completed + '/' + total + ' pagine)';
      if (text === lastProgressText) return;
      lastProgressText = text;
      onProgress?.(text);
    });
  };

  const label = recentOnly ? 'Caricamento ultimi arrivi' : 'Caricamento serie popolari';
  scheduleProgress(label);

  // Concurrency limitato: batch di 3 pagine alla volta
  const CONCURRENCY = 3;
  const failedPages: number[] = [];
  const results: TvmazeShow[][] = new Array(pages.length).fill([]);

  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = pages.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (page, j) => {
        try {
          const pageShows = await getShowsPage(page);
          return { idx: i + j, shows: Array.isArray(pageShows) ? pageShows : [] };
        } catch (e) {
          console.warn('Errore caricamento pagina ' + page + ':', e);
          return { idx: i + j, shows: [] as TvmazeShow[], failed: page };
        } finally {
          completed++;
          scheduleProgress(label);
        }
      }),
    );
    for (const r of batchResults) {
      results[r.idx] = r.shows;
      if ('failed' in r && r.failed !== undefined) failedPages.push(r.failed);
    }
  }

  // BUG-A7-02 (FIXED): cancel any pending progress RAF so onProgress is not
  // invoked after the fetch has settled. The RAF was scheduled in the last
  // page's `finally` and would fire on the next animation frame, leaking a
  // final callback to the caller who already received the resolved data.
  if (progressRAF !== null) {
    cancelAnimationFrame(progressRAF);
    progressRAF = null;
  }

  const all: TvmazeShow[] = [];
  for (const pageShows of results) {
    for (const show of pageShows) {
      // BUG-07-03: weight=0 is INCLUDED (valid TVMaze value). Missing/negative excluded.
      if (!show || !show.image || !show.name) continue;
      // BUG-A7-04 (FIXED): non-numeric weight (string "abc", null, undefined) and
      // non-finite (NaN/Infinity) are now excluded via typeof + isFinite check.
      // Old code: `weight < 0` is false for NaN (NaN < 0 === false), so a string
      // weight would slip through and poison the sort comparator with NaN.
      if (typeof show.weight !== 'number' || !Number.isFinite(show.weight) || show.weight < 0) continue;
      if (recentOnly) {
        if (!show.premiered) continue;
        const d = parseISODateLocal(show.premiered);
        // BUG-A7-01 (FIXED): exclude shows premiered in the FUTURE. "Recent" means
        // "aired in the last 6 months", not "will air eventually". A show with
        // premiered='2099-01-01' would otherwise pass `d >= sixMonthsAgo`.
        if (!d || d < sixMonthsAgo! || d.getTime() > Date.now()) continue;
      }
      all.push(show);
    }
  }

  all.sort((a, b) => {
    const wDiff = (b.weight || 0) - (a.weight || 0);
    if (wDiff !== 0) return wDiff;
    // BUG-A7-05 (FIXED): coerce rating.average to a finite number. A non-numeric
    // value (string "abc") would otherwise yield NaN in the comparator, leaving
    // the sort order undefined. `Number(x) || 0` maps NaN/null/undefined to 0.
    const rA = Number(a.rating?.average) || 0;
    const rB = Number(b.rating?.average) || 0;
    return rB - rA;
  });
  return { shows: all, failedPages };
}

function assignShowsToGroups(candidates: TvmazeShow[]): DiscoverGroups {
  const groups: DiscoverGroups = {} as DiscoverGroups;
  for (const g of GENRE_CAROUSELS) groups[g] = [];
  groups._other = [];
  const assignedIds = new Set<number>();

  // Helper: find the first matching carousel genre that STILL HAS SPACE.
  // BUG-A7-06 (FIXED): the old code picked the first matching genre regardless
  // of whether that carousel was full, then redirected to _other. A show with
  // genres ['Drama','Comedy'] where Comedy was at cap would go to _other even
  // if Drama still had space. Now we try every matching genre in carousel
  // order and pick the first with room.
  const findGenreWithSpace = (genres: string[]): string | null => {
    for (const targetGenre of GENRE_CAROUSELS) {
      if (genres.includes(targetGenre) && groups[targetGenre].length < DISCOVER_TARGET_PER_GENRE) {
        return targetGenre;
      }
    }
    return null;
  };

  // FASE 1
  for (const show of candidates) {
    if (assignedIds.has(show.id)) continue;
    const genres = Array.isArray(show.genres) ? show.genres : [];
    const assigned = findGenreWithSpace(genres);
    if (assigned) {
      groups[assigned].push(show);
      assignedIds.add(show.id);
    } else {
      // Only route to _other in FASE 1 if the show has NO matching carousel
      // genre at all. If it has a matching genre but all are at cap, leave it
      // for FASE 2 (which may spill it to _other).
      const hasAnyCarouselGenre = genres.some((g) => GENRE_CAROUSELS.includes(g));
      if (!hasAnyCarouselGenre && groups._other.length < DISCOVER_TARGET_OTHER) {
        groups._other.push(show);
        assignedIds.add(show.id);
      }
    }
  }

  // FASE 2: ridistribuzione deficit — BUG-07-01/02: rispetta i cap per-genre e _other.
  // BUG-A7-06 (FIXED): uses findGenreWithSpace so multi-genre shows fill any
  // carousel with room before falling back to _other.
  let total = 0;
  for (const g of GENRE_CAROUSELS) total += groups[g].length;
  total += groups._other.length;
  const deficit = DISCOVER_TOTAL_TARGET - total;

  if (deficit > 0) {
    let added = 0;
    for (const show of candidates) {
      if (added >= deficit) break;
      if (assignedIds.has(show.id)) continue;
      const genres = Array.isArray(show.genres) ? show.genres : [];
      const assigned = findGenreWithSpace(genres);
      if (assigned) {
        groups[assigned].push(show);
        assignedIds.add(show.id);
        added++;
      } else if (groups._other.length < DISCOVER_TARGET_OTHER) {
        // No matching genre with space (either no carousel genre, or all at
        // cap). Spillover to _other, respecting its cap (BUG-07-02).
        groups._other.push(show);
        assignedIds.add(show.id);
        added++;
      }
    }
  }

  return groups;
}

async function fetchShowsByGenre(
  pages: number[],
  recentOnly: boolean,
  onProgress?: (text: string) => void,
): Promise<{ groups: DiscoverGroups; failedPages: number[] }> {
  const { shows, failedPages } = await fetchAllCandidates(pages, recentOnly, onProgress);
  return { groups: assignShowsToGroups(shows), failedPages };
}

function readCache(key: string): DiscoverGroups | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { cachedAt: number; groups: DiscoverGroups };
    // BUG-07-04: cachedAt deve essere un numero finito e non nel futuro.
    if (
      !cached ||
      typeof cached.cachedAt !== 'number' ||
      !Number.isFinite(cached.cachedAt) ||
      cached.cachedAt > Date.now() ||
      Date.now() - cached.cachedAt >= DISCOVER_CACHE_TTL
    ) {
      return null;
    }
    // BUG-07-05: groups deve essere un oggetto non-null con chiavi array.
    if (!cached.groups || typeof cached.groups !== 'object' || Array.isArray(cached.groups)) {
      return null;
    }
    // BUG-A7-03 (FIXED): validate that each expected genre key (and _other),
    // if present, is an array. A corrupted cache like `{ Drama: "not-an-array" }`
    // would otherwise be returned as-is, crashing the view's `for (const show
    // of shows)` loop (iterating characters of the string). Reject the cache
    // and fall back to a fresh fetch.
    const groupsRecord = cached.groups as Record<string, unknown>;
    for (const key of [...GENRE_CAROUSELS, '_other']) {
      const v = groupsRecord[key];
      if (v !== undefined && !Array.isArray(v)) {
        return null;
      }
    }
    return cached.groups;
  } catch {
    // cache invalida
  }
  return null;
}

/**
 * Scrive la cache solo se i dati sono completi (no failedPages).
 * In caso di transient failure, scriverebbe cache stale per 1h.
 */
function writeCache(key: string, groups: DiscoverGroups, failedPages: number[]): void {
  if (failedPages.length > 0) {
    console.warn('[discover] skip cache write: ' + failedPages.length + ' pages failed');
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify({ groups, cachedAt: Date.now() }));
  } catch {
    // storage pieno
  }
}

export async function getPopularShows(onProgress?: (text: string) => void): Promise<DiscoverGroups> {
  const cached = readCache(DISCOVER_CACHE_KEY);
  if (cached) return cached;
  const { groups, failedPages } = await fetchShowsByGenre(DISCOVER_POPULAR_PAGES, false, onProgress);
  writeCache(DISCOVER_CACHE_KEY, groups, failedPages);
  return groups;
}

export async function getRecentShows(onProgress?: (text: string) => void): Promise<DiscoverGroups> {
  const cached = readCache(DISCOVER_RECENT_CACHE_KEY);
  if (cached) return cached;
  const { groups, failedPages } = await fetchShowsByGenre(DISCOVER_RECENT_PAGES, true, onProgress);
  writeCache(DISCOVER_RECENT_CACHE_KEY, groups, failedPages);
  return groups;
}

// Promise condivise per il preload in background: una volta avviate, le viste
// possono "attaccarsi" alla stessa promise senza rifare il fetch.
let _popularPromise: Promise<DiscoverGroups> | null = null;
let _recentPromise: Promise<DiscoverGroups> | null = null;

/**
 * Avvia il caricamento in background dei dati Discover (popolari + recenti).
 * Da chiamare all'avvio dell'app, idealmente dopo un piccolo delay per non
 * competere con il render iniziale. Silenzioso: nessuna UI di caricamento.
 * Usa le promise condivise: se già in corso, non riparte.
 */
export function preloadDiscover(): void {
  // Popolari
  if (!_popularPromise) {
    _popularPromise = getPopularShows().catch((e) => {
      console.warn('[discover] preload popular failed:', e);
      _popularPromise = null; // consenti retry al prossimo avvio/tab
      throw e;
    });
  }
  // Recenti (sequenziale per non sovraccaricare TVMaze con troppi fetch paralleli)
  if (!_recentPromise) {
    _recentPromise = _popularPromise
      .catch(() => null) // non bloccare recenti se popolari fallisce
      .then(() => getRecentShows())
      .catch((e) => {
        console.warn('[discover] preload recent failed:', e);
        _recentPromise = null;
        throw e;
      });
  }
}

/**
 * Restituisce la promise (già avviata dal preload o nuova) per il tab richiesto.
 * La vista Discover usa questa invece di chiamare getPopularShows/getRecentShows
 * direttamente, così se il preload è già in corso ci si attacca a quello.
 */
export function getDiscoverPromise(tab: 'popular' | 'recent'): Promise<DiscoverGroups> {
  if (tab === 'popular') {
    if (!_popularPromise) _popularPromise = getPopularShows();
    return _popularPromise;
  }
  if (!_recentPromise) _recentPromise = getRecentShows();
  return _recentPromise;
}

/**
 * Resetta le promise condivise (usato quando l'utente invalida la cache
 * tramite "Aggiorna lista").
 */
export function resetDiscoverPreload(tab?: 'popular' | 'recent'): void {
  if (!tab || tab === 'popular') _popularPromise = null;
  if (!tab || tab === 'recent') _recentPromise = null;
}

export function invalidateDiscoverCache(tab: 'popular' | 'recent'): void {
  try {
    if (tab === 'popular') localStorage.removeItem(DISCOVER_CACHE_KEY);
    else localStorage.removeItem(DISCOVER_RECENT_CACHE_KEY);
  } catch {
    // ignore
  }
}

// Helper: cerca uno show nella cache discover (popolari + recenti)
export function findShowInDiscoverGroups(showId: number, groupsArr: Array<DiscoverGroups | null>): TvmazeShow | null {
  for (const groups of groupsArr) {
    if (!groups) continue;
    for (const key of Object.keys(groups)) {
      const arr = groups[key as keyof DiscoverGroups];
      if (!Array.isArray(arr)) continue;
      const found = arr.find((s) => s && s.id === showId);
      if (found) return found;
    }
  }
  return null;
}

export { ApiError };
