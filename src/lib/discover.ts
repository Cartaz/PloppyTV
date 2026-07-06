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

async function fetchAllCandidates(
  pages: number[],
  recentOnly: boolean,
  onProgress?: (text: string) => void
): Promise<TvmazeShow[]> {
  const sixMonthsAgo = recentOnly
    ? (() => {
        const d = new Date();
        d.setMonth(d.getMonth() - 6);
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

  const fetchPromises = pages.map(
    (page) =>
      (async (): Promise<TvmazeShow[]> => {
        try {
          const pageShows = await getShowsPage(page);
          return Array.isArray(pageShows) ? pageShows : [];
        } catch (e) {
          console.warn('Errore caricamento pagina ' + page + ':', e);
          return [];
        } finally {
          completed++;
          scheduleProgress(label);
        }
      })()
  );

  const pagesResults = await Promise.all(fetchPromises);

  const all: TvmazeShow[] = [];
  for (const pageShows of pagesResults) {
    for (const show of pageShows) {
      if (!show || !show.image || !show.name || !show.weight || show.weight <= 0) continue;
      if (recentOnly) {
        if (!show.premiered) continue;
        const d = parseISODateLocal(show.premiered);
        if (!d || d < sixMonthsAgo!) continue;
      }
      all.push(show);
    }
  }

  all.sort((a, b) => {
    const wDiff = (b.weight || 0) - (a.weight || 0);
    if (wDiff !== 0) return wDiff;
    const rA = a.rating?.average ?? 0;
    const rB = b.rating?.average ?? 0;
    return rB - rA;
  });
  return all;
}

function assignShowsToGroups(candidates: TvmazeShow[]): DiscoverGroups {
  const groups: DiscoverGroups = {} as DiscoverGroups;
  for (const g of GENRE_CAROUSELS) groups[g] = [];
  groups._other = [];
  const assignedIds = new Set<number>();

  // FASE 1
  for (const show of candidates) {
    if (assignedIds.has(show.id)) continue;
    const genres = Array.isArray(show.genres) ? show.genres : [];
    let assigned: string | null = null;
    for (const targetGenre of GENRE_CAROUSELS) {
      if (genres.includes(targetGenre)) {
        assigned = targetGenre;
        break;
      }
    }
    if (assigned) {
      if (groups[assigned].length < DISCOVER_TARGET_PER_GENRE) {
        groups[assigned].push(show);
        assignedIds.add(show.id);
      }
    } else {
      if (groups._other.length < DISCOVER_TARGET_OTHER) {
        groups._other.push(show);
        assignedIds.add(show.id);
      }
    }
  }

  // FASE 2: ridistribuzione deficit
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
      let assigned: string | null = null;
      for (const targetGenre of GENRE_CAROUSELS) {
        if (genres.includes(targetGenre)) {
          assigned = targetGenre;
          break;
        }
      }
      if (assigned) {
        groups[assigned].push(show);
        assignedIds.add(show.id);
        added++;
      } else {
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
  onProgress?: (text: string) => void
): Promise<DiscoverGroups> {
  const candidates = await fetchAllCandidates(pages, recentOnly, onProgress);
  return assignShowsToGroups(candidates);
}

function readCache(key: string): DiscoverGroups | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { cachedAt: number; groups: DiscoverGroups };
    if (cached && cached.cachedAt && Date.now() - cached.cachedAt < DISCOVER_CACHE_TTL && cached.groups) {
      return cached.groups;
    }
  } catch {
    // cache invalida
  }
  return null;
}

function writeCache(key: string, groups: DiscoverGroups): void {
  try {
    localStorage.setItem(key, JSON.stringify({ groups, cachedAt: Date.now() }));
  } catch {
    // storage pieno
  }
}

export async function getPopularShows(onProgress?: (text: string) => void): Promise<DiscoverGroups> {
  const cached = readCache(DISCOVER_CACHE_KEY);
  if (cached) return cached;
  const groups = await fetchShowsByGenre(DISCOVER_POPULAR_PAGES, false, onProgress);
  writeCache(DISCOVER_CACHE_KEY, groups);
  return groups;
}

export async function getRecentShows(onProgress?: (text: string) => void): Promise<DiscoverGroups> {
  const cached = readCache(DISCOVER_RECENT_CACHE_KEY);
  if (cached) return cached;
  const groups = await fetchShowsByGenre(DISCOVER_RECENT_PAGES, true, onProgress);
  writeCache(DISCOVER_RECENT_CACHE_KEY, groups);
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
export function findShowInDiscoverGroups(
  showId: number,
  groupsArr: Array<DiscoverGroups | null>
): TvmazeShow | null {
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
