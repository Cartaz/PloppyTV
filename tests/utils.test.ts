import { describe, it, expect } from 'vitest';
import {
  safeId,
  safeNum,
  safeImageUrl,
  stripHtml,
  parseISODateLocal,
  localISODate,
  isSameLocalDay,
  formatDate,
  escapeHtml,
  escapeAttr,
  getPosterUrl,
} from '../src/lib/utils';

describe('safeId', () => {
  it('accetta interi positivi come number e string', () => {
    expect(safeId(1)).toBe(1);
    expect(safeId(42)).toBe(42);
    expect(safeId('123')).toBe(123);
    expect(safeId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rifiuta booleani, null, undefined, oggetti, array', () => {
    expect(safeId(null)).toBe(0);
    expect(safeId(undefined)).toBe(0);
    expect(safeId(true)).toBe(0);
    expect(safeId(false)).toBe(0);
    expect(safeId({})).toBe(0);
    expect(safeId([1])).toBe(0);
  });

  it('rifiuta zero, negativi, NaN, Infinity', () => {
    expect(safeId(0)).toBe(0);
    expect(safeId(-1)).toBe(0);
    expect(safeId('-5')).toBe(0);
    expect(safeId(NaN)).toBe(0);
    expect(safeId(Infinity)).toBe(0);
  });

  it('rifiuta notazioni esadecimali, scientifiche, float, oltre MAX_SAFE_INTEGER', () => {
    expect(safeId('0x10')).toBe(0); // hex non decimale
    expect(safeId('1e3')).toBe(0); // scientifica
    expect(safeId(1.5)).toBe(0); // non intero
    expect(safeId('1.5')).toBe(0); // stringa float
    expect(safeId(Number.MAX_SAFE_INTEGER + 1)).toBe(0); // oltre safe int
    expect(safeId('99999999999999999999')).toBe(0); // oltre safe int come stringa
  });
});

describe('safeNum', () => {
  it('accetta numeri finiti >= 0', () => {
    expect(safeNum(0)).toBe(0);
    expect(safeNum(42)).toBe(42);
    expect(safeNum('3.14')).toBe(3.14);
    expect(safeNum('0')).toBe(0);
  });

  it('restituisce 0 per NaN, Infinity, stringhe non numeriche, null, oggetti', () => {
    expect(safeNum(NaN)).toBe(0);
    expect(safeNum(Infinity)).toBe(0);
    expect(safeNum('abc')).toBe(0);
    expect(safeNum(null)).toBe(0);
    expect(safeNum(undefined)).toBe(0);
    expect(safeNum({})).toBe(0);
  });

  it('restituisce 0 per numeri negativi', () => {
    expect(safeNum(-1)).toBe(0);
    expect(safeNum('-5')).toBe(0);
  });
});

describe('safeImageUrl', () => {
  it('accetta URL http/https sotto 2048 char', () => {
    expect(safeImageUrl('http://example.com/a.jpg')).toBe('http://example.com/a.jpg');
    expect(safeImageUrl('https://static.tvmaze.com/uploads/pilot.jpg')).toBe(
      'https://static.tvmaze.com/uploads/pilot.jpg',
    );
  });

  it('rifiuta data URL, javascript:, stringhe non-URL, vuote, > 2048 char', () => {
    expect(safeImageUrl('data:image/png;base64,xxx')).toBeNull();
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageUrl('foo/bar')).toBeNull();
    expect(safeImageUrl('')).toBeNull();
    expect(safeImageUrl('https://a.' + 'a'.repeat(2050))).toBeNull();
  });

  it('rifiuta tipi non stringa', () => {
    expect(safeImageUrl(null)).toBeNull();
    expect(safeImageUrl(undefined)).toBeNull();
    expect(safeImageUrl(123)).toBeNull();
    expect(safeImageUrl({})).toBeNull();
  });
});

describe('stripHtml', () => {
  it('rimuove i tag HTML ma ne conserva il testo', () => {
    expect(stripHtml('<p>hello <b>world</b></p>')).toBe('hello world');
    expect(stripHtml('<div>a</div><div>b</div>')).toBe('ab'); // niente spazio tra tag adiacenti
    expect(stripHtml('a <b>b</b> c')).toBe('a b c'); // spazi conservati se presenti nel testo
  });

  it('rimuove completamente script e style inclusi i contenuti', () => {
    expect(stripHtml('<script>alert(1)</script>safe')).toBe('safe');
    expect(stripHtml('<style>.x{color:red}</style>visible')).toBe('visible');
    expect(stripHtml('<script>document.cookie</script>ok')).toBe('ok');
  });

  it('decodifica le entity HTML più comuni', () => {
    expect(stripHtml('&amp;&lt;&gt;&quot;&#39;')).toBe('&<>"\'');
    expect(stripHtml('a &nbsp; b')).toBe('a   b'); // &nbsp; → spazio, conservato se interno
    expect(stripHtml('&nbsp;trimmed&nbsp;')).toBe('trimmed'); // trim rimuove &nbsp; ai bordi
    expect(stripHtml('&apos;&#x27;')).toBe("''");
  });

  it('gestisce input non stringa senza throw', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml(123)).toBe('123');
  });
});

describe('parseISODateLocal', () => {
  it('parsa date YYYY-MM-DD senza shift di fuso', () => {
    const d = parseISODateLocal('2024-06-15');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2024);
    expect(d!.getMonth()).toBe(5); // 0-indexed
    expect(d!.getDate()).toBe(15);
  });

  it('rifiuta date rollover come 2024-02-30 e 2024-13-01', () => {
    expect(parseISODateLocal('2024-02-30')).toBeNull();
    expect(parseISODateLocal('2024-13-01')).toBeNull();
    expect(parseISODateLocal('2024-00-15')).toBeNull();
    expect(parseISODateLocal('2024-06-00')).toBeNull();
    expect(parseISODateLocal('2024-06-32')).toBeNull();
  });

  it('rifiuta input non stringa e formati non ISO', () => {
    expect(parseISODateLocal(null)).toBeNull();
    expect(parseISODateLocal(undefined)).toBeNull();
    expect(parseISODateLocal(123)).toBeNull();
    expect(parseISODateLocal('')).toBeNull();
    expect(parseISODateLocal('not-a-date')).toBeNull();
  });

  it('accetta date ISO con tempo usando parser standard', () => {
    const d = parseISODateLocal('2024-06-15T10:30:00Z');
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2024);
  });
});

describe('localISODate + isSameLocalDay', () => {
  it('localISODate produce YYYY-MM-DD in zona locale', () => {
    const d = new Date(2024, 5, 15, 10, 30); // 15 giugno 2024, local
    expect(localISODate(d)).toBe('2024-06-15');
  });

  it('isSameLocalDay true per stesso giorno, false per giorni diversi', () => {
    const a = new Date(2024, 5, 15, 0, 0);
    const b = new Date(2024, 5, 15, 23, 59);
    const c = new Date(2024, 5, 16, 0, 0);
    expect(isSameLocalDay(a, b)).toBe(true);
    expect(isSameLocalDay(a, c)).toBe(false);
  });
});

describe('formatDate', () => {
  it('ritorna N/D per date nulle o invalide', () => {
    expect(formatDate(null)).toBe('N/D');
    expect(formatDate('not-a-date')).toBe('N/D');
    expect(formatDate('2024-13-40')).toBe('N/D');
  });

  it('formatta una data valida in italiano', () => {
    const out = formatDate('2024-06-15');
    // toLocaleDateString it-IT produce qualcosa tipo "15 giu 2024"
    expect(out).toMatch(/15.*2024/);
  });
});

describe('escapeHtml + escapeAttr', () => {
  it('escapa i caratteri pericolosi per HTML text', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('"quote"')).toBe('&quot;quote&quot;');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('escapeAttr è alias di escapeHtml', () => {
    expect(escapeAttr('<>&"\'')).toBe(escapeHtml('<>&"\''));
  });

  it('gestisce null/undefined senza throw', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('getPosterUrl', () => {
  it('preferisce medium, poi original, poi null (URLs validate via safeImageUrl)', () => {
    // BUG-01-d: getPosterUrl now wraps the chosen URL with safeImageUrl.
    // Use valid http(s) URLs so the preference order is still exercised.
    expect(getPosterUrl({ image: { medium: 'http://m.jpg', original: 'http://o.jpg' } })).toBe('http://m.jpg');
    expect(getPosterUrl({ image: { original: 'http://o.jpg' } })).toBe('http://o.jpg');
    expect(getPosterUrl({ image: {} })).toBeNull();
    expect(getPosterUrl({ image: null })).toBeNull();
    expect(getPosterUrl(null)).toBeNull();
  });

  it('rifiuta scheme non http(s) (javascript:, data:, relativi)', () => {
    expect(getPosterUrl({ image: { medium: 'javascript:alert(1)' } })).toBeNull();
    expect(getPosterUrl({ image: { medium: 'data:text/html,<script>' } })).toBeNull();
    expect(getPosterUrl({ image: { medium: 'relative.jpg' } })).toBeNull();
  });
});
