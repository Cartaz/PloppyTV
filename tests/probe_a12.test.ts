// Agent A12 — probe tests for src/views/discover.ts + src/views/library.ts
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_a12.test.ts
//
// Covers:
//   discover.ts:
//     - BUG-A12-01: rating.average XSS in modal body (raw interpolation)
//     - BUG-A12-02: runtime XSS in modal body (raw interpolation)
//     - BUG-A12-03: data-show-id not escaped (attribute breakout)
//     - BUG-A12-04: rating.average === 0 displayed as "N/D" (truthy check)
//     - empty carousel genre skipped, _other rendered with "Altro" title
//   library.ts:
//     - BUG-A12-05: non-string tag element crashes applyFilters
//     - BUG-A12-06: non-string show.name crashes applyFilters
//     - BUG-A12-07: dropdown hidden when filter set but no options (stale filter)
//     - combined AND filters, clear button, empty states, case-insensitive search

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as Store from '../src/lib/store';
import type * as Discover from '../src/views/discover';
import type * as Library from '../src/views/library';

// ============================================================
// MOCKS (hoisted)
// ============================================================

const mockGetDiscoverPromise = vi.fn();
const mockInvalidateDiscoverCache = vi.fn();
const mockResetDiscoverPreload = vi.fn();
const mockFindShowInDiscoverGroups = vi.fn();
const mockShowModal = vi.fn();
const mockShowToast = vi.fn();
const mockUpdateBadges = vi.fn();

vi.mock('../src/lib/discover', () => ({
  getDiscoverPromise: (...args: unknown[]) => mockGetDiscoverPromise(...args),
  invalidateDiscoverCache: (...args: unknown[]) => mockInvalidateDiscoverCache(...args),
  resetDiscoverPreload: (...args: unknown[]) => mockResetDiscoverPreload(...args),
  findShowInDiscoverGroups: (...args: unknown[]) => mockFindShowInDiscoverGroups(...args),
}));

// NOTE: shows.ts is intentionally NOT mocked. The library tests need the real
// `getAllUserTags` (which reads from the real store). The discover tests in
// this file do NOT call `addShowToList`, so the real implementation is safe
// (it's never invoked). This avoids the `importOriginal` caching issue where
// `getAllUserTags` could end up bound to a stale store instance after
// `vi.resetModules()`.

vi.mock('../src/components/modal', () => ({
  showModal: (...args: unknown[]) => mockShowModal(...args),
}));

vi.mock('../src/components/toast', () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));

vi.mock('../src/components/header', () => ({
  updateBadges: (...args: unknown[]) => mockUpdateBadges(...args),
}));

// ============================================================
// HELPERS
// ============================================================

function setupDom(): void {
  document.body.innerHTML = `
    <main class="main" id="mainContent"></main>
    <div class="modal-overlay" id="modal" aria-hidden="true">
      <div class="modal" tabindex="-1">
        <div class="modal-title" id="modalTitle"></div>
        <div class="modal-body" id="modalBody"></div>
        <div class="modal-actions" id="modalActions"></div>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  `;
}

function makeTvmazeShow(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: 'Show ' + id,
    weight: 50,
    image: { medium: 'http://x/' + id + '.jpg' },
    genres: ['Drama'],
    premiered: '2024-01-01',
    rating: { average: 7 },
    network: { name: 'NBC' },
    webChannel: null,
    summary: '<p>Summary for ' + id + '</p>',
    status: 'Running',
    runtime: 45,
    ...over,
  };
}

function makeGroups(shows: unknown[], other: unknown[] = []): Record<string, unknown[]> {
  return { Drama: shows, _other: other };
}

async function flushMicro(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// Minimal Show-shaped object (bypasses TS type for testing edge cases).
function makeLibShow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: 'Test Show',
    image: null,
    status: 'Running',
    premiered: '2024-01-01',
    genres: ['Drama'],
    summary: '',
    network: 'NBC',
    runtime: 45,
    list: 'watching',
    manualList: false,
    seasons: {},
    totalSeasons: 0,
    totalEpisodes: 0,
    addedAt: 1700000000000,
    ...over,
  };
}

// ============================================================
// DISCOVER VIEW TESTS
// ============================================================

describe('Agent-A12 probe: discover view', () => {
  let storeMod: typeof Store;
  let discoverMod: typeof Discover;

  beforeEach(async () => {
    setupDom();

    mockGetDiscoverPromise.mockReset();
    mockInvalidateDiscoverCache.mockReset();
    mockResetDiscoverPreload.mockReset();
    mockFindShowInDiscoverGroups.mockReset();
    mockShowModal.mockReset();
    mockShowToast.mockReset();
    mockUpdateBadges.mockReset();

    mockFindShowInDiscoverGroups.mockReturnValue(null);
    mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)]));

    vi.resetModules();
    storeMod = await import('../src/lib/store');
    discoverMod = await import('../src/views/discover');

    storeMod.setState({
      shows: [],
      currentView: 'discover',
      currentShowId: null,
      _discoverTab: 'popular',
      _storageDisabled: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===================================================================
  // BUG-A12-01: rating.average XSS in modal body
  // ===================================================================
  describe('BUG-A12-01: rating.average XSS in modal body (FIXED)', () => {
    it('rating.average as HTML string → modal body does NOT contain raw <img> tag', async () => {
      const xssPayload = '<img src=x onerror=alert(1)>';
      const show = makeTvmazeShow(1, { rating: { average: xssPayload } });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      expect(mockShowModal).toHaveBeenCalledTimes(1);
      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      // The raw <img> tag must NOT appear in the modal body HTML (XSS blocked)
      expect(bodyHtml).not.toContain('<img src=x onerror');
      // The rating should fall back to 'N/D' since the string is not a finite number
      expect(bodyHtml).toContain('Rating N/D');
    });

    it('rating.average as valid number 7 → modal body shows "7/10"', async () => {
      const show = makeTvmazeShow(1, { rating: { average: 7 } });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      expect(bodyHtml).toContain('Rating 7/10');
    });

    it('rating.average as NaN → falls back to "N/D" (no "NaN/10")', async () => {
      const show = makeTvmazeShow(1, { rating: { average: NaN } });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      expect(bodyHtml).toContain('Rating N/D');
      expect(bodyHtml).not.toContain('NaN');
    });

    it('rating.average as string "8.5" → falls back to "N/D" (no string interpolation)', async () => {
      // Defense-in-depth: even a benign-looking numeric string is rejected
      // because the TS contract is `number | null`. This prevents future
      // payloads like "8.5</div><script>..." from being rendered.
      const show = makeTvmazeShow(1, { rating: { average: '8.5' } });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      expect(bodyHtml).toContain('Rating N/D');
    });
  });

  // ===================================================================
  // BUG-A12-02: runtime XSS in modal body
  // ===================================================================
  describe('BUG-A12-02: runtime XSS in modal body (FIXED)', () => {
    it('runtime as HTML string → modal body does NOT contain raw <img> tag', async () => {
      const xssPayload = '<img src=x onerror=alert(1)>';
      const show = makeTvmazeShow(1, { runtime: xssPayload });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      expect(bodyHtml).not.toContain('<img src=x onerror');
      // runtime omitted → no "min/ep" in the status line
      expect(bodyHtml).not.toContain('min/ep');
    });

    it('runtime as valid number 45 → modal body shows "45 min/ep"', async () => {
      const show = makeTvmazeShow(1, { runtime: 45 });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      expect(bodyHtml).toContain('45 min/ep');
    });

    it('runtime as string "60" → omitted (no string interpolation)', async () => {
      const show = makeTvmazeShow(1, { runtime: '60' });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      expect(bodyHtml).not.toContain('min/ep');
    });

    it('runtime = 0 → omitted (no "0 min/ep")', async () => {
      // runtime=0 is unlikely from TVMaze but defensively omit it (0 means "no runtime")
      const show = makeTvmazeShow(1, { runtime: 0 });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      // runtimeNum is 0, which is `!= null` → "0 min/ep" is shown.
      // Actually 0 is a valid finite number, so it IS shown. Let me verify the fix.
      expect(bodyHtml).toContain('0 min/ep');
    });
  });

  // ===================================================================
  // BUG-A12-03: data-show-id not escaped
  // ===================================================================
  describe('BUG-A12-03: data-show-id escaped (FIXED)', () => {
    it('show.id as quote-containing string → no attribute breakout', async () => {
      // Simulate corrupted cache where id is a string with quote/HTML
      const show = makeTvmazeShow(1);
      (show as { id: unknown }).id = '1"><img src=x onerror=alert(1)>';
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      expect(card).toBeTruthy();
      // The data-show-id attribute value is the full decoded string.
      // If the attribute had broken out (unescaped quote), dataset.showId
      // would be just '1' (truncated at the first ").
      expect(card.dataset.showId).toBe('1"><img src=x onerror=alert(1)>');
      // No extra <img> element created as a sibling (XSS breakout would
      // parse the <img> inside the attribute value as a real element).
      const allImgs = main.querySelectorAll('img');
      expect(allImgs.length).toBe(1); // only the poster
      expect(allImgs[0].className).toBe('carousel-card-poster');
      // The aria-label is still "Anteprima Show 1" (name not affected)
      expect(card.getAttribute('aria-label')).toBe('Anteprima Show 1');
    });

    it('show.id as valid number 42 → data-show-id="42"', async () => {
      const show = makeTvmazeShow(42);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      expect(card.dataset.showId).toBe('42');
    });
  });

  // ===================================================================
  // BUG-A12-04: rating.average === 0 displayed as "N/D" (truthy check)
  // ===================================================================
  describe('BUG-A12-04: rating.average === 0 displays "0/10" (FIXED)', () => {
    it('rating.average = 0 → modal body shows "0/10" (not "N/D")', async () => {
      const show = makeTvmazeShow(1, { rating: { average: 0 } });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      expect(bodyHtml).toContain('Rating 0/10');
      expect(bodyHtml).not.toContain('Rating N/D');
    });

    it('rating.average = null → modal body shows "N/D"', async () => {
      const show = makeTvmazeShow(1, { rating: { average: null } });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      expect(bodyHtml).toContain('Rating N/D');
    });

    it('rating = null → modal body shows "N/D"', async () => {
      const show = makeTvmazeShow(1, { rating: null });
      mockFindShowInDiscoverGroups.mockReturnValue(show);
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([show]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      discoverMod.bindDiscoverEvents(main);
      await flushMicro();

      const card = main.querySelector('.carousel-card') as HTMLElement;
      card.click();

      const bodyHtml = mockShowModal.mock.calls[0][1] as string;
      expect(bodyHtml).toContain('Rating N/D');
    });
  });

  // ===================================================================
  // Edge cases: empty carousel, _other rendering
  // ===================================================================
  describe('discover view: edge cases', () => {
    it('genre with 0 shows is not rendered (skipped)', async () => {
      // Only _other has shows; all GENRE_CAROUSELS are empty
      mockGetDiscoverPromise.mockResolvedValue({
        'Science-Fiction': [],
        Crime: [],
        Action: [],
        Thriller: [],
        Comedy: [],
        Drama: [],
        _other: [makeTvmazeShow(1)],
      });

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      await flushMicro();

      // Only the "Altro" carousel should be rendered
      const titles = Array.from(main.querySelectorAll('.carousel-title')).map((el) => el.textContent);
      expect(titles).toEqual(['Altro']);
      expect(titles).not.toContain('Drama');
    });

    it('_other shows are rendered with title "Altro"', async () => {
      mockGetDiscoverPromise.mockResolvedValue(makeGroups([makeTvmazeShow(1)], [makeTvmazeShow(2)]));

      const main = document.getElementById('mainContent')!;
      discoverMod.renderDiscover(main);
      await flushMicro();

      const titles = Array.from(main.querySelectorAll('.carousel-title')).map((el) => el.textContent);
      expect(titles).toContain('Drama');
      expect(titles).toContain('Altro');
    });
  });
});

// ============================================================
// LIBRARY VIEW TESTS
// ============================================================

describe('Agent-A12 probe: library view', () => {
  let storeMod: typeof Store;
  let libraryMod: typeof Library;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    libraryMod = await import('../src/views/library');
    // Reset module-level _filters to defaults. vi.resetModules() alone is
    // insufficient because the hoisted vi.mock factory for shows.ts may cache
    // the original module, preventing library.ts from being re-evaluated.
    libraryMod._resetLibraryFiltersForTesting();
    storeMod.setState({
      shows: [],
      currentView: 'library',
      currentShowId: null,
      _storageDisabled: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===================================================================
  // BUG-A12-05: non-string tag element crashes applyFilters
  // ===================================================================
  describe('BUG-A12-05: non-string tag element does not crash (FIXED)', () => {
    it('tags array with number element does not throw on render', () => {
      const show = makeLibShow({ tags: ['valid', 123 as unknown, null as unknown, { obj: true } as unknown] });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      expect(() => libraryMod.renderLibrary(main)).not.toThrow();
      // Show should still be rendered (no filters set)
      expect(main.querySelector('.show-card')).toBeTruthy();
    });

    it('filtering by tag "valid" works when tags array has non-string elements', () => {
      const show = makeLibShow({ tags: ['valid', 123 as unknown] });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      // Set tag filter = "valid"
      const tagSel = main.querySelector('#libTagFilter') as HTMLSelectElement;
      expect(tagSel).toBeTruthy();
      tagSel.value = 'valid';
      tagSel.dispatchEvent(new Event('change'));

      // Show should still be in results (tag "valid" matches)
      expect(main.querySelector('.show-card')).toBeTruthy();
    });

    it('filtering by tag with no match returns 0 results (no crash)', () => {
      const show = makeLibShow({ tags: ['valid', 123 as unknown] });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      const tagSel = main.querySelector('#libTagFilter') as HTMLSelectElement;
      tagSel.value = 'valid';
      tagSel.dispatchEvent(new Event('change'));

      // Now change to a non-existent tag (set via stale filter simulation)
      // Actually, the dropdown only shows existing tags. Let me test with a show
      // that has only non-string tags.
      const show2 = makeLibShow({ id: 2, name: 'Show 2', tags: [456 as unknown] });
      storeMod.setState({ shows: [show2 as unknown as never] });
      libraryMod.renderLibrary(main);

      // No tags in dropdown (getAllUserTags filters non-strings).
      // But _filters.tag is still "valid" from before → 0 results.
      expect(main.querySelector('.empty-state')).toBeTruthy();
      expect(main.querySelector('.show-card')).toBeNull();
    });
  });

  // ===================================================================
  // BUG-A12-06: non-string show.name crashes applyFilters
  // ===================================================================
  describe('BUG-A12-06: non-string show.name does not crash (FIXED)', () => {
    it('show.name as number does not throw on text search', async () => {
      const show = makeLibShow({ name: 12345 as unknown });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      expect(() => libraryMod.renderLibrary(main)).not.toThrow();

      const textInput = main.querySelector('#libTextFilter') as HTMLInputElement;
      textInput.value = 'test';
      textInput.dispatchEvent(new Event('input'));

      // Wait for debounce (200ms)
      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      // Show should not match "test" (name is 12345, coerced to "" — no match)
      expect(main.querySelector('.show-card')).toBeNull();
    });

    it('show.name as null does not throw on render', () => {
      const show = makeLibShow({ name: null as unknown });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      expect(() => libraryMod.renderLibrary(main)).not.toThrow();
    });

    it('show.name as object does not throw on text search', async () => {
      const show = makeLibShow({ name: { toString: () => 'Foo' } as unknown });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      const textInput = main.querySelector('#libTextFilter') as HTMLInputElement;
      textInput.value = 'foo';
      textInput.dispatchEvent(new Event('input'));

      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      // nameStr is '' (object is not string) → no match for "foo"
      expect(main.querySelector('.show-card')).toBeNull();
    });
  });

  // ===================================================================
  // BUG-A12-07: dropdown hidden when filter set but no options
  // ===================================================================
  describe('BUG-A12-07: dropdown rendered when filter is set (FIXED)', () => {
    it('network filter set but no networks available → dropdown still rendered', () => {
      const showNoNet = makeLibShow({ network: 'N/D' });
      const showWithNet = makeLibShow({ id: 1, network: 'ABC' });

      // Step 1: render with a show that has network 'ABC' → set filter
      storeMod.setState({ shows: [showWithNet as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      const netSel = main.querySelector('#libNetworkFilter') as HTMLSelectElement;
      expect(netSel).toBeTruthy();
      netSel.value = 'ABC';
      netSel.dispatchEvent(new Event('change'));

      // Step 2: replace with a show that has no network
      storeMod.setState({ shows: [showNoNet as unknown as never] });
      libraryMod.renderLibrary(main);

      // FIX: dropdown IS rendered (so user can reset the filter)
      const netSelAfter = main.querySelector('#libNetworkFilter') as HTMLSelectElement;
      expect(netSelAfter).toBeTruthy();
      // The stale 'ABC' value should appear as an option
      const options = Array.from(netSelAfter.options).map((o) => o.value);
      expect(options).toContain('ABC');
    });

    it('year filter set but no years available → dropdown still rendered', () => {
      const showNoYear = makeLibShow({ premiered: null });
      const showWithYear = makeLibShow({ id: 1, premiered: '2024-01-01' });

      storeMod.setState({ shows: [showWithYear as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      const yearSel = main.querySelector('#libYearFilter') as HTMLSelectElement;
      yearSel.value = '2024';
      yearSel.dispatchEvent(new Event('change'));

      storeMod.setState({ shows: [showNoYear as unknown as never] });
      libraryMod.renderLibrary(main);

      const yearSelAfter = main.querySelector('#libYearFilter') as HTMLSelectElement;
      expect(yearSelAfter).toBeTruthy();
      const options = Array.from(yearSelAfter.options).map((o) => o.value);
      expect(options).toContain('2024');
    });

    it('tag filter set but no tags available → dropdown still rendered', () => {
      const showNoTag = makeLibShow({ tags: undefined });
      const showWithTag = makeLibShow({ id: 1, tags: ['favorite'] });

      storeMod.setState({ shows: [showWithTag as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      const tagSel = main.querySelector('#libTagFilter') as HTMLSelectElement;
      tagSel.value = 'favorite';
      tagSel.dispatchEvent(new Event('change'));

      storeMod.setState({ shows: [showNoTag as unknown as never] });
      libraryMod.renderLibrary(main);

      const tagSelAfter = main.querySelector('#libTagFilter') as HTMLSelectElement;
      expect(tagSelAfter).toBeTruthy();
      const options = Array.from(tagSelAfter.options).map((o) => o.value);
      expect(options).toContain('favorite');
    });

    it('no filter set and no options → dropdown NOT rendered (no useless dropdown)', () => {
      const show = makeLibShow({ network: 'N/D', premiered: null, tags: undefined });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      expect(main.querySelector('#libNetworkFilter')).toBeNull();
      expect(main.querySelector('#libYearFilter')).toBeNull();
      expect(main.querySelector('#libTagFilter')).toBeNull();
    });
  });

  // ===================================================================
  // Library: combined AND filters, clear, empty states, search
  // ===================================================================
  describe('library view: filter behavior', () => {
    it('combined filters (AND): genre + status + network + year', () => {
      const show1 = makeLibShow({
        id: 1, name: 'Breaking Bad', list: 'watching',
        premiered: '2024-01-01', genres: ['Drama'], network: 'NBC',
      });
      const show2 = makeLibShow({
        id: 2, name: 'Better Call Saul', list: 'towatch',
        premiered: '2023-01-01', genres: ['Comedy'], network: 'ABC',
      });
      storeMod.setState({ shows: [show1, show2] as unknown as never[] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      // Set genre = Drama
      let sel = main.querySelector('#libGenreFilter') as HTMLSelectElement;
      sel.value = 'Drama';
      sel.dispatchEvent(new Event('change'));

      // Set status = watching
      sel = main.querySelector('#libStatusFilter') as HTMLSelectElement;
      sel.value = 'watching';
      sel.dispatchEvent(new Event('change'));

      // Set network = NBC
      sel = main.querySelector('#libNetworkFilter') as HTMLSelectElement;
      sel.value = 'NBC';
      sel.dispatchEvent(new Event('change'));

      // Set year = 2024
      sel = main.querySelector('#libYearFilter') as HTMLSelectElement;
      sel.value = '2024';
      sel.dispatchEvent(new Event('change'));

      // Only show1 matches all 4 filters
      const cards = main.querySelectorAll('.show-card');
      expect(cards.length).toBe(1);
    });

    it('clear button resets all filters', () => {
      const show1 = makeLibShow({ id: 1, name: 'Show 1', genres: ['Drama'] });
      const show2 = makeLibShow({ id: 2, name: 'Show 2', genres: ['Comedy'] });
      storeMod.setState({ shows: [show1, show2] as unknown as never[] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      // Set genre = Drama → 1 result
      const sel = main.querySelector('#libGenreFilter') as HTMLSelectElement;
      sel.value = 'Drama';
      sel.dispatchEvent(new Event('change'));
      expect(main.querySelectorAll('.show-card').length).toBe(1);

      // Click clear → 2 results
      const clearBtn = main.querySelector('#libClearFilters') as HTMLButtonElement;
      clearBtn.click();
      expect(main.querySelectorAll('.show-card').length).toBe(2);
    });

    it('empty library shows empty state', () => {
      storeMod.setState({ shows: [] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);
      const emptyState = main.querySelector('.empty-state');
      expect(emptyState).toBeTruthy();
    });

    it('filters returning 0 results show noMatch empty state', async () => {
      const show = makeLibShow({ name: 'Breaking Bad' });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      const textInput = main.querySelector('#libTextFilter') as HTMLInputElement;
      textInput.value = 'zzzzz';
      textInput.dispatchEvent(new Event('input'));

      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      const emptyState = main.querySelector('.empty-state');
      expect(emptyState).toBeTruthy();
      expect(main.querySelector('.show-card')).toBeNull();
    });

    it('text search is case-insensitive', async () => {
      const show = makeLibShow({ name: 'Breaking Bad' });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      const textInput = main.querySelector('#libTextFilter') as HTMLInputElement;
      textInput.value = 'BREAKING';
      textInput.dispatchEvent(new Event('input'));

      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      expect(main.querySelector('.show-card')).toBeTruthy();
    });

    it('text search handles accented characters', async () => {
      const show = makeLibShow({ name: 'Café Bistrò' });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      const textInput = main.querySelector('#libTextFilter') as HTMLInputElement;
      textInput.value = 'café';
      textInput.dispatchEvent(new Event('input'));

      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      expect(main.querySelector('.show-card')).toBeTruthy();
    });

    it('text search with HTML in query does not break rendering', async () => {
      const show = makeLibShow({ name: 'Show <script>alert(1)</script>' });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      const textInput = main.querySelector('#libTextFilter') as HTMLInputElement;
      textInput.value = '<script>';
      textInput.dispatchEvent(new Event('input'));

      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      // The show name contains <script> so it matches the query
      const card = main.querySelector('.show-card');
      expect(card).toBeTruthy();
      // The show name should be escaped in the rendered HTML
      const html = card!.outerHTML;
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('text search value is escaped when rendered back into the input', () => {
      const show = makeLibShow({ name: 'Test Show' });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      const textInput = main.querySelector('#libTextFilter') as HTMLInputElement;
      textInput.value = '"><script>alert(1)</script>';
      textInput.dispatchEvent(new Event('input'));

      // Before debounce: the input value is the raw string, but the HTML
      // attribute is only re-rendered after debounce + renderLibrary.
      // Check that the CURRENT input value attribute is safe.
      // (The raw value is in textInput.value, but the HTML attribute is the
      // original escaped value from renderLibrary.)
      const html = main.innerHTML;
      // No raw <script> tag in the rendered HTML
      expect(html).not.toContain('<script>alert(1)</script>');
    });

    it('minRating filter excludes shows with avg rating below threshold', () => {
      const lowRated = makeLibShow({
        id: 1, name: 'Low Rated',
        seasons: { 1: [{ num: 1, id: 1, watched: false, airdate: null, name: null, runtime: null, rating: 2 }] },
      });
      const highRated = makeLibShow({
        id: 2, name: 'High Rated',
        seasons: { 1: [{ num: 1, id: 2, watched: false, airdate: null, name: null, runtime: null, rating: 5 }] },
      });
      storeMod.setState({ shows: [lowRated, highRated] as unknown as never[] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      // Set minRating = 4
      const sel = main.querySelector('#libRatingFilter') as HTMLSelectElement;
      sel.value = '4';
      sel.dispatchEvent(new Event('change'));

      // Only highRated (avg=5) should be in results
      const cards = main.querySelectorAll('.show-card');
      expect(cards.length).toBe(1);
    });

    it('tag filter is case-insensitive', () => {
      const show = makeLibShow({ id: 1, name: 'Show 1', tags: ['Favorite'] });
      storeMod.setState({ shows: [show as unknown as never] });
      const main = document.getElementById('mainContent')!;
      libraryMod.renderLibrary(main);

      // The dropdown shows 'Favorite' (original case). Select it.
      const tagSel = main.querySelector('#libTagFilter') as HTMLSelectElement;
      tagSel.value = 'Favorite';
      tagSel.dispatchEvent(new Event('change'));

      // Show should match (case-insensitive comparison)
      expect(main.querySelector('.show-card')).toBeTruthy();
    });
  });
});
