// Helper puri (usabili sia dal main thread che dal worker)

import type { Episode } from '../types';

/**
 * Converte un valore in un ID positivo e intero.
 * Rifuta tipi non numerici/stringa, valori booleani, array, oggetti,
 * symbol, bigint, notazioni esadecimali/scientifiche e numeri oltre MAX_SAFE_INTEGER.
 */
export function safeId(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 0;
  // BUG-01-h: Symbol would throw on Number(); reject explicitly.
  if (typeof v === 'symbol') return 0;
  // BUG-01-i: BigInt is a distinct primitive; reject (doc says "rifiuta tipi non numerici/stringa").
  if (typeof v === 'bigint') return 0;
  if (typeof v === 'object') return 0;
  if (typeof v === 'string') {
    // Accetta solo stringhe che rappresentano un intero decimale
    if (!/^-?\d+$/.test(v)) return 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (!Number.isInteger(n)) return 0;
  if (n <= 0) return 0;
  if (n > Number.MAX_SAFE_INTEGER) return 0;
  return n;
}

export function safeNum(v: unknown): number {
  // BUG-01-e: reject booleans and arrays (consistent with safeId).
  if (typeof v === 'boolean') return 0;
  if (Array.isArray(v)) return 0;
  const n = Number(v);
  // BUG-01-j: normalize -0 to +0 (`n === 0 ? 0 : n` converts -0 because -0 === 0).
  return Number.isFinite(n) && n >= 0 ? (n === 0 ? 0 : n) : 0;
}

export function safeImageUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  if (u.length === 0 || u.length > 2048) return null;
  if (u.startsWith('data:')) return null;
  // BUG-01-k: require at least one non-space/non-slash char after the scheme
  // (a host). Rejects 'http://' and 'https://' (no host) while accepting 'http://x'.
  if (!/^https?:\/\/[^\s/]+/i.test(u)) return null;
  return u;
}

// Entity map for single-pass HTML entity decoding (BUG-01-b).
// Each entity occurrence is decoded exactly once (no sequential double-decode).
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&#x27;': "'",
  '&apos;': "'",
};

/**
 * Rimuove i tag HTML e decodifica le entity più comuni.
 * Rimuove anche il contenuto di <script> e <style> (non solo i tag),
 * evitando che codice JavaScript finisca come testo visibile.
 * Gestisce anche tag <script>/<style> non chiusi e sezioni CDATA.
 */
export function stripHtml(html: unknown): string {
  if (!html) return '';
  const str = String(html);
  return (
    str
      // Rimuovi contenuto di script/style (compreso il testo interno) — coppie chiuse
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      // BUG-01-a: strip unclosed <script> (no closing tag) to end of string
      .replace(/<script[^>]*>[\s\S]*$/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<style[^>]*>[\s\S]*$/gi, '')
      // BUG-01-l: strip CDATA sections (closed and unclosed) before tag-strip
      .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '')
      .replace(/<!\[CDATA\[[\s\S]*$/gi, '')
      .replace(/<[^>]*>/g, '')
      // BUG-01-b: single-pass entity decode (no sequential double-decode of &amp;lt; -> <)
      .replace(/&(?:amp|lt|gt|quot|#39|nbsp|#x27|apos);/g, (m) => HTML_ENTITIES[m] ?? m)
      .trim()
  );
}

export function getPosterUrl(show: { image?: { medium?: string; original?: string } | null } | null): string | null {
  if (!show || !show.image) return null;
  // BUG-01-d: validate scheme/host via safeImageUrl. TVMaze images are always
  // http(s), so this is safe; defends against tampered API responses and
  // removes the need for every caller to remember to wrap with safeImageUrl.
  // (safeImageUrl is hoisted — defined below as a `function` declaration.)
  const url = show.image.medium || show.image.original;
  return safeImageUrl(url);
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
    // BUG-01-c: only accept strict ISO 8601 datetime with 4-digit year in the
    // fallback. Rejects arbitrary strings (e.g. negative-year strings like
    // '-0001-01-01' that V8 misparses as 2001-01-01) and non-ISO formats.
    const m2 = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(str);
    if (!m2) return null;
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
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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
          // BUG-01-f: strict boolean check — only `watched === true` counts.
          // Defense-in-depth against untrusted in-memory Show objects where
          // `watched` might be a truthy string like "false" or a number.
          if (ep && ep.watched === true) count++;
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
export function findNextEpisode<T extends HasSeasons>(
  show: T | null,
): { season: number; num: number; airdate: string | null; name: string | null } | null {
  if (!show || !show.seasons || typeof show.seasons !== 'object' || Array.isArray(show.seasons)) return null;
  try {
    const seasons = Object.keys(show.seasons)
      // BUG-01-m: strict integer key filter (rejects "1.5", "0x10", " 1 ", "+1").
      // Previously `parseInt` truncated "1.5" -> 1, colliding with key "1".
      .filter((k) => /^\d+$/.test(k) && Number(k) > 0)
      .sort((a, b) => Number(a) - Number(b));
    for (const s of seasons) {
      const eps = show.seasons![Number(s)];
      if (!Array.isArray(eps)) continue;
      // Ordina per num per restituire davvero il primo episodio non visto
      const sorted = [...eps].sort((a, b) => a.num - b.num);
      for (const ep of sorted) {
        // BUG-01-g: skip episodes with num <= 0 (defense-in-depth; normalizeShow
        // already filters these, but untrusted in-memory data may not).
        if (!ep || !ep.num || ep.num <= 0) continue;
        // BUG-01-f: strict boolean check — only `watched === true` counts as watched.
        if (ep.watched !== true) {
          return { season: Number(s), num: ep.num, airdate: ep.airdate || null, name: ep.name ?? null };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}
