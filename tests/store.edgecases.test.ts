// Test: edge-case & bug-hunt tests for src/lib/store.ts
//
// Each test maps to a specific-XX fix in store.ts. Tests are written
// to FAIL on the pre-fix code and PASS on the post-fix code.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getState,
  setState,
  subscribe,
  emitChange,
  setShows,
  replaceShow,
  removeShowFromState,
} from '../src/lib/store';
import { updateShowListStatus } from '../src/lib/normalize';
import { makeShow } from './helpers';

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
  });
}

// ---------------------------------------------------------------------------
// 02 [HIGH] setShows/setState shallow-copy difensivo
// ---------------------------------------------------------------------------
describe('setShows/setState defensive shallow-copy', () => {
  beforeEach(resetState);

  it("setShows non condivide la reference dell'array con il caller", () => {
    const arr = [makeShow({ id: 1 })];
    setShows(arr);
    expect(getState().shows).not.toBe(arr);
    // Caller muta l'array originale dopo setShows → store non deve cambiare
    arr.push(makeShow({ id: 2 }));
    expect(getState().shows.length).toBe(1);
  });

  it("setState({ shows: arr }) non condivide la reference dell'array", () => {
    const arr = [makeShow({ id: 1 })];
    setState({ shows: arr });
    expect(getState().shows).not.toBe(arr);
    arr.push(makeShow({ id: 2 }));
    expect(getState().shows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 07 [MEDIUM] emitChange snapshot dei listener (reentrancy-safe)
// ---------------------------------------------------------------------------
describe('emitChange listener iteration is reentrancy-safe', () => {
  beforeEach(resetState);

  it("listener iscritto durante l'emit NON firea nello stesso flush", async () => {
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
// 08 [LOW] subscribe valida che fn sia una funzione
// ---------------------------------------------------------------------------
describe('subscribe validates fn is a function', () => {
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
describe('edge: combinazioni + immutabilità post-fix', () => {
  beforeEach(resetState);

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
});

// ---------------------------------------------------------------------------
// Regression: existing behaviors must be preserved
// ---------------------------------------------------------------------------
describe('regression: existing behaviors preserved', () => {
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

  it("removeShowFromState rimuove solo l'id specificato", () => {
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
});
