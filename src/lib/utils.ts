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
  if (typeof v === 'symbol') return 0;
  if (typeof v === 'bigint') return 0;
  if (typeof v === 'function') return 0;
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
  if (typeof v === 'boolean') return 0;
  if (Array.isArray(v)) return 0;
  if (typeof v === 'symbol') return 0;
  if (typeof v === 'bigint') return 0;
  if (typeof v === 'function') return 0;
  if (v !== null && typeof v === 'object') return 0;
  if (typeof v === 'string') {
    // Rifiuta hex/bin/oct/scientific — Number() li accetterebbe.
    if (!/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(v)) return 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Normalizza -0 a +0.
  return n === 0 ? 0 : n;
}

/**
 * Validatore sintattico minimo per URL immagine HTTP(S). Whitespace ai bordi
 * e caratteri di controllo grezzi vengono rifiutati; gli spazi interni restano
 * parte dell'URL e l'escaping HTML appartiene al renderer. La policy di origine
 * appartiene a `safeTvmazeImageUrl`.
 */
export function safeImageUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  if (u.length === 0 || u.length > 2048) return null;
  if (u !== u.trim()) return null;
  for (let i = 0; i < u.length; i++) {
    const code = u.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (u.startsWith('data:')) return null;
  // Richiede http(s):// seguito da almeno un carattere che non sia spazio o slash.
  if (!/^https?:\/\/[^\s/]/i.test(u)) return null;
  return u;
}

const TVMAZE_IMAGE_ORIGIN = 'https://static.tvmaze.com';

/**
 * Trust boundary per le immagini persistite da PloppyTV. Il prodotto non
 * supporta URL immagine custom: i poster legittimi arrivano dal CDN TVMaze.
 * Manteniamo `safeImageUrl` come validatore sintattico generico per il layer
 * di rendering, mentre qui imponiamo l'origine HTTPS prevista ai dati di dominio.
 */
export function safeTvmazeImageUrl(u: unknown): string | null {
  const safe = safeImageUrl(u);
  if (!safe) return null;
  try {
    if (new URL(safe).origin !== TVMAZE_IMAGE_ORIGIN) return null;
    return safe;
  } catch {
    return null;
  }
}

/**
 * Rimuove i tag HTML e decodifica le entity più comuni.
 * Rimuove anche il contenuto di <script> e <style> (non solo i tag),
 * evitando che codice JavaScript finisca come testo visibile.
 */
export function stripHtml(html: unknown): string {
  if (!html) return '';
  const str = String(html);
  return (
    str
      // Rimuovi sezioni CDATA: includes contenuto anche
      // con > interno; se non chiuse (`]]>` mancante), rimuove fino a fine
      // stringa (consistente con script/style).
      .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '')
      // Rimuovi contenuto di script/style (compreso il testo interno).
      // Anche tag non chiusi vengono rimossi fino a fine stringa.
      .replace(/<script[\s\S]*?(?:<\/script>|$)/gi, '')
      .replace(/<style[\s\S]*?(?:<\/style>|$)/gi, '')
      // Rimuovi commenti HTML (anche non chiusi, fino a fine stringa).
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      // Rimuovi tutti gli altri tag.
      // La regex riconosce `"[^"]*"` e `'[^']*'` come atomi, così
      // un `>` dentro un valore di attributo non chiude il tag prematuramente.
      .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '')
      // Decodifica entity single-pass — la stringa sostituita non
      // viene ri-scansionata, quindi `&amp;lt;` diventa `&lt;` (non `<`).
      .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&#x27;|&apos;|&nbsp;/g, (m) => {
        switch (m) {
          case '&amp;':
            return '&';
          case '&lt;':
            return '<';
          case '&gt;':
            return '>';
          case '&quot;':
            return '"';
          case '&#39;':
            return "'";
          case '&#x27;':
            return "'";
          case '&apos;':
            return "'";
          case '&nbsp;':
            return ' ';
          default:
            return m;
        }
      })
      .trim()
  );
}

/**
 * I poster di dominio sono accettati solo dall'origine HTTPS del CDN TVMaze.
 * Schemi pericolosi e origini esterne vengono neutralizzati a null.
 */
export function getPosterUrl(show: { image?: { medium?: string; original?: string } | null } | null): string | null {
  if (!show || !show.image) return null;
  if (show.image.medium) {
    const u = safeTvmazeImageUrl(show.image.medium);
    if (u) return u;
  }
  if (show.image.original) {
    const u = safeTvmazeImageUrl(show.image.original);
    if (u) return u;
  }
  return null;
}

// ===== DATE HELPERS (timezone-safe) =====
/**
 * Parsa una data ISO. Per date "YYYY-MM-DD" (senza tempo) usa costruttore
 * locale per evitare shift di fuso. Per altre stringhe usa Date standard.
 * Validazione stretta: rifiuta date rollover come 2024-02-30.
 */
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

// Restituisce il numero di giorni del mese (1-12) per l'anno y.
// new Date(y, m, 0) è l'ultimo giorno del mese precedente m (0-indexed), per
// cui new Date(y, m, 0).getDate() = giorni del mese m (1-indexed).
function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

export function parseISODateLocal(str: unknown): Date | null {
  if (!str || typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) {
    // Fallback strict ISO 8601 datetime con anno a 4 cifre.
    // Rifiuta `-0001-01-01`, `2024-1-1`, stringhe non ISO.
    const dt = ISO_DATETIME_RE.exec(str);
    if (!dt) return null;
    const y = Number(dt[1]);
    const mo = Number(dt[2]);
    const d = Number(dt[3]);
    const h = Number(dt[4]);
    const mi = Number(dt[5]);
    const s = dt[6] !== undefined ? Number(dt[6]) : 0;
    if (mo < 1 || mo > 12) return null;
    // Valida i giorni-per-mese (rifiuta 2024-02-30T...).
    if (d < 1 || d > daysInMonth(y, mo)) return null;
    if (h > 23) return null;
    if (mi > 59) return null;
    if (s > 59) return null;
    const date = new Date(str);
    if (isNaN(date.getTime())) return null;
    return date;
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
  if (!d || isNaN(d.getTime())) return '';
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
export function getWatchedCount(show: HasSeasons): number {
  let count = 0;
  for (const eps of Object.values(show.seasons)) for (const ep of eps) if (ep.watched) count++;
  return count;
}

interface HasSeasons {
  seasons: Record<number, Episode[]>;
}

/** Primo episodio non visto, in ordine di stagione e numero. */
export function findNextEpisode(
  show: HasSeasons,
): { season: number; num: number; airdate: string | null; name: string | null } | null {
  const seasons = Object.keys(show.seasons)
    .map(Number)
    .sort((a, b) => a - b);
  for (const season of seasons) {
    const sorted = [...show.seasons[season]].sort((a, b) => a.num - b.num);
    const ep = sorted.find((e) => !e.watched);
    if (ep) return { season, num: ep.num, airdate: ep.airdate || null, name: ep.name ?? null };
  }
  return null;
}

export interface DatedEpisode {
  season: number;
  num: number;
  airdate: string;
  name: string | null;
  /** Mezzanotte locale del giorno di uscita. */
  date: Date;
}

/**
 * Episodi non visti con una data di uscita valida, in ordine cronologico
 * (a parità di data: stagione, poi numero). Base di calendario e notifiche:
 * contano le uscite reali, non solo il primo episodio non visto.
 */
export function unwatchedEpisodesByAirdate(show: HasSeasons): DatedEpisode[] {
  const result: DatedEpisode[] = [];
  for (const [key, eps] of Object.entries(show.seasons)) {
    const season = Number(key);
    for (const ep of eps) {
      if (ep.watched) continue;
      const date = ep.airdate ? parseISODateLocal(ep.airdate) : null;
      if (!date || !ep.airdate) continue;
      result.push({ season, num: ep.num, airdate: ep.airdate, name: ep.name ?? null, date });
    }
  }
  return result.sort((a, b) => a.date.getTime() - b.date.getTime() || a.season - b.season || a.num - b.num);
}
