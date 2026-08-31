from pathlib import Path

utils = Path('src/lib/utils.ts')
text = utils.read_text()

old_image_doc = '''/**
 * BUG-01-k (FIXED): validazione host — la regex richiede almeno un carattere
 * non spazio/non slash dopo `://`. `http://` e `https://` (senza host) sono
 * rifiutati; `http://x` è accettato (host minimo di un carattere).
 */
'''
new_image_doc = '''/**
 * Validatore sintattico minimo per URL immagine HTTP(S). Gli URL devono essere
 * già serializzati: whitespace/control characters non codificati vengono
 * rifiutati invece di affidarsi alle normalizzazioni implicite del browser.
 * La policy di origine appartiene a `safeTvmazeImageUrl`.
 */
'''
if old_image_doc not in text:
    raise SystemExit('safeImageUrl documentation anchor not found')
text = text.replace(old_image_doc, new_image_doc, 1)

old_image_code = '''export function safeImageUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  if (u.length === 0 || u.length > 2048) return null;
  if (u.startsWith('data:')) return null;
  // Richiede http(s):// seguito da almeno un carattere che non sia spazio o slash.
  if (!/^https?:\\/\\/[^\\s/]/i.test(u)) return null;
  return u;
}
'''
new_image_code = '''export function safeImageUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  if (u.length === 0 || u.length > 2048) return null;
  if (/\\s/.test(u)) return null;
  if (u.startsWith('data:')) return null;
  // Richiede http(s):// seguito da almeno un carattere che non sia spazio o slash.
  if (!/^https?:\\/\\/[^\\s/]/i.test(u)) return null;
  return u;
}
'''
if old_image_code not in text:
    raise SystemExit('safeImageUrl code anchor not found')
text = text.replace(old_image_code, new_image_code, 1)

old_find_doc = ''' * BUG-01-m (FIXED): chiavi di stagione non intere (es. "1.5") sono filtrate.
'''
new_find_doc = ''' * Le chiavi stagione devono essere interi positivi in forma decimale canonica:
 * alias testuali come "01" vengono filtrati come già avviene nel boundary di
 * persistenza, evitando due rappresentazioni della stessa stagione.
'''
if old_find_doc not in text:
    raise SystemExit('findNextEpisode documentation anchor not found')
text = text.replace(old_find_doc, new_find_doc, 1)

old_filter = '''      // BUG-01-m: filtra solo chiavi intere positive.
      .filter((k) => {
        const n = Number(k);
        return Number.isInteger(n) && n > 0;
      })
'''
new_filter = '''      // Una stagione ha una sola rappresentazione: "1", non "01".
      .filter((k) => {
        const n = Number(k);
        return Number.isInteger(n) && n > 0 && k === String(n);
      })
'''
if old_filter not in text:
    raise SystemExit('findNextEpisode filter anchor not found')
text = text.replace(old_filter, new_filter, 1)
utils.write_text(text)

edge = Path('tests/utils.edgecases.test.ts')
edge.write_text(r'''import { describe, expect, it, vi } from 'vitest';
import {
  escapeHtml,
  findNextEpisode,
  formatDate,
  getPosterUrl,
  getWatchedCount,
  isSameLocalDay,
  localISODate,
  parseISODateLocal,
  safeId,
  safeImageUrl,
  safeNum,
  safeTvmazeImageUrl,
  stripHtml,
} from '../src/lib/utils';

describe('numeric boundaries', () => {
  it('safeId rejects non-scalar numeric inputs without throwing', () => {
    for (const value of [Symbol('x'), 42n, () => 1, [], [1], {}, true, false]) {
      expect(safeId(value)).toBe(0);
    }
  });

  it('safeId keeps generic decimal parsing separate from domain canonicalization', () => {
    expect(safeId('007')).toBe(7);
    for (const value of [' 5 ', '+5', '1e3', '0x10', '1.5', '']) {
      expect(safeId(value)).toBe(0);
    }
  });

  it('safeNum accepts decimal whitespace but rejects alternate numeric syntaxes and coercible objects', () => {
    expect(safeNum('  5.25  ')).toBe(5.25);
    for (const value of ['1e3', '0x10', '0b10', '0o10', '5px', true, [], [5], {}, Symbol('x'), 1n, () => 1]) {
      expect(safeNum(value)).toBe(0);
    }
  });

  it('safeNum canonicalizes both numeric and textual negative zero', () => {
    expect(Object.is(safeNum(-0), 0)).toBe(true);
    expect(Object.is(safeNum('-0'), 0)).toBe(true);
  });
});

describe('image URL boundaries', () => {
  it('safeImageUrl enforces exact size and rejects raw whitespace/control characters', () => {
    const prefix = 'https://x/';
    const max = prefix + 'a'.repeat(2048 - prefix.length);
    expect(safeImageUrl(max)).toBe(max);
    expect(safeImageUrl(max + 'a')).toBeNull();
    for (const value of ['https://x/a b.jpg', 'https://x/a.jpg\n', ' https://x/a.jpg', 'https://x/a.jpg\t']) {
      expect(safeImageUrl(value)).toBeNull();
    }
  });

  it('safeImageUrl accepts only absolute HTTP(S) URLs with a host', () => {
    expect(safeImageUrl('HTTPS://example.com/x.jpg')).toBe('HTTPS://example.com/x.jpg');
    for (const value of ['http://', 'https://', '/x.jpg', '//host/x.jpg', 'ftp://host/x.jpg', 'data:image/png,x']) {
      expect(safeImageUrl(value)).toBeNull();
    }
  });

  it('safeTvmazeImageUrl owns the origin policy and handles URL parser failures', () => {
    expect(safeTvmazeImageUrl('https://static.tvmaze.com/uploads/x.jpg')).toBe(
      'https://static.tvmaze.com/uploads/x.jpg',
    );
    expect(safeTvmazeImageUrl('https://static.tvmaze.com.evil.example/x.jpg')).toBeNull();
    expect(safeTvmazeImageUrl('https://[')).toBeNull();
  });

  it('getPosterUrl falls back from an invalid medium to a valid TVMaze original', () => {
    expect(
      getPosterUrl({
        image: {
          medium: 'https://attacker.example/pixel.png',
          original: 'https://static.tvmaze.com/uploads/original.jpg',
        },
      }),
    ).toBe('https://static.tvmaze.com/uploads/original.jpg');
    expect(getPosterUrl({ image: { medium: 'javascript:alert(1)', original: 'data:text/plain,x' } })).toBeNull();
  });
});

describe('HTML/text boundaries', () => {
  it('stripHtml removes closed and unclosed executable/container markup', () => {
    const cases: Array<[unknown, string]> = [
      ['<script>alert(1)', ''],
      ['<script type="text/javascript">evil()</script>safe', 'safe'],
      ['<style>body{color:red}', ''],
      ['<!-- unclosed', ''],
      ['<![CDATA[some>data]]>', ''],
      ['<![CDATA[unclosed', ''],
      ['<img title="a>b" onerror="x">safe', 'safe'],
    ];
    for (const [input, output] of cases) expect(stripHtml(input)).toBe(output);
  });

  it('stripHtml decodes known entities once and preserves unknown entities', () => {
    expect(stripHtml('&amp;lt;')).toBe('&lt;');
    expect(stripHtml('&amp;amp;lt;')).toBe('&amp;lt;');
    expect(stripHtml('&unknown;')).toBe('&unknown;');
  });

  it('escapeHtml stringifies non-null values and escapes exactly the HTML-sensitive characters', () => {
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml({})).toBe('[object Object]');
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});

describe('date boundaries', () => {
  it('parseISODateLocal handles leap years and rejects rollover/non-canonical dates', () => {
    expect(parseISODateLocal('2024-02-29')).not.toBeNull();
    for (const value of ['2100-02-29', '0000-01-01', '2024-1-1', '-0001-01-01', '2024-06-31']) {
      expect(parseISODateLocal(value)).toBeNull();
    }
  });

  it('parseISODateLocal validates every datetime component before Date parsing', () => {
    expect(parseISODateLocal('2024-02-29T23:59:59+01:00')).not.toBeNull();
    for (const value of [
      '2024-13-01T10:00:00Z',
      '2024-02-30T10:00:00Z',
      '2024-01-01T24:00:00Z',
      '2024-01-01T23:60:00Z',
      '2024-01-01T23:59:60Z',
    ]) {
      expect(parseISODateLocal(value)).toBeNull();
    }
  });

  it('localISODate rejects Invalid Date and local-day comparison does not equate invalid dates', () => {
    const invalid = new Date(NaN);
    expect(localISODate(invalid)).toBe('');
    expect(isSameLocalDay(invalid, new Date(NaN))).toBe(false);
  });

  it('formatDate has a deterministic Italian fallback when Intl formatting fails', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(() => {
      throw new Error('Intl unavailable');
    });
    try {
      expect(formatDate('2024-06-15')).toBe('15 giu 2024');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('show progress helpers', () => {
  it('getWatchedCount counts only strict boolean true across array seasons', () => {
    const show = {
      seasons: {
        1: [
          { num: 1, watched: true },
          { num: 2, watched: 'true' },
          { num: 3, watched: 1 },
          { num: 4, watched: false },
        ],
        2: 'invalid',
      },
    } as any;
    expect(getWatchedCount(show)).toBe(1);
  });

  it('getWatchedCount fails closed when season enumeration throws', () => {
    const seasons = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(getWatchedCount({ seasons } as any)).toBe(0);
  });

  it('findNextEpisode orders canonical seasons and episode numbers', () => {
    const show = {
      seasons: {
        3: [{ num: 1, watched: false, airdate: null, name: 'S3' }],
        1: [
          { num: 3, watched: false, airdate: null, name: 'third' },
          { num: 1, watched: true, airdate: null, name: 'first' },
          { num: 2, watched: false, airdate: '2024-01-01', name: 'second' },
        ],
      },
    } as any;
    expect(findNextEpisode(show)).toEqual({ season: 1, num: 2, airdate: '2024-01-01', name: 'second' });
  });

  it('findNextEpisode rejects non-canonical season aliases instead of resolving them as another key', () => {
    const show = {
      seasons: {
        1: [{ num: 1, watched: true, airdate: null, name: null }],
        '01': [{ num: 1, watched: false, airdate: null, name: 'alias' }],
      },
    } as any;
    expect(findNextEpisode(show)).toBeNull();
  });

  it('findNextEpisode skips malformed episodes and treats only boolean true as watched', () => {
    const show = {
      seasons: {
        1: [
          null,
          { num: undefined, watched: false },
          { num: NaN, watched: false },
          { num: Infinity, watched: false },
          { num: 1.5, watched: false },
          { num: 0, watched: false },
          { num: 2, watched: 'false', airdate: '', name: undefined },
        ],
      },
    } as any;
    expect(findNextEpisode(show)).toEqual({ season: 1, num: 2, airdate: null, name: null });
  });

  it('findNextEpisode skips non-array seasons and fails closed on enumeration errors', () => {
    expect(
      findNextEpisode({
        seasons: { 1: 'bad', 2: [{ num: 1, watched: false, airdate: null, name: null }] },
      } as any),
    ).toMatchObject({ season: 2, num: 1 });

    const seasons = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(findNextEpisode({ seasons } as any)).toBeNull();
  });
});
''')

probe = Path('tests/probe_utils.test.ts')
if not probe.exists():
    raise SystemExit('probe_utils.test.ts not found')
probe.unlink()
