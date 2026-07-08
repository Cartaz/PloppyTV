// Helper puri (usabili sia dal main thread che dal worker)

import type { Episode } from '../types';

/**
 * Converte un valore in un ID positivo e intero.
 * Rifuta tipi non numerici/stringa, valori booleani, array, oggetti,
 * notazioni esadecimali/scientifiche e numeri oltre MAX_SAFE_INTEGER.
 */
export function safeId(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 0;
  if (typeof v === 'object') return 0;
  if (typeof v === 'string') {
    // Accetta solo stringhe che rappresentano un intero decimale
    if (!/^-?\d+$/.test(v)) return 0;
  }
  const n = typeof v === 'string' ? Number(v) : Number(v);
  if (!Number.isFinite(n)) return 0;
  if (!Number.isInteger(n)) return 0;
  if (n <= 0) return 0;
  if (n > Number.MAX_SAFE_INTEGER) return 0;
  return n;
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

/**
 * Rimuove i tag HTML e decodifica le entity più comuni.
 * Rimuove anche il contenuto di <script> e <style> (non solo i tag),
 * evitando che codice JavaScript finisca come testo visibile.
 */
export function stripHtml(html: unknown): string {
  if (!html) return '';
  const str = String(html);
  return str
    // Rimuovi contenuto di script/style (compreso il testo interno)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

export function getPosterUrl(show: { image?: { medium?: string; original?: string } | null } | null): string | null {
  if (!show || !show.image) return null;
  if (show.image.medium) return show.image.medium;
  if (show.image.original) return show.image.original;
  return null;
}

// ===== DATE HELPERS (timezone-safe) =====
/**
 * Parsa una data ISO. Per date "YYYY-MM-DD" (senza tempo) usa costruttore
 * locale per evitare shift di fuso. Per altre stringhe usa Date standard.
 * Validazione stretta: rifiuta date rollover come 2024-02-30.
 */
export function parseISODateLocal(str: unknown): Date | null {
  if (!str || typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Validazione stretta: rifiuta 2024-13-45, 2024-02-30, ecc.
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  const date = new Date(y, mo - 1, d);
  if (isNaN(date.getTime())) return null;
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
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

/**
 * Trova il primo episodio non watched, iterando le stagioni in ordine numerico
 * e gli episodi di ogni stagione in ordine di `num`.
 * Senza il sort per `num`, un array non ordinato restituirebbe l'episodio
 * sbagliato come "prossimo".
 */
export function findNextEpisode<T extends HasSeasons>(show: T | null): { season: number; num: number; airdate: string | null; name: string | null } | null {
  if (!show || !show.seasons || typeof show.seasons !== 'object' || Array.isArray(show.seasons)) return null;
  try {
    const seasons = Object.keys(show.seasons)
      .filter(k => !isNaN(parseInt(k, 10)) && parseInt(k, 10) > 0)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const s of seasons) {
      const eps = show.seasons![Number(s)];
      if (!Array.isArray(eps)) continue;
      // Ordina per num per restituire davvero il primo episodio non visto
      const sorted = [...eps].sort((a, b) => a.num - b.num);
      for (const ep of sorted) {
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
