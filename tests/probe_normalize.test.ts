// Agent 02 probe: stress-test normalize.ts edge cases
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_normalize.test.ts

import { describe, it, expect } from 'vitest';
import { normalizeShow, buildShowFromTvmaze, reconcileAllLists } from '../src/lib/normalize';
import { updateShowListStatus } from '../src/lib/store';
import { makeShow, makeShowWithSeasons, markWatchedFirst } from './helpers';
import type { TvmazeEpisode, TvmazeShow } from '../src/types';

describe('PROBE normalizeShow — id edge cases', () => {
  it('id 0 → null', () => {
    expect(normalizeShow({ id: 0 })).toBeNull();
  });
  it('id negative → null', () => {
    expect(normalizeShow({ id: -5 })).toBeNull();
  });
  it('id "abc" → null', () => {
    expect(normalizeShow({ id: 'abc' })).toBeNull();
  });
  it('id true → null (safeId rejects boolean)', () => {
    expect(normalizeShow({ id: true })).toBeNull();
  });
  it('id false → null', () => {
    expect(normalizeShow({ id: false })).toBeNull();
  });
});

describe('PROBE normalizeShow — name HTML stripped (BUG-02-08 FIXED)', () => {
  it('name with <script> is stripHtml\'d (script tag+content removed, text kept)', () => {
    const out = normalizeShow({ id: 1, name: '<script>alert(1)</script>Show' });
    expect(out).not.toBeNull();
    // stripHtml removes the <script> tag AND its content, leaving 'Show'
    expect(out!.name).toBe('Show');
  });
  it('summary IS stripHtml\'d (consistent with name)', () => {
    const out = normalizeShow({ id: 1, summary: '<script>alert(1)</script>hello' });
    expect(out!.summary).toBe('hello');
  });
  it('status and network are also stripHtml\'d', () => {
    const out = normalizeShow({
      id: 1,
      status: '<b>Running</b>',
      network: '<i>HBO</i>',
    });
    expect(out!.status).toBe('Running');
    expect(out!.network).toBe('HBO');
  });
});

describe('PROBE normalizeShow — seasons key collisions', () => {
  it('keys "1" and "01" both map to season 1 → second overwrites first (DATA LOSS)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: {
        '1': [{ num: 1, id: 11 }, { num: 2, id: 12 }],
        '01': [{ num: 1, id: 21 }, { num: 2, id: 22 }, { num: 3, id: 23 }],
      },
    });
    expect(out).not.toBeNull();
    // Both keys coerce to Number 1 — last assignment wins
    expect(out!.seasons[1].length).toBe(3); // last (the '01' array) wins
    expect(out!.seasons[1][0].id).toBe(21);
    // The first array (2 episodes) is silently lost
    expect(out!.totalEpisodes).toBe(3);
  });
  it('key " 1 " (whitespace) → safeId rejects (regex ^-?\d+$ fails) → skipped (BUG-02-07 FIXED)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { ' 1 ': [{ num: 1, id: 11 }] },
    });
    expect(out).not.toBeNull();
    expect(Object.keys(out!.seasons)).toEqual([]);
  });
  it('key "1.5" → Number=1.5 not integer → skipped', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { '1.5': [{ num: 1, id: 11 }] },
    });
    expect(out).not.toBeNull();
    expect(Object.keys(out!.seasons)).toEqual([]);
  });
  it('key "abc" → NaN not integer → skipped', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { abc: [{ num: 1, id: 11 }] },
    });
    expect(out).not.toBeNull();
    expect(Object.keys(out!.seasons)).toEqual([]);
  });
  it('key "0" or "-1" → integer but not >0 → skipped', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { '0': [{ num: 1, id: 11 }], '-1': [{ num: 1, id: 21 }] },
    });
    expect(out).not.toBeNull();
    expect(Object.keys(out!.seasons)).toEqual([]);
  });
  it('seasons null → no seasons, totalEpisodes 0', () => {
    const out = normalizeShow({ id: 1, seasons: null });
    expect(out).not.toBeNull();
    expect(out!.seasons).toEqual({});
    expect(out!.totalEpisodes).toBe(0);
  });
  it('seasons as array → ignored', () => {
    const out = normalizeShow({ id: 1, seasons: [{ num: 1 }] });
    expect(out).not.toBeNull();
    expect(out!.seasons).toEqual({});
  });
});

describe('PROBE normalizeShow — episode edge cases', () => {
  it('episode num 0 → filtered (ep.num>0)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 0, id: 11 }] },
    });
    expect(out!.seasons[1]).toEqual([]);
  });
  it('episode num "abc" → safeId=0 → filtered', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 'abc', id: 11 }] },
    });
    expect(out!.seasons[1]).toEqual([]);
  });
  it('episode id missing → safeId=0 (kept, episode still in array)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1 }] },
    });
    expect(out!.seasons[1].length).toBe(1);
    expect(out!.seasons[1][0].id).toBe(0);
  });
  it('episode watched="true" (string) → !! → true', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: 'true' }] },
    });
    expect(out!.seasons[1][0].watched).toBe(true);
  });
  it('episode watched=1 → !! → true', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, watched: 1 }] },
    });
    expect(out!.seasons[1][0].watched).toBe(true);
  });
  it('episode airdate "2024-13-40" REJECTED by parseISODateLocal (BUG-02-02 FIXED)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, airdate: '2024-13-40' }] },
    });
    // parseISODateLocal rejects month 13 → null
    expect(out!.seasons[1][0].airdate).toBeNull();
  });
  it('episode airdate "2024-02-30" (Feb 30, invalid) REJECTED (BUG-02-02 FIXED)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, airdate: '2024-02-30' }] },
    });
    expect(out!.seasons[1][0].airdate).toBeNull();
  });
  it('premiered "2024-13-40" REJECTED (BUG-02-02 FIXED)', () => {
    const out = normalizeShow({ id: 1, premiered: '2024-13-40' });
    expect(out!.premiered).toBeNull();
  });
  it('compare: parseISODateLocal correctly REJECTS "2024-13-40"', async () => {
    const { parseISODateLocal } = await import('../src/lib/utils');
    expect(parseISODateLocal('2024-13-40')).toBeNull();
  });
  it('episode airdate "2024-06-15" → valid', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, airdate: '2024-06-15' }] },
    });
    expect(out!.seasons[1][0].airdate).toBe('2024-06-15');
  });
  it('episode name not string → null', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, name: 123 }] },
    });
    expect(out!.seasons[1][0].name).toBeNull();
  });
  it('episode runtime 0/negative → null', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11, runtime: 0 }, { num: 2, id: 12, runtime: -5 }] },
    });
    expect(out!.seasons[1][0].runtime).toBeNull();
    expect(out!.seasons[1][1].runtime).toBeNull();
  });
});

describe('PROBE normalizeShow — totalEpisodes / totalSeasons always recomputed (BUG-02-06 FIXED)', () => {
  it('totalEpisodes negative string → recompute from seasons', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11 }, { num: 2, id: 12 }] },
      totalEpisodes: '-5',
    });
    expect(out!.totalEpisodes).toBe(2); // recomputed
  });
  it('totalEpisodes NaN → recompute from seasons', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11 }, { num: 2, id: 12 }] },
      totalEpisodes: NaN,
    });
    expect(out!.totalEpisodes).toBe(2);
  });
  it('totalEpisodes=5 but actual 10 → RECOMPUTED to 10 (BUG-02-06 FIXED)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: Array.from({ length: 10 }, (_, i) => ({ num: i + 1, id: i + 1 })) },
      totalEpisodes: 5,
    });
    expect(out!.totalEpisodes).toBe(10); // FIXED: always recomputed
    expect(Object.values(out!.seasons).reduce((s, e) => s + e.length, 0)).toBe(10);
  });
  it('totalEpisodes as float 5.7 with no seasons → recompute to 0', () => {
    const out = normalizeShow({
      id: 1,
      seasons: {},
      totalEpisodes: 5.7,
    });
    expect(out!.totalEpisodes).toBe(0); // FIXED: empty seasons → 0
  });
  it('totalSeasons=2 but actual 1 → RECOMPUTED to 1 (BUG-02-06 FIXED)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1, id: 11 }] },
      totalSeasons: 2,
    });
    expect(out!.totalSeasons).toBe(1); // FIXED: recomputed
    expect(Object.keys(out!.seasons).length).toBe(1);
  });
});

describe('PROBE normalizeShow — genres', () => {
  it('genres not array → []', () => {
    expect(normalizeShow({ id: 1, genres: 'drama' })!.genres).toEqual([]);
    expect(normalizeShow({ id: 1, genres: null })!.genres).toEqual([]);
  });
  it('genres dupes removed, empty filtered, non-string filtered', () => {
    const out = normalizeShow({
      id: 1,
      genres: ['Drama', 'Drama', '', 123, null, 'Crime'],
    });
    expect(out!.genres).toEqual(['Drama', 'Crime']);
  });
  it('genres >20 sliced to 20', () => {
    const g = Array.from({ length: 25 }, (_, i) => 'G' + i);
    const out = normalizeShow({ id: 1, genres: g });
    expect(out!.genres.length).toBe(20);
  });
});

describe('PROBE normalizeShow — list', () => {
  it('list invalid → towatch', () => {
    expect(normalizeShow({ id: 1, list: 'invalid' })!.list).toBe('towatch');
  });
  it('list "watching" preserved', () => {
    expect(normalizeShow({ id: 1, list: 'watching' })!.list).toBe('watching');
  });
  it('list "completed" preserved', () => {
    expect(normalizeShow({ id: 1, list: 'completed' })!.list).toBe('completed');
  });
});

describe('PROBE normalizeShow — image safety', () => {
  it('data: URL blocked', () => {
    expect(normalizeShow({ id: 1, image: 'data:image/png;base64,xxx' })!.image).toBeNull();
  });
  it('javascript: URL blocked', () => {
    expect(normalizeShow({ id: 1, image: 'javascript:alert(1)' })!.image).toBeNull();
  });
  it('relative URL blocked (not http/https)', () => {
    expect(normalizeShow({ id: 1, image: '/img/p.jpg' })!.image).toBeNull();
  });
});

describe('PROBE normalizeShow — runtime / status / network / addedAt', () => {
  it('runtime 0 → 45', () => {
    expect(normalizeShow({ id: 1, runtime: 0 })!.runtime).toBe(45);
  });
  it('runtime Infinity → 45', () => {
    expect(normalizeShow({ id: 1, runtime: Infinity })!.runtime).toBe(45);
  });
  it('runtime 1001 → 45', () => {
    expect(normalizeShow({ id: 1, runtime: 1001 })!.runtime).toBe(45);
  });
  it('runtime "60" string → 45 (string rejected even though valid)', () => {
    expect(normalizeShow({ id: 1, runtime: '60' })!.runtime).toBe(45);
  });
  it('status not string → N/D', () => {
    expect(normalizeShow({ id: 1, status: null })!.status).toBe('N/D');
  });
  it('network not string → N/D', () => {
    expect(normalizeShow({ id: 1, network: undefined })!.network).toBe('N/D');
  });
  it('addedAt negative → Date.now()', () => {
    const before = Date.now();
    const out = normalizeShow({ id: 1, addedAt: -1 });
    expect(out!.addedAt).toBeGreaterThanOrEqual(before);
  });
  it('addedAt Infinity → Date.now()', () => {
    const before = Date.now();
    const out = normalizeShow({ id: 1, addedAt: Infinity });
    expect(out!.addedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('PROBE normalizeShow — manualList truthy coercion (BUG-02-09 FIXED)', () => {
  it('manualList=1 (truthy non-boolean) → !! coerces to true (BUG-02-09 FIXED)', () => {
    const out = normalizeShow({ id: 1, list: 'watching', manualList: 1 });
    expect(out!.manualList).toBe(true);
  });
  it('manualList="yes" → true (BUG-02-09 FIXED)', () => {
    const out = normalizeShow({ id: 1, list: 'watching', manualList: 'yes' });
    expect(out!.manualList).toBe(true);
  });
  it('manualList=true → true', () => {
    const out = normalizeShow({ id: 1, list: 'watching', manualList: true });
    expect(out!.manualList).toBe(true);
  });
  it('manualList=0 / "" / null → false (falsy)', () => {
    expect(normalizeShow({ id: 1, manualList: 0 })!.manualList).toBe(false);
    expect(normalizeShow({ id: 1, manualList: '' })!.manualList).toBe(false);
    expect(normalizeShow({ id: 1, manualList: null })!.manualList).toBe(false);
  });
});

describe('PROBE buildShowFromTvmaze — id validation (BUG-02-03 FIXED)', () => {
  const base: TvmazeShow = { id: 42, name: 'Test', runtime: 60 };
  it('valid id → built normally', () => {
    const show = buildShowFromTvmaze(base, [], 'towatch');
    expect(show.id).toBe(42);
  });
  it('id 0 → throws (BUG-02-03 FIXED: defense-in-depth, caller already guards)', () => {
    const bad: TvmazeShow = { ...base, id: 0 };
    expect(() => buildShowFromTvmaze(bad, [], 'towatch')).toThrow(/Invalid show id/);
  });
  it('id negative → throws', () => {
    const bad: TvmazeShow = { ...base, id: -1 };
    expect(() => buildShowFromTvmaze(bad, [], 'towatch')).toThrow(/Invalid show id/);
  });
  it('id "abc" → throws', () => {
    const bad = { ...base, id: 'abc' } as unknown as TvmazeShow;
    expect(() => buildShowFromTvmaze(bad, [], 'towatch')).toThrow(/Invalid show id/);
  });
});

describe('PROBE buildShowFromTvmaze — runtime / network / image / genres fallbacks', () => {
  it('runtime undefined, averageRuntime undefined → 45', () => {
    const show = buildShowFromTvmaze(
      { id: 1, name: 'X', runtime: undefined, averageRuntime: undefined },
      [],
      'towatch',
    );
    expect(show.runtime).toBe(45);
  });
  it('runtime undefined, averageRuntime=42 → uses 42', () => {
    const show = buildShowFromTvmaze(
      { id: 1, name: 'X', runtime: undefined, averageRuntime: 42 },
      [],
      'towatch',
    );
    expect(show.runtime).toBe(42);
  });
  it('runtime=0 (falsy), averageRuntime=42 → uses 42', () => {
    const show = buildShowFromTvmaze(
      { id: 1, name: 'X', runtime: 0, averageRuntime: 42 },
      [],
      'towatch',
    );
    expect(show.runtime).toBe(42);
  });
  it('runtime=2000 (>1000), no averageRuntime → CLAMPED to 45 (BUG-02-04 FIXED)', () => {
    // safeNum returns 2000, but new clamp [1,1000] rejects → fallback 45
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 2000 }, [], 'towatch');
    expect(show.runtime).toBe(45); // FIXED: clamped like normalizeShow
  });
  it('runtime=1000 (boundary) → kept', () => {
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 1000 }, [], 'towatch');
    expect(show.runtime).toBe(1000);
  });
  it('runtime=1 (boundary) → kept', () => {
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 1 }, [], 'towatch');
    expect(show.runtime).toBe(1);
  });
  it('network & webChannel both missing → N/D', () => {
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, [], 'towatch');
    expect(show.network).toBe('N/D');
  });
  it('image missing → null', () => {
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, [], 'towatch');
    expect(show.image).toBeNull();
  });
  it('genres missing → []', () => {
    const show = buildShowFromTvmaze({ id: 1, name: 'X', runtime: 60 }, [], 'towatch');
    expect(show.genres).toEqual([]);
  });
  it('name missing → Senza titolo', () => {
    const show = buildShowFromTvmaze({ id: 1, runtime: 60 } as TvmazeShow, [], 'towatch');
    expect(show.name).toBe('Senza titolo');
  });
});

describe('PROBE buildShowFromTvmaze — episodes edge cases', () => {
  it('season 0 (specials) skipped', () => {
    const eps: TvmazeEpisode[] = [
      { id: 1, season: 0, number: 1, name: 'Special' },
      { id: 2, season: 1, number: 1, name: 'Pilot' },
    ];
    const show = buildShowFromTvmaze({ id: 1, runtime: 60 }, eps, 'towatch');
    expect(Object.keys(show.seasons)).toEqual(['1']);
    expect(show.totalEpisodes).toBe(1);
  });
  it('season null → skipped', () => {
    const eps = [
      { id: 1, season: null, number: 1, name: 'X' },
      { id: 2, season: 1, number: 1, name: 'Y' },
    ] as unknown as TvmazeEpisode[];
    const show = buildShowFromTvmaze({ id: 1, runtime: 60 }, eps, 'towatch');
    expect(Object.keys(show.seasons)).toEqual(['1']);
  });
  it('number null → skipped (ep.number == null)', () => {
    const eps = [
      { id: 1, season: 1, number: null, name: 'X' },
      { id: 2, season: 1, number: 1, name: 'Y' },
    ] as unknown as TvmazeEpisode[];
    const show = buildShowFromTvmaze({ id: 1, runtime: 60 }, eps, 'towatch');
    expect(show.seasons[1].length).toBe(1);
  });
  it('number 0 → safeId=0 → filtered out (BUG-02-05 FIXED, aligned with normalizeShow)', () => {
    const eps: TvmazeEpisode[] = [
      { id: 1, season: 1, number: 0, name: 'Zero' },
      { id: 2, season: 1, number: 1, name: 'One' },
    ];
    const show = buildShowFromTvmaze({ id: 1, runtime: 60 }, eps, 'towatch');
    // FIXED: num 0 filtered (matches normalizeShow's ep.num > 0 filter)
    expect(show.seasons[1].length).toBe(1);
    expect(show.seasons[1][0].num).toBe(1);
    expect(show.totalEpisodes).toBe(1);
  });
  it('duplicate episode nums within season → DEDUPED (BUG-02-10 FIXED)', () => {
    const eps: TvmazeEpisode[] = [
      { id: 1, season: 1, number: 1, name: 'First' },
      { id: 2, season: 1, number: 1, name: 'Duplicate' },
    ];
    const show = buildShowFromTvmaze({ id: 1, runtime: 60 }, eps, 'towatch');
    // FIXED: first occurrence kept, duplicate skipped
    expect(show.seasons[1].length).toBe(1);
    expect(show.seasons[1][0].name).toBe('First');
    expect(show.totalEpisodes).toBe(1);
  });
});

describe('PROBE normalizeShow — episode dedupe (BUG-02-10 FIXED)', () => {
  it('duplicate episode nums within a season → first kept, duplicate skipped', () => {
    const out = normalizeShow({
      id: 1,
      seasons: {
        1: [
          { num: 1, id: 11, name: 'First' },
          { num: 1, id: 12, name: 'Duplicate' },
          { num: 2, id: 13, name: 'Second' },
        ],
      },
    });
    expect(out!.seasons[1].length).toBe(2);
    expect(out!.seasons[1][0].id).toBe(11);
    expect(out!.seasons[1][1].num).toBe(2);
    expect(out!.totalEpisodes).toBe(2);
  });
});

describe('PROBE reconcileAllLists — manualList respected (BUG-02-01 / C1 FIXED)', () => {
  it('show manually in "completed" with unwatched episodes (manualList=true) → stays completed (manualList respected)', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'completed', manualList: true });
    markWatchedFirst(show, 1, 1); // 1/3 watched
    reconcileAllLists([show]);
    expect(show.list).toBe('completed'); // FIXED: manualList respected (no demotion)
  });

  it('show manually in "towatch" (manualList=true) with watched episodes → STAYS towatch (BUG-02-01 FIXED)', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'towatch', manualList: true });
    markWatchedFirst(show, 1, 1); // 1/3 watched
    reconcileAllLists([show]);
    expect(show.list).toBe('towatch'); // FIXED: respects manualList, no demote
  });

  it('compare: updateShowListStatus also RESPECTS manualList for same case', () => {
    const show1 = makeShowWithSeasons({ 1: 3 }, { list: 'towatch', manualList: true });
    markWatchedFirst(show1, 1, 1);
    updateShowListStatus(show1);
    expect(show1.list).toBe('towatch'); // respected manualList
  });

  it('watched > totalEpisodes (corrupt) → NOT completed (strict === check)', () => {
    // totalEpisodes=2, watched 3 (corrupt)
    const show = makeShowWithSeasons({ 1: 2 }, { list: 'watching' });
    // Push a phantom watched ep (not actually counted in seasons)
    show.totalEpisodes = 2;
    // Make 3 watched manually by pushing a third ep
    show.seasons[1] = [
      { num: 1, id: 1, watched: true, airdate: null, name: null, runtime: null },
      { num: 2, id: 2, watched: true, airdate: null, name: null, runtime: null },
      { num: 3, id: 3, watched: true, airdate: null, name: null, runtime: null },
    ];
    show.totalEpisodes = 2; // mismatch: 3 watched, 2 declared
    reconcileAllLists([show]);
    // watched(3) !== totalEpisodes(2) so NOT completed
    expect(show.list).not.toBe('completed');
  });

  it('watched > totalEpisodes with list=towatch → demoted to watching', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { list: 'towatch' });
    show.seasons[1] = [
      { num: 1, id: 1, watched: true, airdate: null, name: null, runtime: null },
      { num: 2, id: 2, watched: true, airdate: null, name: null, runtime: null },
      { num: 3, id: 3, watched: true, airdate: null, name: null, runtime: null },
    ];
    show.totalEpisodes = 2;
    reconcileAllLists([show]);
    expect(show.list).toBe('watching');
  });

  it('totalEpisodes=0 & list=completed (manualList=false) → demoted to towatch', () => {
    const show = makeShow({ list: 'completed', totalEpisodes: 0, seasons: {} });
    reconcileAllLists([show]);
    expect(show.list).toBe('towatch');
  });

  it('manualList=true & list=completed & totalEpisodes=0 → STAYS completed (BUG-02-01 FIXED)', () => {
    const show = makeShow({ list: 'completed', manualList: true, totalEpisodes: 0, seasons: {} });
    reconcileAllLists([show]);
    expect(show.list).toBe('completed'); // FIXED: manualList respected
  });

  it('manualList=true & list=completed & totalEpisodes=0 vs updateShowListStatus (both respect)', () => {
    const show1 = makeShow({ list: 'completed', manualList: true, totalEpisodes: 0, seasons: {} });
    updateShowListStatus(show1);
    // updateShowListStatus: not all watched (0 eps), manualList true → return → stays completed
    expect(show1.list).toBe('completed');
  });

  it('manualList=false & list=watching & watched=0 → demoted to towatch (NEW branch aligned with updateShowListStatus)', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'watching', manualList: false });
    // no episodes watched
    reconcileAllLists([show]);
    expect(show.list).toBe('towatch'); // NEW: aligned with updateShowListStatus else-branch
  });
});

describe('PROBE reconcileAllLists — clears manualList on auto-promotion (BUG-02-01 FIXED)', () => {
  it('when show auto-promoted to completed, manualList flag is RESET to false (BUG-02-01 FIXED)', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { list: 'watching', manualList: true });
    markWatchedFirst(show, 1, 2); // 2/2 watched
    reconcileAllLists([show]);
    expect(show.list).toBe('completed');
    expect(show.manualList).toBe(false); // FIXED: cleared on auto-promotion
  });

  it('compare: updateShowListStatus also clears manualList=false on auto-promotion', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { list: 'watching', manualList: true });
    markWatchedFirst(show, 1, 2);
    updateShowListStatus(show);
    expect(show.list).toBe('completed');
    expect(show.manualList).toBe(false);
  });
});

describe('PROBE buildShowFromTvmaze vs normalizeShow — name HTML (BUG-02-08 FIXED)', () => {
  it('buildShowFromTvmaze name with <script> — name stripHtml\'d (script tag+content removed)', () => {
    const show = buildShowFromTvmaze(
      { id: 1, name: '<script>alert(1)</script>X', runtime: 60 },
      [],
      'towatch',
    );
    expect(show.name).toBe('X'); // FIXED: stripHtml applied
  });
  it('buildShowFromTvmaze status with HTML — stripHtml\'d', () => {
    const show = buildShowFromTvmaze(
      { id: 1, name: 'X', status: '<b>Running</b>', runtime: 60 },
      [],
      'towatch',
    );
    expect(show.status).toBe('Running');
  });
  it('buildShowFromTvmaze network with HTML — stripHtml\'d', () => {
    const show = buildShowFromTvmaze(
      { id: 1, name: 'X', runtime: 60, network: { name: '<i>HBO</i>' } },
      [],
      'towatch',
    );
    expect(show.network).toBe('HBO');
  });
});

describe('PROBE normalizeShow — seasons key safeId validation (BUG-02-07 FIXED)', () => {
  it('key "1e2" (scientific) → safeId rejects → skipped (BUG-02-07 FIXED)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { '1e2': [{ num: 1, id: 11 }] },
    });
    expect(out).not.toBeNull();
    expect(out!.seasons[100]).toBeUndefined();
    expect(Object.keys(out!.seasons)).toEqual([]);
  });
  it('key "0x10" (hex 16) → safeId rejects → skipped (BUG-02-07 FIXED)', () => {
    const out = normalizeShow({
      id: 1,
      seasons: { '0x10': [{ num: 1, id: 11 }] },
    });
    expect(out).not.toBeNull();
    // safeId regex ^-?\d+$ rejects hex → season skipped
    expect(Object.keys(out!.seasons)).toEqual([]);
  });
  it('compare: safeId("0x10") rejects', async () => {
    const { safeId } = await import('../src/lib/utils');
    expect(safeId('0x10')).toBe(0); // safeId regex ^-?\d+$ rejects hex
  });
});
