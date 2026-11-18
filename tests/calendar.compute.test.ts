import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeCalendar } from '../src/worker/compute';
import { unwatchedEpisodesByAirdate } from '../src/lib/utils';
import type { Episode, Show } from '../src/types';

// Mercoledì 18 novembre 2026: la settimana va da lunedì 16 a domenica 22.
const NOW = new Date(2026, 10, 18, 12, 0, 0);

function ep(num: number, airdate: string | null, watched = false): Episode {
  return { num, id: num, watched, airdate, name: 'E' + num, runtime: 30 };
}

function show(id: number, seasons: Record<number, Episode[]>, list: Show['list'] = 'watching'): Show {
  return {
    id,
    name: 'Serie ' + id,
    image: null,
    status: 'Running',
    premiered: null,
    genres: [],
    summary: '',
    network: 'N/D',
    runtime: 30,
    list,
    manualList: true,
    seasons,
    totalSeasons: Object.keys(seasons).length,
    totalEpisodes: Object.values(seasons).reduce((n, eps) => n + eps.length, 0),
    addedAt: 1,
    tags: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('computeCalendar', () => {
  it('shows this week’s release even when the user is behind on older episodes', () => {
    const behind = show(1, { 1: [ep(1, '2020-01-01', true), ep(2, '2020-01-08')], 2: [ep(1, '2026-11-19')] });
    const { week } = computeCalendar([behind], 0);
    expect(week.map((e) => [e.season, e.num, e.date])).toEqual([[2, 1, '2026-11-19']]);
  });

  it('lists every unwatched release of the week, not just one per show', () => {
    const binge = show(1, { 1: [ep(1, '2026-11-16'), ep(2, '2026-11-16'), ep(3, '2026-11-20')] });
    expect(computeCalendar([binge], 0).week.map((e) => e.num)).toEqual([1, 2, 3]);
  });

  it('skips watched episodes and shows that are not in "watching"', () => {
    const watched = show(1, { 1: [ep(1, '2026-11-17', true)] });
    const towatch = show(2, { 1: [ep(1, '2026-11-17')] }, 'towatch');
    expect(computeCalendar([watched, towatch], 0).week).toEqual([]);
  });

  it('puts the first later release of each show in afterWeek, sorted by date', () => {
    const a = show(1, { 1: [ep(1, '2026-12-10'), ep(2, '2026-12-17')] });
    const b = show(2, { 1: [ep(1, '2026-11-30')] });
    const { afterWeek } = computeCalendar([a, b], 0);
    expect(afterWeek.map((e) => [e.showId, e.date])).toEqual([
      [2, '2026-11-30'],
      [1, '2026-12-10'],
    ]);
  });

  it('navigates to future weeks with weekOffset', () => {
    const s = show(1, { 1: [ep(1, '2026-11-17'), ep(2, '2026-11-24')] });
    const next = computeCalendar([s], 1);
    expect(next.weekStart).toBe('2026-11-23');
    expect(next.week.map((e) => e.num)).toEqual([2]);
  });
});

describe('unwatchedEpisodesByAirdate', () => {
  it('orders by date, then season and number, ignoring missing or invalid dates', () => {
    const s = show(1, {
      1: [ep(2, '2026-01-02'), ep(1, '2026-01-02'), ep(3, null), ep(4, '2026-02-30')],
      2: [ep(1, '2025-12-31')],
    });
    expect(unwatchedEpisodesByAirdate(s).map((e) => [e.season, e.num])).toEqual([
      [2, 1],
      [1, 1],
      [1, 2],
    ]);
  });
});
