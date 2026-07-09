import { describe, it, expect } from 'vitest';
import type { Episode, Show } from '../src/types';
import { getWatchedCount, findNextEpisode } from '../src/lib/utils';
import { makeEpisode, makeShow, makeShowWithSeasons, markWatchedFirst } from './helpers';

describe('getWatchedCount', () => {
  it('ritorna 0 per show nullo o senza seasons', () => {
    expect(getWatchedCount(null)).toBe(0);
    expect(getWatchedCount({} as Show)).toBe(0);
    expect(getWatchedCount({ seasons: null } as unknown as Show)).toBe(0);
    expect(getWatchedCount({ seasons: [] } as unknown as Show)).toBe(0);
  });

  it('conta solo gli episodi watched=true', () => {
    const show = makeShowWithSeasons({ 1: 3, 2: 2 });
    expect(getWatchedCount(show)).toBe(0);
    markWatchedFirst(show, 1, 2);
    expect(getWatchedCount(show)).toBe(2);
    show.seasons[2][0].watched = true;
    show.seasons[2][1].watched = true;
    expect(getWatchedCount(show)).toBe(4);
  });

  it('ignora array di stagione non validi senza throw', () => {
    const show = makeShow({
      seasons: { 1: 'not-an-array' as unknown as Episode[] },
    });
    expect(getWatchedCount(show)).toBe(0);
  });
});

describe('findNextEpisode', () => {
  it('ritorna null per show nullo o senza seasons', () => {
    expect(findNextEpisode(null)).toBeNull();
    expect(findNextEpisode({} as Show)).toBeNull();
    expect(findNextEpisode({ seasons: null } as unknown as Show)).toBeNull();
  });

  it('ritorna il primo episodio non watched della stagione 1 se nulla è visto', () => {
    const show = makeShowWithSeasons({ 1: 3 });
    const next = findNextEpisode(show);
    expect(next).toEqual({ season: 1, num: 1, airdate: null, name: null });
  });

  it('salta episodi watched e stagioni intere watched', () => {
    const show = makeShowWithSeasons({ 1: 2, 2: 2 });
    markWatchedFirst(show, 1, 2); // tutta la stagione 1
    markWatchedFirst(show, 2, 1); // primo episodio stagione 2
    const next = findNextEpisode(show);
    expect(next).toEqual({ season: 2, num: 2, airdate: null, name: null });
  });

  it('ritorna null quando tutti gli episodi sono watched', () => {
    const show = makeShowWithSeasons({ 1: 2 });
    markWatchedFirst(show, 1, 2);
    expect(findNextEpisode(show)).toBeNull();
  });

  it("ordina episodi per num anche se l'array è disordinato", () => {
    const show = makeShowWithSeasons({ 1: 0 });
    // Inserisci episodi fuori ordine
    show.seasons[1] = [
      makeEpisode({ num: 3, id: 13 }),
      makeEpisode({ num: 1, id: 11, watched: true }),
      makeEpisode({ num: 2, id: 12 }),
    ];
    const next = findNextEpisode(show);
    // Dovrebbe saltare num=1 (watched) e tornare num=2 (non num=3 che è primo nell'array)
    expect(next?.num).toBe(2);
  });

  it('ordina le stagioni numericamente (non per chiave stringa)', () => {
    const show = makeShowWithSeasons({ 1: 1, 2: 1, 10: 1 });
    markWatchedFirst(show, 1, 1);
    markWatchedFirst(show, 2, 1);
    const next = findNextEpisode(show);
    // La stagione 10 deve venire dopo la 2, non prima (ordine lessicale "1","10","2")
    expect(next?.season).toBe(10);
  });
});
