// Helper puri (usabili sia dal main thread che dal worker)

import type { Episode } from '../types';

export function safeId(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function safeNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function safeImageUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  if (u.length === 0 || u.length > 2048) return null;
  if (u.startsWith('data:')) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

export function stripHtml(html: unknown): string {
  if (!html) return '';
  const str = String(html);
  // Lavora senza DOMParser (compatibile con Web Worker)
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function getPosterUrl(show: { image?: { medium?: string; original?: string } | null } | null): string | null {
  if (!show || !show.image) return null;
  if (show.image.medium) return show.image.medium;
  if (show.image.original) return show.image.original;
  return null;
}

// ===== DATE HELPERS (timezone-safe) =====
export function parseISODateLocal(str: unknown): Date | null {
  if (!str || typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return null;
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

export function localISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

const IT_MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'N/D';
  const d = parseISODateLocal(dateStr);
  if (!d) return 'N/D';
  try {
    const out = d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
    if (out && !/^\d+$/.test(out)) return out;
  } catch {
    // fallback below
  }
  return d.getDate() + ' ' + IT_MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

// ===== HTML escaping (solo main thread) =====
export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(str: unknown): string {
  return escapeHtml(str);
}

// ===== Show helpers =====
export function getWatchedCount(show: { seasons?: Record<number, Episode[]> } | null): number {
  if (!show || !show.seasons || typeof show.seasons !== 'object' || Array.isArray(show.seasons)) return 0;
  let count = 0;
  try {
    for (const eps of Object.values(show.seasons)) {
      if (Array.isArray(eps)) {
        for (const ep of eps) {
          if (ep && ep.watched) count++;
        }
      }
    }
  } catch {
    return 0;
  }
  return count;
}

interface HasSeasons {
  seasons?: Record<number, Episode[]>;
}

export function findNextEpisode<T extends HasSeasons>(show: T | null): { season: number; num: number; airdate: string | null; name: string | null } | null {
  if (!show || !show.seasons || typeof show.seasons !== 'object' || Array.isArray(show.seasons)) return null;
  try {
    const seasons = Object.keys(show.seasons)
      .filter(k => !isNaN(parseInt(k, 10)) && parseInt(k, 10) > 0)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const s of seasons) {
      const eps = show.seasons![Number(s)];
      if (!Array.isArray(eps)) continue;
      for (const ep of eps) {
        if (ep && !ep.watched) {
          return { season: parseInt(s, 10), num: ep.num, airdate: ep.airdate || null, name: ep.name ?? null };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}
