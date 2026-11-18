import { describe, it, expect } from 'vitest';
import { mergeImportedShow } from '../src/lib/merge';
import type { Episode, Show } from '../src/types';

function ep(num: number, extra: Partial<Episode> = {}): Episode {
  return { num, id: 100 + num, watched: false, airdate: '2024-01-0' + num, name: 'E' + num, runtime: 30, ...extra };
}

function show(seasons: Record<number, Episode[]>, extra: Partial<Show> = {}): Show {
  const totalEpisodes = Object.values(seasons).reduce((n, eps) => n + eps.length, 0);
  return {
    id: 1,
    name: 'Locale',
    image: null,
    status: 'Running',
    premiered: null,
    genres: ['Drama'],
    summary: '',
    network: 'N/D',
    runtime: 30,
    list: 'watching',
    manualList: false,
    seasons,
    totalSeasons: Object.keys(seasons).length,
    totalEpisodes,
    addedAt: 1,
    tags: [],
    ...extra,
  };
}

describe('mergeImportedShow', () => {
  it('keeps local ratings and notes even when the backup has more progress', () => {
    const local = show({ 1: [ep(1, { watched: true, rating: 4, note: 'locale' }), ep(2), ep(3)] });
    const backup = show({ 1: [ep(1, { watched: true }), ep(2, { watched: true }), ep(3)] });

    expect(mergeImportedShow(local, backup)).toBe(true);
    expect(local.seasons[1].map((e) => e.watched)).toEqual([true, true, false]);
    expect(local.seasons[1][0]).toMatchObject({ rating: 4, note: 'locale' });
  });

  it('imports ratings, notes and tags from a backup with less progress', () => {
    const local = show({ 1: [ep(1, { watched: true }), ep(2, { watched: true })] }, { tags: ['Rewatch'] });
    const backup = show({ 1: [ep(1, { rating: 5, note: 'dal backup' }), ep(2)] }, { tags: ['rewatch', 'Estate'] });

    expect(mergeImportedShow(local, backup)).toBe(true);
    expect(local.seasons[1].map((e) => e.watched)).toEqual([true, true]);
    expect(local.seasons[1][0]).toMatchObject({ rating: 5, note: 'dal backup' });
    expect(local.tags).toEqual(['Rewatch', 'Estate']);
  });

  it('adds episodes and seasons that exist only in the backup and recomputes totals', () => {
    const local = show({ 1: [ep(1, { watched: true })] });
    const backup = show({ 1: [ep(1), ep(2, { watched: true })], 2: [ep(1, { id: 201 })] });

    mergeImportedShow(local, backup);
    expect(local.seasons[1].map((e) => e.num)).toEqual([1, 2]);
    expect(local.seasons[2]).toHaveLength(1);
    expect(local.totalEpisodes).toBe(3);
    expect(local.totalSeasons).toBe(2);
  });

  it('keeps local show metadata and reports no change for an identical backup', () => {
    const local = show({ 1: [ep(1, { watched: true }), ep(2)] }, { name: 'Nome locale' });
    const backup = show({ 1: [ep(1, { watched: true }), ep(2)] }, { name: 'Nome backup' });

    expect(mergeImportedShow(local, backup)).toBe(false);
    expect(local.name).toBe('Nome locale');
  });

  it('does not mutate the original local episode objects (rollback stays possible)', () => {
    const original = ep(1);
    const local = show({ 1: [original] });
    mergeImportedShow(local, show({ 1: [ep(1, { watched: true })] }));

    expect(original.watched).toBe(false);
    expect(local.seasons[1][0].watched).toBe(true);
  });

  it('promotes to completed when the merged progress covers every episode', () => {
    const local = show({ 1: [ep(1, { watched: true }), ep(2)] });
    mergeImportedShow(local, show({ 1: [ep(1), ep(2, { watched: true })] }));
    expect(local.list).toBe('completed');
  });
});
