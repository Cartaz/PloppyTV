// Agent A2 probe: edge-case & bug-hunt tests for src/lib/store.ts
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_a2.test.ts
//
// Each test maps to a specific BUG-A2-XX fix in store.ts. Tests are written
// to FAIL on the pre-fix code and PASS on the post-fix code.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Show } from '../src/types';
import {
  getState,
  getStateSnapshot,
  setState,
  subscribe,
  emitChange,
  setShows,
  replaceShow,
  removeShowFromState,
  updateShowListStatus,
} from '../src/lib/store';
import { makeShow, makeShowWithSeasons, markWatchedFirst } from './helpers';

// Helper: reset dello store tra i test (lo store è un module-level singleton).
function resetState(): void {
  setState({
    shows: [],
    currentView: 'dashboard',
    currentShowId: null,
    currentSeason: 1,
    calendarWeekOffset: 0,
    _storageDisabled: false,
    _quotaWarned: false,
    _discoverTab: 'popular',
    _localDirty: false,
  });
}

// ---------------------------------------------------------------------------
// BUG-A2-01 [HIGH] setShows(null/undefined/non-array) corrompe state.shows
// ---------------------------------------------------------------------------
describe('BUG-A2-01: setShows validates non-array input', () => {
  beforeEach(resetState);

  it('setShows(null) non corrompe state.shows (rimane array vuoto)', () => {
    setShows([makeShow({ id: 1 })]);
    expect(getState().shows.length).toBe(1);
    // @ts-expect-error — intentionally invalid runtime input
    setShows(null);
    expect(Array.isArray(getState().shows)).toBe(true);
    expect(getState().shows).toEqual([]);
  });

  it('setShows(undefined) non corrompe state.shows', () => {
    setShows([makeShow({ id: 1 })]);
    // @ts-expect-error intentional invalid-type test input
    setShows(undefined);
    expect(Array.isArray(getState().shows)).toBe(true);
    expect(getState().shows).toEqual([]);
  });

  it('setShows(string) non corrompe state.shows', () => {
    // @ts-expect-error intentional invalid-type test input
    setShows('not-an-array');
    expect(Array.isArray(getState().shows)).toBe(true);
    expect(getState().shows).toEqual([]);
  });

  it('setShows({foo:bar}) non corrompe state.shows', () => {
    // @ts-expect-error intentional invalid-type test input
    setShows({ foo: 'bar' });
    expect(Array.isArray(getState().shows)).toBe(true);
    expect(getState().shows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BUG-A2-02 [HIGH] setShows/setState shallow-copy difensivo
// ---------------------------------------------------------------------------
describe('BUG-A2-02: setShows/setState defensive shallow-copy', () => {
  beforeEach(resetState);

  it('setShows non condivide la reference dell\'array con il caller', () => {
    const arr = [makeShow({ id: 1 })];
    setShows(arr);
    expect(getState().shows).not.toBe(arr);
    // Caller muta l'array originale dopo setShows → store non deve cambiare
    arr.push(makeShow({ id: 2 }));
    expect(getState().shows.length).toBe(1);
  });

  it('setState({ shows: arr }) non condivide la reference dell\'array', () => {
    const arr = [makeShow({ id: 1 })];
    setState({ shows: arr });
    expect(getState().shows).not.toBe(arr);
    arr.push(makeShow({ id: 2 }));
    expect(getState().shows.length).toBe(1);
  });

  it('removeShowFromState non crasha se state.shows è stato corrotto a null', () => {
    // Simula corruzione diretta
    (getState() as { shows: unknown }).shows = null;
    expect(() => removeShowFromState(1)).not.toThrow();
    expect(Array.isArray(getState().shows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG-A2-03 [HIGH] replaceShow valida show (null/undefined/id invalido)
// ---------------------------------------------------------------------------
describe('BUG-A2-03: replaceShow validates invalid show / id', () => {
  beforeEach(resetState);

  it('replaceShow(null) è no-op (non pusha garbage)', () => {
    // @ts-expect-error intentional invalid-type test input
    replaceShow(null);
    expect(getState().shows.length).toBe(0);
  });

  it('replaceShow(undefined) è no-op', () => {
    // @ts-expect-error intentional invalid-type test input
    replaceShow(undefined);
    expect(getState().shows.length).toBe(0);
  });

  it('replaceShow({}) (no id) è no-op', () => {
    // @ts-expect-error intentional invalid-type test input
    replaceShow({});
    expect(getState().shows.length).toBe(0);
  });

  it('replaceShow con id=0 è no-op (id non positivo)', () => {
    replaceShow({ ...makeShow(), id: 0 });
    expect(getState().shows.length).toBe(0);
  });

  it('replaceShow con id negativo è no-op', () => {
    replaceShow({ ...makeShow(), id: -5 });
    expect(getState().shows.length).toBe(0);
  });

  it('replaceShow con id=NaN è no-op', () => {
    replaceShow({ ...makeShow(), id: NaN });
    expect(getState().shows.length).toBe(0);
  });

  it('replaceShow con id=Infinity è no-op', () => {
    replaceShow({ ...makeShow(), id: Infinity });
    expect(getState().shows.length).toBe(0);
  });

  it('replaceShow con id valido funziona ancora (regression check)', () => {
    replaceShow(makeShow({ id: 100 }));
    expect(getState().shows.length).toBe(1);
    expect(getState().shows[0].id).toBe(100);
    // replace existing
    replaceShow({ ...makeShow({ id: 100 }), name: 'Updated' });
    expect(getState().shows.length).toBe(1);
    expect(getState().shows[0].name).toBe('Updated');
  });
});

// ---------------------------------------------------------------------------
// BUG-A2-04 [HIGH] getStateSnapshot deep-clona tags e genres
// ---------------------------------------------------------------------------
describe('BUG-A2-04: getStateSnapshot deep-clones tags & genres', () => {
  beforeEach(resetState);

  it('snapshot.tags è un nuovo array (non shared con live)', () => {
    const show = makeShow({ id: 1, tags: ['foo', 'bar'] });
    setShows([show]);
    const snap = getStateSnapshot();
    expect(snap.shows[0].tags).not.toBe(getState().shows[0].tags);
  });

  it('snapshot.genres è un nuovo array (non shared con live)', () => {
    const show = makeShow({ id: 1, genres: ['Drama', 'Comedy'] });
    setShows([show]);
    const snap = getStateSnapshot();
    expect(snap.shows[0].genres).not.toBe(getState().shows[0].genres);
  });

  it('mutare snapshot.tags non leaka nel live state', () => {
    const show = makeShow({ id: 1, tags: ['foo'] });
    setShows([show]);
    const snap = getStateSnapshot();
    snap.shows[0].tags!.push('leaked');
    expect(getState().shows[0].tags).toEqual(['foo']);
  });

  it('mutare snapshot.genres non leaka nel live state', () => {
    const show = makeShow({ id: 1, genres: ['Drama'] });
    setShows([show]);
    const snap = getStateSnapshot();
    snap.shows[0].genres.push('leaked');
    expect(getState().shows[0].genres).toEqual(['Drama']);
  });

  it('tags undefined nello show → snapshot.tags resta undefined (no crash)', () => {
    const show = makeShow({ id: 1 });
    delete show.tags;
    setShows([show]);
    const snap = getStateSnapshot();
    expect(snap.shows[0].tags).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BUG-A2-05 [HIGH] getStateSnapshot gestisce seasons malformati
// ---------------------------------------------------------------------------
describe('BUG-A2-05: getStateSnapshot handles malformed seasons', () => {
  beforeEach(resetState);

  it('seasons=null non crasha (restituisce {} nel snapshot)', () => {
    const show = makeShow({ id: 1 });
    // @ts-expect-error — intentionally malformed
    show.seasons = null;
    setShows([show]);
    expect(() => getStateSnapshot()).not.toThrow();
    const snap = getStateSnapshot();
    expect(snap.shows[0].seasons).toEqual({});
  });

  it('seasons=undefined non crasha', () => {
    const show = makeShow({ id: 1 });
    // @ts-expect-error intentional invalid-type test input
    show.seasons = undefined;
    setShows([show]);
    expect(() => getStateSnapshot()).not.toThrow();
    expect(getStateSnapshot().shows[0].seasons).toEqual({});
  });

  it('seasons=array non crasha (trattato come non-object)', () => {
    const show = makeShow({ id: 1 });
    // @ts-expect-error intentional invalid-type test input
    show.seasons = [['ep1']];
    setShows([show]);
    expect(() => getStateSnapshot()).not.toThrow();
    expect(getStateSnapshot().shows[0].seasons).toEqual({});
  });

  it('seasons con value non-array → snapshot ha [] per quella season', () => {
    const show = makeShow({ id: 1 });
    // @ts-expect-error intentional invalid-type test input
    show.seasons = { 1: 'not-an-array', 2: 42 };
    setShows([show]);
    const snap = getStateSnapshot();
    expect(Array.isArray(snap.shows[0].seasons[1])).toBe(true);
    expect(snap.shows[0].seasons[1]).toEqual([]);
    expect(snap.shows[0].seasons[2]).toEqual([]);
  });

  it('state.shows non-array non crasha getStateSnapshot (defense-in-depth)', () => {
    (getState() as { shows: unknown }).shows = null;
    expect(() => getStateSnapshot()).not.toThrow();
    expect(getStateSnapshot().shows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BUG-A2-06 [HIGH] setState valida shows se presente nel patch
// ---------------------------------------------------------------------------
describe('BUG-A2-06: setState validates `shows` field if present', () => {
  beforeEach(resetState);

  it('setState({ shows: null }) non corrompe state.shows (preserva existing)', () => {
    setShows([makeShow({ id: 1 })]);
    expect(getState().shows.length).toBe(1);
    // @ts-expect-error intentional invalid-type test input
    setState({ shows: null });
    expect(Array.isArray(getState().shows)).toBe(true);
    expect(getState().shows.length).toBe(1); // preserved, not wiped
  });

  it('setState({ shows: undefined }) non corrompe state.shows', () => {
    setShows([makeShow({ id: 1 })]);
    // Note: { shows: undefined } is TS-legal (optional prop), but runtime-invalid.
    setState({ shows: undefined as unknown as Show[] });
    expect(Array.isArray(getState().shows)).toBe(true);
    expect(getState().shows.length).toBe(1);
  });

  it('setState({ shows: null, currentView: "x" }) applica currentView ma scarta shows', () => {
    setShows([makeShow({ id: 1 })]);
    // @ts-expect-error intentional invalid-type test input
    setState({ shows: null, currentView: 'library' });
    expect(getState().shows.length).toBe(1); // preserved
    expect(getState().currentView).toBe('library'); // applied
  });

  it('setState({ shows: "not-array" }) non corrompe', () => {
    setShows([makeShow({ id: 1 })]);
    // @ts-expect-error intentional invalid-type test input
    setState({ shows: 'not-array' });
    expect(Array.isArray(getState().shows)).toBe(true);
    expect(getState().shows.length).toBe(1);
  });

  it('setState(non-object) è no-op', () => {
    setShows([makeShow({ id: 1 })]);
    // @ts-expect-error intentional invalid-type test input
    setState(null);
    // @ts-expect-error intentional invalid-type test input
    setState(undefined);
    // @ts-expect-error intentional invalid-type test input
    setState('string');
    expect(getState().shows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BUG-A2-07 [MEDIUM] emitChange snapshot dei listener (reentrancy-safe)
// ---------------------------------------------------------------------------
describe('BUG-A2-07: emitChange listener iteration is reentrancy-safe', () => {
  beforeEach(resetState);

  it('listener iscritto durante l\'emit NON firea nello stesso flush', async () => {
    const late = vi.fn();
    let unsubLate: () => void = () => {};
    const early = vi.fn(() => {
      unsubLate = subscribe(late);
    });
    const unsubEarly = subscribe(early);

    emitChange();
    // Wait for RAF + buffer
    await new Promise((r) => setTimeout(r, 60));

    expect(early).toHaveBeenCalledTimes(1);
    // FIXED: late non deve fireare nello stesso flush — verrebbe chiamato
    // dal vivo Set.forEach senza la snapshot.
    expect(late).not.toHaveBeenCalled();

    unsubEarly();
    unsubLate();
  });

  it('listener che si disiscrive da solo non crasha e firea una sola volta', async () => {
    let calls = 0;
    const self = vi.fn(() => {
      calls++;
      if (calls === 1) unsub();
    });
    const unsub = subscribe(self);

    emitChange();
    await new Promise((r) => setTimeout(r, 60));
    expect(self).toHaveBeenCalledTimes(1);

    // Re-emit: self non deve fireare (disiscritto)
    emitChange();
    await new Promise((r) => setTimeout(r, 60));
    expect(self).toHaveBeenCalledTimes(1);
  });

  it('listener A che disiscrive listener B (non ancora chiamato) → B saltato', async () => {
    const b = vi.fn();
    let unsubB: () => void = () => {};
    const a = vi.fn(() => {
      unsubB();
    });
    const unsubA = subscribe(a);
    unsubB = subscribe(b);

    emitChange();
    await new Promise((r) => setTimeout(r, 60));

    expect(a).toHaveBeenCalledTimes(1);
    // B è stato rimosso da A prima di essere chiamato → B saltato.
    expect(b).not.toHaveBeenCalled();

    unsubA();
  });

  it('listener che throw non blocca gli altri listener', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const unsubT = subscribe(throwing);
    const unsubA = subscribe(after);

    emitChange();
    await new Promise((r) => setTimeout(r, 60));

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1); // still called despite throw
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
    unsubT();
    unsubA();
  });

  it('emitChange ricorsivo da un listener programma un nuovo flush', async () => {
    let count = 0;
    const fn = vi.fn(() => {
      count++;
      if (count < 2) emitChange();
    });
    const unsub = subscribe(fn);

    emitChange();
    await new Promise((r) => setTimeout(r, 80));

    expect(fn).toHaveBeenCalledTimes(2); // initial + recursive
    unsub();
  });
});

// ---------------------------------------------------------------------------
// BUG-A2-08 [LOW] subscribe valida che fn sia una funzione
// ---------------------------------------------------------------------------
describe('BUG-A2-08: subscribe validates fn is a function', () => {
  beforeEach(resetState);

  it('subscribe(null) è no-op, ritorna unsubscribe no-op', () => {
    // @ts-expect-error intentional invalid-type test input
    const unsub = subscribe(null);
    expect(() => unsub()).not.toThrow();
    // emit non deve fireare (null non aggiunto al Set)
    const marker = vi.fn();
    const unsubM = subscribe(marker);
    emitChange();
    return new Promise((r) => setTimeout(r, 60)).then(() => {
      expect(marker).toHaveBeenCalledTimes(1); // only marker, not null
      unsubM();
    });
  });

  it('subscribe(undefined) è no-op', () => {
    // @ts-expect-error intentional invalid-type test input
    const unsub = subscribe(undefined);
    expect(() => unsub()).not.toThrow();
  });

  it('subscribe(42) è no-op', () => {
    // @ts-expect-error intentional invalid-type test input
    const unsub = subscribe(42);
    expect(() => unsub()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Combinatorial / edge case stress
// ---------------------------------------------------------------------------
describe('BUG-A2 edge: combinazioni + immutabilità post-fix', () => {
  beforeEach(resetState);

  it('snapshot di show con tutti i campi (tags, genres, seasons) è totalmente isolato', () => {
    const show = makeShowWithSeasons({ 1: 3 }, {
      id: 7,
      tags: ['gold', 'rewatch'],
      genres: ['Drama', 'Thriller'],
      list: 'watching',
      manualList: true,
    });
    markWatchedFirst(show, 1, 2);
    setShows([show]);

    const snap = getStateSnapshot();

    // Tutti i livelli sono reference diverse
    expect(snap.shows).not.toBe(getState().shows);
    expect(snap.shows[0]).not.toBe(getState().shows[0]);
    expect(snap.shows[0].tags).not.toBe(getState().shows[0].tags);
    expect(snap.shows[0].genres).not.toBe(getState().shows[0].genres);
    expect(snap.shows[0].seasons).not.toBe(getState().shows[0].seasons);
    expect(snap.shows[0].seasons[1]).not.toBe(getState().shows[0].seasons[1]);
    expect(snap.shows[0].seasons[1][0]).not.toBe(getState().shows[0].seasons[1][0]);

    // Mutazioni sul snapshot non leakano.
    // Episodio [1][2] è unwatched nel live (markWatchedFirst ha marcato solo 0,1).
    // Mutiamo il snapshot a watched=true → il live deve restare false.
    snap.shows[0].tags!.push('leaked');
    snap.shows[0].genres.push('leaked');
    snap.shows[0].seasons[1][2].watched = true;
    snap.shows[0].list = 'completed';

    const live = getState().shows[0];
    expect(live.tags).toEqual(['gold', 'rewatch']);
    expect(live.genres).toEqual(['Drama', 'Thriller']);
    expect(live.seasons[1][2].watched).toBe(false);
    expect(live.list).toBe('watching');
  });

  it('replaceShow + removeShowFromState flow con id mistivalidi/invalidi', () => {
    // Setup con show validi
    setShows([makeShow({ id: 10 }), makeShow({ id: 20 }), makeShow({ id: 30 })]);
    expect(getState().shows.length).toBe(3);

    // replace di un esistente
    replaceShow({ ...makeShow({ id: 20 }), name: 'Updated 20' });
    expect(getState().shows.length).toBe(3);
    expect(getState().shows.find((s) => s.id === 20)?.name).toBe('Updated 20');

    // replace di un non-esistente (id valido) → push
    replaceShow(makeShow({ id: 40 }));
    expect(getState().shows.length).toBe(4);

    // replace invalido → no-op
    // @ts-expect-error intentional invalid-type test input
    replaceShow(null);
    replaceShow({ ...makeShow(), id: 0 });
    expect(getState().shows.length).toBe(4);

    // remove inesistente → no-op (ma emette)
    removeShowFromState(999);
    expect(getState().shows.length).toBe(4);

    // remove esistente
    removeShowFromState(20);
    expect(getState().shows.length).toBe(3);
    expect(getState().shows.find((s) => s.id === 20)).toBeUndefined();
  });

  it('updateShowListStatus: edge cases misti non producono stati invalidi', () => {
    // totalEp=0, watched=0, manualList=false, list=watching → towatch
    const s1 = makeShow({ list: 'watching', manualList: false, seasons: {}, totalEpisodes: 0 });
    updateShowListStatus(s1);
    expect(s1.list).toBe('towatch');

    // totalEp=NaN, watched=0, list=watching → towatch (non crasha)
    const s2 = makeShow({ list: 'watching', manualList: false, seasons: {}, totalEpisodes: NaN });
    updateShowListStatus(s2);
    expect(s2.list).toBe('towatch');

    // totalEp negativo, watched=0, list=completed → towatch
    const s3 = makeShow({ list: 'completed', manualList: false, seasons: {}, totalEpisodes: -5 });
    updateShowListStatus(s3);
    expect(s3.list).toBe('towatch');

    // totalEp=0, manualList=true, list=watching → resta watching (manual)
    const s4 = makeShow({ list: 'watching', manualList: true, seasons: {}, totalEpisodes: 0 });
    updateShowListStatus(s4);
    expect(s4.list).toBe('watching');
  });

  it('snapshot con show parziale (campi mancanti) non crasha', () => {
    const partial = {
      id: 1,
      name: 'Partial',
      image: null,
      status: 'Running',
      premiered: null,
      genres: [],
      summary: '',
      network: '',
      runtime: 0,
      list: 'towatch' as const,
      // seasons mancante
      totalSeasons: 0,
      totalEpisodes: 0,
      addedAt: 0,
    };
    setShows([partial as never]);
    expect(() => getStateSnapshot()).not.toThrow();
    const snap = getStateSnapshot();
    expect(snap.shows[0].seasons).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Regression: existing behaviors must be preserved
// ---------------------------------------------------------------------------
describe('BUG-A2 regression: existing behaviors preserved', () => {
  beforeEach(resetState);

  it('setShows con array valido funziona normalmente', () => {
    const shows = [makeShow({ id: 1 }), makeShow({ id: 2 })];
    setShows(shows);
    expect(getState().shows.length).toBe(2);
    expect(getState().shows[0].id).toBe(1);
  });

  it('replaceShow esistente sostituisce in-place (no push)', () => {
    setShows([makeShow({ id: 1, name: 'Old' })]);
    replaceShow(makeShow({ id: 1, name: 'New' }));
    expect(getState().shows.length).toBe(1);
    expect(getState().shows[0].name).toBe('New');
  });

  it('removeShowFromState rimuove solo l\'id specificato', () => {
    setShows([makeShow({ id: 1 }), makeShow({ id: 2 }), makeShow({ id: 3 })]);
    removeShowFromState(2);
    expect(getState().shows.map((s) => s.id)).toEqual([1, 3]);
  });

  it('subscribe/unsubscribe normali funzionano', async () => {
    const fn = vi.fn();
    const unsub = subscribe(fn);
    emitChange();
    await new Promise((r) => setTimeout(r, 60));
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    emitChange();
    await new Promise((r) => setTimeout(r, 60));
    expect(fn).toHaveBeenCalledTimes(1); // not called after unsub
  });

  it('snapshot preserva i valori dei campi scalari', () => {
    const show = makeShowWithSeasons({ 1: 2 }, {
      id: 42,
      name: 'Test',
      list: 'watching',
      manualList: true,
      runtime: 60,
      totalEpisodes: 2,
      totalSeasons: 1,
    });
    markWatchedFirst(show, 1, 1);
    setShows([show]);

    const snap = getStateSnapshot();
    expect(snap.shows[0].id).toBe(42);
    expect(snap.shows[0].name).toBe('Test');
    expect(snap.shows[0].list).toBe('watching');
    expect(snap.shows[0].manualList).toBe(true);
    expect(snap.shows[0].runtime).toBe(60);
    expect(snap.shows[0].totalEpisodes).toBe(2);
    expect(snap.shows[0].totalSeasons).toBe(1);
    expect(snap.shows[0].seasons[1].length).toBe(2);
    expect(snap.shows[0].seasons[1][0].watched).toBe(true);
    expect(snap.shows[0].seasons[1][1].watched).toBe(false);
  });
});
