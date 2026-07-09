// Agent A3 — probe tests for src/lib/utils.ts (round 2)
// Purpose: regression tests for bugs found in round A3.
//
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_a3.test.ts

import { describe, it, expect } from 'vitest';
import {
  safeNum,
  stripHtml,
  parseISODateLocal,
  localISODate,
  findNextEpisode,
} from '../src/lib/utils';

// ============================================================
// BUG-A3-01: localISODate(Invalid Date) → "" (was "NaN-NaN-NaN")
// ============================================================
describe('A3 BUG-A3-01: localISODate handles Invalid Date', () => {
  it('returns "" for new Date(NaN)', () => {
    expect(localISODate(new Date(NaN))).toBe('');
  });
  it('returns "" for Invalid Date constructed from bad string', () => {
    expect(localISODate(new Date('not-a-date'))).toBe('');
  });
  it('returns "" for null', () => {
    // Defensive: signature says Date, but null guard prevents throw.
    expect(localISODate(null as unknown as Date)).toBe('');
  });
  it('returns "" for undefined', () => {
    expect(localISODate(undefined as unknown as Date)).toBe('');
  });
  it('still works for valid Date', () => {
    expect(localISODate(new Date(2024, 5, 15))).toBe('2024-06-15');
  });
  it('still works at midnight and end-of-day', () => {
    expect(localISODate(new Date(2024, 5, 15, 0, 0))).toBe('2024-06-15');
    expect(localISODate(new Date(2024, 5, 15, 23, 59, 59))).toBe('2024-06-15');
  });
  it('does NOT produce "NaN-NaN-NaN" for invalid Date', () => {
    expect(localISODate(new Date(NaN))).not.toContain('NaN');
  });
});

// ============================================================
// BUG-A3-02: stripHtml — `>` inside quoted attribute no longer leaks
// ============================================================
describe('A3 BUG-A3-02: stripHtml handles `>` in quoted attribute values', () => {
  it('double-quoted: <img title="a>b">text → "text"', () => {
    expect(stripHtml('<img title="a>b">text')).toBe('text');
  });
  it('single-quoted: <img title=\'a>b\'>text → "text"', () => {
    expect(stripHtml("<img title='a>b'>text")).toBe('text');
  });
  it('nested: <a href="x>y">link</a> → "link"', () => {
    expect(stripHtml('<a href="x>y">link</a>')).toBe('link');
  });
  it('multiple attrs with > in middle one', () => {
    expect(stripHtml('<a data-x="a>b" href="ok">link</a>')).toBe('link');
  });
  it('still strips normal tags', () => {
    expect(stripHtml('<p>hello <b>world</b></p>')).toBe('hello world');
  });
  it('still strips <img onerror=...> (no quotes)', () => {
    expect(stripHtml('<img src=x onerror=alert(1)>')).toBe('');
  });
  it('still strips <img src="x" onerror="alert(1)">', () => {
    expect(stripHtml('<img src="x" onerror="alert(1)">')).toBe('');
  });
});

// ============================================================
// BUG-A3-03: stripHtml — incomplete comment stripped to end
// ============================================================
describe('A3 BUG-A3-03: stripHtml handles incomplete comments', () => {
  it('"<!-- unclosed" → ""', () => {
    expect(stripHtml('<!-- unclosed')).toBe('');
  });
  it('"text<!-- unclosed" → "text"', () => {
    expect(stripHtml('text<!-- unclosed')).toBe('text');
  });
  it('"<!-- foo -->bar<!-- baz" → "bar"', () => {
    expect(stripHtml('<!-- foo -->bar<!-- baz')).toBe('bar');
  });
  it('still strips complete comments', () => {
    expect(stripHtml('<!-- comment -->ok')).toBe('ok');
  });
  it('does NOT leak the literal "<!--" string', () => {
    expect(stripHtml('<!-- foo')).not.toContain('<!--');
  });
});

// ============================================================
// BUG-A3-04: stripHtml — incomplete CDATA stripped to end
// ============================================================
describe('A3 BUG-A3-04: stripHtml handles incomplete CDATA', () => {
  it('"<![CDATA[unclosed" → ""', () => {
    expect(stripHtml('<![CDATA[unclosed')).toBe('');
  });
  it('"text<![CDATA[unclosed" → "text"', () => {
    expect(stripHtml('text<![CDATA[unclosed')).toBe('text');
  });
  it('still strips closed CDATA with > inside', () => {
    expect(stripHtml('<![CDATA[some>data]]>')).toBe('');
  });
  it('does NOT leak the literal "<![CDATA[" string', () => {
    expect(stripHtml('<![CDATA[foo')).not.toContain('<![CDATA[');
  });
});

// ============================================================
// BUG-A3-05: parseISODateLocal rejects datetime rollover (2024-02-30T10:00)
// ============================================================
describe('A3 BUG-A3-05: parseISODateLocal rejects datetime rollover', () => {
  it('"2024-02-30T10:00:00" → null (Feb has 29 days in 2024)', () => {
    expect(parseISODateLocal('2024-02-30T10:00:00')).toBeNull();
  });
  it('"2024-02-30T10:00:00Z" → null', () => {
    expect(parseISODateLocal('2024-02-30T10:00:00Z')).toBeNull();
  });
  it('"2024-02-31T10:00:00" → null', () => {
    expect(parseISODateLocal('2024-02-31T10:00:00')).toBeNull();
  });
  it('"2024-04-31T10:00:00" → null (April has 30 days)', () => {
    expect(parseISODateLocal('2024-04-31T10:00:00')).toBeNull();
  });
  it('"2024-06-31T10:00:00" → null (June has 30 days)', () => {
    expect(parseISODateLocal('2024-06-31T10:00:00')).toBeNull();
  });
  it('"2024-09-31T10:00:00" → null (Sept has 30 days)', () => {
    expect(parseISODateLocal('2024-09-31T10:00:00')).toBeNull();
  });
  it('"2024-11-31T10:00:00" → null (Nov has 30 days)', () => {
    expect(parseISODateLocal('2024-11-31T10:00:00')).toBeNull();
  });
  it('"2100-02-29T10:00:00" → null (2100 not leap)', () => {
    expect(parseISODateLocal('2100-02-29T10:00:00')).toBeNull();
  });
  it('"2024-02-29T10:00:00" → non-null (2024 leap, valid)', () => {
    expect(parseISODateLocal('2024-02-29T10:00:00')).not.toBeNull();
  });
  it('"2024-06-15T10:30:00Z" → non-null (valid)', () => {
    expect(parseISODateLocal('2024-06-15T10:30:00Z')).not.toBeNull();
  });
  it('"2024-06-15T23:30:00-05:00" → non-null (valid offset date)', () => {
    // Edge case: this is a valid date with explicit offset near midnight.
    // The UTC moment is June 16 04:30, but the input represents June 15.
    // daysInMonth validation accepts this (15 ≤ 30).
    expect(parseISODateLocal('2024-06-15T23:30:00-05:00')).not.toBeNull();
  });
  it('"2024-12-31T23:59:59Z" → non-null (valid end of year)', () => {
    expect(parseISODateLocal('2024-12-31T23:59:59Z')).not.toBeNull();
  });
  it('"0001-01-01T00:00:00" → non-null (year 1, valid)', () => {
    expect(parseISODateLocal('0001-01-01T00:00:00')).not.toBeNull();
  });
});

// ============================================================
// BUG-A3-06: safeNum rejects hex / scientific / binary / octal strings
// ============================================================
describe('A3 BUG-A3-06: safeNum rejects non-decimal string notations', () => {
  it('"0x10" (hex) → 0', () => {
    expect(safeNum('0x10')).toBe(0);
  });
  it('"0xff" (hex 2-digit) → 0', () => {
    expect(safeNum('0xff')).toBe(0);
  });
  it('"0b101" (binary) → 0', () => {
    expect(safeNum('0b101')).toBe(0);
  });
  it('"0o17" (octal) → 0', () => {
    expect(safeNum('0o17')).toBe(0);
  });
  it('"1e3" (scientific) → 0', () => {
    expect(safeNum('1e3')).toBe(0);
  });
  it('"1E3" (scientific uppercase) → 0', () => {
    expect(safeNum('1E3')).toBe(0);
  });
  it('"1.5e10" (scientific with decimal) → 0', () => {
    expect(safeNum('1.5e10')).toBe(0);
  });
  it('"Infinity" → 0', () => {
    expect(safeNum('Infinity')).toBe(0);
  });
  it('"" empty → 0', () => {
    expect(safeNum('')).toBe(0);
  });
  it('"." lone dot → 0', () => {
    expect(safeNum('.')).toBe(0);
  });
  // Preserve existing accepted formats
  it('"5" → 5 (preserved)', () => {
    expect(safeNum('5')).toBe(5);
  });
  it('"3.14" → 3.14 (preserved)', () => {
    expect(safeNum('3.14')).toBe(3.14);
  });
  it('"0" → 0 (preserved)', () => {
    expect(safeNum('0')).toBe(0);
  });
  it('"  5  " → 5 (whitespace preserved)', () => {
    expect(safeNum('  5  ')).toBe(5);
  });
  it('"-0" → +0 (preserved)', () => {
    const r = safeNum('-0');
    expect(Object.is(r, 0)).toBe(true);
    expect(Object.is(r, -0)).toBe(false);
  });
  it('"5px" → 0 (preserved)', () => {
    expect(safeNum('5px')).toBe(0);
  });
  it('number inputs unaffected (2000 → 2000)', () => {
    expect(safeNum(2000)).toBe(2000);
  });
  it('number inputs unaffected (3.14 → 3.14)', () => {
    expect(safeNum(3.14)).toBe(3.14);
  });
});

// ============================================================
// BUG-A3-07: findNextEpisode rejects non-integer / NaN / Infinity / string num
// ============================================================
describe('A3 BUG-A3-07: findNextEpisode validates ep.num strictly', () => {
  it('rejects ep with num=undefined (skip, look at next valid)', () => {
    const show: any = {
      seasons: { 1: [{ id: 1, num: undefined, watched: false }] },
    };
    // No valid ep → null
    expect(findNextEpisode(show)).toBeNull();
  });
  it('rejects ep with num=NaN', () => {
    const show: any = {
      seasons: { 1: [{ id: 1, num: NaN, watched: false }] },
    };
    expect(findNextEpisode(show)).toBeNull();
  });
  it('rejects ep with num=Infinity', () => {
    const show: any = {
      seasons: { 1: [{ id: 1, num: Infinity, watched: false }] },
    };
    expect(findNextEpisode(show)).toBeNull();
  });
  it('rejects ep with num=1.5 (float)', () => {
    const show: any = {
      seasons: { 1: [{ id: 1, num: 1.5, watched: false }] },
    };
    expect(findNextEpisode(show)).toBeNull();
  });
  it('rejects ep with num="2" (string)', () => {
    const show: any = {
      seasons: { 1: [{ id: 1, num: '2', watched: false }] },
    };
    expect(findNextEpisode(show)).toBeNull();
  });
  it('rejects ep with num=null', () => {
    const show: any = {
      seasons: { 1: [{ id: 1, num: null, watched: false }] },
    };
    expect(findNextEpisode(show)).toBeNull();
  });
  it('skips invalid num ep, finds next valid non-watched', () => {
    // Mixed array: NaN first, then valid 2, then valid 1.
    // Robust sort should put valid 1 before valid 2, NaN at end.
    const show: any = {
      seasons: {
        1: [
          { id: 1, num: NaN, watched: false },
          { id: 2, num: 2, watched: false },
          { id: 3, num: 1, watched: false },
        ],
      },
    };
    const r = findNextEpisode(show);
    expect(r).not.toBeNull();
    expect(r!.num).toBe(1); // smallest valid, not 2
  });
  it('skips invalid num ep, finds next valid when invalid interleaved', () => {
    // Original order: NaN, 2, NaN, 1, NaN
    // Naive sort (NaN=0) would keep order [NaN, 2, NaN, 1, NaN] → returns 2 (BUG).
    // Robust sort puts invalid at end → [1, 2, NaN, NaN, NaN] → returns 1.
    const show: any = {
      seasons: {
        1: [
          { id: 1, num: NaN, watched: false },
          { id: 2, num: 2, watched: false },
          { id: 3, num: NaN, watched: false },
          { id: 4, num: 1, watched: false },
          { id: 5, num: NaN, watched: false },
        ],
      },
    };
    const r = findNextEpisode(show);
    expect(r).not.toBeNull();
    expect(r!.num).toBe(1);
  });
  it('still returns valid ep when only valid eps exist', () => {
    const show: any = {
      seasons: { 1: [{ id: 1, num: 1, watched: false }] },
    };
    expect(findNextEpisode(show)?.num).toBe(1);
  });
  it('still skips watched valid eps', () => {
    const show: any = {
      seasons: {
        1: [
          { id: 1, num: 1, watched: true },
          { id: 2, num: 2, watched: false },
        ],
      },
    };
    expect(findNextEpisode(show)?.num).toBe(2);
  });
  it('return type contract: num is always a number (never undefined/NaN)', () => {
    const show: any = {
      seasons: {
        1: [
          { id: 1, num: undefined, watched: false },
          { id: 2, num: 'bad', watched: false },
          { id: 3, num: 5, watched: false },
        ],
      },
    };
    const r = findNextEpisode(show);
    expect(r).not.toBeNull();
    expect(typeof r!.num).toBe('number');
    expect(Number.isFinite(r!.num)).toBe(true);
    expect(Number.isInteger(r!.num)).toBe(true);
  });
});

// ============================================================
// Cross-check: existing functions still pass basic smoke tests
// ============================================================
describe('A3 smoke: no regression on adjacent behaviors', () => {
  it('stripHtml still decodes entities', () => {
    expect(stripHtml('&amp;&lt;&gt;&quot;&#39;')).toBe('&<>"\'');
  });
  it('stripHtml still handles script content removal', () => {
    expect(stripHtml('<script>alert(1)</script>safe')).toBe('safe');
  });
  it('parseISODateLocal still accepts valid date-only', () => {
    const d = parseISODateLocal('2024-06-15');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2024);
    expect(d!.getMonth()).toBe(5);
    expect(d!.getDate()).toBe(15);
  });
  it('parseISODateLocal still rejects date-only rollover', () => {
    expect(parseISODateLocal('2024-02-30')).toBeNull();
    expect(parseISODateLocal('2024-13-01')).toBeNull();
  });
  it('localISODate round-trips via parseISODateLocal for valid date', () => {
    const d = new Date(2024, 5, 15, 10, 30);
    const s = localISODate(d);
    expect(s).toBe('2024-06-15');
    expect(parseISODateLocal(s)).not.toBeNull();
  });
});
