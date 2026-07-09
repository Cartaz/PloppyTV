// Agent 01 — probe tests for src/lib/utils.ts
// Purpose: empirically verify edge-case hypotheses for safeId, safeNum,
// safeImageUrl, stripHtml, parseISODateLocal, localISODate, isSameLocalDay,
// formatDate, escapeHtml, escapeAttr, getPosterUrl, getWatchedCount,
// findNextEpisode.
//
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_utils.test.ts

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
  getWatchedCount,
  findNextEpisode,
} from '../src/lib/utils';

// ===================== safeId =====================
describe('PROBE safeId', () => {
  it('MAX_SAFE_INTEGER accepted; +1 rejected', () => {
    expect(safeId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(safeId(Number.MAX_SAFE_INTEGER + 1)).toBe(0);
  });

  it('"0" -> 0', () => {
    expect(safeId('0')).toBe(0);
  });

  it('negative ints -> 0 (number and string)', () => {
    expect(safeId(-5)).toBe(0);
    expect(safeId('-5')).toBe(0);
  });

  it('Symbol() -> 0 (FIXED: typeof symbol guard)', () => {
    // BUG-01-h fixed: safeId now rejects symbol explicitly instead of throwing.
    expect(safeId(Symbol('x'))).toBe(0);
  });

  it('function -> 0', () => {
    expect(safeId(() => 1)).toBe(0);
  });

  it('BigInt rejected -> 0 (FIXED: typeof bigint guard)', () => {
    // BUG-01-i fixed: BigInt is a distinct primitive, rejected per doc.
    expect(safeId(BigInt(42))).toBe(0);
    expect(safeId(BigInt(Number.MAX_SAFE_INTEGER))).toBe(0);
    expect(safeId(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe(0);
  });

  it('"007" -> 7 (leading zeros accepted)', () => {
    expect(safeId('007')).toBe(7);
  });

  it('" 5 " (whitespace) -> 0 (regex strict)', () => {
    expect(safeId(' 5 ')).toBe(0);
  });

  it('"  " whitespace-only -> 0', () => {
    expect(safeId('  ')).toBe(0);
  });

  it('"+5" -> 0 (plus sign rejected)', () => {
    expect(safeId('+5')).toBe(0);
  });

  it('"-0" -> 0', () => {
    expect(safeId('-0')).toBe(0);
  });

  it('Infinity / NaN -> 0', () => {
    expect(safeId(Infinity)).toBe(0);
    expect(safeId(NaN)).toBe(0);
  });

  it('boolean / array / object -> 0', () => {
    expect(safeId(true)).toBe(0);
    expect(safeId(false)).toBe(0);
    expect(safeId([])).toBe(0);
    expect(safeId([1])).toBe(0);
    expect(safeId({})).toBe(0);
  });
});

// ===================== safeNum =====================
describe('PROBE safeNum', () => {
  it('true -> 0 (FIXED: boolean rejected, consistent with safeId)', () => {
    // BUG-01-e fixed: boolean guard added.
    expect(safeNum(true)).toBe(0);
  });

  it('false -> 0', () => {
    expect(safeNum(false)).toBe(0);
  });

  it('[5] -> 0 (FIXED: array rejected)', () => {
    // BUG-01-e fixed: array guard added.
    expect(safeNum([5])).toBe(0);
  });

  it('[1,2] -> 0 (multi-element array -> NaN)', () => {
    expect(safeNum([1, 2])).toBe(0);
  });

  it('[] -> 0', () => {
    expect(safeNum([])).toBe(0);
  });

  it('"  5  " (whitespace) -> 5 (inconsistent with safeId)', () => {
    expect(safeNum('  5  ')).toBe(5);
  });

  it('"5px" -> 0', () => {
    expect(safeNum('5px')).toBe(0);
  });

  it('-0 -> +0 (FIXED: normalized to positive zero)', () => {
    // BUG-01-j fixed: -0 normalized to +0.
    const r = safeNum(-0);
    expect(Object.is(r, 0)).toBe(true);
    expect(Object.is(r, -0)).toBe(false);
  });

  it('"-0" -> +0 (FIXED: normalized to positive zero)', () => {
    // BUG-01-j fixed: string '-0' also normalized to +0.
    const r = safeNum('-0');
    expect(Object.is(r, 0)).toBe(true);
    expect(Object.is(r, -0)).toBe(false);
  });

  it('null / undefined -> 0', () => {
    expect(safeNum(null)).toBe(0);
    expect(safeNum(undefined)).toBe(0);
  });

  it('{} -> 0', () => {
    expect(safeNum({})).toBe(0);
  });

  it('Infinity -> 0', () => {
    expect(safeNum(Infinity)).toBe(0);
  });

  it('NaN -> 0', () => {
    expect(safeNum(NaN)).toBe(0);
  });

  it('negatives -> 0', () => {
    expect(safeNum(-1)).toBe(0);
    expect(safeNum('-5')).toBe(0);
  });
});

// ===================== safeImageUrl =====================
describe('PROBE safeImageUrl', () => {
  it('"HTTPS://" uppercase accepted (regex is /i)', () => {
    expect(safeImageUrl('HTTPS://example.com/x.jpg')).toBe('HTTPS://example.com/x.jpg');
  });

  it('"Http://" mixed case accepted', () => {
    expect(safeImageUrl('Http://example.com/x.jpg')).toBe('Http://example.com/x.jpg');
  });

  it('length 2048 accepted; 2049 rejected', () => {
    const base = 'http://x/';
    const u2048 = base + 'a'.repeat(2048 - base.length);
    expect(u2048.length).toBe(2048);
    expect(safeImageUrl(u2048)).toBe(u2048);

    const u2049 = base + 'a'.repeat(2049 - base.length);
    expect(u2049.length).toBe(2049);
    expect(safeImageUrl(u2049)).toBeNull();
  });

  it('"http://" no host rejected (FIXED: host validation)', () => {
    // BUG-01-k fixed: regex requires at least one non-space/non-slash char after ://.
    expect(safeImageUrl('http://')).toBeNull();
    expect(safeImageUrl('https://')).toBeNull();
    expect(safeImageUrl('http://x')).toBe('http://x');
  });

  it('trailing newline not stripped (BUG: no whitespace trim)', () => {
    expect(safeImageUrl('http://x.com/a.jpg\n')).toBe('http://x.com/a.jpg\n');
  });

  it('"data:" blocked', () => {
    expect(safeImageUrl('data:image/png;base64,xxx')).toBeNull();
  });

  it('"javascript:" blocked', () => {
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
  });

  it('relative "/path" blocked', () => {
    expect(safeImageUrl('/path')).toBeNull();
  });

  it('protocol-relative "//host" blocked', () => {
    expect(safeImageUrl('//host/x.jpg')).toBeNull();
  });

  it('"ftp://" blocked', () => {
    expect(safeImageUrl('ftp://host/x.jpg')).toBeNull();
  });

  it('non-string -> null', () => {
    expect(safeImageUrl(null)).toBeNull();
    expect(safeImageUrl(undefined)).toBeNull();
    expect(safeImageUrl(123)).toBeNull();
    expect(safeImageUrl({})).toBeNull();
  });
});

// ===================== stripHtml =====================
describe('PROBE stripHtml', () => {
  it('UNCLOSED <script> stripped to end (FIXED)', () => {
    // BUG-01-a fixed: unclosed <script> stripped to end of string.
    expect(stripHtml('<script>alert(1)')).toBe('');
  });

  it('UNCLOSED <script> with attributes stripped to end (FIXED)', () => {
    // BUG-01-a fixed.
    expect(stripHtml('<script type="text/javascript">evil()')).toBe('');
  });

  it('<script> with attributes (closed) works', () => {
    expect(stripHtml('<script type="text/javascript">alert(1)</script>safe')).toBe('safe');
  });

  it('UNCLOSED <style> stripped to end (FIXED)', () => {
    // BUG-01-a fixed.
    expect(stripHtml('<style>body{color:red}')).toBe('');
  });

  it('nested / sequential <script>...</script> removed', () => {
    expect(stripHtml('<script>a</script><script>b</script>safe')).toBe('safe');
  });

  it('double-encoded entity &amp;lt; single-pass decoded to "&lt;" (FIXED)', () => {
    // BUG-01-b fixed: single-pass regex decode; &amp; -> &, then 'lt;' has no & prefix, untouched.
    expect(stripHtml('&amp;lt;')).toBe('&lt;');
  });

  it('triple-encoded &amp;amp;lt; single-pass decoded -> "&amp;lt;"', () => {
    // Single-pass regex doesn't re-scan replaced text; both &amp; and &lt;
    // are matched in one pass on disjoint positions.
    // Input:  &amp; a m p ; l t ;   (positions 0-4 is &amp;, 5-8 is 'amp;', 9-11 is 'lt;')
    // Wait: &amp;amp;lt; = &amp;(0-4) + amp;(5-8) + lt;(9-11). Only &amp; matches.
    // Result: & + amp;lt; = &amp;lt;
    expect(stripHtml('&amp;amp;lt;')).toBe('&amp;lt;');
  });

  it('&unknown; preserved', () => {
    expect(stripHtml('&unknown;')).toBe('&unknown;');
  });

  it('HTML comments stripped', () => {
    expect(stripHtml('<!-- comment -->ok')).toBe('ok');
  });

  it('<img onerror=...> tag stripped (no JS content leaks)', () => {
    expect(stripHtml('<img src=x onerror=alert(1)>')).toBe('');
  });

  it('CDATA with > inside stripped entirely (FIXED)', () => {
    // BUG-01-l fixed: CDATA sections stripped before tag-strip.
    expect(stripHtml('<![CDATA[some>data]]>')).toBe('');
  });

  it('emoji preserved', () => {
    expect(stripHtml('<p>😀</p>')).toBe('😀');
  });

  it('null / undefined -> ""', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });

  it('0 -> "" (falsy short-circuit)', () => {
    expect(stripHtml(0)).toBe('');
  });

  it('"0" (string) -> "0"', () => {
    expect(stripHtml('0')).toBe('0');
  });

  it('number 123 -> "123"', () => {
    expect(stripHtml(123)).toBe('123');
  });
});

// ===================== parseISODateLocal =====================
describe('PROBE parseISODateLocal', () => {
  it('"2024-02-30" reject (rollover)', () => {
    expect(parseISODateLocal('2024-02-30')).toBeNull();
  });

  it('"2024-13-01" reject', () => {
    expect(parseISODateLocal('2024-13-01')).toBeNull();
  });

  it('"0000-01-01" reject (year 0 maps to 1900 in Date ctor)', () => {
    // new Date(0, 0, 1) -> Jan 1 1900; getFullYear()=1900 != 0
    expect(parseISODateLocal('0000-01-01')).toBeNull();
  });

  it('"2024-00-01" reject', () => {
    expect(parseISODateLocal('2024-00-01')).toBeNull();
  });

  it('"2024-02-29" leap accepted', () => {
    expect(parseISODateLocal('2024-02-29')).not.toBeNull();
  });

  it('"2100-02-29" not leap rejected', () => {
    expect(parseISODateLocal('2100-02-29')).toBeNull();
  });

  it('"2024-1-1" (no padding) rejected (FIXED: strict YYYY-MM-DD or ISO datetime only)', () => {
    // With the strict fallback, '2024-1-1' matches neither YYYY-MM-DD nor the
    // ISO datetime regex -> null (previously V8 parsed it as 2024-01-01).
    expect(parseISODateLocal('2024-1-1')).toBeNull();
  });

  it('"2024-01-01T00:00:00Z" accepted (Date fallback)', () => {
    const r = parseISODateLocal('2024-01-01T00:00:00Z');
    expect(r).not.toBeNull();
  });

  it('"2024-01-01T25:00:00" rejected (bad hour)', () => {
    expect(parseISODateLocal('2024-01-01T25:00:00')).toBeNull();
  });

  it('negative-year string rejected (FIXED: strict ISO fallback)', () => {
    // BUG-01-c fixed: fallback now only accepts strict ISO 8601 datetime with
    // 4-digit year; '-0001-01-01' doesn't match either regex -> null.
    expect(parseISODateLocal('-0001-01-01')).toBeNull();
  });

  it('"2024-06-31" rejected (June has 30 days)', () => {
    expect(parseISODateLocal('2024-06-31')).toBeNull();
  });

  it('"2024-06-15" yields local 2024-06-15', () => {
    const d = parseISODateLocal('2024-06-15');
    expect(d!.getFullYear()).toBe(2024);
    expect(d!.getMonth()).toBe(5);
    expect(d!.getDate()).toBe(15);
  });
});

// ===================== localISODate / isSameLocalDay =====================
describe('PROBE localISODate + isSameLocalDay', () => {
  it('midnight produces correct ISO', () => {
    expect(localISODate(new Date(2024, 5, 15, 0, 0))).toBe('2024-06-15');
  });

  it('end-of-day produces same ISO', () => {
    expect(localISODate(new Date(2024, 5, 15, 23, 59, 59))).toBe('2024-06-15');
  });

  it('isSameLocalDay true/false as expected', () => {
    const a = new Date(2024, 5, 15, 0, 0);
    const b = new Date(2024, 5, 15, 23, 59);
    const c = new Date(2024, 5, 16, 0, 0);
    expect(isSameLocalDay(a, b)).toBe(true);
    expect(isSameLocalDay(a, c)).toBe(false);
  });

  it('isSameLocalDay with Invalid Date returns false (NaN !== NaN)', () => {
    const a = new Date(NaN);
    const b = new Date(NaN);
    expect(isSameLocalDay(a, b)).toBe(false);
  });
});

// ===================== formatDate =====================
describe('PROBE formatDate', () => {
  it('null -> N/D', () => {
    expect(formatDate(null)).toBe('N/D');
  });

  it('"" -> N/D', () => {
    expect(formatDate('')).toBe('N/D');
  });

  it('"invalid" -> N/D', () => {
    expect(formatDate('invalid')).toBe('N/D');
  });

  it('"2024-02-30" -> N/D (rollover reject)', () => {
    expect(formatDate('2024-02-30')).toBe('N/D');
  });

  it('"2024-13-40" -> N/D', () => {
    expect(formatDate('2024-13-40')).toBe('N/D');
  });

  it('"2024-06-15" produces formatted Italian output', () => {
    const out = formatDate('2024-06-15');
    // eslint-disable-next-line no-console
    console.log('  formatDate("2024-06-15") ->', JSON.stringify(out));
    expect(out).not.toBe('N/D');
  });

  it('"2024-06-15" fallback path does not produce pure-digit string', () => {
    const out = formatDate('2024-06-15');
    expect(/^\d+$/.test(out)).toBe(false);
  });
});

// ===================== escapeHtml / escapeAttr =====================
describe('PROBE escapeHtml + escapeAttr', () => {
  it('null -> ""', () => {
    expect(escapeHtml(null)).toBe('');
  });

  it('undefined -> ""', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  it('number 123 -> "123"', () => {
    expect(escapeHtml(123)).toBe('123');
  });

  it('0 -> "0" (NOT falsy-short-circuited)', () => {
    expect(escapeHtml(0)).toBe('0');
  });

  it('object -> "[object Object]"', () => {
    expect(escapeHtml({})).toBe('[object Object]');
  });

  it('already-escaped "&amp;" double-escapes to "&amp;amp;" (by design)', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('backtick preserved (not escaped)', () => {
    expect(escapeHtml('`code`')).toBe('`code`');
  });

  it('emoji preserved', () => {
    expect(escapeHtml('😀')).toBe('😀');
  });

  it('escapeAttr is alias of escapeHtml', () => {
    expect(escapeAttr('<>&"\'')).toBe(escapeHtml('<>&"\''));
  });

  it('long string handled without throw', () => {
    const s = '<a>'.repeat(10000);
    const r = escapeHtml(s);
    // each '<a>' (3 chars) -> '&lt;a&gt;' (9 chars); 9 * 10000 = 90000
    expect(r.length).toBe(90000);
    expect(r.startsWith('&lt;a&gt;')).toBe(true);
  });
});

// ===================== getPosterUrl =====================
describe('PROBE getPosterUrl', () => {
  it('image null', () => {
    expect(getPosterUrl({ image: null })).toBeNull();
  });

  it('image {}', () => {
    expect(getPosterUrl({ image: {} })).toBeNull();
  });

  it('image {medium:null, original:"http://x"} -> "http://x"', () => {
    // BUG-01-d fixed: getPosterUrl now validates via safeImageUrl; use valid URL.
    expect(getPosterUrl({ image: { medium: null, original: 'http://x' } as any })).toBe('http://x');
  });

  it('image {medium:"", original:"http://y"} -> "http://y" (empty string falls back)', () => {
    // BUG-01-d fixed: getPosterUrl validates; use valid URL for original.
    expect(getPosterUrl({ image: { medium: '', original: 'http://y' } })).toBe('http://y');
  });

  it('image {medium:"http://x", original:null} -> "http://x"', () => {
    expect(getPosterUrl({ image: { medium: 'http://x', original: null } as any })).toBe('http://x');
  });

  it('image {medium:"javascript:alert(1)"} -> null (FIXED: scheme validation)', () => {
    // BUG-01-d fixed: getPosterUrl wraps with safeImageUrl; javascript: blocked.
    expect(getPosterUrl({ image: { medium: 'javascript:alert(1)' } })).toBeNull();
  });

  it('image {medium:"data:x"} -> null (FIXED: data: blocked)', () => {
    // BUG-01-d fixed: getPosterUrl wraps with safeImageUrl; data: blocked.
    expect(getPosterUrl({ image: { medium: 'data:text/html,<script>' } })).toBeNull();
  });

  it('show null -> null', () => {
    expect(getPosterUrl(null)).toBeNull();
  });

  it('show with no image field -> null', () => {
    expect(getPosterUrl({} as any)).toBeNull();
  });
});

// ===================== getWatchedCount =====================
describe('PROBE getWatchedCount', () => {
  it('seasons is array -> 0', () => {
    expect(getWatchedCount({ seasons: [] as any })).toBe(0);
  });

  it('null show -> 0', () => {
    expect(getWatchedCount(null)).toBe(0);
  });

  it('seasons null -> 0', () => {
    expect(getWatchedCount({ seasons: null as any })).toBe(0);
  });

  it('seasons with non-array value -> 0', () => {
    expect(getWatchedCount({ seasons: { 1: 'nope' as any } })).toBe(0);
  });

  it('episode watched field missing -> not counted', () => {
    expect(getWatchedCount({ seasons: { 1: [{ id: 1, num: 1 }] as any } })).toBe(0);
  });

  it('episode watched="true" (string) -> NOT counted (FIXED: strict === true)', () => {
    // BUG-01-f fixed: only boolean true counts.
    expect(getWatchedCount({ seasons: { 1: [{ id: 1, num: 1, watched: 'true' as any }] as any } })).toBe(0);
  });

  it('episode watched="false" (string) -> NOT counted (FIXED: strict === true)', () => {
    // BUG-01-f fixed: truthy string no longer counts.
    expect(getWatchedCount({ seasons: { 1: [{ id: 1, num: 1, watched: 'false' as any }] as any } })).toBe(0);
  });

  it('episode watched=1 (number) -> NOT counted (FIXED: strict === true)', () => {
    // BUG-01-f fixed: truthy number no longer counts.
    expect(getWatchedCount({ seasons: { 1: [{ id: 1, num: 1, watched: 1 as any }] as any } })).toBe(0);
  });

  it('episode watched=0 -> not counted', () => {
    expect(getWatchedCount({ seasons: { 1: [{ id: 1, num: 1, watched: 0 as any }] as any } })).toBe(0);
  });

  it('episode watched=null -> not counted', () => {
    expect(getWatchedCount({ seasons: { 1: [{ id: 1, num: 1, watched: null as any }] as any } })).toBe(0);
  });

  it('circular ref in seasons -> 0 (no throw)', () => {
    const obj: any = { seasons: { 1: [] } };
    obj.seasons[1].push(obj);
    expect(() => getWatchedCount(obj)).not.toThrow();
    expect(getWatchedCount(obj)).toBe(0);
  });
});

// ===================== findNextEpisode =====================
describe('PROBE findNextEpisode', () => {
  it('unsorted season keys sorted numerically', () => {
    const show: any = {
      seasons: {
        3: [{ id: 31, num: 1, watched: false }],
        1: [{ id: 11, num: 1, watched: true }],
        2: [{ id: 21, num: 1, watched: false }],
      },
    };
    expect(findNextEpisode(show)?.season).toBe(2);
  });

  it('episodes unsorted by num -> sorted', () => {
    const show: any = {
      seasons: {
        1: [
          { id: 13, num: 3, watched: false },
          { id: 11, num: 1, watched: true },
          { id: 12, num: 2, watched: false },
        ],
      },
    };
    expect(findNextEpisode(show)?.num).toBe(2);
  });

  it('season "0" key filtered', () => {
    const show: any = {
      seasons: {
        0: [{ id: 1, num: 1, watched: false }],
        1: [{ id: 2, num: 1, watched: false }],
      },
    };
    expect(findNextEpisode(show)?.season).toBe(1);
  });

  it('season "-1" key filtered', () => {
    const show: any = {
      seasons: {
        '-1': [{ id: 1, num: 1, watched: false }],
        1: [{ id: 2, num: 1, watched: false }],
      },
    };
    expect(findNextEpisode(show)?.season).toBe(1);
  });

  it('season key "1.5" rejected (FIXED: strict integer key filter)', () => {
    // BUG-01-m fixed: non-integer keys filtered out; "1.5" no longer collides with "1".
    // Season 1 episode is watched; season "1.5" is filtered out; result is null.
    const show: any = {
      seasons: {
        '1': [{ id: 11, num: 1, watched: true }],
        '1.5': [{ id: 21, num: 1, watched: false }],
      },
    };
    expect(findNextEpisode(show)).toBeNull();
  });

  it('episode num 0 skipped (FIXED: num > 0 filter)', () => {
    // BUG-01-g fixed: episodes with num <= 0 are skipped.
    const show: any = {
      seasons: { 1: [{ id: 1, num: 0, watched: false }] },
    };
    expect(findNextEpisode(show)).toBeNull();
  });

  it('all watched -> null', () => {
    const show: any = {
      seasons: { 1: [{ id: 1, num: 1, watched: true }] },
    };
    expect(findNextEpisode(show)).toBeNull();
  });

  it('null show -> null', () => {
    expect(findNextEpisode(null)).toBeNull();
  });

  it('empty seasons -> null', () => {
    expect(findNextEpisode({ seasons: {} } as any)).toBeNull();
  });

  it('episode watched="false" (string) treated as UNWATCHED (FIXED)', () => {
    // BUG-01-f fixed: strict !== true check; truthy string "false" is unwatched.
    const show: any = {
      seasons: { 1: [{ id: 1, num: 1, watched: 'false' as any }] },
    };
    expect(findNextEpisode(show)?.num).toBe(1);
  });

  it('episode watched=0 (number) treated as unwatched (correct)', () => {
    const show: any = {
      seasons: { 1: [{ id: 1, num: 1, watched: 0 as any }] },
    };
    expect(findNextEpisode(show)?.num).toBe(1);
  });

  it('seasons is array -> null', () => {
    expect(findNextEpisode({ seasons: [] } as any)).toBeNull();
  });

  it('circular ref in seasons -> null (no throw)', () => {
    const obj: any = { seasons: { 1: [] } };
    obj.seasons[1].push(obj);
    expect(() => findNextEpisode(obj)).not.toThrow();
  });
});
