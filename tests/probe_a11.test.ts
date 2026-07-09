// Agent A11 — probe tests for src/views/showDetail.ts
// Covers: BUG-A11-01..10 (seasonAvgRating NaN/Infinity, episode sorting,
// non-array tags/genres/seasons guards, openNoteEditor guards, openAddTagModal
// suggestions guard, addTag modal keepOpen on failure, show.image non-string),
// plus P2 interaction tests (star rating toggle, note editor save, tag add via
// Enter, tag remove click) and XSS regression tests for tags/notes/ep-name.
//
// Strategy:
//  - Mock shows.ts mutation functions (no localStorage / network access).
//  - Mock modal.ts (showModal/closeModal) to avoid global DOM/listener pollution
//    that would leak across test files in the same vitest worker. The mock
//    injects bodyHtml into a test-controlled container so we can query
//    #noteTextarea / #tagInput, and exposes the actions array so we can invoke
//    onClick callbacks directly.
//  - Mock toast.ts (no-op) to avoid DOM dependencies.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Show } from '../src/types';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import * as ShowsNS from '../src/lib/shows';
import { makeShow, makeShowWithSeasons, makeEpisode } from './helpers';

// --- Modal mock state ---
interface MockModalCall {
  title: string;
  bodyHtml: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: any[];
}
let _lastModalCall: MockModalCall | null = null;
let _modalOpen = false;

vi.mock('../src/components/modal', () => ({
  showModal: vi.fn((title: string, bodyHtml: string, actions: unknown[]) => {
    _lastModalCall = { title, bodyHtml, actions: actions as never[] };
    _modalOpen = true;
    // Inject bodyHtml into the test container so #noteTextarea / #tagInput
    // are queryable (the real modal would put them in #modalBody).
    const container = document.getElementById('modalTestContainer');
    if (container) container.innerHTML = bodyHtml;
  }),
  closeModal: vi.fn(() => {
    _modalOpen = false;
    _lastModalCall = null;
    const container = document.getElementById('modalTestContainer');
    if (container) container.innerHTML = '';
  }),
  closeAllModals: vi.fn(() => {
    _modalOpen = false;
    _lastModalCall = null;
    const container = document.getElementById('modalTestContainer');
    if (container) container.innerHTML = '';
  }),
  initModal: vi.fn(),
  isModalOpen: vi.fn(() => _modalOpen),
}));

vi.mock('../src/components/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../src/lib/shows.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ShowsNS>();
  return {
    ...actual,
    moveShowToList: vi.fn(),
    removeShow: vi.fn(),
    toggleEpisode: vi.fn(),
    markSeasonWatched: vi.fn(),
    refreshShowEpisodes: vi.fn(async (_id: number, _opts?: { silent?: boolean }) => true),
    setEpisodeRating: vi.fn(),
    setEpisodeNote: vi.fn(),
    addShowTag: vi.fn(() => true),
    removeShowTag: vi.fn(),
  };
});

import { renderShowDetail, bindShowDetailEvents, resetBoundGuard } from '../src/views/showDetail';
import { setState } from '../src/lib/store';
import {
  toggleEpisode,
  setEpisodeRating,
  setEpisodeNote,
  addShowTag,
  removeShowTag,
} from '../src/lib/shows';
import { showModal, closeModal } from '../src/components/modal';

// --- Helpers ---

function getMain(): HTMLElement {
  const m = document.getElementById('mainContent')!;
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

/** Find a modal action by label and invoke its onClick (if any). */
function clickModalButton(label: string): void {
  expect(_lastModalCall).toBeTruthy();
  const action = _lastModalCall!.actions.find((a) => a.label === label);
  expect(action).toBeTruthy();
  if (action.onClick) action.onClick();
  // Simulate the modal framework's auto-close behavior (unless keepOpen).
  if (!action.keepOpen) {
    _modalOpen = false;
    _lastModalCall = null;
    const container = document.getElementById('modalTestContainer');
    if (container) container.innerHTML = '';
  }
}

beforeEach(() => {
  document.body.innerHTML =
    '<main class="main" id="mainContent"></main>' +
    '<div id="modalTestContainer"></div>' +
    '<div id="toast"></div>';
  _lastModalCall = null;
  _modalOpen = false;
  resetState();
  vi.clearAllMocks();
  // addShowTag default mock returns true (success).
  (addShowTag as ReturnType<typeof vi.fn>).mockImplementation(() => true);
});

// ============================================================================
// BUG-A11-01: seasonAvgRating filters NaN/Infinity ratings
// ============================================================================
describe('BUG-A11-01: seasonAvgRating rejects NaN/Infinity/negative ratings', () => {
  it('NaN rating in episode → no "NaN" in season-rating-avg output', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    (show.seasons[1][0] as { rating?: number }).rating = NaN;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const avg = document.querySelector('.season-rating-avg');
    // NaN excluded → rated.length === 0 → no avg label rendered.
    expect(avg).toBeNull();
  });

  it('Infinity rating in episode → no "Infinity" in season-rating-avg output', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][1].name = 'Ep 2';
    (show.seasons[1][0] as { rating?: number }).rating = Infinity;
    (show.seasons[1][1] as { rating?: number }).rating = 4;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const avg = document.querySelector('.season-rating-avg');
    expect(avg).toBeTruthy();
    expect(avg?.textContent).not.toContain('Infinity');
    // Only the finite rating (4) counts: avg = 4.0, count = 1.
    expect(avg?.textContent).toContain('4.0');
    expect(avg?.textContent).toContain('(1)');
  });

  it('negative rating excluded from average', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][1].name = 'Ep 2';
    (show.seasons[1][0] as { rating?: number }).rating = -5;
    (show.seasons[1][1] as { rating?: number }).rating = 5;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const avg = document.querySelector('.season-rating-avg');
    expect(avg?.textContent).toContain('5.0');
    expect(avg?.textContent).toContain('(1)');
  });

  it('zero rating excluded (0 means "no rating")', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][1].name = 'Ep 2';
    (show.seasons[1][0] as { rating?: number }).rating = 0;
    (show.seasons[1][1] as { rating?: number }).rating = 3;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const avg = document.querySelector('.season-rating-avg');
    expect(avg?.textContent).toContain('3.0');
    expect(avg?.textContent).toContain('(1)');
  });

  it('valid ratings 1..MAX produce correct average', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][1].name = 'Ep 2';
    show.seasons[1][2].name = 'Ep 3';
    (show.seasons[1][0] as { rating?: number }).rating = 3;
    (show.seasons[1][1] as { rating?: number }).rating = 4;
    (show.seasons[1][2] as { rating?: number }).rating = 5;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const avg = document.querySelector('.season-rating-avg');
    expect(avg?.textContent).toContain('4.0');
    expect(avg?.textContent).toContain('(3)');
  });
});

// ============================================================================
// BUG-A11-02: episodes sorted by num before render
// ============================================================================
describe('BUG-A11-02: episodes sorted by num (not storage order)', () => {
  it('episodes stored out of order → rendered in num order', () => {
    const show = makeShow({ id: 1, totalSeasons: 1, totalEpisodes: 3 });
    show.seasons = {
      1: [makeEpisode({ num: 3, id: 13 }), makeEpisode({ num: 1, id: 11 }), makeEpisode({ num: 2, id: 12 })],
    };
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const items = Array.from(document.querySelectorAll('.episode-item'));
    expect(items.length).toBe(3);
    expect((items[0] as HTMLElement).dataset.ep).toBe('1');
    expect((items[1] as HTMLElement).dataset.ep).toBe('2');
    expect((items[2] as HTMLElement).dataset.ep).toBe('3');
  });

  it('episodes with non-finite num (NaN/Infinity) sorted to end', () => {
    const show = makeShow({ id: 1, totalSeasons: 1, totalEpisodes: 3 });
    show.seasons = {
      1: [
        makeEpisode({ num: 2, id: 12 }),
        makeEpisode({ num: NaN, id: 99 }),
        makeEpisode({ num: 1, id: 11 }),
      ],
    };
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const items = Array.from(document.querySelectorAll('.episode-item'));
    expect(items.length).toBe(3);
    expect((items[0] as HTMLElement).dataset.ep).toBe('1');
    expect((items[1] as HTMLElement).dataset.ep).toBe('2');
    expect((items[2] as HTMLElement).dataset.ep).toBe('NaN');
  });

  it('in-order episodes remain in order (no regression)', () => {
    const show = makeShowWithSeasons({ 1: 3 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][1].name = 'Ep 2';
    show.seasons[1][2].name = 'Ep 3';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const items = Array.from(document.querySelectorAll('.episode-item'));
    expect((items[0] as HTMLElement).dataset.ep).toBe('1');
    expect((items[1] as HTMLElement).dataset.ep).toBe('2');
    expect((items[2] as HTMLElement).dataset.ep).toBe('3');
  });
});

// ============================================================================
// BUG-A11-03: tagsSectionHtml guards non-array show.tags
// ============================================================================
describe('BUG-A11-03: tagsSectionHtml guards non-array show.tags', () => {
  it('show.tags as string → no character-iteration (no .user-tag per char)', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { tags: unknown }).tags = 'Summer';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const tags = Array.from(document.querySelectorAll('.user-tag'));
    expect(tags.length).toBe(0);
  });

  it('show.tags as null → no tags rendered (no crash)', () => {
    const show = makeShow({ id: 1, tags: undefined });
    (show as unknown as { tags: unknown }).tags = null;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelectorAll('.user-tag').length).toBe(0);
  });

  it('show.tags as object → no crash, no tags rendered', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { tags: unknown }).tags = { 0: 'a', 1: 'b' };
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    expect(() => renderShowDetail(getMain())).not.toThrow();
    expect(document.querySelectorAll('.user-tag').length).toBe(0);
  });

  it('show.tags as valid array → tags rendered normally', () => {
    const show = makeShow({ id: 1, tags: ['Summer', 'Rewatch'] });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelectorAll('.user-tag').length).toBe(2);
  });
});

// ============================================================================
// BUG-A11-04: episode list guards non-array seasons[currentSeason]
// ============================================================================
describe('BUG-A11-04: episode list guards non-array seasons[currentSeason]', () => {
  it('seasons[1] as string → no character-iteration (no .episode-item per char)', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { seasons: Record<string, unknown> }).seasons = { 1: 'abc' };
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    expect(() => renderShowDetail(getMain())).not.toThrow();
    expect(document.querySelectorAll('.episode-item').length).toBe(0);
  });

  it('seasons[1] as object → no crash, no episodes rendered', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { seasons: Record<string, unknown> }).seasons = { 1: { num: 1 } };
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    expect(() => renderShowDetail(getMain())).not.toThrow();
    expect(document.querySelectorAll('.episode-item').length).toBe(0);
  });

  it('seasons[1] as null → empty episode list, no crash', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { seasons: Record<string, unknown> }).seasons = { 1: null };
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    expect(() => renderShowDetail(getMain())).not.toThrow();
    expect(document.querySelectorAll('.episode-item').length).toBe(0);
  });
});

// ============================================================================
// BUG-A11-06: episode list skips null/undefined items in array
// ============================================================================
describe('BUG-A11-06: episode list skips null/undefined items', () => {
  it('array with null/undefined episodes → skipped, no TypeError', () => {
    const show = makeShow({ id: 1, totalSeasons: 1, totalEpisodes: 3 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    show.seasons = { 1: [null as any, makeEpisode({ num: 2, id: 12 }), undefined as any, makeEpisode({ num: 1, id: 11 })] };
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    expect(() => renderShowDetail(getMain())).not.toThrow();
    const items = Array.from(document.querySelectorAll('.episode-item'));
    expect(items.length).toBe(2);
    expect((items[0] as HTMLElement).dataset.ep).toBe('1');
    expect((items[1] as HTMLElement).dataset.ep).toBe('2');
  });
});

// ============================================================================
// BUG-A11-07: genres guards non-array
// ============================================================================
describe('BUG-A11-07: detail-genres guards non-array show.genres', () => {
  it('show.genres as string → no crash, no genre-tag elements', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { genres: unknown }).genres = 'Drama';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    expect(() => renderShowDetail(getMain())).not.toThrow();
    expect(document.querySelectorAll('.genre-tag').length).toBe(0);
  });

  it('show.genres as null → no crash', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { genres: unknown }).genres = null;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    expect(() => renderShowDetail(getMain())).not.toThrow();
    expect(document.querySelectorAll('.genre-tag').length).toBe(0);
  });

  it('show.genres as valid array → genre-tag elements rendered', () => {
    const show = makeShow({ id: 1, genres: ['Drama', 'Comedy'] });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelectorAll('.genre-tag').length).toBe(2);
  });
});

// ============================================================================
// BUG-A11-05: show.image non-string doesn't crash renderShowDetail
// ============================================================================
describe('BUG-A11-05: show.image non-string guarded (no .replace TypeError)', () => {
  it('show.image as number → no crash (no .replace TypeError on non-string)', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { image: unknown }).image = 42;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    expect(() => renderShowDetail(getMain())).not.toThrow();
    // typeof 42 !== 'string' → bigImg = null → falls to solo-medium branch (42 truthy).
    const img = document.querySelector('.detail-poster') as HTMLImageElement | null;
    expect(img).toBeTruthy();
  });

  it('show.image as object → no crash', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { image: unknown }).image = { medium: 'x' };
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    expect(() => renderShowDetail(getMain())).not.toThrow();
  });

  it('show.image as 0 (falsy non-string) → placeholder branch, no crash', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { image: unknown }).image = 0;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    expect(() => renderShowDetail(getMain())).not.toThrow();
    const placeholder = document.querySelector('.detail-poster-placeholder');
    expect(placeholder).toBeTruthy();
  });

  it('show.image as valid string URL → original_portrait replace works (no regression)', () => {
    const url = 'https://static.tvmaze.com/uploads/images/medium_portrait/100/250000.jpg';
    const show = makeShow({ id: 1, image: url });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const img = document.querySelector('.detail-poster') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(
      'https://static.tvmaze.com/uploads/images/original_portrait/100/250000.jpg',
    );
  });
});

// ============================================================================
// BUG-A11-08: openNoteEditor guards show.seasons undefined + non-array season
// ============================================================================
describe('BUG-A11-08: openNoteEditor guards corrupted seasons', () => {
  function setupAndClickNote(show: Show): void {
    setState({ currentShowId: show.id, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const btn = document.querySelector('[data-action="editNote"]') as HTMLElement | null;
    if (btn) btn.click();
  }

  it('show.seasons undefined → editNote click no-op (no TypeError)', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    (show as unknown as { seasons: unknown }).seasons = undefined;
    expect(() => setupAndClickNote(show)).not.toThrow();
    expect(setEpisodeNote).not.toHaveBeenCalled();
    expect(showModal).not.toHaveBeenCalled();
  });

  it('show.seasons[1] as string → editNote click no-op (no .find TypeError)', () => {
    const show = makeShow({ id: 1 });
    (show as unknown as { seasons: Record<string, unknown> }).seasons = { 1: 'abc' };
    expect(() => setupAndClickNote(show)).not.toThrow();
    expect(setEpisodeNote).not.toHaveBeenCalled();
    expect(showModal).not.toHaveBeenCalled();
  });

  it('show.seasons null → editNote click no-op', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    (show as unknown as { seasons: unknown }).seasons = null;
    expect(() => setupAndClickNote(show)).not.toThrow();
    expect(setEpisodeNote).not.toHaveBeenCalled();
    expect(showModal).not.toHaveBeenCalled();
  });
});

// ============================================================================
// BUG-A11-09: openAddTagModal suggestions guard non-array s.tags
// ============================================================================
describe('BUG-A11-09: openAddTagModal suggestions guard non-array tags', () => {
  it('other show has tags as string → no character-iteration in suggestions', () => {
    const showA = makeShow({ id: 1, tags: [] });
    const showB = makeShow({ id: 2, tags: [] });
    (showB as unknown as { tags: unknown }).tags = 'Summer';
    setState({ currentShowId: 1, currentSeason: 1, shows: [showA, showB] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const btn = document.querySelector('[data-action="addTag"]') as HTMLElement;
    btn.click();
    const suggestions = Array.from(document.querySelectorAll('.tag-suggestion'));
    expect(suggestions.length).toBe(0);
  });

  it('other show has tags as valid array → suggestions rendered', () => {
    const showA = makeShow({ id: 1, tags: [] });
    const showB = makeShow({ id: 2, tags: ['Summer', 'Rewatch'] });
    setState({ currentShowId: 1, currentSeason: 1, shows: [showA, showB] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const btn = document.querySelector('[data-action="addTag"]') as HTMLElement;
    btn.click();
    const suggestions = Array.from(document.querySelectorAll('.tag-suggestion'));
    expect(suggestions.length).toBe(2);
  });

  it('other show has tags with non-string elements → only strings added', () => {
    const showA = makeShow({ id: 1, tags: [] });
    const showB = makeShow({ id: 2, tags: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (showB as unknown as { tags: any[] }).tags = ['Valid', 42, null, { x: 1 }, 'Also'];
    setState({ currentShowId: 1, currentSeason: 1, shows: [showA, showB] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const btn = document.querySelector('[data-action="addTag"]') as HTMLElement;
    btn.click();
    const suggestions = Array.from(document.querySelectorAll('.tag-suggestion'));
    expect(suggestions.length).toBe(2);
    const labels = suggestions.map((s) => s.textContent);
    expect(labels).toContain('Valid');
    expect(labels).toContain('Also');
  });
});

// ============================================================================
// BUG-A11-10: addTag modal stays open on failure (duplicate/max)
// ============================================================================
describe('BUG-A11-10: addTag modal stays open on failure', () => {
  function openAddTagModal(): void {
    const show = makeShow({ id: 1, tags: [] });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const btn = document.querySelector('[data-action="addTag"]') as HTMLElement;
    btn.click();
  }

  it('addShowTag returns false (duplicate) → closeModal NOT called', () => {
    (addShowTag as ReturnType<typeof vi.fn>).mockImplementation(() => false);
    openAddTagModal();
    const input = document.getElementById('tagInput') as HTMLInputElement;
    input.value = 'NewTag';
    clickModalButton('Aggiungi');
    expect(addShowTag).toHaveBeenCalledWith(1, 'NewTag');
    // Modal should NOT have closed (keepOpen=true, closeModal not called by onClick).
    expect(closeModal).not.toHaveBeenCalled();
  });

  it('addShowTag returns true (success) → closeModal called', () => {
    (addShowTag as ReturnType<typeof vi.fn>).mockImplementation(() => true);
    openAddTagModal();
    const input = document.getElementById('tagInput') as HTMLInputElement;
    input.value = 'NewTag';
    clickModalButton('Aggiungi');
    expect(addShowTag).toHaveBeenCalledWith(1, 'NewTag');
    expect(closeModal).toHaveBeenCalledTimes(1);
  });

  it('Enter on tag input with success → closeModal called', () => {
    vi.useFakeTimers();
    (addShowTag as ReturnType<typeof vi.fn>).mockImplementation(() => true);
    openAddTagModal();
    const input = document.getElementById('tagInput') as HTMLInputElement;
    input.value = 'ViaEnter';
    // Advance the 50ms setTimeout in openAddTagModal that attaches the Enter listener.
    vi.advanceTimersByTime(60);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(addShowTag).toHaveBeenCalledWith(1, 'ViaEnter');
    expect(closeModal).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('Enter on tag input with failure → closeModal NOT called', () => {
    vi.useFakeTimers();
    (addShowTag as ReturnType<typeof vi.fn>).mockImplementation(() => false);
    openAddTagModal();
    const input = document.getElementById('tagInput') as HTMLInputElement;
    input.value = 'Dup';
    vi.advanceTimersByTime(60);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(addShowTag).toHaveBeenCalledWith(1, 'Dup');
    expect(closeModal).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('Annulla button → modal closes (keepOpen not set on Annulla)', () => {
    (addShowTag as ReturnType<typeof vi.fn>).mockImplementation(() => false);
    openAddTagModal();
    clickModalButton('Annulla');
    // Annulla has no keepOpen → clickModalButton simulates auto-close.
    expect(addShowTag).not.toHaveBeenCalled();
  });
});

// ============================================================================
// P2 interactions: star rating toggle
// ============================================================================
describe('P2: star rating click → setEpisodeRating called', () => {
  function setup(show: Show): HTMLElement {
    setState({ currentShowId: show.id, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    return main;
  }

  it('click on star 3 → setEpisodeRating(showId, season, ep, 3)', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setup(show);
    const star = document.querySelector('[data-star="3"]') as HTMLElement;
    star.click();
    expect(setEpisodeRating).toHaveBeenCalledWith(1, 1, 1, 3);
  });

  it('click on same star as current rating → setEpisodeRating(..., 0) removes rating', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    (show.seasons[1][0] as { rating?: number }).rating = 4;
    setup(show);
    const star = document.querySelector('[data-star="4"]') as HTMLElement;
    star.click();
    expect(setEpisodeRating).toHaveBeenCalledWith(1, 1, 1, 0);
  });

  it('click on different star than current → setEpisodeRating with new value', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    (show.seasons[1][0] as { rating?: number }).rating = 2;
    setup(show);
    const star = document.querySelector('[data-star="5"]') as HTMLElement;
    star.click();
    expect(setEpisodeRating).toHaveBeenCalledWith(1, 1, 1, 5);
  });

  it('click on .ep-rating container (not a star) → no-op', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setup(show);
    const container = document.querySelector('.ep-rating') as HTMLElement;
    container.click();
    expect(setEpisodeRating).not.toHaveBeenCalled();
  });

  it('star click does NOT also trigger toggleEpisode (stopPropagation + closest)', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setup(show);
    const star = document.querySelector('[data-star="3"]') as HTMLElement;
    star.click();
    expect(setEpisodeRating).toHaveBeenCalledTimes(1);
    expect(toggleEpisode).not.toHaveBeenCalled();
  });
});

// ============================================================================
// P2 interactions: note editor save
// ============================================================================
describe('P2: note editor save → setEpisodeNote called', () => {
  it('click editNote → modal opens → Salva → setEpisodeNote called with textarea value', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const btn = document.querySelector('[data-action="editNote"]') as HTMLElement;
    btn.click();
    const ta = document.getElementById('noteTextarea') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    ta.value = 'My note';
    clickModalButton('Salva');
    expect(setEpisodeNote).toHaveBeenCalledWith(1, 1, 1, 'My note');
  });

  it('empty note → setEpisodeNote called with empty string (clears note)', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const btn = document.querySelector('[data-action="editNote"]') as HTMLElement;
    btn.click();
    const ta = document.getElementById('noteTextarea') as HTMLTextAreaElement;
    ta.value = '';
    clickModalButton('Salva');
    expect(setEpisodeNote).toHaveBeenCalledWith(1, 1, 1, '');
  });

  it('existing note pre-filled in textarea', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][0].note = 'Pre-existing note';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const btn = document.querySelector('[data-action="editNote"]') as HTMLElement;
    btn.click();
    const ta = document.getElementById('noteTextarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('Pre-existing note');
  });
});

// ============================================================================
// P2 interactions: tag remove
// ============================================================================
describe('P2: tag remove click → removeShowTag called', () => {
  it('click on tag-remove button → removeShowTag(showId, tag)', () => {
    const show = makeShow({ id: 1, tags: ['Summer', 'Rewatch'] });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const btns = Array.from(document.querySelectorAll('[data-action="removeTag"]')) as HTMLElement[];
    expect(btns.length).toBe(2);
    btns[0].click();
    expect(removeShowTag).toHaveBeenCalledWith(1, 'Summer');
  });

  it('tag with HTML chars → data-tag round-trips correctly via escapeAttr', () => {
    const show = makeShow({ id: 1, tags: ['<script>alert(1)</script>'] });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    const main = getMain();
    resetBoundGuard();
    renderShowDetail(main);
    bindShowDetailEvents(main);
    const btn = document.querySelector('[data-action="removeTag"]') as HTMLElement;
    // No raw <script> element created in the DOM (XSS neutralized by escapeAttr).
    expect(document.querySelectorAll('#mainContent script').length).toBe(0);
    // dataset.tag decodes entities back to the original string.
    expect(btn.dataset.tag).toBe('<script>alert(1)</script>');
    btn.click();
    expect(removeShowTag).toHaveBeenCalledWith(1, '<script>alert(1)</script>');
  });
});

// ============================================================================
// XSS regression: tags, notes, episode names
// ============================================================================
describe('XSS regression: tags/notes/episode-name escaped in render', () => {
  it('tag with <img onerror> → escaped, no <img> element created', () => {
    const show = makeShow({
      id: 1,
      tags: ['<img src=x onerror=alert(1)>'],
    });
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelectorAll('#mainContent img').length).toBe(0);
    expect(document.querySelectorAll('#mainContent [onerror]').length).toBe(0);
  });

  it('episode note preview with <script> → escaped, no script execution', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][0].note = '<script>alert("xss")</script>';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelectorAll('#mainContent script').length).toBe(0);
    const preview = document.querySelector('.episode-note-preview');
    expect(preview?.textContent).toBe('<script>alert("xss")</script>');
  });

  it('episode name with HTML → escaped, no onerror attr in DOM', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = '<img src=y onerror=alert(2)>';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelectorAll('#mainContent [onerror]').length).toBe(0);
    const nameEl = document.querySelector('.episode-name');
    expect(nameEl?.textContent).toBe('<img src=y onerror=alert(2)>');
  });

  it('episode aria-label with HTML in name → escaped via escapeAttr', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = '<b>"quote"</b>';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const item = document.querySelector('.episode-item') as HTMLElement;
    expect(item.getAttribute('aria-label')).toContain('<b>"quote"</b>');
    // No raw <b> element created from aria-label.
    expect(document.querySelectorAll('#mainContent b').length).toBe(0);
  });
});

// ============================================================================
// P2: episode-note-preview only rendered when note is non-empty string
// ============================================================================
describe('episode-note-preview rendering edge cases', () => {
  it('note as empty string → no preview rendered', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][0].note = '';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelector('.episode-note-preview')).toBeNull();
  });

  it('note as null → no preview rendered', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][0].note = null as unknown as string; // intentional null to test runtime guard
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelector('.episode-note-preview')).toBeNull();
  });

  it('note as undefined → no preview rendered', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][0].note = undefined;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelector('.episode-note-preview')).toBeNull();
  });

  it('note as non-empty string → preview rendered with escaped content', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][0].note = 'Great episode!';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const preview = document.querySelector('.episode-note-preview');
    expect(preview?.textContent).toBe('Great episode!');
  });
});

// ============================================================================
// Star rating HTML structure
// ============================================================================
describe('starRatingHtml structure', () => {
  it('renders MAX_EPISODE_RATING stars per episode', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const stars = document.querySelectorAll('.star');
    expect(stars.length).toBe(5);
  });

  it('rating=3 → first 3 stars have .filled class', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    (show.seasons[1][0] as { rating?: number }).rating = 3;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const stars = Array.from(document.querySelectorAll('.star'));
    expect(stars[0].classList.contains('filled')).toBe(true);
    expect(stars[1].classList.contains('filled')).toBe(true);
    expect(stars[2].classList.contains('filled')).toBe(true);
    expect(stars[3].classList.contains('filled')).toBe(false);
    expect(stars[4].classList.contains('filled')).toBe(false);
  });

  it('no rating → no stars filled', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    expect(document.querySelectorAll('.star.filled').length).toBe(0);
  });

  it('stars have role=button, tabindex=0, aria-label', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const stars = document.querySelectorAll('.star');
    for (const s of stars) {
      expect(s.getAttribute('role')).toBe('button');
      expect(s.getAttribute('tabindex')).toBe('0');
      expect(s.getAttribute('aria-label')).toMatch(/stelle$/);
    }
  });
});

// ============================================================================
// Episode runtime null/0 edge cases
// ============================================================================
describe('episode runtime edge cases in render', () => {
  it('runtime=0 → no "0 min" in meta (falsy check)', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][0].runtime = 0;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const meta = document.querySelector('.episode-meta');
    expect(meta?.textContent).not.toContain('0 min');
  });

  it('runtime=null → no "min" in meta', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][0].runtime = null;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const meta = document.querySelector('.episode-meta');
    expect(meta?.textContent).not.toContain('min');
  });

  it('airdate null → no "N/D" in episode meta', () => {
    const show = makeShowWithSeasons({ 1: 1 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][0].airdate = null;
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const meta = document.querySelector('.episode-meta');
    expect(meta?.textContent).not.toContain('N/D');
  });
});

// ============================================================================
// Cross-cutting: no regressions in existing rendering
// ============================================================================
describe('no regressions in core rendering', () => {
  it('episode-item data-attrs preserved after sort fix', () => {
    const show = makeShowWithSeasons({ 1: 2 }, { id: 1 });
    show.seasons[1][0].name = 'Pilot';
    show.seasons[1][1].name = 'Ep 2';
    setState({ currentShowId: 1, currentSeason: 1, shows: [show] });
    renderShowDetail(getMain());
    const items = document.querySelectorAll('.episode-item');
    expect(items.length).toBe(2);
    const first = items[0] as HTMLElement;
    expect(first.dataset.action).toBe('toggleEpisode');
    expect(first.dataset.showId).toBe('1');
    expect(first.dataset.season).toBe('1');
    expect(first.dataset.ep).toBe('1');
  });

  it('season-tabs render correctly with sort fix', () => {
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
});
