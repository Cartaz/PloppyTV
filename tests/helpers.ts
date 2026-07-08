// Helper di test: factory per Show/Episode con defaults sensati.
// Importato da tutti i file di test per evitare ripetizione.

import type { Episode, Show } from '../src/types';

export function makeEpisode(over: Partial<Episode> = {}): Episode {
  return {
    num: 1,
    id: 1,
    watched: false,
    airdate: null,
    name: null,
    runtime: null,
    ...over,
  };
}

export function makeShow(over: Partial<Show> = {}): Show {
  return {
    id: 1,
    name: 'Test Show',
    image: null,
    status: 'Running',
    premiered: '2024-01-01',
    genres: ['Drama'],
    summary: '',
    network: 'N/D',
    runtime: 45,
    list: 'towatch',
    manualList: false,
    seasons: {},
    totalSeasons: 0,
    totalEpisodes: 0,
    addedAt: 1700000000000,
    ...over,
  };
}

/**
 * Costruisce una show con N stagioni da M episodi ciascuna.
 * Gli episodi sono watched=false di default.
 */
export function makeShowWithSeasons(seasons: Record<number, number>, over: Partial<Show> = {}): Show {
  const s: Show['seasons'] = {};
  let totalEp = 0;
  for (const [sn, count] of Object.entries(seasons)) {
    const n = Number(sn);
    s[n] = [];
    for (let i = 1; i <= count; i++) {
      s[n].push(makeEpisode({ num: i, id: n * 1000 + i }));
      totalEp++;
    }
  }
  return makeShow({
    seasons: s,
    totalSeasons: Object.keys(s).length,
    totalEpisodes: totalEp,
    ...over,
  });
}

/**
 * Marca i primi `n` episodi di una stagione come watched.
 * Mutazione in-place per semplicità nei test.
 */
export function markWatchedFirst(show: Show, season: number, n: number): void {
  const eps = show.seasons[season];
  if (!eps) return;
  for (let i = 0; i < Math.min(n, eps.length); i++) {
    eps[i].watched = true;
  }
}
