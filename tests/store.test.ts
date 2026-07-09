import { describe, it, expect } from 'vitest';
import type { Show } from '../src/types';
import { updateShowListStatus } from '../src/lib/store';
import { makeShowWithSeasons, markWatchedFirst } from './helpers';

describe('updateShowListStatus', () => {
  it('promuove a completed quando tutti gli episodi sono watched', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { list: 'watching', manualList: false });
    markWatchedFirst(show, 1, 2);
    updateShowListStatus(show);
    expect(show.list).toBe('completed');
    expect(show.manualList).toBe(false);
  });

  it('promuove towatch→watching al primo episodio watched (senza manualList)', () => {
    // Copre la transizione towatch→watching: precedentemente testata tramite
    // `reconcileList` (ora rimosso come dead code); portata qui su
    // `updateShowListStatus` per preservare la coverage.
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'towatch' });
    markWatchedFirst(show, 1, 1);
    updateShowListStatus(show);
    expect(show.list).toBe('watching');
  });

  it('rispetta manualList: non retrocede completed→watching se manualList=true', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'completed', manualList: true });
    // Solo 1 episodio watched su 3 → normalmente retrocederebbe a watching,
    // ma manualList=true blocca la retrocessione.
    markWatchedFirst(show, 1, 1);
    updateShowListStatus(show);
    expect(show.list).toBe('completed');
  });

  it('promuove comunque a completed anche con manualList=true se tutti visti', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { list: 'watching', manualList: true });
    markWatchedFirst(show, 1, 2);
    updateShowListStatus(show);
    expect(show.list).toBe('completed');
    expect(show.manualList).toBe(false); // auto-promotion clears override
  });

  it('retrocede a towatch quando nessun episodio è watched (senza manualList)', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'watching', manualList: false });
    // Nessun episodio watched → towatch
    updateShowListStatus(show);
    expect(show.list).toBe('towatch');
  });

  it('mantiene watching se almeno un episodio watched (no manualList)', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'watching', manualList: false });
    markWatchedFirst(show, 1, 1);
    updateShowListStatus(show);
    expect(show.list).toBe('watching');
  });

  it('su serie con totalEpisodes=0, retrocede completed→towatch', () => {
    const show = makeShowWithSeasons({}, { list: 'completed', totalEpisodes: 0, manualList: false });
    updateShowListStatus(show);
    expect(show.list).toBe('towatch');
  });
});

// Sanity test: importiamo Show solo per evitare warning "unused" in build
describe('Type safety', () => {
  it('Show type è istanziabile', () => {
    const s: Show = {
      id: 1,
      name: 'x',
      image: null,
      status: 'Running',
      premiered: null,
      genres: [],
      summary: '',
      network: 'N/D',
      runtime: 45,
      list: 'towatch',
      seasons: {},
      totalSeasons: 0,
      totalEpisodes: 0,
      addedAt: 0,
    };
    expect(s.id).toBe(1);
  });
});
