import { describe, expect, it } from 'vitest';
import type { TvmazeEpisode, TvmazeShow } from '../src/types';
import { buildShowFromTvmaze, normalizeShow, reconcileAllLists } from '../src/lib/normalize';
import { makeShow, makeShowWithSeasons, markWatchedFirst } from './helpers';

describe('normalizeShow — persisted-data invariants', () => {
  it('rejects malformed identifiers without throwing', () => {
    for (const id of [0, -1, 1.5, 'abc', true, false, {}, [], Symbol('id')]) {
      expect(normalizeShow({ id })).toBeNull();
    }
  });

  it('accepts only canonical decimal season keys', () => {
    const show = normalizeShow({
      id: 1,
      seasons: {
        '1': [{ num: 1, id: 11 }],
        '01': [{ num: 1, id: 21 }],
        ' 1 ': [{ num: 1, id: 31 }],
        '1.5': [{ num: 1, id: 41 }],
        '1e2': [{ num: 1, id: 51 }],
        '0x10': [{ num: 1, id: 61 }],
        '0': [{ num: 1, id: 71 }],
        '-1': [{ num: 1, id: 81 }],
      },
    });

    expect(show).not.toBeNull();
    expect(Object.keys(show!.seasons)).toEqual(['1']);
    expect(show!.seasons[1].map((ep) => ep.id)).toEqual([11]);
    expect(show!.totalSeasons).toBe(1);
    expect(show!.totalEpisodes).toBe(1);
  });

  it('normalizes episode fields and strict watched values in one pass', () => {
    const show = normalizeShow({
      id: 1,
      seasons: {
        1: [
          { num: 1, watched: true, airdate: '2024-06-15', name: '<b>Pilot</b>', runtime: 42 },
          { num: 2, watched: 'true', airdate: '2024-02-30', name: 123, runtime: 0 },
          { num: 3, watched: 1, runtime: Infinity },
          { num: 4, watched: 'false' },
          { num: 5, watched: 0 },
          { num: 0, id: 99 },
          { num: 'abc', id: 100 },
          { num: null, id: 101 },
          null,
          'bad',
        ],
      },
    });

    expect(show!.seasons[1]).toHaveLength(5);
    expect(show!.seasons[1].map((ep) => ep.watched)).toEqual([true, true, true, false, false]);
    expect(show!.seasons[1][0]).toMatchObject({ id: 0, airdate: '2024-06-15', name: 'Pilot', runtime: 42 });
    expect(show!.seasons[1][1]).toMatchObject({ airdate: null, name: null, runtime: null });
    expect(show!.seasons[1][2].runtime).toBeNull();
  });

  it('deduplicates episode numbers with first occurrence winning', () => {
    const show = normalizeShow({
      id: 1,
      seasons: {
        1: [
          { num: 1, id: 11, name: 'First' },
          { num: 1, id: 12, name: 'Duplicate' },
          { num: 2, id: 13, name: 'Second' },
        ],
      },
    });

    expect(show!.seasons[1].map((ep) => ep.id)).toEqual([11, 13]);
    expect(show!.totalEpisodes).toBe(2);
  });

  it('recomputes aggregate counts instead of trusting persisted totals', () => {
    const show = normalizeShow({
      id: 1,
      seasons: { 1: [{ num: 1 }, { num: 2 }], 2: [{ num: 1 }] },
      totalEpisodes: 999,
      totalSeasons: 999,
    });

    expect(show!.totalEpisodes).toBe(3);
    expect(show!.totalSeasons).toBe(2);
  });

  it('sanitizes text and applies domain defaults', () => {
    const before = Date.now();
    const show = normalizeShow({
      id: 1,
      name: '<script>x()</script>',
      status: '<b></b>',
      network: '<i></i>',
      summary: '<p>Hello</p><script>bad()</script>',
      runtime: Infinity,
      addedAt: -1,
      list: 'invalid',
      manualList: 'yes',
    });

    expect(show).toMatchObject({
      name: 'Senza titolo',
      status: 'N/D',
      network: 'N/D',
      summary: 'Hello',
      runtime: 45,
      list: 'towatch',
      manualList: true,
    });
    expect(show!.addedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('buildShowFromTvmaze — API boundary', () => {
  it('rejects invalid show ids at the boundary', () => {
    const base = { name: 'Test' } as TvmazeShow;
    for (const id of [0, -1, 'abc']) {
      expect(() => buildShowFromTvmaze({ ...base, id } as TvmazeShow, [], 'towatch')).toThrow(/Invalid show id/);
    }
  });

  it('uses average runtime only when primary runtime is absent or zero and clamps the result', () => {
    expect(buildShowFromTvmaze({ id: 1, runtime: undefined, averageRuntime: 42 }, [], 'towatch').runtime).toBe(42);
    expect(buildShowFromTvmaze({ id: 1, runtime: 0, averageRuntime: 42 }, [], 'towatch').runtime).toBe(42);
    expect(buildShowFromTvmaze({ id: 1, runtime: 1 }, [], 'towatch').runtime).toBe(1);
    expect(buildShowFromTvmaze({ id: 1, runtime: 1000 }, [], 'towatch').runtime).toBe(1000);
    expect(buildShowFromTvmaze({ id: 1, runtime: 2000 }, [], 'towatch').runtime).toBe(45);
  });

  it('filters malformed/special episodes and deduplicates numbers', () => {
    const episodes = [
      null,
      { id: 1, season: 0, number: 1, name: 'Special' },
      { id: 2, season: null, number: 1, name: 'No season' },
      { id: 3, season: 1, number: null, name: 'No number' },
      { id: 4, season: 1, number: 0, name: 'Zero' },
      { id: 5, season: 1, number: 1, name: 'First' },
      { id: 6, season: 1, number: 1, name: 'Duplicate' },
      { id: 7, season: 1, number: 2, name: '<b>Second</b>', airdate: '2024-02-30', runtime: Infinity },
    ] as unknown as TvmazeEpisode[];

    const show = buildShowFromTvmaze({ id: 1, name: 'X' }, episodes, 'towatch');
    expect(show.seasons[1]).toHaveLength(2);
    expect(show.seasons[1].map((ep) => ep.id)).toEqual([5, 7]);
    expect(show.seasons[1][1]).toMatchObject({ name: 'Second', airdate: null, runtime: null });
    expect(show.totalEpisodes).toBe(2);
  });

  it('sanitizes API metadata and uses webChannel as network fallback', () => {
    const show = buildShowFromTvmaze(
      {
        id: 1,
        name: '<script>x()</script>Show',
        status: '<b>Running</b>',
        premiered: '2024-02-30',
        genres: ['Drama', 'Drama', '', 42 as unknown as string],
        summary: '<p>Hello</p>',
        webChannel: { name: '<i>Stream</i>' },
      },
      [],
      'invalid' as never,
    );

    expect(show).toMatchObject({
      name: 'Show',
      status: 'Running',
      premiered: null,
      genres: ['Drama'],
      summary: 'Hello',
      network: 'Stream',
      list: 'towatch',
      image: null,
    });
  });

  it('falls back cleanly when optional TVMaze metadata is absent', () => {
    const show = buildShowFromTvmaze({ id: 1 } as TvmazeShow, [], 'towatch');
    expect(show).toMatchObject({ name: 'Senza titolo', status: 'N/D', network: 'N/D', genres: [], runtime: 45 });
    expect(show.image).toBeNull();
  });
});

describe('reconcileAllLists — observable list contract', () => {
  it('manual placement blocks ordinary automatic transitions', () => {
    const towatch = makeShowWithSeasons({ 1: 3 }, { list: 'towatch', manualList: true });
    markWatchedFirst(towatch, 1, 1);
    const completed = makeShow({ list: 'completed', manualList: true, totalEpisodes: 0, seasons: {} });

    reconcileAllLists([towatch, completed]);
    expect(towatch.list).toBe('towatch');
    expect(completed.list).toBe('completed');
  });

  it('full completion wins over manual placement and clears the flag', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { list: 'watching', manualList: true });
    markWatchedFirst(show, 1, 2);

    reconcileAllLists([show]);
    expect(show.list).toBe('completed');
    expect(show.manualList).toBe(false);
  });

  it('performs the normal automatic transitions in both directions', () => {
    const started = makeShowWithSeasons({ 1: 3 }, { list: 'towatch' });
    markWatchedFirst(started, 1, 1);
    const reset = makeShowWithSeasons({ 1: 3 }, { list: 'watching' });
    const emptyCompleted = makeShow({ list: 'completed', totalEpisodes: 0, seasons: {} });

    reconcileAllLists([started, reset, emptyCompleted]);
    expect(started.list).toBe('watching');
    expect(reset.list).toBe('towatch');
    expect(emptyCompleted.list).toBe('towatch');
  });

  it('does not mark corrupt progress as completed when watched exceeds declared total', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { list: 'towatch' });
    show.seasons[1].push({ num: 3, id: 3, watched: true, airdate: null, name: null, runtime: null });
    for (const episode of show.seasons[1]) episode.watched = true;
    show.totalEpisodes = 2;

    reconcileAllLists([show]);
    expect(show.list).toBe('watching');
  });
});
