// Agent 14 — probe tests for src/views/showDetail.ts
// Covers: poster fallback chain (bigImg replace bug), season tabs/episode list,
// progress clamp, markSeason/refresh/move/remove event delegation, auto-refresh,
// bindShowDetailEvents listener-accumulation (FIXED), edge cases in currentSeason logic,
// H17 a11y (role/tabindex/keydown on episode-item and season-tab).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Show } from '../src/types';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import * as ShowsNS from '../src/lib/shows';
import { makeShow, makeShowWithSeasons, markWatchedFirst, makeEpisode } from './helpers';

// Mock the network/mutation functions in shows.ts; keep pure helpers (showNeedsEpisodeNames) real.
vi.mock('../src/lib/shows.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ShowsNS>();
  return {
    ...actual,
    moveShowToList: vi.fn(),
    removeShow: vi.fn(),
    toggleEpisode: vi.fn(),
    markSeasonWatched: vi.fn(),
    refreshShowEpisodes: vi.fn(async (_id: number, _opts?: { silent?: boolean }) => true),
  };
});

import { renderShowDetail, bindShowDetailEvents, resetBoundGuard } from '../src/views/showDetail';
import { getState, setState, subscribe } from '../src/lib/store';
import {
  toggleEpisode,
  markSeasonWatched,
  refreshShowEpisodes,
  moveShowToList,
  removeShow,
} from '../src/lib/shows';

function getMain(): HTMLElement {
  let m = document.getElementById('mainContent');
  if (!m) {
    m = document.createElement('div');
    m.id = 'mainContent';
    document.body.appendChild(m);
  }
  m.innerHTML = '';
  return m;
}

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

beforeEach(() => {
  resetState();
  document.body.innerHTML = '<div id="mainContent"></div>';
  vi.clearAllMocks();
});

// ============================================================================
// show not found
// ============================================================================
describe('renderShowDetail — show not found', () => {
  it('calls closeShow when currentShowId has no matching show', () => {
    setState({ currentShowId: 4242, shows: [makeShow({ id: 1 })] });
    expect(getState().currentShowId).toBe(4242);
    renderShowDetail(getMain());
    expect(getState().currentShowId).toBeNull();
  });

  it('safeId rejects non-positive currentShowId → no show found → closeShow', () => {
    setState({ currentShowId: 0, shows: [makeShow({ id: 1 })] });
    renderShowDetail(getMain());
    expect(getState().currentShowId).toBeNull();
  });
});

// ============================================================================
// bigImg URL replace bug
// ============================================================================
describe('renderShowDetail — bigImg URL replace', () => {
  it('TVMaze medium_portrait URL → original_portrait URL (CORRECT case)', () => {
    const url = 'https://static.tvmaze.com/uploads/images/medium_portrait/100/250000.jpg';
    const show = makeShow({ id: 1, image: url });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const img = document.querySelector('.detail-poster') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe(
      'https://static.tvmaze.com/uploads/images/original_portrait/100/250000.jpg',
    );
    expect(img.dataset.fallbackSrc).toBe(url);
    expect(img.dataset.fallback).toBe('Immagine non disponibile');
    expect(img.dataset.fallbackCls).toBe('detail-poster-placeholder');
  });

  it('pathological URL with multiple "medium" — regex matches only /medium_(portrait|landscape)/ — URL unchanged (FIXED)', () => {
    // FIX BUG-14-03: la regex /\/medium_(portrait|landscape)\// non matcha
    // URL non-standard come questo (medium-shows, medium_poster) → bigImg === show.image
    // → si cade nel branch "solo medium disponibile" (no data-fallback-src).
    const url = 'https://cdn.example.com/medium-shows/medium_poster/x.jpg';
    const show = makeShow({ id: 1, image: url });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const img = document.querySelector('.detail-poster') as HTMLImageElement;
    // FIX: URL invariato (nessuna corruzione). bigImg === show.image → solo-medium branch.
    expect(img.getAttribute('src')).toBe(url);
    // Nessun data-fallback-src (solo-medium branch non lo imposta).
    expect(img.dataset.fallbackSrc).toBeUndefined();
  });

  it('show.image already original (no "medium") → bigImg===show.image → solo-medium branch', () => {
    const url = 'https://static.tvmaze.com/uploads/images/original_portrait/100/250000.jpg';
    const show = makeShow({ id: 1, image: url });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const img = document.querySelector('.detail-poster') as HTMLImageElement;
    // solo-medium branch: src is the same, NO data-fallback-src attribute
    expect(img.getAttribute('src')).toBe(url);
    expect(img.dataset.fallbackSrc).toBeUndefined();
    expect(img.dataset.fallback).toBe('Immagine non disponibile');
  });

  it('show.image=null → placeholder div rendered', () => {
    const show = makeShow({ id: 1, image: null });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const ph = document.querySelector('.detail-poster-placeholder');
    expect(ph).toBeTruthy();
    expect(ph?.textContent).toBe('Immagine non disponibile');
  });

  it('show.image with "medium" substring in filename only — regex no match → URL unchanged (FIXED)', () => {
    // FIX BUG-14-03: la regex non matcha "medium" dentro un filename, solo
    // path-segment TVMaze `/medium_portrait/` o `/medium_landscape/`.
    const url = 'https://cdn.example.com/posters/show-medium-cover.jpg';
    const show = makeShow({ id: 1, image: url });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const img = document.querySelector('.detail-poster') as HTMLImageElement;
    // FIX: URL invariato (filename non corrotto). bigImg === show.image → solo-medium branch.
    expect(img.getAttribute('src')).toBe(url);
    expect(img.dataset.fallbackSrc).toBeUndefined();
  });
});

// ============================================================================
// progress not clamped
// ============================================================================
describe('renderShowDetail — progress not clamped (BUG-14-02 FIXED)', () => {
  it('watched > totalEpisodes → width clamped to 100%, label clamped to 100% (FIXED)', () => {
    // 5 episodes in season, all watched, but totalEpisodes=3 (stale)
    const show = makeShowWithSeasons({ 1: 5 }, { id: 1, totalEpisodes: 3 });
    markWatchedFirst(show, 1, 5);
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const fill = document.querySelector('.detail-progress-fill') as HTMLElement;
    expect(fill).toBeTruthy();
    const w = fill.getAttribute('style') || '';
    // FIX: progress clamped to 100, not 166.67.
    expect(w).toMatch(/width:100(\.0+)?%?/);
    expect(w).not.toMatch(/width:1[6-9]\d/);
    const meta = document.querySelector('.detail-progress-meta') as HTMLElement;
    // FIX: Math.round(100) = 100, not 167.
    expect(meta.textContent).toContain('100%');
    expect(meta.textContent).not.toContain('167%');
    // The raw count is still shown (5 / 3) — only the % and width are clamped.
    expect(meta.textContent).toContain('5 / 3');
  });

  it('watched=0, totalEpisodes=0 → progress=0, no division-by-zero', () => {
    const show = makeShow({ id: 1, seasons: {}, totalEpisodes: 0 });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const fill = document.querySelector('.detail-progress-fill') as HTMLElement;
    expect(fill.getAttribute('style') || '').toContain('width:0%');
  });
});

// ============================================================================
// seasons filter+sort + currentSeason logic
// ============================================================================
describe('renderShowDetail — seasons filter+sort', () => {
  it('seasons sorted numerically (not lexicographically)', () => {
    const show = makeShowWithSeasons({ 10: 1, 2: 1, 1: 1 }, { id: 1 });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const tabs = Array.from(document.querySelectorAll('.season-tab'));
    expect(tabs.map((t) => t.textContent?.trim())).toEqual([
      'Stagione 1',
      'Stagione 2',
      'Stagione 10',
    ]);
  });

  it('currentSeason set to first season when not in seasons', () => {
    const show = makeShowWithSeasons({ 2: 3 }, { id: 1 });
    setState({ currentShowId: 1, currentSeason: 99, shows: [show] });
    renderShowDetail(getMain());
    expect(getState().currentSeason).toBe(2);
    const activeTab = document.querySelector('.season-tab.active');
    expect(activeTab?.textContent).toContain('2');
  });

  it('currentSeason is null → reset to first season', () => {
    const show = makeShowWithSeasons({ 3: 1 }, { id: 1 });
    setState({ currentShowId: 1, currentSeason: null, shows: [show] });
    renderShowDetail(getMain());
    expect(getState().currentSeason).toBe(3);
  });

  it('no seasons → currentSeason=null, no season tabs, empty-state', () => {
    const show = makeShow({ id: 1, seasons: {}, totalSeasons: 0, totalEpisodes: 0 });
    setState({ currentShowId: 1, currentSeason: 5, shows: [show] });
    renderShowDetail(getMain());
    expect(getState().currentSeason).toBeNull();
    expect(document.querySelector('.season-tabs')).toBeNull();
    expect(document.querySelector('.empty-state')).toBeTruthy();
    expect(document.querySelector('.empty-state-title')?.textContent).toBe(
      'Nessun episodio disponibile',
    );
  });

  it('pathological non-integer season key "1.5" — REJECTED by filter (FIXED BUG-14-04)', () => {
    // FIX BUG-14-04: il filter ora usa /^\d+$/ (regex stretta) invece di
    // !isNaN(parseInt(k,10)) che accettava "1.5". Ora "1.5" è filtrato →
    // seasons.length === 0 → empty-state, nessun tab.
    const show = makeShow({ id: 1 }) as unknown as Show & { seasons: Record<string, unknown> };
    show.seasons = { '1.5': [makeEpisode({ num: 1, id: 1 })] };
    setState({ currentShowId: 1, currentSeason: 1, shows: [show as unknown as Show] });
    renderShowDetail(getMain());
    // FIX: nessun tab renderizzato (filter ha rejecting "1.5").
    const tabs = Array.from(document.querySelectorAll('.season-tab'));
    expect(tabs.length).toBe(0);
    // Empty-state renderizzato (seasons.length === 0).
    expect(document.querySelector('.empty-state')).toBeTruthy();
    expect(document.querySelectorAll('.episode-item').length).toBe(0);
  });

  it('show.seasons as Array → reassigned to {} → empty-state', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { seasons: unknown }).seasons = [];
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(Array.isArray(show.seasons)).toBe(false);
    expect(show.seasons).toEqual({});
    expect(document.querySelector('.empty-state')).toBeTruthy();
  });

  it('show.seasons null → reassigned to {} → empty-state', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { seasons: unknown }).seasons = null;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(show.seasons).toEqual({});
  });
});

// ============================================================================
// status badge
// ============================================================================
describe('renderShowDetail — status badge', () => {
  it('status "Running" → status-running class', () => {
    const show = makeShow({ id: 1, status: 'Running' });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const badge = document.querySelector('.status-badge');
    expect(badge?.classList.contains('status-running')).toBe(true);
  });

  it('status "In corso" (Italian) → status-running class', () => {
    const show = makeShow({ id: 1, status: 'In corso' });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const badge = document.querySelector('.status-badge');
    expect(badge?.classList.contains('status-running')).toBe(true);
  });

  it('status "Ended" → status-ended class', () => {
    const show = makeShow({ id: 1, status: 'Ended' });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const badge = document.querySelector('.status-badge');
    expect(badge?.classList.contains('status-ended')).toBe(true);
  });

  it('status empty → escapeHtml("") renders empty text, status-ended class', () => {
    const show = makeShow({ id: 1, status: '' });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const badge = document.querySelector('.status-badge');
    expect(badge?.classList.contains('status-ended')).toBe(true);
    expect(badge?.textContent).toBe('');
  });
});

// ============================================================================
// move buttons (hidden for current list)
// ============================================================================
describe('renderShowDetail — move buttons visibility', () => {
  it('list=watching → hides "In corso" button, shows others', () => {
    const show = makeShow({ id: 1, list: 'watching' });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const btns = Array.from(document.querySelectorAll('[data-action="moveShow"]')) as HTMLElement[];
    const lists = btns.map((b) => b.dataset.list);
    expect(lists).not.toContain('watching');
    expect(lists).toContain('towatch');
    expect(lists).toContain('completed');
  });

  it('list=towatch → hides "Da vedere" button', () => {
    const show = makeShow({ id: 1, list: 'towatch' });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const btns = Array.from(document.querySelectorAll('[data-action="moveShow"]')) as HTMLElement[];
    const lists = btns.map((b) => b.dataset.list);
    expect(lists).not.toContain('towatch');
    expect(lists).toContain('watching');
    expect(lists).toContain('completed');
  });

  it('list=completed → hides "Completata" button', () => {
    const show = makeShow({ id: 1, list: 'completed' });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const btns = Array.from(document.querySelectorAll('[data-action="moveShow"]')) as HTMLElement[];
    const lists = btns.map((b) => b.dataset.list);
    expect(lists).not.toContain('completed');
    expect(lists).toContain('watching');
    expect(lists).toContain('towatch');
  });
});

// ============================================================================
// summary rendering
// ============================================================================
describe('renderShowDetail — summary rendering', () => {
  it('empty line → <p></p>', () => {
    const show = makeShow({ id: 1, summary: 'line1\n\nline3' });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const summary = document.querySelector('.detail-summary');
    expect(summary?.innerHTML).toContain('<p>line1</p>');
    expect(summary?.innerHTML).toContain('<p></p>');
    expect(summary?.innerHTML).toContain('<p>line3</p>');
  });

  it('summary with HTML-like content (NOT stripHtml\'d by renderShowDetail) → escapeHtml neutralizes safely', () => {
    // renderShowDetail does NOT call stripHtml on summary — it relies on normalize.
    // For an un-normalized state with raw <script>, escapeHtml neutralizes tags
    // (no XSS), but the literal text shows through (not stripped).
    const show = makeShow({ id: 1, summary: '<script>x</script>plain text' });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const summary = document.querySelector('.detail-summary');
    // No raw <script> tag in HTML output (escapeHtml converts to &lt;script&gt;)
    expect(summary?.innerHTML).not.toContain('<script>');
    expect(summary?.innerHTML).toContain('&lt;script&gt;');
    // textContent shows the literal escaped text (NOT stripped).
    expect(summary?.textContent?.trim()).toBe('<script>x</script>plain text');
  });
});

// ============================================================================
// genres rendering
// ============================================================================
describe('renderShowDetail — genres rendering', () => {
  it('renders each genre as a tag', () => {
    const show = makeShow({ id: 1, genres: ['Drama', 'Comedy', 'Sci-Fi'] });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const tags = Array.from(document.querySelectorAll('.genre-tag'));
    expect(tags.map((t) => t.textContent)).toEqual(['Drama', 'Comedy', 'Sci-Fi']);
  });

  it('empty genres → no tags', () => {
    const show = makeShow({ id: 1, genres: [] });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelectorAll('.genre-tag').length).toBe(0);
  });
});

// ============================================================================
// detail-meta rendering
// ============================================================================
describe('renderShowDetail — detail-meta', () => {
  it('renders premiered, network, totalSeasons, totalEpisodes', () => {
    const show = makeShow({
      id: 1,
      premiered: '2024-03-15',
      network: 'HBO',
      totalSeasons: 4,
      totalEpisodes: 42,
    });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const meta = document.querySelector('.detail-meta');
    expect(meta?.textContent).toContain('4 stagioni');
    expect(meta?.textContent).toContain('42 episodi');
    expect(meta?.textContent).toContain('HBO');
    // formatDate('2024-03-15') — Italian short format
    expect(meta?.textContent).toContain('15 mar 2024');
  });

  it('premiered null → no extra "N/D" span beyond network default', () => {
    const show = makeShow({ id: 1, premiered: null, network: 'HBO' });
    setState({ currentShowId: 1, shows: [show] });
    renderShowDetail(getMain());
    const meta = document.querySelector('.detail-meta');
    // Network is "HBO", premiered is null → no extra "N/D" span.
    expect(meta?.textContent).not.toContain('N/D');
  });
});

// ============================================================================
// episode list rendering
// ============================================================================
describe('renderShowDetail — episode list', () => {
  it('renders episode items with proper data-attrs', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const items = document.querySelectorAll('.episode-item');
    expect(items.length).toBe(2);
    const first = items[0] as HTMLElement;
    expect(first.dataset.action).toBe('toggleEpisode');
    expect(first.dataset.showId).toBe('1');
    expect(first.dataset.season).toBe('1');
    expect(first.dataset.ep).toBe('1');
    // S1E1 label
    expect(first.querySelector('.episode-meta')?.textContent).toContain('S1E1');
  });

  it('episode with name=null → italic placeholder "Episodio N"', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = null;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const name = document.querySelector('.episode-name') as HTMLElement;
    expect(name.innerHTML).toContain('font-style:italic');
    expect(name.textContent).toContain('Episodio 1');
  });

  it('episode with name="" (empty string) → falls to italic placeholder (truthy check)', () => {
    // ep.name ? escapeHtml(ep.name) : placeholder
    // Empty string is falsy → placeholder branch.
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = '';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const name = document.querySelector('.episode-name') as HTMLElement;
    expect(name.textContent).toContain('Episodio 1');
  });

  it('episode with name="Pilot" → rendered', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const name = document.querySelector('.episode-name') as HTMLElement;
    expect(name.textContent).toBe('Pilot');
  });

  it('watched episode → .episode-item.watched and .episode-checkbox.checked', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    markWatchedFirst(show, 1, 1);
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const items = document.querySelectorAll('.episode-item');
    expect(items[0].classList.contains('watched')).toBe(true);
    expect(items[0].querySelector('.episode-checkbox')?.classList.contains('checked')).toBe(true);
    expect(items[1].classList.contains('watched')).toBe(false);
  });

  it('episode with airdate and runtime → meta includes formatted airdate and runtime', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].airdate = '2024-05-10';
    show.seasons[1][0].runtime = 60;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const meta = document.querySelector('.episode-meta') as HTMLElement;
    expect(meta.textContent).toContain('10 mag 2024');
    expect(meta.textContent).toContain('60 min');
  });
});

// ============================================================================
// mark season buttons rendering
// ============================================================================
describe('renderShowDetail — markSeason buttons', () => {
  it('renders both mark-season buttons with correct data-watched', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const btns = Array.from(document.querySelectorAll('[data-action="markSeason"]')) as HTMLElement[];
    expect(btns.length).toBe(2);
    const watchedVals = btns.map((b) => b.dataset.watched).sort();
    expect(watchedVals).toEqual(['0', '1']);
    // All have data-show-id and data-season
    for (const b of btns) {
      expect(b.dataset.showId).toBe('1');
      expect(b.dataset.season).toBe('1');
    }
  });

  it('markSeason buttons NOT rendered when currentSeason is null', () => {
    const show = makeShow({ id: 1, seasons: {}, totalSeasons: 0, totalEpisodes: 0 });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelectorAll('[data-action="markSeason"]').length).toBe(0);
  });
});

// ============================================================================
// refreshShow button
// ============================================================================
describe('renderShowDetail — refreshShow button', () => {
  it('always rendered with data-action=refreshShow', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const btn = document.querySelector('[data-action="refreshShow"]') as HTMLElement;
    expect(btn).toBeTruthy();
    expect(btn.dataset.showId).toBe('1');
  });
});

// ============================================================================
// removeShow button
// ============================================================================
describe('renderShowDetail — removeShow button', () => {
  it('renders with data-show-name (round-trip via escapeAttr)', () => {
    const show = makeShow({ id: 1, name: 'O\'Brien "X" & Friends' });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const btn = document.querySelector('[data-action="removeShow"]') as HTMLElement;
    expect(btn).toBeTruthy();
    expect(btn.dataset.showId).toBe('1');
    // DOM deserializes the escaped attribute back to the original.
    expect(btn.dataset.showName).toBe('O\'Brien "X" & Friends');
    // Raw HTML should not contain unescaped quotes
    const main = document.getElementById('mainContent')!;
    expect(main.innerHTML).not.toContain('data-show-name="O\'Brien "X" & Friends"');
  });
});

// ============================================================================
// auto-refresh trigger
// ============================================================================
describe('renderShowDetail — auto-refresh trigger', () => {
  it('refreshShowEpisodes called when showNeedsEpisodeNames is true (silent:true)', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    // makeEpisode default name=null → triggers showNeedsEpisodeNames
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(refreshShowEpisodes).toHaveBeenCalledWith(1, { silent: true });
  });

  it('refreshShowEpisodes NOT called when all episodes have names', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][1].name = 'Ep 2';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(refreshShowEpisodes).not.toHaveBeenCalled();
  });

  it('refreshShowEpisodes IS called when names are empty string (BUG-06-03 FIXED by Subagent 3)', () => {
    // Subagent 3 fixed showNeedsEpisodeNames to also treat empty string as missing
    // (ep.name == null || ep.name === ''). So now refreshShowEpisodes IS called.
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = '';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(refreshShowEpisodes).toHaveBeenCalledWith(1, { silent: true });
  });

  it('refreshShowEpisodes NOT called when no seasons', () => {
    const show = makeShow({ id: 1, seasons: {}, totalSeasons: 0, totalEpisodes: 0 });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(refreshShowEpisodes).not.toHaveBeenCalled();
  });
});

// ============================================================================
// bindShowDetailEvents — event delegation
// ============================================================================
describe('bindShowDetailEvents — event delegation', () => {
  function setup(show: Show): HTMLElement {
    setState({ currentShowId: show.id, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    return main;
  }

  it('toggleEpisode called on episode-item click', () => {
    setup(makeShowWithSeasons({ 1: 2 }, { id: 1 }));
    const item = document.querySelector('.episode-item') as HTMLElement;
    item.click();
    expect(toggleEpisode).toHaveBeenCalledWith(1, 1, 1);
  });

  it('toggleEpisode called when clicking the checkbox div (event bubbles to item)', () => {
    setup(makeShowWithSeasons({ 1: 2 }, { id: 1 }));
    const checkbox = document.querySelector('.episode-checkbox') as HTMLElement;
    checkbox.click();
    expect(toggleEpisode).toHaveBeenCalledWith(1, 1, 1);
  });

  it('markSeason watched=1 button', () => {
    setup(makeShowWithSeasons({ 1: 2 }, { id: 1 }));
    const btn = document.querySelector('[data-action="markSeason"][data-watched="1"]') as HTMLElement;
    btn.click();
    expect(markSeasonWatched).toHaveBeenCalledWith(1, 1, true);
  });

  it('markSeason watched=0 button', () => {
    setup(makeShowWithSeasons({ 1: 2 }, { id: 1 }));
    const btn = document.querySelector('[data-action="markSeason"][data-watched="0"]') as HTMLElement;
    btn.click();
    expect(markSeasonWatched).toHaveBeenCalledWith(1, 1, false);
  });

  it('refreshShow button → refreshShowEpisodes called WITHOUT silent (user-initiated)', () => {
    const s = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    s.seasons[1][0].name = 'Pilot';
    setup(s);
    const btn = document.querySelector('[data-action="refreshShow"]') as HTMLElement;
    btn.click();
    // User-click path calls refreshShowEpisodes(showId) with no opts (silent=undefined)
    expect(refreshShowEpisodes).toHaveBeenCalledWith(1);
  });

  it('moveShow button → moveShowToList called', () => {
    setup(makeShow({ id: 1, list: 'watching' }));
    const btn = document.querySelector('[data-action="moveShow"][data-list="towatch"]') as HTMLElement;
    btn.click();
    expect(moveShowToList).toHaveBeenCalledWith(1, 'towatch');
  });

  it('removeShow button → removeShow called with decoded name', () => {
    setup(makeShow({ id: 1, name: 'O\'Brien "X" & Friends' }));
    const btn = document.querySelector('[data-action="removeShow"]') as HTMLElement;
    btn.click();
    expect(removeShow).toHaveBeenCalledWith(1, 'O\'Brien "X" & Friends');
  });

  it('switchSeason button (season-tab) → state.currentSeason updated', () => {
    setup(makeShowWithSeasons({ 1: 1, 2: 1 }, { id: 1 }));
    const tab2 = document.querySelector('.season-tab[data-season="2"]') as HTMLElement;
    tab2.click();
    expect(getState().currentSeason).toBe(2);
  });

  it('closeShow button click — NOT handled by bindShowDetailEvents (handled by renderer.ts global delegation)', () => {
    setup(makeShow({ id: 1 }));
    const btn = document.querySelector('[data-action="closeShow"]') as HTMLElement;
    btn.click();
    // bindShowDetailEvents does NOT handle closeShow; renderer.ts does.
    // In this test (no renderer init), currentShowId remains unchanged.
    expect(getState().currentShowId).toBe(1);
    // None of the showDetail-specific actions fire either:
    expect(toggleEpisode).not.toHaveBeenCalled();
    expect(markSeasonWatched).not.toHaveBeenCalled();
    expect(moveShowToList).not.toHaveBeenCalled();
    expect(removeShow).not.toHaveBeenCalled();
    expect(refreshShowEpisodes).not.toHaveBeenCalled();
  });

  it('click on element without [data-action] ancestor → no action', () => {
    setup(makeShowWithSeasons({ 1: 2 }, { id: 1 }));
    // Click on the page-title or some non-action element
    const header = document.querySelector('.detail-header') as HTMLElement;
    header.click();
    expect(toggleEpisode).not.toHaveBeenCalled();
    expect(markSeasonWatched).not.toHaveBeenCalled();
    expect(moveShowToList).not.toHaveBeenCalled();
    expect(removeShow).not.toHaveBeenCalled();
  });
});

// ============================================================================
// bindShowDetailEvents — listener accumulation (HIGH severity bug, FIXED)
// ============================================================================
describe('bindShowDetailEvents — listener accumulation (BUG-14-01, FIXED)', () => {
  it('after resetBoundGuard + re-bind on same main, only ONE active listener (FIXED)', () => {
    // FIX H1/BUG-14-01: resetBoundGuard ora rimuove il listener precedente
    // prima che bindShowDetailEvents ne aggiunga uno nuovo. Quindi N cicli di
    // reset+bind → 1 listener attivo → 1 chiamata a toggleEpisode per click.
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][1].name = 'Ep 2';
    setState({ currentShowId: show.id, currentSeason: 1, shows: [show] });

    const main = getMain();

    // First render+bind (initial openShow)
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);

    let item = document.querySelector('.episode-item') as HTMLElement;
    item.click();
    expect(toggleEpisode).toHaveBeenCalledTimes(1);

    // Second render+bind (after a re-render triggered by emitChange)
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);

    item = document.querySelector('.episode-item') as HTMLElement;
    item.click();
    // FIX: ONE listener → 1 more call (2 total).
    expect(toggleEpisode).toHaveBeenCalledTimes(2);

    // Third render+bind
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);

    item = document.querySelector('.episode-item') as HTMLElement;
    item.click();
    // FIX: ONE listener → 1 more call (3 total).
    expect(toggleEpisode).toHaveBeenCalledTimes(3);
  });

  it('listener accumulation FIXED — markSeason fires EXACTLY once after 2 binds', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][1].name = 'Ep 2';
    setState({ currentShowId: show.id, currentSeason: 1, shows: [show] });
    const main = getMain();

    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);

    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);

    const btn = document.querySelector('[data-action="markSeason"][data-watched="1"]') as HTMLElement;
    btn.click();
    // FIX: ONE listener → markSeasonWatched called exactly once.
    expect(markSeasonWatched).toHaveBeenCalledTimes(1);
  });

  it('without resetBoundGuard between binds, _boundShowDetail flag prevents accumulation', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][1].name = 'Ep 2';
    setState({ currentShowId: show.id, currentSeason: 1, shows: [show] });
    const main = getMain();

    // First bind (sets flag)
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);

    // Second bind WITHOUT resetBoundGuard — flag is true, no-op.
    renderShowDetail(main);
    bindShowDetailEvents(main);

    const item = document.querySelector('.episode-item') as HTMLElement;
    item.click();
    // Only ONE listener bound (flag prevented second bind).
    expect(toggleEpisode).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// H17 a11y — keyboard accessible episode-item and season-tab
// ============================================================================
describe('H17 a11y — episode-item and season-tab keyboard accessible (FIXED)', () => {
  it('episode-item has role=button, tabindex=0, aria-label', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const item = document.querySelector('.episode-item') as HTMLElement;
    expect(item).toBeTruthy();
    expect(item.getAttribute('role')).toBe('button');
    expect(item.getAttribute('tabindex')).toBe('0');
    expect(item.getAttribute('aria-label')).toBeTruthy();
  });

  it('season-tab has role=tab, tabindex=0, aria-selected', () => {
    const show = makeShowWithSeasons({ 1: 1, 2: 1 }, { id: 1 });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const tabs = document.querySelectorAll('.season-tab');
    expect(tabs.length).toBe(2);
    for (const tab of tabs) {
      expect(tab.getAttribute('role')).toBe('tab');
      expect(tab.getAttribute('tabindex')).toBe('0');
      expect(tab.hasAttribute('aria-selected')).toBe(true);
    }
    // Active tab (season 1) has aria-selected=true.
    const active = document.querySelector('.season-tab.active') as HTMLElement;
    expect(active.getAttribute('aria-selected')).toBe('true');
  });

  it('keydown Enter on episode-item triggers toggleEpisode (via delegated keydown handler)', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const item = document.querySelector('.episode-item') as HTMLElement;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(toggleEpisode).toHaveBeenCalledWith(1, 1, 1);
  });

  it('keydown Space on season-tab triggers switchSeason', () => {
    const show = makeShowWithSeasons({ 1: 1, 2: 1 }, { id: 1 });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const tab2 = document.querySelector('.season-tab[data-season="2"]') as HTMLElement;
    tab2.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(getState().currentSeason).toBe(2);
  });

  it('keydown ArrowDown (non-Enter/Space) on episode-item does NOT trigger toggleEpisode', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const item = document.querySelector('.episode-item') as HTMLElement;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(toggleEpisode).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Cross-cutting: renderShowDetail mutates state.currentSeason without emitChange
// ============================================================================
describe('renderShowDetail — silent state mutation', () => {
  it('mutates state.currentSeason during render (no emitChange)', () => {
    const show = makeShowWithSeasons({ 5: 1 }, { id: 1 });
    setState({ currentShowId: 1, currentSeason: 99, shows: [show] });
    let emitCount = 0;
    // Subscribe to detect emitChange calls during render
    const unsub = subscribe(() => {
      emitCount++;
    });
    renderShowDetail(getMain());
    // state.currentSeason was mutated to 5, but emitChange was NOT triggered
    expect(getState().currentSeason).toBe(5);
    expect(emitCount).toBe(0);
    unsub();
  });
});
