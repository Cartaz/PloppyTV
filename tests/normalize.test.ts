import { describe, it, expect } from 'vitest';
import type { TvmazeEpisode, TvmazeShow } from '../src/types';
import { normalizeShow, buildShowFromTvmaze, reconcileAllLists } from '../src/lib/normalize';
import { makeShow, makeShowWithSeasons, markWatchedFirst } from './helpers';

describe('normalizeShow', () => {
  it('ritorna null per input non oggetto o senza id valido', () => {
    expect(normalizeShow(null)).toBeNull();
    expect(normalizeShow(undefined)).toBeNull();
    expect(normalizeShow('string')).toBeNull();
    expect(normalizeShow(123)).toBeNull();
    expect(normalizeShow([])).toBeNull();
    expect(normalizeShow({})).toBeNull(); // senza id
    expect(normalizeShow({ id: 0 })).toBeNull();
    expect(normalizeShow({ id: -1 })).toBeNull();
    expect(normalizeShow({ id: 'abc' })).toBeNull();
    expect(normalizeShow({ id: 1.5 })).toBeNull();
  });

  it('sanitizza name, status, network, summary con fallback e slice', () => {
    const long = 'x'.repeat(500);
    const out = normalizeShow({
      id: 42,
      name: 123, // non-string → fallback
      status: null, // non-string → fallback
      network: undefined, // non-string → fallback
      summary: '<p>hello</p><script>alert(1)</script>',
    });
    expect(out).not.toBeNull();
    expect(out!.name).toBe('Senza titolo');
    expect(out!.status).toBe('N/D');
    expect(out!.network).toBe('N/D');
    expect(out!.summary).toBe('hello'); // stripHtml applicato
    void long;
  });

  it('deduplica generi e tronca a 20', () => {
    const genres = Array.from({ length: 25 }, (_, i) => 'G' + (i % 8)); // 25 con duplicati
    const out = normalizeShow({ id: 1, genres });
    expect(out!.genres.length).toBeLessThanOrEqual(20);
    expect(new Set(out!.genres).size).toBe(out!.genres.length); // unici
  });

  it('valida list con fallback a towatch per valori non ammessi', () => {
    expect(normalizeShow({ id: 1, list: 'invalid' })!.list).toBe('towatch');
    expect(normalizeShow({ id: 1, list: 'watching' })!.list).toBe('watching');
    expect(normalizeShow({ id: 1, list: 123 })!.list).toBe('towatch');
  });

  it('filtra stagioni/episodi non validi, mantiene struttura', () => {
    const out = normalizeShow({
      id: 1,
      seasons: {
        1: [
          { num: 1, id: 11, watched: true },
          { num: 2, id: 12 }, // ok
          { num: 'abc' }, // num non valido → scartato
          { num: 0 }, // num <= 0 → scartato
          null, // scartato
          'not-an-ep', // scartato
        ],
        2: 'not-an-array', // scartato
        '-1': [{ num: 1, id: 21 }], // chiave stagione <= 0 → scartata
        abc: [{ num: 1, id: 31 }], // chiave non numerica → scartata
      },
    });
    expect(out).not.toBeNull();
    expect(Object.keys(out!.seasons).sort()).toEqual(['1']);
    expect(out!.seasons[1].length).toBe(2);
    expect(out!.totalEpisodes).toBe(2);
    expect(out!.totalSeasons).toBe(1);
  });

  it('valida airededate con regex YYYY-MM-DD', () => {
    const out = normalizeShow({
      id: 1,
      seasons: {
        1: [
          { num: 1, id: 11, airdate: '2024-06-15' },
          { num: 2, id: 12, airdate: 'not-a-date' },
          { num: 3, id: 13, airdate: null },
        ],
      },
    });
    expect(out!.seasons[1][0].airdate).toBe('2024-06-15');
    expect(out!.seasons[1][1].airdate).toBeNull();
    expect(out!.seasons[1][2].airdate).toBeNull();
  });

  it('valida premiered con regex', () => {
    expect(normalizeShow({ id: 1, premiered: '2024-06-15' })!.premiered).toBe('2024-06-15');
    expect(normalizeShow({ id: 1, premiered: 'invalid' })!.premiered).toBeNull();
    expect(normalizeShow({ id: 1, premiered: null })!.premiered).toBeNull();
  });

  it('rifiuta image data URL/javascript e conserva URL validi', () => {
    expect(normalizeShow({ id: 1, image: 'https://x.com/p.jpg' })!.image).toBe('https://x.com/p.jpg');
    expect(normalizeShow({ id: 1, image: 'data:image/png;base64,xxx' })!.image).toBeNull();
    expect(normalizeShow({ id: 1, image: 'javascript:alert(1)' })!.image).toBeNull();
  });

  it('valida runtime nel range 1-1000, fallback 45', () => {
    expect(normalizeShow({ id: 1, runtime: 60 })!.runtime).toBe(60);
    expect(normalizeShow({ id: 1, runtime: 0 })!.runtime).toBe(45);
    expect(normalizeShow({ id: 1, runtime: -5 })!.runtime).toBe(45);
    expect(normalizeShow({ id: 1, runtime: 5000 })!.runtime).toBe(45);
    expect(normalizeShow({ id: 1, runtime: 'abc' })!.runtime).toBe(45);
  });

  it('valida addedAt come timestamp positivo finito, fallback Date.now()', () => {
    const before = Date.now();
    const out = normalizeShow({ id: 1, addedAt: -1 });
    const after = Date.now();
    expect(out!.addedAt).toBeGreaterThanOrEqual(before);
    expect(out!.addedAt).toBeLessThanOrEqual(after);

    expect(normalizeShow({ id: 1, addedAt: 1700000000000 })!.addedAt).toBe(1700000000000);
    expect(normalizeShow({ id: 1, addedAt: NaN })!.addedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('buildShowFromTvmaze', () => {
  const tvmazeShow: TvmazeShow = {
    id: 42,
    name: 'Test Show',
    status: 'Running',
    premiered: '2024-01-01',
    genres: ['Drama', 'Drama', 'Crime'],
    summary: '<p>A <b>great</b> show</p>',
    runtime: 60,
    image: { medium: 'https://img.tvmaze.com/m.jpg', original: 'https://img.tvmaze.com/o.jpg' },
    network: { name: 'HBO' },
  };

  const episodes: TvmazeEpisode[] = [
    { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2024-01-01', runtime: 60 },
    { id: 102, season: 1, number: 2, name: 'Ep2', airdate: '2024-01-08', runtime: 60 },
    { id: 201, season: 2, number: 1, name: 'S2E1', airdate: '2025-01-01', runtime: 60 },
    // Speciali (season 0) e senza number devono essere saltati
    { id: 0, season: 0, number: 1, name: 'Special' },
    { id: 999, season: 1, name: 'NoNumber' } as TvmazeEpisode,
  ];

  it('costruisce uno Show completo saltando speciali e episodi senza number', () => {
    const show = buildShowFromTvmaze(tvmazeShow, episodes, 'towatch');
    expect(show.id).toBe(42);
    expect(show.name).toBe('Test Show');
    expect(show.image).toBe('https://img.tvmaze.com/m.jpg'); // preferisce medium
    expect(show.network).toBe('HBO');
    expect(show.summary).toBe('A great show'); // stripHtml
    expect(show.genres).toEqual(['Drama', 'Crime']); // deduplica
    expect(show.runtime).toBe(60);
    expect(show.list).toBe('towatch');
    expect(show.manualList).toBe(false);
    expect(show.totalEpisodes).toBe(3); // 2 in S1 + 1 in S2
    expect(show.totalSeasons).toBe(2);
    expect(Object.keys(show.seasons).sort()).toEqual(['1', '2']);
    expect(show.seasons[1].length).toBe(2);
    expect(show.seasons[2].length).toBe(1);
    expect(show.seasons[1][0]).toEqual({
      num: 1,
      id: 101,
      watched: false,
      airdate: '2024-01-01',
      name: 'Pilot',
      runtime: 60,
    });
  });

  it('forza list="towatch" se list non ammessa', () => {
    const show = buildShowFromTvmaze(tvmazeShow, [], 'invalid' as never);
    expect(show.list).toBe('towatch');
  });

  it('usa runtime fallback 45 se runtime mancante', () => {
    const noRuntime: TvmazeShow = { ...tvmazeShow, runtime: undefined, averageRuntime: undefined };
    const show = buildShowFromTvmaze(noRuntime, [], 'towatch');
    expect(show.runtime).toBe(45);
  });
});

describe('reconcileAllLists', () => {
  it('promuove a completed quando tutti gli episodi sono watched', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { list: 'watching' });
    markWatchedFirst(show, 1, 2);
    reconcileAllLists([show]);
    expect(show.list).toBe('completed');
  });

  it('promuove towatch→watching quando almeno un episodio è watched', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'towatch' });
    markWatchedFirst(show, 1, 1);
    reconcileAllLists([show]);
    expect(show.list).toBe('watching');
  });

  it('retrocede completed→towatch se totalEpisodes=0', () => {
    const show = makeShow({ list: 'completed', totalEpisodes: 0, seasons: {} });
    reconcileAllLists([show]);
    expect(show.list).toBe('towatch');
  });

  it('non modifica serie already-correct', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { list: 'watching' });
    markWatchedFirst(show, 1, 1);
    const before = show.list;
    reconcileAllLists([show]);
    expect(show.list).toBe(before);
  });

  it('gestisce array vuoto senza throw', () => {
    expect(() => reconcileAllLists([])).not.toThrow();
  });
});
