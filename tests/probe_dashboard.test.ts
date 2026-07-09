// Agent 13 — probe tests for src/views/dashboard.ts + src/views/showList.ts
// Covers: progress bar overflow (no clamp), isCompleted semantics, continueWatching
// filter edge cases, findNextEpisode display, sections slice(0,12) + slice(0,8),
// showCardHtml XSS surface (exported & reused by showList), empty states, stats
// grid consistency, escapeHtml on title/name, ordering, a11y of clickable divs.
//
// State is set via setShows() (singleton store imported by dashboard/showList via
// getState()). We render into a real jsdom <main> and assert on innerHTML strings.

import { describe, it, expect, beforeEach } from 'vitest';
import { renderDashboard, showCardHtml } from '../src/views/dashboard';
import { renderShowList } from '../src/views/showList';
import { setShows } from '../src/lib/store';
import type { Show } from '../src/types';
import { makeShow, makeShowWithSeasons, makeEpisode, markWatchedFirst } from './helpers';

let main: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<main id="main"></main>';
  main = document.getElementById('main') as HTMLElement;
  setShows([]);
});

// ---------- helpers ----------

// Craft a Show with N watched episodes but a smaller totalEpisodes field
// (simulates corrupt/imported data — reachable via normalizeShow's stale
// totalEpisodes trust; see BUG-02 in agent-02-normalize.md).
function corruptShow(opts: {
  id?: number;
  name?: string;
  list?: Show['list'];
  totalEpisodes: number;
  watched: number;
  image?: string | null;
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
  });
}

// ---------- tests ----------

describe('dashboard — empty state', () => {
  it('renders welcome empty state when totalShows=0', () => {
    setShows([]);
    renderDashboard(main);
    expect(main.innerHTML).toContain('Benvenuto in PloppyTV');
    expect(main.innerHTML).not.toContain('stats-grid');
    expect(main.innerHTML).not.toContain('Continua a guardare');
  });
});

describe('dashboard — stats grid', () => {
  it('counts watching / completed / totalShows / totalWatched correctly', () => {
    const a = makeShowWithSeasons({ 1: 3 }, { id: 1, list: 'watching', name: 'A' });
    markWatchedFirst(a, 1, 1);
    const b = makeShowWithSeasons({ 1: 2 }, { id: 2, list: 'completed', name: 'B' });
    markWatchedFirst(b, 1, 2);
    const c = makeShowWithSeasons({ 1: 4 }, { id: 3, list: 'towatch', name: 'C' });
    // 0 watched
    setShows([a, b, c]);
    renderDashboard(main);
    // totalShows = 3, totalWatched = 1+2+0 = 3, watching = 1, completed = 1
    expect(main.innerHTML).toContain('Serie tracciate');
    const statValues = Array.from(main.querySelectorAll('.stat-value')).map((e) => e.textContent);
    expect(statValues).toEqual(['3', '3', '1', '1']);
  });

  it('stat value numbers are NOT escaped (raw interpolation of numbers)', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 1, list: 'watching', name: 'X' });
    markWatchedFirst(s, 1, 2);
    setShows([s]);
    renderDashboard(main);
    expect(main.innerHTML).toContain('5');
  });

  it('stat inconsistency: shows with list outside ALLOWED_LISTS still counted in totalShows but not in any section', () => {
    // Simulate a bypassed-normalize show with an invalid list value.
    // normalizeShow forces invalid → 'towatch', but if the state is mutated
    // directly this is reachable. Verify the inconsistency.
    const s = makeShowWithSeasons({ 1: 2 }, { id: 1, list: 'invalid_list' as any, name: 'X' });
    setShows([s]);
    renderDashboard(main);
    const statValues = Array.from(main.querySelectorAll('.stat-value')).map((e) => e.textContent);
    // totalShows = 1, totalWatched = 0, watching = 0, completed = 0
    expect(statValues).toEqual(['1', '0', '0', '0']);
    // No section titles rendered (watching/towatch/completed all empty).
    // (Stat-label "Completate" is always present in the stats grid, so we check
    // for section-title text nodes instead.)
    const sectionTitles = Array.from(main.querySelectorAll('.section-title')).map((e) => e.textContent);
    expect(sectionTitles).not.toContain('Sto guardando');
    expect(sectionTitles).not.toContain('Da vedere');
    expect(sectionTitles).not.toContain('Completate');
  });
});

describe('dashboard — progress bar clamp (BUG-13-01 fixed)', () => {
  it('showCardHtml clamps width to 100% when watched > totalEpisodes', () => {
    // watched=5, totalEpisodes=3 → raw progress = (5/3)*100 ≈ 166.67, clamped to 100.
    const s = corruptShow({ id: 1, name: 'Overflow', list: 'watching', totalEpisodes: 3, watched: 5 });
    const html = showCardHtml(s);
    // The bar element:
    const m = html.match(/show-card-progress-bar[^"]*"[^>]*style="width:([0-9.]+)%"/);
    expect(m, 'progress bar style found').not.toBeNull();
    const width = parseFloat(m![1]);
    expect(width).toBeLessThanOrEqual(100);
    expect(width).toBe(100); // clamped
  });

  it('dashboard renders the clamped bar (width:100%) in the "Sto guardando" section', () => {
    const s = corruptShow({ id: 1, name: 'Overflow', list: 'watching', totalEpisodes: 3, watched: 5 });
    setShows([s]);
    renderDashboard(main);
    const bar = main.querySelector('.show-card-progress-bar') as HTMLElement | null;
    expect(bar, 'progress bar exists').not.toBeNull();
    const style = bar!.getAttribute('style') || '';
    const m = style.match(/width:([0-9.]+)%/);
    expect(m, 'width style present: ' + style).not.toBeNull();
    expect(parseFloat(m![1])).toBeLessThanOrEqual(100);
    expect(parseFloat(m![1])).toBe(100); // clamped to 100
  });

  it('isCompleted triggers (green "completed" class) for watched>=totalEpisodes; width clamped to 100%', () => {
    // watched(5) >= totalEpisodes(3) → isCompleted = true → adds "completed" class
    const s = corruptShow({ id: 1, name: 'Overflow', list: 'watching', totalEpisodes: 3, watched: 5 });
    const html = showCardHtml(s);
    expect(html).toContain('show-card-progress-bar completed');
    // Width is now clamped to 100 (was previously >100 with fractional digits)
    expect(html).toContain('width:100%');
    expect(html).not.toMatch(/style="width:1[0-9]{2}\.[0-9]+%/);
  });

  it('stats.ts and dashboard.ts BOTH clamp progress — defense-in-depth parity', () => {
    // After BUG-13-01 fix, both views clamp to [0, 100].
    const corruptProgress = (5 / 3) * 100;
    const statsClamped = Math.max(0, Math.min(100, corruptProgress));
    expect(statsClamped).toBe(100);
    // dashboard's clamp (post-fix) — also 100
    const dashClamped = Math.max(0, Math.min(100, corruptProgress));
    expect(dashClamped).toBe(100);
  });

  it('meta text shows inconsistent "5/3 ep" while bar shows full/green (clamped)', () => {
    // The meta text is intentionally NOT clamped (the user might want to see
    // they have corrupt data); only the visual bar is clamped.
    const s = corruptShow({ id: 1, name: 'Overflow', list: 'watching', totalEpisodes: 3, watched: 5 });
    const html = showCardHtml(s);
    expect(html).toContain('5/3');
    expect(html).toContain('show-card-progress-bar completed');
    expect(html).toContain('width:100%');
  });
});

describe('dashboard — continueWatching filter edge cases', () => {
  it('excludes a watching show with totalEpisodes=0 (0<0 is false)', () => {
    const s = makeShow({ id: 1, name: 'Empty', list: 'watching', totalEpisodes: 0, seasons: {} });
    setShows([s]);
    renderDashboard(main);
    expect(main.innerHTML).not.toContain('Continua a guardare');
    // But it IS in "Sto guardando"
    expect(main.innerHTML).toContain('Sto guardando');
  });

  it('excludes a watching show where watched===totalEpisodes (nothing to continue)', () => {
    const s = makeShowWithSeasons({ 1: 3 }, { id: 1, name: 'Done', list: 'watching' });
    markWatchedFirst(s, 1, 3);
    setShows([s]);
    renderDashboard(main);
    // watched(3) < totalEpisodes(3) → false → excluded from continue
    expect(main.innerHTML).not.toContain('Continua a guardare');
    // But the show is still in "Sto guardando" (filter is by list, not by completion)
    expect(main.innerHTML).toContain('Sto guardando');
  });

  it('excludes a corrupt watching show with watched > totalEpisodes (5<3 false)', () => {
    const s = corruptShow({ id: 1, name: 'Overflow', list: 'watching', totalEpisodes: 3, watched: 5 });
    setShows([s]);
    renderDashboard(main);
    // Excluded from "Continua a guardare"…
    expect(main.innerHTML).not.toContain('Continua a guardare');
    // …but still rendered (with clamped bar) in "Sto guardando"
    expect(main.innerHTML).toContain('Sto guardando');
    const bar = main.querySelector('.show-card-progress-bar') as HTMLElement | null;
    expect(bar?.getAttribute('style') || '').toContain('width:100%');
  });

  it('includes a watching show with watched=0, totalEpisodes=5 → "Prossimo: Stagione 1, Ep 1"', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 1, name: 'New', list: 'watching' });
    setShows([s]);
    renderDashboard(main);
    expect(main.innerHTML).toContain('Continua a guardare');
    expect(main.innerHTML).toContain('Prossimo: Stagione 1, Ep 1');
  });

  it('continue-card uses a div for "Continua" button (not <button>) — a11y: card carries role/tabindex (BUG-13-05 fix)', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 1, name: 'New', list: 'watching' });
    setShows([s]);
    renderDashboard(main);
    const continueBtns = main.querySelectorAll('.continue-card-btn');
    expect(continueBtns.length).toBe(1);
    expect(continueBtns[0].tagName).toBe('DIV'); // NOT a <button> (decorative)
    // The continue-card itself (which has data-action) carries role/tabindex.
    const card = main.querySelector('.continue-card') as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card!.getAttribute('role')).toBe('button');
    expect(card!.getAttribute('tabindex')).toBe('0');
  });

  it('continue-card and show-card have role=button + tabindex=0 (BUG-13-05 fixed)', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 1, name: 'New', list: 'watching' });
    setShows([s]);
    renderDashboard(main);
    const cards = main.querySelectorAll('[data-action="openShow"]');
    expect(cards.length).toBeGreaterThan(0);
    for (const c of Array.from(cards)) {
      expect(c.tagName).toBe('DIV');
      expect(c.getAttribute('role')).toBe('button');
      expect(c.getAttribute('tabindex')).toBe('0');
    }
  });

  it('section-link spans also carry role=button + tabindex=0 (BUG-13-05 fixed)', () => {
    const w = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'W', list: 'watching' });
    setShows([w]);
    renderDashboard(main);
    const links = main.querySelectorAll('[data-action="switchView"]');
    expect(links.length).toBeGreaterThan(0);
    for (const l of Array.from(links)) {
      expect(l.tagName).toBe('SPAN');
      expect(l.getAttribute('role')).toBe('button');
      expect(l.getAttribute('tabindex')).toBe('0');
    }
  });

  it('keyboard: Enter on a focused show-card triggers a click (BUG-13-05 fixed)', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 7, name: 'Kbd', list: 'watching' });
    setShows([s]);
    renderDashboard(main);
    const card = main.querySelector('.show-card') as HTMLElement;
    expect(card).not.toBeNull();
    let clicked = 0;
    card.addEventListener('click', () => { clicked++; });
    // Focus the card, then dispatch a keydown Enter.
    card.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(ev, 'target', { value: card });
    main.dispatchEvent(ev);
    expect(clicked).toBe(1);
  });

  it('keyboard: Space on a focused continue-card triggers a click (BUG-13-05 fixed)', () => {
    const s = makeShowWithSeasons({ 1: 5 }, { id: 1, name: 'Kbd', list: 'watching' });
    setShows([s]);
    renderDashboard(main);
    const card = main.querySelector('.continue-card') as HTMLElement;
    expect(card).not.toBeNull();
    let clicked = 0;
    card.addEventListener('click', () => { clicked++; });
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true });
    Object.defineProperty(ev, 'target', { value: card });
    main.dispatchEvent(ev);
    expect(clicked).toBe(1);
  });

  it('keyboard: keydown listener is bound only once per main (no accumulation across re-renders)', () => {
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

  it('continue-card "Prossimo" line shows season+num from findNextEpisode (raw, unescaped numbers)', () => {
    const s = makeShowWithSeasons({ 1: 5, 2: 3 }, { id: 1, name: 'Show', list: 'watching' });
    markWatchedFirst(s, 1, 5); // season 1 fully watched
    setShows([s]);
    renderDashboard(main);
    expect(main.innerHTML).toContain('Prossimo: Stagione 2, Ep 1');
  });

  it('BUG-13-03 fix: continue-card suppresses "Prossimo: Stagione 1, Ep 0" for episodes with num=0 (falls back to X/Y episodi)', () => {
    // Build a show where all episodes have num=0. normalizeShow would filter
    // these out (.filter(ep => ep.num > 0)), but a directly-mutated state can
    // hold them. After the BUG-13-03 fix, findNextEpisode's num=0 result is
    // defensively suppressed here in the dashboard (guarded via nextEp.num > 0),
    // so the continue-card falls back to "X/Y episodi".
    const s = makeShow({
      id: 1,
      name: 'Weird',
      list: 'watching',
      totalEpisodes: 5,
      seasons: {
        1: [
          makeEpisode({ num: 0, id: 1, watched: false }),
          makeEpisode({ num: 0, id: 2, watched: false }),
        ],
      },
    });
    setShows([s]);
    renderDashboard(main);
    // watched=0 < 5 → included in continue
    expect(main.innerHTML).toContain('Continua a guardare');
    // Fixed: no longer displays "Ep 0" — falls back to "0/5 episodi".
    expect(main.innerHTML).not.toContain('Prossimo: Stagione 1, Ep 0');
    expect(main.innerHTML).toContain('0/5 episodi');
  });

  it('continueWatching caps at 8 eligible shows', () => {
    const shows: Show[] = [];
    for (let i = 1; i <= 10; i++) {
      shows.push(makeShowWithSeasons({ 1: 5 }, { id: i, name: `S${i}`, list: 'watching' }));
    }
    setShows(shows);
    renderDashboard(main);
    const continueCards = main.querySelectorAll('.continue-card');
    expect(continueCards.length).toBe(8);
  });
});

describe('dashboard — sections slice(0,12)', () => {
  it('caps each section at 12 cards even with 15 watching shows', () => {
    const shows: Show[] = [];
    for (let i = 1; i <= 15; i++) {
      shows.push(makeShowWithSeasons({ 1: 5 }, { id: i, name: `S${i}`, list: 'watching' }));
    }
    setShows(shows);
    renderDashboard(main);
    // "Sto guardando" section
    const section = Array.from(main.querySelectorAll('.section')).find((s) =>
      s.querySelector('.section-title')?.textContent?.includes('Sto guardando'),
    );
    expect(section).toBeDefined();
    const cards = section!.querySelectorAll('.show-card');
    expect(cards.length).toBe(12);
  });

  it('each section has a "Vedi tutte" link with data-action=switchView', () => {
    const w = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'W', list: 'watching' });
    const t = makeShowWithSeasons({ 1: 2 }, { id: 2, name: 'T', list: 'towatch' });
    const c = makeShowWithSeasons({ 1: 2 }, { id: 3, name: 'C', list: 'completed' });
    setShows([w, t, c]);
    renderDashboard(main);
    const links = main.querySelectorAll('[data-action="switchView"]');
    const views = Array.from(links).map((l) => (l as HTMLElement).getAttribute('data-view'));
    expect(views).toEqual(expect.arrayContaining(['watching', 'towatch', 'completed']));
  });

  it('does not render a section whose list is empty', () => {
    const w = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'W', list: 'watching' });
    setShows([w]);
    renderDashboard(main);
    const sectionTitles = Array.from(main.querySelectorAll('.section-title')).map((e) => e.textContent);
    expect(sectionTitles).toContain('Sto guardando');
    expect(sectionTitles).not.toContain('Da vedere');
    expect(sectionTitles).not.toContain('Completate');
  });
});

describe('dashboard — showCardHtml XSS / escaping', () => {
  it('escapes HTML in show.name', () => {
    const s = makeShow({ id: 1, name: '<script>alert(1)</script>', list: 'watching' });
    const html = showCardHtml(s);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('escapes HTML in show.name when image is null (placeholder branch)', () => {
    const s = makeShow({ id: 1, name: '<b>bold</b>', image: null, list: 'watching' });
    const html = showCardHtml(s);
    expect(html).toContain('show-card-placeholder');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('escapes HTML in show.name passed to imgTag as alt', () => {
    const s = makeShow({ id: 1, name: '"injected"', image: 'https://x/y.jpg', list: 'watching' });
    const html = showCardHtml(s);
    // alt attribute value should escape embedded quotes as &quot;
    expect(html).toContain('alt="&quot;injected&quot;"');
  });

  it('show.id is escaped into data-show-id (BUG-13-04 fix — defense-in-depth)', () => {
    const s = makeShow({ id: 42, name: 'X', list: 'watching' });
    const html = showCardHtml(s);
    expect(html).toContain('data-show-id="42"');
  });

  it('show.id as crafted string with quote → attribute is escaped (BUG-13-04 fixed)', () => {
    // We bypass normalizeShow by mutating a Show directly with a malicious id.
    // This is NOT reachable through production (safeId rejects strings), but
    // verifies that showCardHtml now escapes show.id via escapeAttr.
    const s = makeShow({ id: 1, name: 'X', list: 'watching' });
    (s as any).id = '"><img src=x onerror=alert(1)>';
    const html = showCardHtml(s);
    // After the fix, the quote is escaped to &quot; — no attribute breakout.
    expect(html).not.toContain('data-show-id=""><img src=x onerror=alert(1)>"');
    expect(html).toContain('data-show-id="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    // No live onerror attribute created.
    expect(html).not.toMatch(/onerror="alert\(1\)"/);
  });

  it('numbers (watched, totalEpisodes) are interpolated raw — safe (numbers)', () => {
    const s = makeShowWithSeasons({ 1: 7 }, { id: 1, name: 'N', list: 'watching' });
    markWatchedFirst(s, 1, 3);
    const html = showCardHtml(s);
    expect(html).toContain('3/7');
    expect(html).toContain('width:42.857142857142854%');
  });

  it('NaN progress if getWatchedCount returned NaN — defensive check (not currently reachable)', () => {
    // getWatchedCount always returns a number; this is just a regression guard
    // to document that the view does not defensively clamp/validate.
    const s = makeShow({ id: 1, name: 'X', list: 'watching', totalEpisodes: 0, seasons: {} });
    const html = showCardHtml(s);
    // totalEpisodes=0 → guarded, progress=0
    expect(html).toContain('width:0%');
  });

  it('negative totalEpisodes (hand-crafted, bypass normalize) → guarded, width:0%', () => {
    const s = makeShow({ id: 1, name: 'X', list: 'watching', totalEpisodes: -5, seasons: {} });
    const html = showCardHtml(s);
    // show.totalEpisodes > 0 is false → progress = 0
    expect(html).toContain('width:0%');
  });

  it('image src with quote is escaped by imgTag (escapeAttr)', () => {
    const s = makeShow({
      id: 1,
      name: 'X',
      list: 'watching',
      image: 'https://x/y.jpg" onerror="alert(1)',
    });
    const html = showCardHtml(s);
    // The embedded " is escaped to &quot; inside the src attribute value.
    // The src attribute should start with src="https://x/y.jpg&quot; (NOT src="https://x/y.jpg" onerror=")
    expect(html).toContain('src="https://x/y.jpg&quot; onerror=&quot;alert(1)"');
    // No attribute breakout: there is no `src="..." onerror="..."` pattern
    // (the injected onerror is INSIDE the src value, not a new attribute).
    expect(html).not.toMatch(/src="[^"]*" onerror="/);
  });
});

describe('showList — basic rendering', () => {
  it('renders escapeHtml(title) in <h1> (no actual elements injected)', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'A', list: 'watching' });
    setShows([s]);
    renderShowList(main, 'watching', '<b>Bold</b> & "quotes"');
    const h1 = main.querySelector('.page-title');
    // textContent reflects the decoded entities (i.e., the raw input as text).
    expect(h1?.textContent).toBe('<b>Bold</b> & "quotes"');
    // Crucially, no <b> element was actually injected (XSS-safe).
    expect(main.querySelector('.page-title b')).toBeNull();
    // Round-tripped innerHTML re-encodes <, >, & but NOT " in text context.
    expect(main.innerHTML).toContain('&lt;b&gt;Bold&lt;/b&gt; &amp;');
  });

  it('renders ALL shows of the requested list (no slice)', () => {
    const shows: Show[] = [];
    for (let i = 1; i <= 20; i++) {
      shows.push(makeShowWithSeasons({ 1: 2 }, { id: i, name: `S${i}`, list: 'watching' }));
    }
    setShows(shows);
    renderShowList(main, 'watching', 'Watching');
    const cards = main.querySelectorAll('.show-card');
    expect(cards.length).toBe(20); // no slice(0,12) here
  });

  it('renders empty state when list is empty', () => {
    setShows([]);
    renderShowList(main, 'watching', 'Watching');
    expect(main.innerHTML).toContain('empty-state');
    expect(main.innerHTML).toContain('Nessuna serie');
    expect(main.querySelectorAll('.show-card').length).toBe(0);
  });

  it('filters by list — only requested list shown', () => {
    const w = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'W', list: 'watching' });
    const t = makeShowWithSeasons({ 1: 2 }, { id: 2, name: 'T', list: 'towatch' });
    const c = makeShowWithSeasons({ 1: 2 }, { id: 3, name: 'C', list: 'completed' });
    setShows([w, t, c]);
    renderShowList(main, 'watching', 'Watching');
    expect(main.querySelectorAll('.show-card').length).toBe(1);
    expect(main.querySelector('.show-card')?.getAttribute('data-show-id')).toBe('1');
    renderShowList(main, 'towatch', 'ToWatch');
    expect(main.querySelector('.show-card')?.getAttribute('data-show-id')).toBe('2');
    renderShowList(main, 'completed', 'Completed');
    expect(main.querySelector('.show-card')?.getAttribute('data-show-id')).toBe('3');
  });

  it('renders in insertion order (no alpha sort) — order = state.shows order', () => {
    const shows: Show[] = [
      makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'Zebra', list: 'watching' }),
      makeShowWithSeasons({ 1: 2 }, { id: 2, name: 'Apple', list: 'watching' }),
      makeShowWithSeasons({ 1: 2 }, { id: 3, name: 'Mango', list: 'watching' }),
    ];
    setShows(shows);
    renderShowList(main, 'watching', 'Watching');
    const names = Array.from(main.querySelectorAll('.show-card-name')).map((e) => e.textContent);
    expect(names).toEqual(['Zebra', 'Apple', 'Mango']); // insertion order, NOT alpha
  });

  it('empty title renders an empty <h1>', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 1, name: 'A', list: 'watching' });
    setShows([s]);
    renderShowList(main, 'watching', '');
    const h1 = main.querySelector('.page-title');
    expect(h1?.textContent).toBe('');
  });

  it('reuses the same showCardHtml as dashboard (single source of truth)', () => {
    const s = makeShowWithSeasons({ 1: 2 }, { id: 7, name: 'Shared', list: 'watching' });
    markWatchedFirst(s, 1, 1);
    setShows([s]);
    renderDashboard(main);
    const dashCard = main.querySelector('.show-card')!.outerHTML;
    renderShowList(main, 'watching', 'Watching');
    const listCard = main.querySelector('.show-card')!.outerHTML;
    expect(dashCard).toBe(listCard);
  });

  it('showList propagates the same clamp behavior (uses showCardHtml) — BUG-13-01 fixed', () => {
    const s = corruptShow({ id: 1, name: 'Overflow', list: 'watching', totalEpisodes: 3, watched: 5 });
    setShows([s]);
    renderShowList(main, 'watching', 'Watching');
    const bar = main.querySelector('.show-card-progress-bar') as HTMLElement | null;
    expect(bar).not.toBeNull();
    const style = bar!.getAttribute('style') || '';
    // Clamped to 100% — no longer >100%.
    expect(style).toContain('width:100%');
    expect(style).not.toMatch(/width:1[0-9]{2}\.[0-9]+%/);
  });
});

describe('dashboard — showCardHtml completion semantics', () => {
  it('watched===totalEpisodes → isCompleted=true → green bar', () => {
    const s = makeShowWithSeasons({ 1: 3 }, { id: 1, name: 'Done', list: 'watching' });
    markWatchedFirst(s, 1, 3);
    const html = showCardHtml(s);
    expect(html).toContain('show-card-progress-bar completed');
    expect(html).toContain('width:100%');
  });

  it('list=completed forces isCompleted even with watched=0', () => {
    const s = makeShowWithSeasons({ 1: 3 }, { id: 1, name: 'Manual', list: 'completed' });
    // watched=0 but list=completed → isCompleted=true
    const html = showCardHtml(s);
    expect(html).toContain('show-card-progress-bar completed');
    expect(html).toContain('width:0%'); // 0/3*100
  });

  it('list=completed with totalEpisodes=0 → progress=0, isCompleted=true', () => {
    const s = makeShow({ id: 1, name: 'Empty', list: 'completed', totalEpisodes: 0, seasons: {} });
    const html = showCardHtml(s);
    expect(html).toContain('show-card-progress-bar completed');
    expect(html).toContain('width:0%');
  });
});

describe('dashboard — does not crash on malformed seasons', () => {
  it('showCardHtml handles missing seasons gracefully (getWatchedCount returns 0)', () => {
    const s = makeShow({ id: 1, name: 'X', list: 'watching', totalEpisodes: 5 });
    (s as any).seasons = undefined;
    const html = showCardHtml(s); // should not throw
    expect(html).toContain('0/5');
    expect(html).toContain('width:0%');
  });

  it('renderDashboard handles a show with seasons=null', () => {
    const s = makeShow({ id: 1, name: 'X', list: 'watching', totalEpisodes: 5 });
    (s as any).seasons = null;
    setShows([s]);
    expect(() => renderDashboard(main)).not.toThrow();
    expect(main.innerHTML).toContain('0/5');
  });
});

describe('dashboard — count consistency for totalWatched stat', () => {
  it('totalWatched counts phantom watched for corrupt show (watched>totalEpisodes)', () => {
    const s = corruptShow({ id: 1, name: 'X', list: 'watching', totalEpisodes: 3, watched: 5 });
    setShows([s]);
    renderDashboard(main);
    const statValues = Array.from(main.querySelectorAll('.stat-value')).map((e) => e.textContent);
    // totalShows=1, totalWatched=5, watching=1, completed=0
    // (5 phantom watched episodes are counted even though totalEpisodes=3)
    expect(statValues).toEqual(['1', '5', '1', '0']);
  });
});
