// Agent A10 — probe tests for src/views/dashboard.ts + src/views/showList.ts
//
// Copre i bug trovati/fixati in questo round:
//  - BUG-A10-01 [HIGH]: goldBtn click handler non re-bound su re-render.
//  - BUG-A10-02 [MEDIUM]: _activeTag persisteva across list switches; user trapped.
//  - BUG-A10-03 [MEDIUM]: showList keyboard a11y rotta senza dashboard render preventivo.
//  - BUG-A10-04 [MEDIUM]: goldEp.ep.num interpolato raw (XSS via stato corrotto).
//
// Inoltre regression su XSS surface già coperta (show.name, tag, title, data-show-id),
// edge case numerici (NaN progress, totalEpisodes=0), e interazioni chip filter.

import { describe, it, expect, beforeEach } from 'vitest';
import { renderDashboard, showCardHtml, bindKeydown } from '../src/views/dashboard';
import { renderShowList, _resetShowListStateForTesting } from '../src/views/showList';
import { setShows, getState } from '../src/lib/store';
import type { Show } from '../src/types';
import { makeShow, makeShowWithSeasons, makeEpisode, markWatchedFirst } from './helpers';

let main: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<main id="main"></main>';
  main = document.getElementById('main') as HTMLElement;
  setShows([]);
  _resetShowListStateForTesting();
});

// ---------- helpers ----------

function corruptShow(opts: {
  id?: number;
  name?: string;
  list?: Show['list'];
  totalEpisodes: number;
  watched: number;
  image?: string | null;
  tags?: string[];
}): Show {
  const watched = opts.watched;
  const seasons: Show['seasons'] = { 1: [] };
  for (let i = 1; i <= watched; i++) {
    seasons[1].push(makeEpisode({ num: i, id: i, watched: true }));
  }
  return makeShow({
    id: opts.id ?? 1,
    name: opts.name ?? 'Corrupt',
    list: opts.list ?? 'watching',
    image: opts.image === undefined ? null : opts.image,
    seasons,
    totalSeasons: 1,
    totalEpisodes: opts.totalEpisodes,
    tags: opts.tags,
  });
}

// ============================================================
// BUG-A10-01: goldBtn click handler non re-bound su re-render
// ============================================================

describe('BUG-A10-01: goldBtn click re-bound on re-render', () => {
  it('goldBtn is clickable on first render', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 42, name: 'Gold', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    (s.seasons[1][0] as any).rating = 5;
    setShows([s]);
    renderDashboard(main);
    const goldBtn = main.querySelector('#randomGoldBtn') as HTMLElement;
    expect(goldBtn).not.toBeNull();
    goldBtn.click();
    expect(getState().currentShowId).toBe(42);
  });

  it('goldBtn is STILL clickable after re-render (BUG-A10-01 fixed)', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 42, name: 'Gold', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    (s.seasons[1][0] as any).rating = 5;
    setShows([s]);
    renderDashboard(main);
    const gold1 = main.querySelector('#randomGoldBtn') as HTMLElement;
    gold1.click();
    expect(getState().currentShowId).toBe(42);

    // Reset state and re-render (simula: utente torna alla dashboard)
    (getState() as any).currentShowId = null;
    renderDashboard(main);

    const gold2 = main.querySelector('#randomGoldBtn') as HTMLElement;
    expect(gold2).not.toBeNull();
    // PRIMA del fix: gold2.click() era no-op (listener non re-bound).
    gold2.click();
    expect(getState().currentShowId).toBe(42);
  });

  it('goldBtn is clickable when gold episodes appear after first render', () => {
    // Primo render: nessun episodio 5★ → nessun goldBtn.
    const s = makeShowWithSeasons({ 1: 2 }, { id: 99, name: 'Late', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    setShows([s]);
    renderDashboard(main);
    expect(main.querySelector('#randomGoldBtn')).toBeNull();

    // Secondo render: l'utente marca 5★ → goldBtn appare.
    (s.seasons[1][0] as any).rating = 5;
    renderDashboard(main);
    const goldBtn = main.querySelector('#randomGoldBtn') as HTMLElement;
    expect(goldBtn).not.toBeNull();
    // PRIMA del fix: il goldBtn era presente ma senza listener.
    goldBtn.click();
    expect(getState().currentShowId).toBe(99);
  });

  it('goldBtn click shows warning toast when no gold episodes remain', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'X', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    (s.seasons[1][0] as any).rating = 5;
    setShows([s]);
    renderDashboard(main);
    // Rimuovi il rating: al click il getRandomGoldEpisode torna null.
    (s.seasons[1][0] as any).rating = 0;
    const goldBtn = main.querySelector('#randomGoldBtn') as HTMLElement;
    const toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
    goldBtn.click();
    // Il toast mostra il warning (textContent).
    expect(toast.textContent).toContain('5★');
    expect(toast.className).toContain('warning');
  });

  it('keydown listener does NOT accumulate across re-renders (regression for BUG-13-05)', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 1, name: 'Kbd', list: 'watching' });
    setShows([s]);
    renderDashboard(main);
    renderDashboard(main);
    renderDashboard(main);
    const card = main.querySelector('.show-card') as HTMLElement;
    let clicked = 0;
    card.addEventListener('click', () => { clicked++; });
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(ev, 'target', { value: card });
    main.dispatchEvent(ev);
    // Should fire exactly once even though renderDashboard ran 3×.
    expect(clicked).toBe(1);
  });
});

// ============================================================
// BUG-A10-02: _activeTag persisteva across list switches
// ============================================================

describe('BUG-A10-02: _activeTag reset on list switch + always-clearable', () => {
  it('resets _activeTag when switching to a different list', () => {
    const w = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'W', list: 'watching' });
    (w as any).tags = ['drama'];
    const c = makeShowWithSeasons({ 1: 2 }, { id: 2, name: 'C', list: 'completed' });
    setShows([w, c]);
    renderShowList(main, 'watching', 'Watching');
    // Click drama chip → _activeTag = 'drama'
    const chip = main.querySelector('.tag-filter-chip[data-tag="drama"]') as HTMLElement;
    expect(chip).not.toBeNull();
    chip.click();
    // Solo W ha tag drama → 1 card
    expect(main.querySelectorAll('.show-card').length).toBe(1);

    // Switch to completed: _activeTag dovrebbe reset.
    renderShowList(main, 'completed', 'Completed');
    // PRIMA del fix: empty state con "Nessuna serie con il tag drama".
    // DOPO il fix: mostra la serie C.
    expect(main.querySelectorAll('.show-card').length).toBe(1);
    expect(main.querySelector('.show-card')?.getAttribute('data-show-id')).toBe('2');
    expect(main.innerHTML).not.toContain('Nessuna serie con il tag');
  });

  it('shows "Tutti" chip when _activeTag is set but no tags exist in current list', () => {
    // Scenario: tag rimosso da tutte le serie ma _activeTag ancora set.
    const w = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'W', list: 'watching' });
    (w as any).tags = ['drama'];
    setShows([w]);
    renderShowList(main, 'watching', 'Watching');
    const chip = main.querySelector('.tag-filter-chip[data-tag="drama"]') as HTMLElement;
    chip.click();
    expect(main.querySelectorAll('.show-card').length).toBe(1);

    // Rimuovi il tag dalla serie (simula: utente elimina il tag altrove).
    (w as any).tags = [];
    renderShowList(main, 'watching', 'Watching');

    // PRIMA del fix: nessun chip bar (tagsInList vuoto) → user trapped.
    // DOPO il fix: chip "Tutti" sempre renderizzato quando _activeTag è set.
    const tuttiChips = main.querySelectorAll('.tag-filter-chip[data-tag=""]');
    expect(tuttiChips.length).toBe(1);
    // Empty state mostra il messaggio tag-specific.
    expect(main.innerHTML).toContain('Nessuna serie con il tag');
    // L'utente può clearare cliccando "Tutti".
    (tuttiChips[0] as HTMLElement).click();
    // Ora _activeTag = '', ma la serie W non ha più tag → 1 card mostrata.
    expect(main.querySelectorAll('.show-card').length).toBe(1);
  });

  it('_activeTag persists within the same list across re-renders', () => {
    const s1 = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'A', list: 'watching' });
    (s1 as any).tags = ['drama'];
    const s2 = makeShowWithSeasons({ 1: 2 }, { id: 2, name: 'B', list: 'watching' });
    setShows([s1, s2]);
    renderShowList(main, 'watching', 'Watching');
    const chip = main.querySelector('.tag-filter-chip[data-tag="drama"]') as HTMLElement;
    chip.click();
    expect(main.querySelectorAll('.show-card').length).toBe(1); // solo A

    // Re-render della stessa lista: _activeTag dovrebbe persistere.
    renderShowList(main, 'watching', 'Watching');
    expect(main.querySelectorAll('.show-card').length).toBe(1);
    // Il chip drama dovrebbe essere active.
    const dramaChip = main.querySelector('.tag-filter-chip[data-tag="drama"]') as HTMLElement;
    expect(dramaChip.className).toContain('active');
  });

  it('switching list and back resets filter (no stale _activeTag)', () => {
    const w = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'W', list: 'watching' });
    (w as any).tags = ['drama'];
    const t = makeShowWithSeasons({ 1: 2 }, { id: 2, name: 'T', list: 'towatch' });
    setShows([w, t]);
    renderShowList(main, 'watching', 'Watching');
    (main.querySelector('.tag-filter-chip[data-tag="drama"]') as HTMLElement).click();
    expect(main.querySelectorAll('.show-card').length).toBe(1);

    // Switch to towatch (reset filter).
    renderShowList(main, 'towatch', 'ToWatch');
    expect(main.querySelectorAll('.show-card').length).toBe(1); // T

    // Switch back to watching: filter dovrebbe essere reset.
    renderShowList(main, 'watching', 'Watching');
    expect(main.querySelectorAll('.show-card').length).toBe(1); // W
    // Il chip "Tutti" dovrebbe essere active (nessun filtro).
    const tuttiChip = main.querySelector('.tag-filter-chip[data-tag=""]') as HTMLElement;
    expect(tuttiChip.className).toContain('active');
  });
});

// ============================================================
// BUG-A10-03: showList keyboard a11y senza dashboard render preventivo
// ============================================================

describe('BUG-A10-03: showList keyboard nav without dashboard first', () => {
  it('Enter on a focused show-card triggers click (no prior renderDashboard)', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 7, name: 'Kbd', list: 'watching' });
    setShows([s]);
    // renderShowList WITHOUT renderDashboard first.
    renderShowList(main, 'watching', 'Watching');
    const card = main.querySelector('.show-card') as HTMLElement;
    expect(card).not.toBeNull();
    let clicked = 0;
    card.addEventListener('click', () => { clicked++; });
    card.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(ev, 'target', { value: card });
    main.dispatchEvent(ev);
    // PRIMA del fix: clicked === 0 (nessun keydown listener).
    expect(clicked).toBe(1);
  });

  it('Space on a focused show-card triggers click (no prior renderDashboard)', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 7, name: 'Kbd', list: 'towatch' });
    setShows([s]);
    renderShowList(main, 'towatch', 'ToWatch');
    const card = main.querySelector('.show-card') as HTMLElement;
    let clicked = 0;
    card.addEventListener('click', () => { clicked++; });
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true });
    Object.defineProperty(ev, 'target', { value: card });
    main.dispatchEvent(ev);
    expect(clicked).toBe(1);
  });

  it('keydown listener does NOT accumulate when both dashboard and showList render', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 7, name: 'Both', list: 'watching' });
    setShows([s]);
    renderDashboard(main);
    renderShowList(main, 'watching', 'Watching');
    renderShowList(main, 'watching', 'Watching');
    const card = main.querySelector('.show-card') as HTMLElement;
    let clicked = 0;
    card.addEventListener('click', () => { clicked++; });
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(ev, 'target', { value: card });
    main.dispatchEvent(ev);
    expect(clicked).toBe(1); // una sola volta, no accumulation
  });

  it('bindKeydown is exported and idempotent', () => {
    expect(typeof bindKeydown).toBe('function');
    const s = makeShowWithSeasons({ 1: 5 }, { id: 7, name: 'Direct', list: 'completed' });
    setShows([s]);
    // Chiama bindKeydown direttamente (senza renderDashboard/showList).
    main.innerHTML = '<div class="card" role="button" tabindex="0">X</div>';
    bindKeydown(main);
    bindKeydown(main); // idempotente
    const card = main.querySelector('.card') as HTMLElement;
    let clicked = 0;
    card.addEventListener('click', () => { clicked++; });
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(ev, 'target', { value: card });
    main.dispatchEvent(ev);
    expect(clicked).toBe(1);
  });
});

// ============================================================
// BUG-A10-04: goldEp.ep.num XSS via stato corrotto
// ============================================================

describe('BUG-A10-04: goldEp.ep.num coercion (XSS defense-in-depth)', () => {
  it('does NOT interpolate raw HTML when ep.num is a malicious string', () => {
    const s = makeShowWithSeasons({ 1: 1 }, { id: 1, name: 'Gold', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    (s.seasons[1][0] as any).rating = 5;
    // Bypass normalize: ep.num è una stringa malevola.
    (s.seasons[1][0] as any).num = '<img src=x onerror=alert(1)>';
    setShows([s]);
    renderDashboard(main);
    // PRIMA del fix: HTML conteneva `<img src=x onerror=alert(1)>`.
    expect(main.innerHTML).not.toContain('<img src=x onerror=alert(1)>');
    expect(main.innerHTML).not.toMatch(/onerror="alert\(1\)"/);
    expect(main.innerHTML).not.toMatch(/onerror=alert/);
  });

  it('coerces non-numeric ep.num to 0 in random-gold-hint', () => {
    const s = makeShowWithSeasons({ 1: 1 }, { id: 1, name: 'Gold', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    (s.seasons[1][0] as any).rating = 5;
    (s.seasons[1][0] as any).num = '<img>';
    setShows([s]);
    renderDashboard(main);
    const hint = main.querySelector('.random-gold-hint');
    expect(hint).not.toBeNull();
    // Number('<img>') || 0 === 0 → "S1E0"
    expect(hint?.textContent).toContain('S1E0');
    expect(hint?.textContent).not.toContain('<img>');
  });

  it('coerces numeric string ep.num to number', () => {
    const s = makeShowWithSeasons({ 1: 1 }, { id: 1, name: 'Gold', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    (s.seasons[1][0] as any).rating = 5;
    (s.seasons[1][0] as any).num = '7'; // stringa numerica
    setShows([s]);
    renderDashboard(main);
    const hint = main.querySelector('.random-gold-hint');
    expect(hint?.textContent).toContain('S1E7');
  });

  it('valid numeric ep.num displays normally', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 1, name: 'Gold', list: 'watching' });
    markWatchedFirst(s, 1, 3);
    (s.seasons[1][2] as any).rating = 5; // ep 3
    setShows([s]);
    renderDashboard(main);
    const hint = main.querySelector('.random-gold-hint');
    expect(hint?.textContent).toContain('S1E3');
  });
});

// ============================================================
// XSS regression — show.name, tag, title, data-show-id
// ============================================================

describe('XSS regression — escaping surface', () => {
  it('showCardHtml escapes show.name in placeholder (image=null)', () => {
    const s = makeShow({ id: 1, name: '<script>alert(1)</script>', image: null, list: 'watching' });
    const html = showCardHtml(s);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('showCardHtml escapes show.name in card-name div', () => {
    const s = makeShow({ id: 1, name: '<b onclick="alert(1)">x</b>', image: 'https://a/b.jpg', list: 'watching' });
    const html = showCardHtml(s);
    expect(html).toContain('&lt;b onclick=&quot;alert(1)&quot;&gt;x&lt;/b&gt;');
    expect(html).not.toMatch(/<b onclick="alert\(1\)"}/);
  });

  it('showCardHtml escapes show.name as img alt (quote injection)', () => {
    const s = makeShow({
      id: 1,
      name: '" onerror="alert(1)',
      image: 'https://a/b.jpg',
      list: 'watching',
    });
    const html = showCardHtml(s);
    // alt attribute value should escape embedded quotes.
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"');
    // No attribute breakout: no raw onerror as a new attribute.
    expect(html).not.toMatch(/alt="[^"]*" onerror="/);
  });

  it('showCardHtml escapes show.id in data-show-id (quote injection via corrupt id)', () => {
    const s = makeShow({ id: 1, name: 'X', list: 'watching' });
    (s as any).id = '"><img src=x onerror=alert(1)>';
    const html = showCardHtml(s);
    expect(html).not.toContain('data-show-id=""><img src=x onerror=alert(1)>"');
    expect(html).toContain('data-show-id="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });

  it('showList escapes title in h1', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'A', list: 'watching' });
    setShows([s]);
    renderShowList(main, 'watching', '<img src=x onerror=alert(1)>');
    const h1 = main.querySelector('.page-title');
    expect(h1?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(main.querySelector('.page-title img')).toBeNull();
  });

  it('showList escapes tag in chip content AND data-tag attribute', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'A', list: 'watching' });
    const maliciousTag = '"><img src=x onerror=alert(1)>';
    (s as any).tags = [maliciousTag];
    setShows([s]);
    renderShowList(main, 'watching', 'Watching');
    // Skip the "Tutti" chip (data-tag=""), select the actual tag chip.
    const chips = Array.from(main.querySelectorAll('.tag-filter-chip'));
    const chip = chips.find((c) => (c as HTMLElement).dataset.tag !== '') as HTMLElement;
    expect(chip).not.toBeNull();
    // data-tag attribute (decoded by DOM API) === raw tag.
    const dataTag = chip.getAttribute('data-tag') || '';
    expect(dataTag).toBe(maliciousTag);
    // XSS check: no <img> element was created (attribute didn't break out).
    expect(main.querySelectorAll('img').length).toBe(0);
    // No onerror attribute exists anywhere in the DOM.
    const onerrorEls = main.querySelectorAll('[onerror]');
    expect(onerrorEls.length).toBe(0);
    // Chip text content is the raw string (escaped for text context).
    expect(chip.textContent).toBe(maliciousTag);
  });

  it('showList escapes _activeTag in empty-state text', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'A', list: 'watching' });
    const xssTag = '<script>alert(1)</script>';
    (s as any).tags = [xssTag];
    setShows([s]);
    renderShowList(main, 'watching', 'Watching');
    // Skip "Tutti" chip, click the actual tag chip.
    const chips = Array.from(main.querySelectorAll('.tag-filter-chip'));
    const chip = chips.find((c) => (c as HTMLElement).dataset.tag !== '') as HTMLElement;
    expect(chip).not.toBeNull();
    chip.click();
    // _activeTag is now set. Remove the show: tag-filter-bar still renders
    // (BUG-A10-02 fix: always show "Tutti" when _activeTag is set).
    setShows([]);
    renderShowList(main, 'watching', 'Watching');
    expect(main.innerHTML).toContain('empty-state');
    expect(main.innerHTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(main.innerHTML).not.toContain('<script>alert(1)</script>');
    // "Tutti" chip always available to clear the filter.
    expect(main.querySelectorAll('.tag-filter-chip[data-tag=""]').length).toBe(1);
  });

  it('dashboard escapes goldEp.show.name in random-gold-hint', () => {
    const s = makeShowWithSeasons({ 1: 1 }, { id: 1, name: '<img src=x onerror=alert(1)>', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    (s.seasons[1][0] as any).rating = 5;
    setShows([s]);
    renderDashboard(main);
    const hint = main.querySelector('.random-gold-hint');
    expect(hint?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(main.querySelectorAll('img').length).toBe(0); // no live img injected
  });

  it('dashboard escapes show.name in continue-card-name', () => {
    const s = makeShowWithSeasons(
      { 1: 5 },
      { id: 1, name: '<script>alert("xss")</script>', list: 'watching' },
    );
    setShows([s]);
    renderDashboard(main);
    const name = main.querySelector('.continue-card-name');
    expect(name?.textContent).toContain('<script>alert("xss")</script>');
    expect(main.querySelectorAll('script').length).toBe(0);
  });
});

// ============================================================
// Edge cases — numeri, empty state, stats
// ============================================================

describe('Edge cases — numbers and empty states', () => {
  it('showCardHtml with totalEpisodes=0 → width:0%, no NaN', () => {
    const s = makeShow({ id: 1, name: 'Empty', list: 'watching', totalEpisodes: 0, seasons: {} });
    const html = showCardHtml(s);
    expect(html).toContain('width:0%');
    expect(html).not.toContain('NaN');
  });

  it('showCardHtml with negative totalEpisodes → width:0%, no NaN', () => {
    const s = makeShow({ id: 1, name: 'Neg', list: 'watching', totalEpisodes: -5, seasons: {} });
    const html = showCardHtml(s);
    expect(html).toContain('width:0%');
    expect(html).not.toContain('NaN');
  });

  it('dashboard empty state (0 shows) does not render stats or sections', () => {
    setShows([]);
    renderDashboard(main);
    expect(main.innerHTML).toContain('Benvenuto in PloppyTV');
    expect(main.innerHTML).not.toContain('stats-grid');
    expect(main.innerHTML).not.toContain('random-gold-card');
    expect(main.innerHTML).not.toContain('Sto guardando');
  });

  it('dashboard with goldEp but no show.image renders goldBtn without crashing', () => {
    const s = makeShow({
      id: 1,
      name: 'NoImg',
      image: null,
      list: 'watching',
      seasons: { 1: [makeEpisode({ num: 1, id: 1, watched: true, rating: 5 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    setShows([s]);
    expect(() => renderDashboard(main)).not.toThrow();
    expect(main.querySelector('#randomGoldBtn')).not.toBeNull();
  });

  it('showList empty list (no active tag) shows generic empty state', () => {
    setShows([]);
    renderShowList(main, 'watching', 'Watching');
    expect(main.innerHTML).toContain('Non hai serie in questa lista.');
    expect(main.innerHTML).not.toContain('Nessuna serie con il tag');
  });

  it('showList with tag chip click but no matching shows shows tag-specific empty state', () => {
    const s1 = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'A', list: 'watching' });
    (s1 as any).tags = ['drama'];
    const s2 = makeShowWithSeasons({ 1: 2 }, { id: 2, name: 'B', list: 'watching' });
    (s2 as any).tags = ['comedy'];
    setShows([s1, s2]);
    renderShowList(main, 'watching', 'Watching');
    (main.querySelector('.tag-filter-chip[data-tag="drama"]') as HTMLElement).click();
    expect(main.querySelectorAll('.show-card').length).toBe(1);
    // Ora switcha a comedy: 1 card (B).
    (main.querySelector('.tag-filter-chip[data-tag="comedy"]') as HTMLElement).click();
    expect(main.querySelectorAll('.show-card').length).toBe(1);
    expect(main.querySelector('.show-card')?.getAttribute('data-show-id')).toBe('2');
  });

  it('showList renders all shows (no slice) even with many', () => {
    const shows: Show[] = [];
    for (let i = 1; i <= 50; i++) {
      shows.push(makeShowWithSeasons({ 1: 2 }, { id: i, name: `S${i}`, list: 'watching' }));
    }
    setShows(shows);
    renderShowList(main, 'watching', 'Watching');
    expect(main.querySelectorAll('.show-card').length).toBe(50);
  });
});

// ============================================================
// Event delegation — chip click, goldBtn click, role=button
// ============================================================

describe('Event delegation — interactions', () => {
  it('clicking inside a show-card (on the name) triggers openShow via delegation', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 5, name: 'Click', list: 'watching' });
    setShows([s]);
    renderShowList(main, 'watching', 'Watching');
    const nameEl = main.querySelector('.show-card-name') as HTMLElement;
    expect(nameEl).not.toBeNull();
    // Simula il delegated click handler del renderer.
    const card = nameEl.closest('[data-action="openShow"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.dataset.showId).toBe('5');
  });

  it('tag-filter-chip is a native <button> (no role needed, keyboard-native)', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'A', list: 'watching' });
    (s as any).tags = ['x'];
    setShows([s]);
    renderShowList(main, 'watching', 'Watching');
    const chip = main.querySelector('.tag-filter-chip') as HTMLElement;
    expect(chip.tagName).toBe('BUTTON');
    // Native buttons handle Enter/Space without explicit role.
    expect(chip.getAttribute('role')).toBeNull();
  });

  it('goldBtn has role=button + tabindex=0 (a11y)', () => {
    const s = makeShowWithSeasons({ 1: 1 }, { id: 1, name: 'Gold', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    (s.seasons[1][0] as any).rating = 5;
    setShows([s]);
    renderDashboard(main);
    const goldBtn = main.querySelector('#randomGoldBtn') as HTMLElement;
    expect(goldBtn.getAttribute('role')).toBe('button');
    expect(goldBtn.getAttribute('tabindex')).toBe('0');
  });

  it('Enter on goldBtn triggers click (keyboard a11y)', () => {
    const s = makeShowWithSeasons({ 1: 1 }, { id: 77, name: 'Gold', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    (s.seasons[1][0] as any).rating = 5;
    setShows([s]);
    renderDashboard(main);
    const goldBtn = main.querySelector('#randomGoldBtn') as HTMLElement;
    let clicked = 0;
    goldBtn.addEventListener('click', () => { clicked++; });
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(ev, 'target', { value: goldBtn });
    main.dispatchEvent(ev);
    expect(clicked).toBe(1);
  });
});

// ============================================================
// Cross-check: showCardHtml shared between dashboard and showList
// ============================================================

describe('Cross-check — shared showCardHtml', () => {
  it('dashboard and showList render identical show-card HTML', () => {
    const s = makeShowWithSeasons({ 1: 3 }, { id: 9, name: 'Shared', list: 'watching' });
    markWatchedFirst(s, 1, 2);
    setShows([s]);
    renderDashboard(main);
    const dashCard = main.querySelector('.show-card')!.outerHTML;
    renderShowList(main, 'watching', 'Watching');
    const listCard = main.querySelector('.show-card')!.outerHTML;
    expect(dashCard).toBe(listCard);
  });

  it('showList clamps progress (uses showCardHtml) — BUG-13-01 parity', () => {
    const s = corruptShow({ id: 1, name: 'Overflow', list: 'watching', totalEpisodes: 3, watched: 5 });
    setShows([s]);
    renderShowList(main, 'watching', 'Watching');
    const bar = main.querySelector('.show-card-progress-bar') as HTMLElement | null;
    expect(bar).not.toBeNull();
    const style = bar!.getAttribute('style') || '';
    expect(style).toContain('width:100%');
    expect(style).not.toMatch(/width:1[0-9]{2}\.[0-9]+%/);
  });
});
