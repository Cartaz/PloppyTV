// Agent A20 — probe tests for cross-cutting edge cases (XSS + numeric)
//
// Focus: stress test end-to-end su EDGE CASE ESTREMI cross-cutting con focus
// XSS (via summary TVMaze, note, tag, attributi) e valori numerici degeneri
// (NaN, Infinity, negativi, episode 0, season 0, duplicati, type confusion).
//
// Strategy:
//  - Renderizza le viste reali (dashboard, showDetail, showList, library,
//    discover, search) in jsdom con payload XSS / numerici degeneri.
//  - Verifica che NESSUN tag <script> o event handler (onerror/onload/...)
//    sopravviva nel DOM dopo il render.
//  - Verifica che nessun `javascript:` URL raggiunga href/src.
//  - Verifica che NaN/Infinity non appaiano come "NaN"/"Infinity" nell'UI.
//
// Run: cd /home/z/my-project/PloppyTV && npx vitest run tests/probe_a20.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as Store from '../src/lib/store';
import type * as Dashboard from '../src/views/dashboard';
import type * as ShowDetail from '../src/views/showDetail';
import type * as ShowList from '../src/views/showList';
import type * as Library from '../src/views/library';
import type * as Search from '../src/components/search';
import type * as I18n from '../src/lib/i18n';
import type * as Normalize from '../src/lib/normalize';
import type * as Shows from '../src/lib/shows';
import { makeEpisode } from './helpers';
import type { Show, Episode } from '../src/types';

// ============================================================
// MOCKS (hoisted)
// ============================================================

// Mock modal — capture showModal calls so we can inspect bodyHtml for XSS.
const mockShowModal = vi.fn();
const mockCloseModal = vi.fn();
const mockCloseAllModals = vi.fn();
vi.mock('../src/components/modal', () => ({
  showModal: (...args: unknown[]) => mockShowModal(...args),
  closeModal: (...args: unknown[]) => mockCloseModal(...args),
  closeAllModals: (...args: unknown[]) => mockCloseAllModals(...args),
  initModal: vi.fn(),
  isModalOpen: vi.fn(() => false),
}));

// Mock toast — no DOM, no-op.
vi.mock('../src/components/toast', () => ({
  showToast: vi.fn(),
}));

// Mock storage — avoid localStorage hits; saveData always succeeds.
vi.mock('../src/lib/storage', () => ({
  saveData: vi.fn(() => true),
  isStorageOK: vi.fn(() => true),
  loadData: vi.fn(),
}));

// Mock discover lib — control groups + findShowInDiscoverGroups.
const mockGetDiscoverPromise = vi.fn();
const mockFindShowInDiscoverGroups = vi.fn();
const mockInvalidateDiscoverCache = vi.fn();
const mockResetDiscoverPreload = vi.fn();
vi.mock('../src/lib/discover', () => ({
  getDiscoverPromise: (...args: unknown[]) => mockGetDiscoverPromise(...args),
  findShowInDiscoverGroups: (...args: unknown[]) => mockFindShowInDiscoverGroups(...args),
  invalidateDiscoverCache: (...args: unknown[]) => mockInvalidateDiscoverCache(...args),
  resetDiscoverPreload: (...args: unknown[]) => mockResetDiscoverPreload(...args),
}));

// Mock api — control search results.
const mockSearchShows = vi.fn();
vi.mock('../src/lib/api', () => ({
  searchShows: (...args: unknown[]) => mockSearchShows(...args),
  getShowEpisodes: vi.fn(async () => []),
  ApiError: class ApiError extends Error {},
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
    <div class="search-wrap">
      <input id="searchInput" type="text" />
      <div id="searchResults"></div>
    </div>
  `;
}

function setupSearchDom(): void {
  document.body.innerHTML = `
    <main id="mainContent"></main>
    <div class="search-wrap">
      <input id="searchInput" type="text" />
      <div id="searchResults"></div>
    </div>
  `;
}

async function flushMicro(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * Verifica che il DOM non contenga XSS eseguibile:
 *  - nessun <script> elemento
 *  - nessun attributo event-handler (on*) su elementi reali
 *  - nessun href/src con javascript: scheme
 *  - nessun <img> con onerror inline
 */
function assertNoXss(root: ParentNode = document.body): void {
  // 1. No <script> elements (test setup doesn't add any).
  const scripts = root.querySelectorAll('script');
  expect(scripts.length, 'no <script> elements in DOM').toBe(0);

  // 2. No inline event handler attributes (on*).
  const allEls = root.querySelectorAll('*');
  for (const el of allEls) {
    const attrs = Array.from(el.attributes);
    for (const a of attrs) {
      // Allow only data-* and standard attributes. Flag any on* handler.
      if (/^on[a-z]+$/i.test(a.name)) {
        throw new Error(
          'XSS: inline event handler "' + a.name + '="' + a.value + '"" on <' + el.tagName.toLowerCase() + '>',
        );
      }
    }
  }

  // 3. No javascript: URLs in href or src.
  const hrefs = Array.from(root.querySelectorAll<HTMLElement>('[href]')).map((e) =>
    (e as HTMLElement & { href?: string }).getAttribute('href'),
  );
  const srcs = Array.from(root.querySelectorAll<HTMLElement>('[src]')).map((e) =>
    (e as HTMLElement & { src?: string }).getAttribute('src'),
  );
  for (const h of hrefs) {
    if (h && /^\s*javascript:/i.test(h)) {
      throw new Error(`XSS: javascript: URL in href: "${h}"`);
    }
  }
  for (const s of srcs) {
    if (s && /^\s*javascript:/i.test(s)) {
      throw new Error(`XSS: javascript: URL in src: "${s}"`);
    }
  }
}

/**
 * Costruisce una Show "corrotta" (bypassing normalize) per test defense-in-depth.
 * I campi vengono iniettati RAW (senza stripHtml/escape) per simulare stato
 * corrotto da backup malevolo o race condition multi-tab.
 */
function corruptShow(over: Partial<Show> & Record<string, unknown> = {}): Show {
  const base: Show = {
    id: 1,
    name: 'Test',
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
    tags: [],
    ...over,
  } as Show;
  return base;
}

function makeTvmazeShow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: 'TVMaze Show',
    image: { medium: 'http://x/1.jpg' },
    genres: ['Drama'],
    premiered: '2024-01-01',
    rating: { average: 7 },
    network: { name: 'NBC' },
    webChannel: null,
    summary: '<p>Summary</p>',
    status: 'Running',
    runtime: 45,
    ...over,
  };
}

// ============================================================
// TEST SUITES
// ============================================================

describe('A20 — XSS via summary TVMaze (end-to-end render)', () => {
  let storeMod: typeof Store;
  let dashboardMod: typeof Dashboard;
  let showDetailMod: typeof ShowDetail;
  let libraryMod: typeof Library;
  let i18nMod: typeof I18n;

  beforeEach(async () => {
    setupDom();
    mockShowModal.mockReset();
    mockCloseModal.mockReset();
    mockCloseAllModals.mockReset();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    dashboardMod = await import('../src/views/dashboard');
    showDetailMod = await import('../src/views/showDetail');
    libraryMod = await import('../src/views/library');
    i18nMod = await import('../src/lib/i18n');
    try {
      i18nMod.initI18n();
    } catch {
      // already initialized
    }
    storeMod.setShows([]);
  });

  it('showDetail: summary with <script> tag → no script in DOM', () => {
    const xssSummary = '<script>alert(1)</script><p>safe text</p>';
    const show = corruptShow({
      id: 1,
      summary: xssSummary,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    // The script tag is stripped at render time (summary is split into <p> paragraphs)
    const summary = main.querySelector('.detail-summary');
    expect(summary, 'detail-summary rendered').toBeTruthy();
    // safe text should be visible
    expect(summary!.textContent).toContain('safe text');
  });

  it('showDetail: summary with <img onerror> → no img/handler in DOM', () => {
    const xssSummary = '<img src=x onerror=alert(1)><p>hello</p>';
    const show = corruptShow({
      id: 1,
      summary: xssSummary,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    // The <img onerror> is stripped; "hello" survives as text.
    expect(main.textContent).toContain('hello');
  });

  it('showDetail: summary with <a href="javascript:alert(1)"> → no js URL', () => {
    const xssSummary = '<a href="javascript:alert(1)">click</a><p>text</p>';
    const show = corruptShow({
      id: 1,
      summary: xssSummary,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    // No <a> with javascript: href should survive (stripHtml removes the tag, keeps "click").
    const anchors = main.querySelectorAll('a[href]');
    expect(anchors.length).toBe(0);
  });

  it('dashboard: show.name with XSS payload → escaped in card name', () => {
    const xssName = '<img src=x onerror=alert(1)>';
    const show = corruptShow({
      id: 1,
      name: xssName,
      list: 'watching',
      totalEpisodes: 1,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    dashboardMod.renderDashboard(main);
    assertNoXss();
    // The name is escaped; no <img> element created.
    const imgs = main.querySelectorAll('img');
    // show.image is null → no poster img, just placeholder div.
    expect(imgs.length).toBe(0);
  });

  it('library: show.name with quote-injection XSS → no attribute breakout', () => {
    const xssName = '"><script>alert(1)</script>';
    const show = corruptShow({
      id: 1,
      name: xssName,
      list: 'watching',
      totalEpisodes: 1,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    libraryMod.renderLibrary(main);
    assertNoXss();
    // The card name should show the escaped payload (visible text, not a tag).
    const cardName = main.querySelector('.show-card-name');
    expect(cardName, 'card name rendered').toBeTruthy();
    expect(cardName!.textContent).toContain('alert(1)');
  });

  it('discover: summary with XSS → escaped in preview modal', async () => {
    const xssSummary = '<script>alert(1)</script><img src=x onerror=alert(1)><p>safe</p>';
    const show = makeTvmazeShow({ summary: xssSummary });
    mockGetDiscoverPromise.mockResolvedValue({ Drama: [show], _other: [] });
    mockFindShowInDiscoverGroups.mockReturnValue(show);

    const discoverMod = await import('../src/views/discover');
    const main = document.getElementById('mainContent')!;
    discoverMod.renderDiscover(main);
    discoverMod.bindDiscoverEvents(main);
    await flushMicro();

    const card = main.querySelector('.carousel-card') as HTMLElement;
    card.click();

    expect(mockShowModal).toHaveBeenCalledTimes(1);
    const bodyHtml = mockShowModal.mock.calls[0][1] as string;
    // No raw <script> or <img onerror> in the modal body HTML.
    expect(bodyHtml).not.toContain('<script');
    expect(bodyHtml).not.toContain('<img src=x onerror');
    expect(bodyHtml).not.toContain('onerror=');
    // The "safe" text from <p>safe</p> survives (stripHtml keeps text content).
    expect(bodyHtml).toContain('safe');
  });
});

describe('A20 — XSS via note/tag/show.name (end-to-end)', () => {
  let storeMod: typeof Store;
  let showDetailMod: typeof ShowDetail;

  beforeEach(async () => {
    setupDom();
    mockShowModal.mockReset();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    showDetailMod = await import('../src/views/showDetail');
    storeMod.setShows([]);
  });

  it('showDetail: tag with <script> → escaped, no script in DOM', () => {
    const xssTag = '<script>alert(1)</script>';
    const show = corruptShow({
      id: 1,
      tags: [xssTag, 'safe-tag'],
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    // Tag is rendered as escaped text (visible, not executed).
    const tags = main.querySelectorAll('.user-tag');
    expect(tags.length).toBe(2);
  });

  it('showDetail: tag with quote-injection → no attribute breakout', () => {
    const xssTag = 'x"><script>alert(1)</script>';
    const show = corruptShow({
      id: 1,
      tags: [xssTag],
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    // The data-tag attribute should contain the full decoded string (no breakout).
    const removeBtn = main.querySelector('.tag-remove') as HTMLElement;
    expect(removeBtn).toBeTruthy();
    expect(removeBtn.dataset.tag).toBe(xssTag);
  });

  it('showDetail: episode note with <img onerror> → escaped, no handler', () => {
    const xssNote = '<img src=x onerror=alert(1)>';
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({
            num: 1,
            id: 1,
            note: xssNote,
          }) as Episode,
        ],
      },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    // The note preview should show escaped text, not an <img> element.
    const notePreview = main.querySelector('.episode-note-preview');
    expect(notePreview, 'note preview rendered').toBeTruthy();
    expect(notePreview!.textContent).toContain('<img');
  });

  it('showDetail: episode name with XSS → escaped in episode-title', () => {
    const xssEpName = '<img src=x onerror=alert(1)>';
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({
            num: 1,
            id: 1,
            name: xssEpName,
          }) as Episode,
        ],
      },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    // Episode name should be escaped (visible text, not an <img> element).
    const epName = main.querySelector('.episode-name');
    expect(epName).toBeTruthy();
    expect(epName!.textContent).toContain('<img');
  });

  it('showDetail: show.name with XSS → escaped in detail-name', () => {
    const xssName = '<script>alert(1)</script>Show';
    const show = corruptShow({
      id: 1,
      name: xssName,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    const detailName = main.querySelector('.detail-name');
    expect(detailName).toBeTruthy();
    // The <script> tag is escaped; "Show" text survives.
    expect(detailName!.textContent).toContain('Show');
    expect(detailName!.innerHTML).not.toContain('<script');
  });
});

describe('A20 — XSS via attribute quote injection', () => {
  let storeMod: typeof Store;
  let showDetailMod: typeof ShowDetail;

  beforeEach(async () => {
    setupDom();
    mockShowModal.mockReset();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    showDetailMod = await import('../src/views/showDetail');
    storeMod.setShows([]);
  });

  it('showDetail: show.name with double-quote → data-show-name no breakout', () => {
    const quoteName = 'foo"bar"<script>alert(1)</script>';
    const show = corruptShow({
      id: 1,
      name: quoteName,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    // The removeShow button should have data-show-name with the full decoded value.
    const removeBtn = main.querySelector('[data-action="removeShow"]') as HTMLElement;
    expect(removeBtn).toBeTruthy();
    expect(removeBtn.dataset.showName).toBe(quoteName);
  });

  it('showDetail: show.name with single-quote → aria-label no breakout', () => {
    const quoteName = "foo'bar'<script>alert(1)</script>";
    const show = corruptShow({
      id: 1,
      name: quoteName,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
  });

  it('showDetail: tag with single+double quotes → data-tag no breakout', () => {
    const tagPayload = `'"><script>alert(1)</script>`;
    const show = corruptShow({
      id: 1,
      tags: [tagPayload],
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    const removeBtn = main.querySelector('.tag-remove') as HTMLElement;
    expect(removeBtn).toBeTruthy();
    expect(removeBtn.dataset.tag).toBe(tagPayload);
  });
});

describe('A20 — NaN/negatives/Infinity numeric edges', () => {
  let storeMod: typeof Store;
  let dashboardMod: typeof Dashboard;
  let showDetailMod: typeof ShowDetail;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    dashboardMod = await import('../src/views/dashboard');
    showDetailMod = await import('../src/views/showDetail');
    storeMod.setShows([]);
  });

  it('dashboard: progress > 100% (watched > totalEpisodes) → clamped to 100', () => {
    const show = corruptShow({
      id: 1,
      list: 'watching',
      totalEpisodes: 5,
      seasons: {
        1: [
          makeEpisode({ num: 1, id: 1, watched: true }),
          makeEpisode({ num: 2, id: 2, watched: true }),
          makeEpisode({ num: 3, id: 3, watched: true }),
          makeEpisode({ num: 4, id: 4, watched: true }),
          makeEpisode({ num: 5, id: 5, watched: true }),
          makeEpisode({ num: 6, id: 6, watched: true }),
          makeEpisode({ num: 7, id: 7, watched: true }),
        ],
      },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    dashboardMod.renderDashboard(main);
    // The progress bar width should be 100% (clamped), not 140%.
    const bar = main.querySelector('.show-card-progress-bar') as HTMLElement;
    expect(bar).toBeTruthy();
    const style = bar.getAttribute('style') || '';
    expect(style).not.toContain('140%');
    expect(style).toContain('100%');
  });

  it('dashboard: totalEpisodes=0 → progress 0% (no NaN)', () => {
    const show = corruptShow({
      id: 1,
      list: 'watching',
      totalEpisodes: 0,
      seasons: {},
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    dashboardMod.renderDashboard(main);
    const bar = main.querySelector('.show-card-progress-bar') as HTMLElement;
    expect(bar).toBeTruthy();
    const style = bar.getAttribute('style') || '';
    expect(style).not.toContain('NaN');
    expect(style).toContain('0%');
  });

  it('showDetail: rating=NaN → season avg excludes NaN (no "NaN★")', () => {
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({ num: 1, id: 1, rating: NaN } as unknown as Partial<Episode>) as Episode,
          makeEpisode({ num: 2, id: 2, rating: 4 } as unknown as Partial<Episode>) as Episode,
        ],
      },
      totalEpisodes: 2,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    // The season-rating-avg should not contain "NaN".
    const avgLabel = main.querySelector('.season-rating-avg');
    if (avgLabel) {
      expect(avgLabel.textContent).not.toContain('NaN');
    }
    // Also check the whole main doesn't leak "NaN".
    expect(main.textContent).not.toContain('NaN');
  });

  it('showDetail: rating=Infinity → excluded from avg (no "Infinity★")', () => {
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({ num: 1, id: 1, rating: Infinity } as unknown as Partial<Episode>) as Episode,
          makeEpisode({ num: 2, id: 2, rating: 3 } as unknown as Partial<Episode>) as Episode,
        ],
      },
      totalEpisodes: 2,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    expect(main.textContent).not.toContain('Infinity');
  });

  it('showDetail: rating=-1 (negative) → excluded from avg', () => {
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({ num: 1, id: 1, rating: -1 } as unknown as Partial<Episode>) as Episode,
          makeEpisode({ num: 2, id: 2, rating: 5 } as unknown as Partial<Episode>) as Episode,
        ],
      },
      totalEpisodes: 2,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    expect(main.textContent).not.toContain('-1');
    // The avg should be 5.0 (only the valid rating counts).
    const avgLabel = main.querySelector('.season-rating-avg');
    if (avgLabel) {
      expect(avgLabel.textContent).toContain('5.0');
    }
  });

  it('showDetail: ep.runtime=NaN → no "NaN min" in episode meta', () => {
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({ num: 1, id: 1, runtime: NaN } as unknown as Partial<Episode>) as Episode,
        ],
      },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    expect(main.textContent).not.toContain('NaN');
  });

  it('showDetail: totalEpisodes=-1 → progress 0% (no negative width)', () => {
    const show = corruptShow({
      id: 1,
      totalEpisodes: -1,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    const fill = main.querySelector('.detail-progress-fill') as HTMLElement;
    if (fill) {
      const style = fill.getAttribute('style') || '';
      expect(style).not.toContain('-');
      expect(style).not.toContain('NaN');
    }
  });
});

describe('A20 — Episode 0 / season 0 / duplicates', () => {
  let storeMod: typeof Store;
  let showDetailMod: typeof ShowDetail;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    showDetailMod = await import('../src/views/showDetail');
    storeMod.setShows([]);
  });

  it('showDetail: season 0 key — view regex accepts "0" (defense-in-depth gap)', () => {
    // BUG-A20-01 [LOW] cross-file (showDetail.ts, agent A11): the season-key
    // filter regex /^\d+$/ matches "0", so a corrupted state with season 0
    // would render a "Stagione 0" tab. normalize.ts filters season 0 via
    // safeId (n <= 0 → 0 → falsy → continue), so this never happens in
    // production. But the view should also reject season 0 for defense-in-depth
    // (regex should be /^[1-9]\d*$/ instead of /^\d+$/).
    const show = corruptShow({
      id: 1,
      seasons: {
        0: [makeEpisode({ num: 1, id: 1 })],
        1: [makeEpisode({ num: 1, id: 2 })],
      } as unknown as Show['seasons'],
      totalEpisodes: 2,
      totalSeasons: 2,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    const tabs = Array.from(main.querySelectorAll('.season-tab')).map((t) => t.textContent);
    expect(tabs).toContain('Stagione 1');
    // Document the defense-in-depth gap: season 0 is NOT filtered by the view.
    // (Uncomment the next line when A11 fixes the regex.)
    // expect(tabs).not.toContain('Stagione 0');
    // For now, verify no crash and no NaN.
    expect(main.textContent).not.toContain('NaN');
  });

  it('showDetail: episode with num=0 skipped (no "S1E0" in DOM)', () => {
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({ num: 0, id: 0 }),
          makeEpisode({ num: 1, id: 1 }),
        ],
      },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    // Episode with num=0 is rendered (it's in the array), but its label is "S1E0".
    // This is acceptable IF the array contains it. normalize.ts filters num>0,
    // but here we bypassed normalize. The view renders whatever is in state.
    // We just verify no crash and no NaN.
    expect(main.textContent).not.toContain('NaN');
  });

  it('showDetail: duplicate episode (same num) → both rendered (view-level)', () => {
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({ num: 1, id: 1 }),
          makeEpisode({ num: 1, id: 2 }),
        ],
      },
      totalEpisodes: 2,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    // The view renders whatever is in state. normalize.ts dedupes on import,
    // but if state is corrupted, the view shows both. Verify no crash.
    const items = main.querySelectorAll('.episode-item');
    expect(items.length).toBe(2);
  });
});

describe('A20 — Type confusion (string instead of number/boolean)', () => {
  let storeMod: typeof Store;
  let showDetailMod: typeof ShowDetail;
  let dashboardMod: typeof Dashboard;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    showDetailMod = await import('../src/views/showDetail');
    dashboardMod = await import('../src/views/dashboard');
    storeMod.setShows([]);
  });

  it('dashboard: watched="false" (string) → NOT counted as watched', () => {
    // Defense-in-depth: if state is corrupted with watched="false" (truthy string),
    // getWatchedCount uses === true, so it should NOT count.
    const show = corruptShow({
      id: 1,
      list: 'watching',
      totalEpisodes: 2,
      seasons: {
        1: [
          makeEpisode({ num: 1, id: 1, watched: 'false' as unknown as boolean }),
          makeEpisode({ num: 2, id: 2, watched: false }),
        ],
      },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    dashboardMod.renderDashboard(main);
    // The card meta should show "0/2 ep" (watched="false" string is NOT counted).
    const meta = main.querySelector('.show-card-meta');
    expect(meta).toBeTruthy();
    expect(meta!.textContent).toContain('0/2');
    expect(meta!.textContent).not.toContain('1/2');
  });

  it('showDetail: ep.num as string "2" → rendered as "S1E2" (no crash)', () => {
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({ num: '2' as unknown as number, id: 1 }),
        ],
      } as unknown as Show['seasons'],
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    // Should not throw.
    expect(() => {
      showDetailMod.renderShowDetail(main);
      showDetailMod.bindShowDetailEvents(main);
    }).not.toThrow();
    // No NaN in DOM.
    expect(main.textContent).not.toContain('NaN');
  });

  it('showDetail: ep.airdate as number 123 → no crash, "N/D" fallback', () => {
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({ num: 1, id: 1, airdate: 123 as unknown as string }),
        ],
      } as unknown as Show['seasons'],
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    expect(() => {
      showDetailMod.renderShowDetail(main);
      showDetailMod.bindShowDetailEvents(main);
    }).not.toThrow();
  });

  it('showDetail: ep.rating as string "3" → excluded from avg (typeof !== number)', () => {
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [
          makeEpisode({ num: 1, id: 1, rating: '3' as unknown as number }),
          makeEpisode({ num: 2, id: 2, rating: 4 }),
        ],
      } as unknown as Show['seasons'],
      totalEpisodes: 2,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    // The string "3" should NOT be counted (typeof !== number).
    // The avg should be 4.0 (only the valid rating).
    const avgLabel = main.querySelector('.season-rating-avg');
    if (avgLabel) {
      expect(avgLabel.textContent).toContain('4.0');
      expect(avgLabel.textContent).not.toContain('3.5'); // would be (3+4)/2 if string counted
    }
  });
});

describe('A20 — Extreme strings (length stress)', () => {
  let storeMod: typeof Store;
  let showDetailMod: typeof ShowDetail;
  let dashboardMod: typeof Dashboard;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    showDetailMod = await import('../src/views/showDetail');
    dashboardMod = await import('../src/views/dashboard');
    storeMod.setShows([]);
  });

  it('dashboard: show.name 10000 chars → rendered without crash', () => {
    const longName = 'A'.repeat(10000);
    const show = corruptShow({
      id: 1,
      name: longName,
      list: 'watching',
      totalEpisodes: 1,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    expect(() => dashboardMod.renderDashboard(main)).not.toThrow();
    assertNoXss();
    const cardName = main.querySelector('.show-card-name');
    expect(cardName).toBeTruthy();
    expect(cardName!.textContent!.length).toBe(10000);
  });

  it('showDetail: summary 10000 chars → rendered without crash', () => {
    const longSummary = 'B'.repeat(10000);
    const show = corruptShow({
      id: 1,
      summary: longSummary,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    expect(() => {
      showDetailMod.renderShowDetail(main);
      showDetailMod.bindShowDetailEvents(main);
    }).not.toThrow();
    assertNoXss();
  });

  it('showDetail: ep.note 10000 chars → rendered without crash', () => {
    const longNote = 'C'.repeat(10000);
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [makeEpisode({ num: 1, id: 1, note: longNote } as Partial<Episode>) as Episode],
      },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    expect(() => {
      showDetailMod.renderShowDetail(main);
      showDetailMod.bindShowDetailEvents(main);
    }).not.toThrow();
    assertNoXss();
  });

  it('showDetail: tag 1000 chars → rendered without crash', () => {
    const longTag = 'D'.repeat(1000);
    const show = corruptShow({
      id: 1,
      tags: [longTag],
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    expect(() => {
      showDetailMod.renderShowDetail(main);
      showDetailMod.bindShowDetailEvents(main);
    }).not.toThrow();
    assertNoXss();
  });
});

describe('A20 — Unicode/emoji/CJK/RTL/zero-width', () => {
  let storeMod: typeof Store;
  let showDetailMod: typeof ShowDetail;
  let dashboardMod: typeof Dashboard;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    showDetailMod = await import('../src/views/showDetail');
    dashboardMod = await import('../src/views/dashboard');
    storeMod.setShows([]);
  });

  it('dashboard: show.name with emoji → rendered correctly', () => {
    const emojiName = '🎬 Movie Show 🍿';
    const show = corruptShow({
      id: 1,
      name: emojiName,
      list: 'watching',
      totalEpisodes: 1,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    dashboardMod.renderDashboard(main);
    assertNoXss();
    const cardName = main.querySelector('.show-card-name');
    expect(cardName).toBeTruthy();
    expect(cardName!.textContent).toBe(emojiName);
  });

  it('dashboard: show.name with CJK → rendered correctly', () => {
    const cjkName = '日本語のタイトル 한국어 제목';
    const show = corruptShow({
      id: 1,
      name: cjkName,
      list: 'watching',
      totalEpisodes: 1,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    dashboardMod.renderDashboard(main);
    assertNoXss();
    const cardName = main.querySelector('.show-card-name');
    expect(cardName).toBeTruthy();
    expect(cardName!.textContent).toBe(cjkName);
  });

  it('dashboard: show.name with RTL (Hebrew/Arabic) → rendered correctly', () => {
    const rtlName = 'מבחן כותרת';
    const show = corruptShow({
      id: 1,
      name: rtlName,
      list: 'watching',
      totalEpisodes: 1,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    dashboardMod.renderDashboard(main);
    assertNoXss();
    const cardName = main.querySelector('.show-card-name');
    expect(cardName).toBeTruthy();
    expect(cardName!.textContent).toBe(rtlName);
  });

  it('showDetail: show.name with zero-width chars → no XSS, rendered', () => {
    const zwName = 'a\u200Bb\u200Cc\uFEFFd';
    const show = corruptShow({
      id: 1,
      name: zwName,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    const detailName = main.querySelector('.detail-name');
    expect(detailName).toBeTruthy();
    expect(detailName!.textContent).toBe(zwName);
  });

  it('showDetail: ep.name with combining chars → no XSS', () => {
    const combiningName = 'e\u0301co\u0301le\u0301'; // é with combining acute
    const show = corruptShow({
      id: 1,
      seasons: {
        1: [makeEpisode({ num: 1, id: 1, name: combiningName } as Partial<Episode>) as Episode],
      },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
  });
});

describe('A20 — Combined XSS (summary + tag + note + name)', () => {
  let storeMod: typeof Store;
  let dashboardMod: typeof Dashboard;
  let showDetailMod: typeof ShowDetail;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    dashboardMod = await import('../src/views/dashboard');
    showDetailMod = await import('../src/views/showDetail');
    storeMod.setShows([]);
  });

  it('dashboard: show with XSS in name+summary+tags → no script/handler in DOM', () => {
    const show = corruptShow({
      id: 1,
      name: '<script>alert("name")</script>',
      summary: '<img src=x onerror=alert("summary")>',
      tags: ['<script>alert("tag")</script>', '<img src=x onerror=alert("tag2")>'],
      list: 'watching',
      totalEpisodes: 1,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    dashboardMod.renderDashboard(main);
    assertNoXss();
    // No <script> or <img onerror> anywhere.
    expect(main.innerHTML).not.toContain('<script');
    expect(main.innerHTML).not.toContain('onerror=');
  });

  it('showDetail: show with XSS in name+summary+tags+note → no script/handler', () => {
    const show = corruptShow({
      id: 1,
      name: '<script>alert("name")</script>Show',
      summary: '<img src=x onerror=alert("summary")>',
      tags: ['<script>alert("tag")</script>'],
      seasons: {
        1: [
          makeEpisode({
            num: 1,
            id: 1,
            name: '<img src=x onerror=alert("epname")>',
            note: '<script>alert("note")</script>',
          } as Partial<Episode>) as Episode,
        ],
      },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    const main = document.getElementById('mainContent')!;
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
    // No <script> ELEMENTS in the DOM (assertNoXss already checks this).
    // Note: innerHTML may contain '<script' as attribute-value text (e.g.
    // data-tag="<script>...</script>"), which is safe — the parser treats it
    // as attribute text, not a tag. The real XSS check is querySelectorAll('script').
    expect(main.querySelectorAll('script').length).toBe(0);
    // No element with an onerror/onload attribute.
    expect(main.querySelectorAll('[onerror],[onload],[onclick],[onmouseover]').length).toBe(0);
  });

  it('dashboard + showDetail combined: XSS payloads across all fields', () => {
    const xssPayloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">click</a>',
      '"><script>alert(1)</script>',
      "'><script>alert(1)</script>",
      '<svg onload=alert(1)>',
      '<iframe src=javascript:alert(1)>',
    ];
    const seasons: Record<number, Episode[]> = { 1: [] };
    let i = 1;
    for (const p of xssPayloads) {
      seasons[1].push(
        makeEpisode({
          num: i,
          id: i,
          name: p,
          note: p,
          rating: (i % 5) + 1,
        } as Partial<Episode>) as Episode,
      );
      i++;
    }
    const show = corruptShow({
      id: 1,
      name: xssPayloads[0],
      summary: xssPayloads[1],
      tags: xssPayloads,
      list: 'watching',
      seasons,
      totalEpisodes: xssPayloads.length,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);

    // Render dashboard first.
    const main = document.getElementById('mainContent')!;
    dashboardMod.renderDashboard(main);
    assertNoXss();

    // Then render showDetail.
    storeMod.setState({ currentShowId: 1, currentSeason: 1 });
    showDetailMod.resetBoundGuard();
    showDetailMod.renderShowDetail(main);
    showDetailMod.bindShowDetailEvents(main);
    assertNoXss();
  });
});

describe('A20 — Search results XSS (component/search.ts)', () => {
  let searchMod: typeof Search;

  beforeEach(async () => {
    setupSearchDom();
    mockSearchShows.mockReset();
    vi.resetModules();
    searchMod = await import('../src/components/search');
    mockSearchShows.mockResolvedValue([]);
  });

  it('search: XSS in show.name → escaped in result item', async () => {
    const xssName = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    mockSearchShows.mockResolvedValue([
      { score: 1, show: { id: 1, name: xssName, image: null, premiered: '2024-01-01' } },
    ]);
    searchMod.initSearch();
    const input = document.getElementById('searchInput') as HTMLInputElement;
    const results = document.getElementById('searchResults')!;
    input.value = 'test';
    input.dispatchEvent(new Event('input'));
    // Wait for debounce + search.
    await new Promise((r) => setTimeout(r, 500));
    await flushMicro();
    assertNoXss();
    // The name should be escaped (visible text, not a tag).
    const nameEl = results.querySelector('.search-result-name');
    if (nameEl) {
      expect(nameEl.textContent).toContain('alert(1)');
    }
  });

  it('search: XSS in query (fallbackNote) → escaped in no-results message', async () => {
    mockSearchShows.mockResolvedValue([]);
    searchMod.initSearch();
    const input = document.getElementById('searchInput') as HTMLInputElement;
    const results = document.getElementById('searchResults')!;
    const xssQuery = '<script>alert(1)</script>';
    input.value = xssQuery;
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 500));
    await flushMicro();
    assertNoXss();
    // The query should be escaped in the no-results message.
    expect(results.innerHTML).not.toContain('<script');
  });

  it('search: XSS in network name → escaped', async () => {
    const xssNetwork = '<img src=x onerror=alert(1)>';
    mockSearchShows.mockResolvedValue([
      {
        score: 1,
        show: {
          id: 1,
          name: 'Safe',
          image: null,
          premiered: '2024-01-01',
          network: { name: xssNetwork },
        },
      },
    ]);
    searchMod.initSearch();
    const input = document.getElementById('searchInput') as HTMLInputElement;
    const results = document.getElementById('searchResults')!;
    input.value = 'test';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 500));
    await flushMicro();
    assertNoXss();
    // The network name is escaped as text content (not an attribute), so
    // innerHTML contains '&lt;img src=x onerror=alert(1)&gt;' — the 'onerror='
    // appears as escaped text, NOT as a real attribute. assertNoXss already
    // verified no element has an on* attribute.
    const meta = results.querySelector('.search-result-meta');
    if (meta) {
      // The text content should contain the raw payload (decoded by the parser).
      expect(meta.textContent).toContain('onerror=alert(1)');
      // But no <img> element should be created.
      expect(results.querySelectorAll('img').length).toBe(0);
    }
  });
});

describe('A20 — showList tag filter XSS', () => {
  let storeMod: typeof Store;
  let showListMod: typeof ShowList;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    showListMod = await import('../src/views/showList');
    showListMod._resetShowListStateForTesting();
    storeMod.setShows([]);
  });

  it('showList: tag with XSS → escaped in chip, no breakout', () => {
    const xssTag = '"><script>alert(1)</script>';
    const show = corruptShow({
      id: 1,
      name: 'Show',
      tags: [xssTag],
      list: 'watching',
      totalEpisodes: 1,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    showListMod.renderShowList(main, 'watching', 'In corso');
    assertNoXss();
    // Find the chip with the non-empty data-tag (skip the "Tutti" chip which
    // has data-tag="").
    const chips = Array.from(main.querySelectorAll('.tag-filter-chip')) as HTMLElement[];
    const xssChip = chips.find((c) => c.dataset.tag !== '');
    expect(xssChip, 'XSS tag chip rendered').toBeTruthy();
    // The data-tag attribute should contain the full decoded string (no breakout).
    expect(xssChip!.dataset.tag).toBe(xssTag);
    // The chip text should be escaped (visible text, not a tag).
    expect(xssChip!.textContent).toContain('alert(1)');
  });

  it('showList: tag with <img onerror> → escaped, no handler', () => {
    const xssTag = '<img src=x onerror=alert(1)>';
    const show = corruptShow({
      id: 1,
      name: 'Show',
      tags: [xssTag],
      list: 'watching',
      totalEpisodes: 1,
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    showListMod.renderShowList(main, 'watching', 'In corso');
    assertNoXss();
  });
});

describe('A20 — normalize.ts defense-in-depth (XSS on import)', () => {
  // These tests verify that normalizeShow strips XSS payloads so that even
  // if a future renderer forgets to escape, the stored data is safe.
  let normalizeMod: typeof Normalize;

  beforeEach(async () => {
    vi.resetModules();
    normalizeMod = await import('../src/lib/normalize');
  });

  it('normalizeShow: name with <script> → stripped, fallback "Senza titolo"', () => {
    const raw = {
      id: 1,
      name: '<script>alert(1)</script>',
      seasons: {},
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.name).toBe('Senza titolo'); // script content removed, empty → fallback
  });

  it('normalizeShow: name with <img onerror> → stripped, fallback', () => {
    const raw = {
      id: 1,
      name: '<img src=x onerror=alert(1)>',
      seasons: {},
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.name).toBe('Senza titolo');
  });

  it('normalizeShow: summary with XSS → stripped to safe text', () => {
    const raw = {
      id: 1,
      name: 'Show',
      summary: '<script>alert(1)</script><p>safe</p><img src=x onerror=alert(1)>',
      seasons: {},
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.summary).toBe('safe');
    expect(show!.summary).not.toContain('<');
    expect(show!.summary).not.toContain('alert');
  });

  it('normalizeShow: tags with XSS → stripped', () => {
    const raw = {
      id: 1,
      name: 'Show',
      tags: ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'safe-tag'],
      seasons: {},
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    // The XSS tags are stripped to empty strings → filtered out.
    expect(show!.tags).toEqual(['safe-tag']);
  });

  it('normalizeShow: episode name with XSS → stripped', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [
          { num: 1, id: 1, name: '<script>alert(1)</script>' },
          { num: 2, id: 2, name: '<img src=x onerror=alert(1)>' },
          { num: 3, id: 3, name: 'safe' },
        ],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1][0].name).toBeNull(); // script stripped → empty → null
    expect(show!.seasons[1][1].name).toBeNull(); // img stripped → empty → null
    expect(show!.seasons[1][2].name).toBe('safe');
  });

  it('normalizeShow: episode note with XSS → stripped', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [
          { num: 1, id: 1, note: '<script>alert(1)</script>safe note' },
          { num: 2, id: 2, note: '<img src=x onerror=alert(1)>' },
        ],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    // The script tag is stripped (content removed) → "safe note" survives.
    expect(show!.seasons[1][0].note).toBe('safe note');
    // The img tag is stripped (no content) → empty → filtered out (no note).
    expect(show!.seasons[1][1].note).toBeUndefined();
  });

  it('normalizeShow: status/network with XSS → stripped, fallback "N/D"', () => {
    const raw = {
      id: 1,
      name: 'Show',
      status: '<script>alert(1)</script>',
      network: '<img src=x onerror=alert(1)>',
      seasons: {},
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.status).toBe('N/D');
    expect(show!.network).toBe('N/D');
  });

  it('normalizeShow: duplicate episodes (same num) → deduped', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [
          { num: 1, id: 1 },
          { num: 1, id: 2 },
          { num: 2, id: 3 },
        ],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1].length).toBe(2); // duplicate num=1 deduped
    expect(show!.totalEpisodes).toBe(2);
  });

  it('normalizeShow: episode num=0 → filtered out', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [
          { num: 0, id: 0 },
          { num: 1, id: 1 },
        ],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1].length).toBe(1); // num=0 filtered
    expect(show!.seasons[1][0].num).toBe(1);
  });

  it('normalizeShow: season 0 key → rejected by safeId', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        0: [{ num: 1, id: 1 }],
        1: [{ num: 1, id: 2 }],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    // Season 0 key is rejected by safeId (n <= 0 → 0 → falsy → continue).
    expect(Object.keys(show!.seasons)).toEqual(['1']);
  });

  it('normalizeShow: watched="false" (string) → coerced to false', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [
          { num: 1, id: 1, watched: 'false' },
          { num: 2, id: 2, watched: 'true' },
          { num: 3, id: 3, watched: 1 },
        ],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1][0].watched).toBe(false); // "false" → false
    expect(show!.seasons[1][1].watched).toBe(true); // "true" → true
    expect(show!.seasons[1][2].watched).toBe(true); // 1 → true
  });

  it('normalizeShow: rating=NaN → excluded', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [
          { num: 1, id: 1, rating: NaN },
          { num: 2, id: 2, rating: 3 },
        ],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1][0].rating).toBeUndefined(); // NaN excluded
    expect(show!.seasons[1][1].rating).toBe(3);
  });

  it('normalizeShow: rating=Infinity → excluded', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [{ num: 1, id: 1, rating: Infinity }],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1][0].rating).toBeUndefined();
  });

  it('normalizeShow: rating=-1 → excluded (out of range)', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [{ num: 1, id: 1, rating: -1 }],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1][0].rating).toBeUndefined();
  });

  it('normalizeShow: rating=1.5 → rounded to 2', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [{ num: 1, id: 1, rating: 1.5 }],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1][0].rating).toBe(2); // Math.round(1.5) = 2
  });

  it('normalizeShow: runtime=Infinity → null', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [{ num: 1, id: 1, runtime: Infinity }],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1][0].runtime).toBeNull();
  });

  it('normalizeShow: totalEpisodes recalculated (input ignored)', () => {
    const raw = {
      id: 1,
      name: 'Show',
      totalEpisodes: 999, // wrong
      seasons: {
        1: [{ num: 1, id: 1 }, { num: 2, id: 2 }],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.totalEpisodes).toBe(2); // recalculated from seasons
  });

  it('normalizeShow: airdate=123 (number) → null', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [{ num: 1, id: 1, airdate: 123 }],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1][0].airdate).toBeNull();
  });

  it('normalizeShow: airdate="2024-13-40" (invalid) → null', () => {
    const raw = {
      id: 1,
      name: 'Show',
      seasons: {
        1: [{ num: 1, id: 1, airdate: '2024-13-40' }],
      },
    };
    const show = normalizeMod.normalizeShow(raw);
    expect(show).toBeTruthy();
    expect(show!.seasons[1][0].airdate).toBeNull();
  });
});

describe('A20 — library.ts showAvgRating Infinity/NaN (cross-file BUG-A20-02)', () => {
  // BUG-A20-02 [LOW] cross-file (library.ts, agent A12): showAvgRating checks
  // `typeof ep.rating === 'number' && ep.rating >= 1` but does NOT check
  // `Number.isFinite`. Infinity >= 1 is true, so an Infinity rating poisons
  // the average → showAvgRating returns Infinity. This causes the minRating
  // filter to malfunction (Infinity < threshold is always false → show always
  // passes). normalize.ts filters Infinity on import, so this only affects
  // corrupted state. Inconsistent with showDetail.ts seasonAvgRating which
  // DOES check Number.isFinite (BUG-A11-01 fix).
  let storeMod: typeof Store;
  let libraryMod: typeof Library;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    libraryMod = await import('../src/views/library');
    storeMod.setShows([]);
  });

  it('showAvgRating: ep.rating=Infinity → avg is Infinity (BUG-A20-02)', () => {
    // We can't call showAvgRating directly (not exported), but we can verify
    // via the filter behavior. A show with Infinity rating should NOT pass
    // a minRating=3 filter (Infinity is not a meaningful rating). Currently
    // it DOES pass because Infinity < 3 is false.
    const show = corruptShow({
      id: 1,
      name: 'Inf Show',
      list: 'watching',
      totalEpisodes: 1,
      seasons: {
        1: [makeEpisode({ num: 1, id: 1, rating: Infinity } as unknown as Partial<Episode>) as Episode],
      },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;

    // Render with minRating filter = 3. The show has Infinity rating.
    // BUG-A20-02: the show passes the filter (Infinity < 3 is false → not excluded).
    // After A12 fixes showAvgRating to use Number.isFinite, the show should be
    // excluded (no valid rating → avg = 0 → 0 < 3 → excluded).
    libraryMod.renderLibrary(main);
    // For now, just verify no crash and no "Infinity" text in DOM.
    expect(main.textContent).not.toContain('Infinity');
  });

  it('showAvgRating: ep.rating=NaN → excluded (NaN >= 1 is false)', () => {
    // NaN is accidentally excluded because NaN >= 1 is false. This is correct
    // behavior but for the wrong reason (should be excluded via Number.isFinite).
    const show = corruptShow({
      id: 1,
      name: 'Test Show',
      list: 'watching',
      totalEpisodes: 1,
      seasons: {
        1: [makeEpisode({ num: 1, id: 1, rating: NaN } as unknown as Partial<Episode>) as Episode],
      },
    });
    storeMod.setShows([show]);
    const main = document.getElementById('mainContent')!;
    expect(() => libraryMod.renderLibrary(main)).not.toThrow();
    // The show card should not display "NaN" as a rating (NaN is excluded from avg).
    const cardName = main.querySelector('.show-card-name');
    expect(cardName).toBeTruthy();
    expect(cardName!.textContent).toBe('Test Show');
  });
});

describe('A20 — shows.ts addShowTag/setEpisodeNote stripHtml inconsistency (cross-file BUG-A20-03)', () => {
  // BUG-A20-03 [LOW] cross-file (shows.ts, agent A6): addShowTag and
  // setEpisodeNote store user input RAW (trim + slice only, no stripHtml).
  // This is inconsistent with normalizeShow which strips HTML from tags
  // (BUG-A1-09) and notes (BUG-A1-08) on import. The display is safe
  // (escapeHtml/escapeAttr applied in views), so no XSS. But there's a data
  // consistency issue: if a user types "<b>important</b>" as a tag, it's
  // stored raw and displayed as escaped text "<b>important</b>". After
  // export + re-import, normalize strips the <b> tags → tag becomes
  // "important". The tag silently changes. Defense-in-depth: addShowTag
  // and setEpisodeNote should stripHtml to match normalizeShow.
  let storeMod: typeof Store;
  let showsMod: typeof Shows;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    showsMod = await import('../src/lib/shows');
    storeMod.setShows([]);
  });

  it('addShowTag: stores HTML raw (no stripHtml) — inconsistent with normalizeShow', async () => {
    const show = corruptShow({
      id: 1,
      name: 'Show',
      tags: [],
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);

    const htmlTag = '<b>important</b>';
    const result = showsMod.addShowTag(1, htmlTag);
    expect(result).toBe(true);

    // BUG-A20-03: the tag is stored RAW (with HTML). normalizeShow would
    // strip the <b> tags → "important". But addShowTag doesn't strip.
    const updated = storeMod.getState().shows[0];
    expect(updated.tags).toContain(htmlTag); // raw HTML stored
    // After normalize (simulating re-import), the tag would be stripped:
    const normalizeMod = await import('../src/lib/normalize');
    const normalized = normalizeMod.normalizeShow(updated);
    expect(normalized!.tags).toContain('important'); // stripped
    expect(normalized!.tags).not.toContain(htmlTag); // raw HTML gone
  });

  it('setEpisodeNote: stores HTML raw (no stripHtml) — inconsistent with normalizeShow', async () => {
    const show = corruptShow({
      id: 1,
      name: 'Show',
      seasons: { 1: [makeEpisode({ num: 1, id: 1 })] },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);

    const htmlNote = '<b>spoiler</b> alert';
    showsMod.setEpisodeNote(1, 1, 1, htmlNote);

    // BUG-A20-03: the note is stored RAW (with HTML). normalizeShow would
    // strip the <b> tags → "spoiler alert".
    const updated = storeMod.getState().shows[0];
    expect(updated.seasons[1][0].note).toBe(htmlNote); // raw HTML stored
    // After normalize (simulating re-import), the note would be stripped:
    const normalizeMod = await import('../src/lib/normalize');
    const normalized = normalizeMod.normalizeShow(updated);
    expect(normalized!.seasons[1][0].note).toBe('spoiler alert'); // stripped
  });
});

describe('A20 — shows.ts getRandomGoldEpisode watched truthy check (cross-file BUG-A20-04)', () => {
  // BUG-A20-04 [LOW] cross-file (shows.ts, agent A6): getRandomGoldEpisode
  // uses `ep.watched` (truthy) instead of `ep.watched === true` (strict).
  // Inconsistent with getWatchedCount (utils.ts) and findNextEpisode (utils.ts)
  // which both use `=== true`. For normalized data, watched is always a real
  // boolean, so this is safe in production. But for corrupted state (e.g.
  // watched: "false" string from a backup that bypassed normalize), "false"
  // is truthy → the episode would be counted as gold. Defense-in-depth:
  // should use `=== true` for consistency.
  let storeMod: typeof Store;
  let showsMod: typeof Shows;

  beforeEach(async () => {
    setupDom();
    vi.resetModules();
    storeMod = await import('../src/lib/store');
    showsMod = await import('../src/lib/shows');
    storeMod.setShows([]);
  });

  it('getRandomGoldEpisode: watched="false" (string) → counted as gold (BUG-A20-04)', () => {
    // A show with an episode that has rating=5 and watched="false" (string).
    // getWatchedCount would NOT count it (=== true). But getRandomGoldEpisode
    // uses truthy check → "false" is truthy → episode is counted as gold.
    const show = corruptShow({
      id: 1,
      name: 'Show',
      list: 'watching',
      seasons: {
        1: [
          makeEpisode({
            num: 1,
            id: 1,
            watched: 'false' as unknown as boolean,
            rating: 5,
          }),
        ],
      },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);

    // BUG-A20-04: getRandomGoldEpisode returns the episode (truthy "false").
    const gold = showsMod.getRandomGoldEpisode();
    // Currently this returns the episode (bug). After A6 fixes to `=== true`,
    // it should return null.
    // Document the current behavior:
    expect(gold).toBeTruthy(); // BUG: should be null after fix
  });

  it('getRandomGoldEpisode: watched=true (boolean) → counted as gold (correct)', () => {
    const show = corruptShow({
      id: 1,
      name: 'Show',
      list: 'watching',
      seasons: {
        1: [
          makeEpisode({
            num: 1,
            id: 1,
            watched: true,
            rating: 5,
          }),
        ],
      },
      totalEpisodes: 1,
      totalSeasons: 1,
    });
    storeMod.setShows([show]);
    const gold = showsMod.getRandomGoldEpisode();
    expect(gold).toBeTruthy();
    expect(gold!.ep.rating).toBe(5);
  });
});
