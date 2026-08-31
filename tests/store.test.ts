import { describe, expect, it } from 'vitest';
import { updateShowListStatus } from '../src/lib/store';
import { makeShowWithSeasons, markWatchedFirst } from './helpers';

describe('updateShowListStatus contracts', () => {
  it('promotes a fully watched show to completed and clears manualList', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { list: 'watching', manualList: true });
    markWatchedFirst(show, 1, 2);

    updateShowListStatus(show);

    expect(show.list).toBe('completed');
    expect(show.manualList).toBe(false);
  });

  it('promotes towatch to watching after the first watched episode', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'towatch', manualList: false });
    markWatchedFirst(show, 1, 1);

    updateShowListStatus(show);

    expect(show.list).toBe('watching');
  });

  it('keeps a partially watched show in watching', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'watching', manualList: false });
    markWatchedFirst(show, 1, 1);

    updateShowListStatus(show);

    expect(show.list).toBe('watching');
  });

  it('demotes an unwatched show to towatch when there is no manual override', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'watching', manualList: false });

    updateShowListStatus(show);

    expect(show.list).toBe('towatch');
  });

  it('does not demote a manually placed completed show', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'completed', manualList: true });
    markWatchedFirst(show, 1, 1);

    updateShowListStatus(show);

    expect(show.list).toBe('completed');
  });

  it('demotes an empty completed show to towatch', () => {
    const show = makeShowWithSeasons({}, { list: 'completed', totalEpisodes: 0, manualList: false });

    updateShowListStatus(show);

    expect(show.list).toBe('towatch');
  });
});
