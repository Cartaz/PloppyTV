// Helper puri (usabili sia dal main thread che dal worker)

import type { Episode } from '../types';

/**
 * Converte un valore in un ID positivo e intero.
 * Rifuta tipi non numerici/stringa, valori booleani, array, oggetti,
 * notazioni esadecimali/scientifiche e numeri oltre MAX_SAFE_INTEGER.
 *
 * BUG-01-h (FIXED): typeof symbol guard — Symbol() non tenta la conversione
 * numerica (che lancerebbe TypeError), viene rifiutato subito.
 * BUG-01-i (FIXED): typeof bigint guard — BigInt è un tipo primitivo distinto,
 * rifiutato esplicitamente (Number(bigint) lancerebbe TypeError).
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

/**
 * BUG-01-j (FIXED): -0 normalizzato a +0 (Object.is(-0, 0) === false).
 * BUG-A3-06 (FIXED): le stringhe vengono validate con regex stretta (solo
 * notazione decimale). `Number()` di per sé accetterebbe '0x10' (hex→16),
 * '0b101' (bin→5), '0o17' (oct→15), '1e3' (sci→1000) e '+5' — tutti input
 * scorretti per un campo numerico (runtimi, conteggi episodi). La regex
 * `^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$` ammette solo cifre decimali con
 * segno/punto opzionali e whitespace ai bordi (consistente con il behavior
 * preesistente che accetta ' 5 ' e '3.14').
 */
export function safeNum(v: unknown): number {
  if (typeof v === 'boolean') return 0;
  if (Array.isArray(v)) return 0;
  if (typeof v === 'symbol') return 0;
  if (typeof v === 'bigint') return 0;
  if (typeof v === 'function') return 0;
  if (v !== null && typeof v === 'object') return 0;
  if (typeof v === 'string') {
    // BUG-A3-06: rifiuta hex/bin/oct/scientific — Number() li accetterebbe.
    if (!/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(v)) return 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Normalizza -0 a +0 (BUG-01-j).
  return n === 0 ? 0 : n;
}

/**
 * BUG-01-k (FIXED): validazione host — la regex richiede almeno un carattere
 * non spazio/non slash dopo `://`. `http://` e `https://` (senza host) sono
 * rifiutati; `http://x` è accettato (host minimo di un carattere).
 */
export function safeImageUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  if (u.length === 0 || u.length > 2048) return null;
  if (u.startsWith('data:')) return null;
  // Richiede http(s):// seguito da almeno un carattere che non sia spazio o slash.
  if (!/^https?:\/\/[^\s/]/i.test(u)) return null;
  return u;
}

/**
 * Rimuove i tag HTML e decodifica le entity più comuni.
 * Rimuove anche il contenuto di <script> e <style> (non solo i tag),
 * evitando che codice JavaScript finisca come testo visibile.
 *
 * BUG-01-a (FIXED): tag <script>/<style> non chiusi vengono rimossi fino a
 * fine stringa (invece di restare nel testo).
 * BUG-01-b (FIXED): decodifica single-pass — le entity non vengono ri-scansionate
 * dopo la sostituzione (es. `&amp;lt;` → `&lt;`, non `<`).
 * BUG-01-l (FIXED): le sezioni CDATA vengono rimosse interamente prima dello
 * strip dei tag.
 * BUG-A3-02 (FIXED): la regex di tag-strip ora riconosce le virgolette
 * (`"[^"]*"` / `'[^']*'`) come atomi, così i `>` interni a un valore di
 * attributo non terminano il tag (es. `<img title="a>b">text` → `text`).
 * BUG-A3-03 (FIXED): i commenti non chiusi (`<!-- foo` senza `-->`) vengono
 * rimossi fino a fine stringa, come già avveniva per <script>/<style>.
 * BUG-A3-04 (FIXED): le sezioni CDATA non chiuse (`<![CDATA[foo` senza `]]>`)
 * vengono rimosse fino a fine stringa.
 */
export function stripHtml(html: unknown): string {
  if (!html) return '';
  const str = String(html);
  return (
    str
      // Rimuovi sezioni CDATA (BUG-01-l, BUG-A3-04): includes contenuto anche
      // con > interno; se non chiuse (`]]>` mancante), rimuove fino a fine
      // stringa (consistente con script/style).
      .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '')
      // Rimuovi contenuto di script/style (compreso il testo interno).
      // BUG-01-a: anche tag non chiusi vengono rimossi fino a fine stringa.
      .replace(/<script[\s\S]*?(?:<\/script>|$)/gi, '')
      .replace(/<style[\s\S]*?(?:<\/style>|$)/gi, '')
      // Rimuovi commenti HTML (BUG-A3-03: anche non chiusi, fino a fine stringa).
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      // Rimuovi tutti gli altri tag.
      // BUG-A3-02: la regex riconosce `"[^"]*"` e `'[^']*'` come atomi, così
      // un `>` dentro un valore di attributo non chiude il tag prematuramente.
      .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '')
      // BUG-01-b: decodifica entity single-pass — la stringa sostituita non
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
 * BUG-01-d (FIXED): getPosterUrl ora valida gli URL tramite safeImageUrl,
 * quindi `javascript:` e `data:` vengono filtrati → null.
 */
export function getPosterUrl(show: { image?: { medium?: string; original?: string } | null } | null): string | null {
  if (!show || !show.image) return null;
  if (show.image.medium) {
    const u = safeImageUrl(show.image.medium);
    if (u) return u;
  }
  if (show.image.original) {
    const u = safeImageUrl(show.image.original);
    if (u) return u;
  }
  return null;
}

// ===== DATE HELPERS (timezone-safe) =====
/**
 * Parsa una data ISO. Per date "YYYY-MM-DD" (senza tempo) usa costruttore
 * locale per evitare shift di fuso. Per altre stringhe usa Date standard.
 * Validazione stretta: rifiuta date rollover come 2024-02-30.
 *
 * BUG-01-c (FIXED): il fallback ora accetta solo ISO 8601 datetime stretto
 * con anno a 4 cifre positivo. `2024-1-1` e `-0001-01-01` sono rifiutati.
 * BUG-A3-05 (FIXED): il branch datetime ora valida i giorni-per-mese con
 * `daysInMonth(y, mo)` invece del solo range 1-31, rifiutando rollover come
 * `2024-02-30T10:00:00` (che `new Date(str)` accetterebbe convertirlo in
 * `2024-03-01T10:00:00.000Z` invece di tornare Invalid Date).
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
    // BUG-01-c: fallback strict ISO 8601 datetime con anno a 4 cifre.
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
    // BUG-A3-05: valida i giorni-per-mese (rifiuta 2024-02-30T...).
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

/**
 * BUG-A3-01 (FIXED): se `d` è una Data invalida (es. `new Date(NaN)`), torna
 * stringa vuota invece di `"NaN-NaN-NaN"` (che rompeva `parseISODateLocal`
 * downstream e finiva in URL/label).
 */
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
/**
 * BUG-01-f (FIXED): solo `watched === true` (booleano stretto) viene contato.
 * Stringhe come "true"/"false" e numeri come 1 non contano più.
 */
export function getWatchedCount(show: { seasons?: Record<number, Episode[]> } | null): number {
  if (!show || !show.seasons || typeof show.seasons !== 'object' || Array.isArray(show.seasons)) return 0;
  let count = 0;
  try {
    for (const eps of Object.values(show.seasons)) {
      if (Array.isArray(eps)) {
        for (const ep of eps) {
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
 *
 * BUG-01-f (FIXED): solo `watched === true` conta come watched; tutti gli
 * altri valori (stringa "false", numero 0, ecc.) sono trattati come UNWATCHED.
 * BUG-01-g (FIXED): episodi con `num <= 0` sono saltati.
 * BUG-01-m (FIXED): chiavi di stagione non intere (es. "1.5") sono filtrate.
 * BUG-A3-07 (FIXED): `ep.num` deve essere un intero positivo (`typeof number`,
 * `Number.isInteger`, `> 0`). Prima, valori come `undefined`, `NaN`, `Infinity`,
 * `1.5` o stringhe passavano il check `ep.num <= 0` (che è false per NaN/undefined
 * e per stringhe non-numeric) e venivano restituiti nel risultato, violando il
 * contratto `num: number`. Il sort ora coerisce i num non-finiti a `Infinity`
 * così finiscono in fondo e non disturbano l'ordine dei valori validi
 * (sort con `NaN` comparator è trattato come 0 e risultava instabile).
 */
export function findNextEpisode<T extends HasSeasons>(
  show: T | null,
): { season: number; num: number; airdate: string | null; name: string | null } | null {
  if (!show || !show.seasons || typeof show.seasons !== 'object' || Array.isArray(show.seasons)) return null;
  try {
    const seasons = Object.keys(show.seasons)
      // BUG-01-m: filtra solo chiavi intere positive.
      .filter((k) => {
        const n = Number(k);
        return Number.isInteger(n) && n > 0;
      })
      .sort((a, b) => Number(a) - Number(b));
    for (const s of seasons) {
      const eps = show.seasons![Number(s)];
      if (!Array.isArray(eps)) continue;
      // Ordina per num per restituire davvero il primo episodio non visto.
      // BUG-A3-07: coerige num non-finiti/invalidi a Infinity così i valori
      // validi vengono ordinati correttamente tra loro.
      const sorted = [...eps].sort((a, b) => {
        const an = a && typeof a.num === 'number' && Number.isFinite(a.num) ? a.num : Infinity;
        const bn = b && typeof b.num === 'number' && Number.isFinite(b.num) ? b.num : Infinity;
        return an - bn;
      });
      for (const ep of sorted) {
        // BUG-01-g + BUG-A3-07: salta ep con num non intero positivo.
        if (!ep || typeof ep.num !== 'number' || !Number.isInteger(ep.num) || ep.num <= 0) continue;
        // BUG-01-f: strict !== true check.
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
