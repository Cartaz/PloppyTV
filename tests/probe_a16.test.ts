// Agent A16 — probe tests for src/components/search.ts + src/components/exportImport.ts
//
// Covers NEW bugs found by A16 (BUG-A16-01..04) + edge cases not yet covered:
//  - BUG-A16-01 [MEDIUM] search.ts selectSearchResult clears input after await
//    even if user typed a new query during the await (erasing the new query).
//  - BUG-A16-02 [MEDIUM] exportImport.ts reader.onload post-parse logic not
//    wrapped in try/catch — normalizeShow throw = silent crash, no toast.
//  - BUG-A16-03 [LOW-MEDIUM] search.ts selectSearchResult doesn't try/catch
//    addShowToList — unhandled rejection if it throws.
//  - BUG-A16-04 [LOW] search.ts document click listener accumulates on
//    re-init (memory leak across vi.resetModules / SPA re-init / HMR).

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import type { Show } from '../src/types';
import { setShows, getState } from '../src/lib/store';
import { initModal, closeAllModals, isModalOpen } from '../src/components/modal';

// =====================================================================
// Mocks (hoisted)
// =====================================================================

const mockSearchShows = vi.fn();
const mockAddShowToList = vi.fn();

vi.mock('../src/lib/api', () => ({
  searchShows: (...args: unknown[]) => mockSearchShows(...args),
  ApiError: class ApiError extends Error {
    override name: string;
    status?: number;
    constructor(msg: string, name: string, status?: number) {
      super(msg);
      this.name = name;
      this.status = status;
    }
  },
}));

vi.mock('../src/lib/shows', () => ({
  addShowToList: (...args: unknown[]) => mockAddShowToList(...args),
}));

const showToastMock = vi.fn();
vi.mock('../src/components/toast', () => ({
  showToast: (msg: string, type?: string) => showToastMock(msg, type),
}));

// Mock storage (for exportImport tests — search tests don't transitively
// import storage since shows.ts is mocked).
const saveDataMock = vi.fn((_opts?: { immediate?: boolean }) => true);
vi.mock('../src/lib/storage', () => ({
  saveData: (opts?: { immediate?: boolean }) => saveDataMock(opts),
  isStorageOK: () => true,
}));

// Mock normalizeShow with a spy that delegates to the real implementation
// by default, but can be overridden per-test via mockImplementationOnce
// (for BUG-A16-02: simulate normalizeShow throwing on a specific input).
// vi.hoisted ensures the spy is created BEFORE vi.mock factory runs.
const { normalizeShowSpy } = vi.hoisted(() => ({ normalizeShowSpy: vi.fn() }));
vi.mock('../src/lib/normalize', async () => {
  // any is OK in test files (ESLint override disables no-explicit-any for tests).
  const actual = (await vi.importActual('../src/lib/normalize')) as {
    normalizeShow: (raw: unknown) => Show | null;
    reconcileAllLists: (shows: Show[]) => void;
  };
  normalizeShowSpy.mockImplementation((raw: unknown) => actual.normalizeShow(raw));
  return {
    ...actual,
    normalizeShow: normalizeShowSpy,
  };
});

// Polyfill URL.createObjectURL/revokeObjectURL BEFORE exportImport.ts loads.
vi.hoisted(() => {
  const g = globalThis as { URL?: typeof URL };
  if (g.URL && !g.URL.createObjectURL) {
    g.URL.createObjectURL = (() => 'blob:fake-url') as typeof URL.createObjectURL;
  }
  if (g.URL && !g.URL.revokeObjectURL) {
    g.URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  }
});

// Static import — evaluated once at file load (after mocks are in place).
import { initExportImport } from '../src/components/exportImport';

// =====================================================================
// Search test helpers
// =====================================================================

function setupSearchDom(): void {
  document.body.innerHTML = `
    <div class="search-wrap">
      <input type="text" id="searchInput" maxlength="100" autocomplete="off">
      <div class="search-results" id="searchResults"></div>
    </div>
    <div id="toast"></div>
  `;
}

function makeResult(id: number, name: string, premiered = '2020-01-01'): {
  score: number;
  show: { id: number; name: string; image: null; premiered: string; network: { name: string }; webChannel: null };
} {
  return {
    score: 1,
    show: {
      id,
      name,
      image: null,
      premiered,
      network: { name: 'NBC' },
      webChannel: null,
    },
  };
}

function fireInput(value: string): void {
  const input = document.getElementById('searchInput') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pendingPromise<T>(_initial?: T): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resultsEl(): HTMLElement {
  return document.getElementById('searchResults') as HTMLElement;
}
function inputEl(): HTMLInputElement {
  return document.getElementById('searchInput') as HTMLInputElement;
}

let initSearch: () => void;

// =====================================================================
// Export/Import test helpers
// =====================================================================

const APP_HTML = `
<button id="exportBtn">Export</button>
<button id="importBtn">Import</button>
<input type="file" id="importFile" accept=".json,application/json" />
<div class="modal-overlay" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" aria-hidden="true">
  <div class="modal" tabindex="-1">
    <div class="modal-title" id="modalTitle"></div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-actions" id="modalActions"></div>
  </div>
</div>
<span id="badge-watching">0</span>
<span id="badge-towatch">0</span>
<span id="badge-completed">0</span>
<div id="toast"></div>
`;

class MockFileReader {
  onload: ((ev: { target: { result: ArrayBuffer | string | null } | null }) => void) | null = null;
  onerror: (() => void) | null = null;
  result: ArrayBuffer | string | null = null;
  readAsText(file: File & { _content?: string }, _encoding?: string): void {
    const content = (file as { _content?: string })._content ?? '';
    this.result = content;
    if (this.onload) {
      this.onload({ target: { result: this.result } });
    }
  }
  readAsArrayBuffer(file: File & { _content?: string; _bytes?: ArrayBuffer }): void {
    const f = file as { _content?: string; _bytes?: ArrayBuffer };
    if (f._bytes) {
      this.result = f._bytes;
    } else {
      const content = f._content ?? '';
      this.result = new TextEncoder().encode(content).buffer as ArrayBuffer;
    }
    if (this.onload) {
      this.onload({ target: { result: this.result } });
    }
  }
}

function makeFile(content: string): File {
  const file = new File([content], 'test.json', { type: 'application/json' }) as File & { _content: string };
  (file as { _content: string })._content = content;
  return file;
}

function makeShow(over: Partial<Show> = {}): Show {
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

function setFile(file: File): void {
  const input = document.getElementById('importFile') as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function modalButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('#modalActions button'));
}

function modalTitle(): string {
  return document.getElementById('modalTitle')!.textContent || '';
}

function modalBody(): string {
  return document.getElementById('modalBody')!.innerHTML || '';
}

function clickButton(label: string): void {
  const btn = modalButtons().find((b) => b.textContent === label);
  if (!btn) {
    throw new Error(
      `Button "${label}" not found. Available: [${modalButtons().map((b) => b.textContent).join(', ')}]`,
    );
  }
  btn.click();
}

function lastToast(): { msg: string; type?: string } | null {
  const calls = showToastMock.mock.calls;
  if (calls.length === 0) return null;
  return {
    msg: calls[calls.length - 1][0] as string,
    type: calls[calls.length - 1][1] as string | undefined,
  };
}

// =====================================================================
// SEARCH TESTS (BUG-A16-01, BUG-A16-03, BUG-A16-04 + edge cases)
// =====================================================================

describe('search.ts probe (A16)', () => {
  beforeEach(async () => {
    setupSearchDom();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockSearchShows.mockReset();
    mockAddShowToList.mockReset();
    showToastMock.mockClear();
    vi.resetModules();
    const mod = await import('../src/components/search');
    initSearch = mod.initSearch;
    initSearch();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- BUG-A16-01 ---

  it('BUG-A16-01 FIXED: selectSearchResult does NOT clear input if user typed during addShowToList await', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    const addPending = pendingPromise<{ id: number; name: string }>({ id: 1, name: 'A' });
    mockAddShowToList.mockReturnValueOnce(addPending.promise);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(inputEl().value).toBe('foo');

    const btn = document.querySelector('button[data-idx="0"][data-list="watching"]') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    // During the await, user types a new query 'bar'
    fireInput('bar');
    await vi.advanceTimersByTimeAsync(0);

    addPending.resolve({ id: 1, name: 'A' });
    await vi.advanceTimersByTimeAsync(0);

    // FIXED: input NOT cleared — user typed 'bar' during the await
    expect(inputEl().value).toBe('bar');
    expect(mockAddShowToList).toHaveBeenCalledTimes(1);
  });

  it('BUG-A16-01 regression: selectSearchResult DOES clear input when no typing during await (success path)', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    mockAddShowToList.mockResolvedValue({ id: 1, name: 'A' } as unknown as Show);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(inputEl().value).toBe('foo');

    const btn = document.querySelector('button[data-idx="0"][data-list="watching"]') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(inputEl().value).toBe('');
  });

  it('BUG-A16-01: user types same query during await → input NOT cleared (searchSeq changed)', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    const addPending = pendingPromise<{ id: number; name: string }>({ id: 1, name: 'A' });
    mockAddShowToList.mockReturnValueOnce(addPending.promise);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const btn = document.querySelector('button[data-idx="0"][data-list="watching"]') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(0);

    addPending.resolve({ id: 1, name: 'A' });
    await vi.advanceTimersByTimeAsync(0);

    expect(inputEl().value).toBe('foo');
  });

  it('BUG-A16-01: addShowToList returns null (failure) during typing → input NOT cleared', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    const addPending = pendingPromise<null>(null);
    mockAddShowToList.mockReturnValueOnce(addPending.promise);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const btn = document.querySelector('button[data-idx="0"][data-list="watching"]') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    fireInput('baz');
    await vi.advanceTimersByTimeAsync(0);

    addPending.resolve(null);
    await vi.advanceTimersByTimeAsync(0);

    expect(inputEl().value).toBe('baz');
  });

  // --- BUG-A16-03 ---

  it('BUG-A16-03 FIXED: addShowToList throws → toast shown, no unhandled rejection, input preserved', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    mockAddShowToList.mockRejectedValueOnce(new Error('unexpected crash'));

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const btn = document.querySelector('button[data-idx="0"][data-list="watching"]') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    const t = lastToast();
    expect(t).not.toBeNull();
    expect(t!.msg).toBe('Errore aggiunta serie');
    expect(t!.type).toBe('error');
    expect(inputEl().value).toBe('foo');
  });

  it('BUG-A16-03: addShowToList throws after user typed → input preserved', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    const addPending = pendingPromise<Show>();
    mockAddShowToList.mockReturnValueOnce(addPending.promise);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const btn = document.querySelector('button[data-idx="0"][data-list="watching"]') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    fireInput('newquery');
    await vi.advanceTimersByTimeAsync(0);

    addPending.reject(new Error('crash'));
    await vi.advanceTimersByTimeAsync(0);

    expect(lastToast()?.msg).toBe('Errore aggiunta serie');
    expect(inputEl().value).toBe('newquery');
  });

  // --- BUG-A16-04 ---

  it('BUG-A16-04 FIXED: document click listener does NOT accumulate on re-init (removeEventListener called)', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    addSpy.mockClear();
    removeSpy.mockClear();

    vi.resetModules();
    const mod = await import('../src/components/search');
    setupSearchDom();
    mod.initSearch();

    const addClickCalls = addSpy.mock.calls.filter((c) => c[0] === 'click');
    expect(addClickCalls.length).toBe(1);

    const removeClickCalls = removeSpy.mock.calls.filter((c) => c[0] === 'click');
    expect(removeClickCalls.length).toBe(1);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('BUG-A16-04: after re-init, click outside fires the NEW handler (clears current DOM)', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultsEl().classList.contains('active')).toBe(true);

    vi.resetModules();
    const mod = await import('../src/components/search');
    setupSearchDom();
    mod.initSearch();

    mockSearchShows.mockResolvedValue([makeResult(2, 'B')]);
    fireInput('bar');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultsEl().classList.contains('active')).toBe(true);
    expect(document.querySelector('.search-result-name')?.textContent).toBe('B');

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(resultsEl().classList.contains('active')).toBe(false);
    expect(resultsEl().innerHTML).toBe('');
  });

  it('BUG-A16-04: multiple re-inits do not leak listeners (add count == remove count)', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    addSpy.mockClear();
    removeSpy.mockClear();

    for (let i = 0; i < 3; i++) {
      vi.resetModules();
      const mod = await import('../src/components/search');
      setupSearchDom();
      mod.initSearch();
    }

    const addClickCalls = addSpy.mock.calls.filter((c) => c[0] === 'click');
    const removeClickCalls = removeSpy.mock.calls.filter((c) => c[0] === 'click');
    expect(addClickCalls.length).toBe(3);
    expect(removeClickCalls.length).toBe(3);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  // --- Edge cases ---

  it('unicode query (CJK) is passed to searchShows and rendered', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'アニメ', '2021-05-05')]);
    fireInput('アニメ');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSearchShows).toHaveBeenCalledTimes(1);
    expect(mockSearchShows.mock.calls[0][0]).toBe('アニメ');
    expect(document.querySelector('.search-result-name')?.textContent).toBe('アニメ');
  });

  it('single emoji query is passed through (no fallback — emoji length < 3)', async () => {
    // '🎬'.length === 2 (surrogate pair). Input handler requires length >= 2 → OK.
    // Fallback requires words with length >= 3 → emoji filtered out → no fallback.
    mockSearchShows.mockResolvedValue([]);
    fireInput('🎬');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSearchShows).toHaveBeenCalledTimes(1);
    expect(mockSearchShows.mock.calls[0][0]).toBe('🎬');
    expect(resultsEl().innerHTML).toContain('Nessuna serie trovata');
  });

  it('query with HTML chars is escaped in no-results message (XSS defense)', async () => {
    mockSearchShows.mockResolvedValue([]);
    const xss = '<script>alert(1)</script>';
    fireInput(xss);
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultsEl().innerHTML).not.toContain('<script>');
    expect(resultsEl().innerHTML).toContain('&lt;script&gt;');
  });

  it('query with HTML chars is escaped in fallback note (XSS defense)', async () => {
    // 'foo bar<img src=x onerror=alert(1)>' has spaces → multi-word.
    // The longest word becomes altQuery. Both the original query and altQuery
    // appear in the fallback note — both must be HTML-escaped so that no
    // live <img>/<script> element is created.
    mockSearchShows.mockResolvedValueOnce([]).mockResolvedValueOnce([makeResult(1, 'Foo')]);
    fireInput('foo bar<img src=x onerror=alert(1)>');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    // No live HTML elements (the <img must be escaped to &lt;img)
    expect(resultsEl().innerHTML).not.toContain('<img ');
    expect(resultsEl().innerHTML).not.toContain('<script');
    // The angle brackets are escaped
    expect(resultsEl().innerHTML).toContain('&lt;img');
    expect(resultsEl().innerHTML).toContain('&gt;');
  });

  it('empty results array from API → no-results message shown', async () => {
    mockSearchShows.mockResolvedValue([]);
    fireInput('xyz');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultsEl().innerHTML).toContain('Nessuna serie trovata');
    expect(resultsEl().querySelectorAll('.search-result-item').length).toBe(0);
  });

  it('null results from API → no-results message', async () => {
    mockSearchShows.mockResolvedValue(null as unknown as []);
    fireInput('xyz');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultsEl().innerHTML).toContain('Nessuna serie trovata');
  });

  it('show without image → placeholder div rendered (not broken img)', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'NoImg')]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    const imgs = document.querySelectorAll('.search-result-img');
    expect(imgs.length).toBe(1);
    expect(imgs[0].tagName).toBe('DIV');
    expect(imgs[0].textContent).toBe('N/D');
  });

  it('show without premiered date → year shows "N/D"', async () => {
    const r = makeResult(1, 'NoDate', '');
    mockSearchShows.mockResolvedValue([r]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    const meta = document.querySelector('.search-result-meta');
    expect(meta?.textContent).toContain('N/D');
  });

  it('show with invalid premiered date → year shows "N/D"', async () => {
    const r = makeResult(1, 'BadDate', '2024-13-45');
    mockSearchShows.mockResolvedValue([r]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    const meta = document.querySelector('.search-result-meta');
    expect(meta?.textContent).toContain('N/D');
  });

  it('double-click on result button: second click is no-op (DOM already cleared)', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    const addPending = pendingPromise<Show>(makeShow({ id: 1 }));
    mockAddShowToList.mockReturnValueOnce(addPending.promise);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const btn = document.querySelector('button[data-idx="0"][data-list="watching"]') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockAddShowToList).toHaveBeenCalledTimes(1);
    addPending.resolve(makeShow({ id: 1 }));
    await vi.advanceTimersByTimeAsync(0);
  });
});

// =====================================================================
// EXPORT/IMPORT TESTS (BUG-A16-02 + edge cases)
// =====================================================================

describe('exportImport.ts probe (A16)', () => {
  beforeAll(() => {
    document.body.innerHTML = APP_HTML;
    (globalThis as { FileReader: typeof FileReader }).FileReader =
      MockFileReader as unknown as typeof FileReader;
    initModal();
    initExportImport();
  });

  beforeEach(() => {
    closeAllModals();
    document.getElementById('modalTitle')!.textContent = '';
    document.getElementById('modalBody')!.innerHTML = '';
    document.getElementById('modalActions')!.innerHTML = '';
    setShows([]);
    saveDataMock.mockReturnValue(true);
    saveDataMock.mockClear();
    showToastMock.mockClear();
    // Clear spy call history but preserve the default implementation
    // (delegates to real normalizeShow).
    normalizeShowSpy.mockClear();
  });

  // --- BUG-A16-02 ---

  it('BUG-A16-02 FIXED: normalizeShow throwing is caught with toast (no silent crash)', () => {
    // Override normalizeShow to throw on the next call (simulating a future
    // bug or Proxy-like input that causes normalizeShow to crash).
    normalizeShowSpy.mockImplementationOnce(() => {
      throw new Error('simulated normalizeShow crash');
    });

    const backup = {
      version: 1,
      shows: [makeShow({ id: 1 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));

    // FIXED: try/catch catches the throw, shows toast
    const t = lastToast();
    expect(t).not.toBeNull();
    expect(t!.msg).toContain('Errore elaborazione backup');
    expect(t!.msg).toContain('simulated normalizeShow crash');
    expect(t!.type).toBe('error');
    // Input cleared
    const input = document.getElementById('importFile') as HTMLInputElement;
    expect(input.value).toBe('');
    // No modal opened
    expect(isModalOpen()).toBe(false);
  });

  it('BUG-A16-02: normalizeShow throws on 2nd show only → 1st valid, but whole import fails safely', () => {
    // First call throws (for the first show). The map() propagates the throw.
    normalizeShowSpy.mockImplementationOnce(() => {
      throw new Error('crash on first show');
    });

    const backup = {
      version: 1,
      shows: [makeShow({ id: 1 }), makeShow({ id: 2 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));

    expect(lastToast()?.msg).toContain('Errore elaborazione backup');
    expect(isModalOpen()).toBe(false);
  });

  it('BUG-A16-02: valid backup after the throwing one still works (no module state corruption)', () => {
    // First: throwing backup → toast error
    normalizeShowSpy.mockImplementationOnce(() => {
      throw new Error('crash');
    });
    setFile(makeFile(JSON.stringify({
      version: 1,
      shows: [makeShow({ id: 1 })],
      exportedAt: '2024-01-01',
    })));
    expect(lastToast()?.msg).toContain('Errore elaborazione backup');

    showToastMock.mockClear();

    // Second: valid backup → modal opens (default implementation restored)
    setFile(makeFile(JSON.stringify({
      version: 1,
      shows: [makeShow({ id: 10 })],
      exportedAt: '2024-01-01',
    })));
    expect(modalTitle()).toBe('Importa backup');
    expect(isModalOpen()).toBe(true);
  });

  // --- Edge cases: prototype pollution ---

  it('prototype pollution: __proto__ in shows does not corrupt Object.prototype', () => {
    const backup = {
      version: 1,
      shows: [
        makeShow({ id: 1, name: 'Clean' }),
        { __proto__: { polluted: true }, id: 2, name: 'Polluter' },
      ],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));

    expect(modalTitle()).toBe('Importa backup');
    clickButton('Unisci (smart)');

    // Object.prototype should NOT have a `polluted` property
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(getState().shows.length).toBeGreaterThanOrEqual(1);
  });

  it('prototype pollution: constructor.prototype in shows does not corrupt Object.prototype', () => {
    const backup = {
      version: 1,
      shows: [
        { id: 1, name: 'Test', constructor: { prototype: { polluted: true } } },
      ],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
    clickButton('Unisci (smart)');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  // --- Edge cases: import of primitives / null / arrays ---

  it('import of array of primitives → all filtered as invalid', () => {
    setFile(makeFile(JSON.stringify({
      version: 1,
      shows: [1, 2, 3, 'string', true, null],
      exportedAt: '2024-01-01',
    })));
    expect(lastToast()?.msg).toBe('Nessuna serie valida nel file');
    expect(isModalOpen()).toBe(false);
  });

  it('import of empty object shows ({} with no id) → filtered as invalid', () => {
    setFile(makeFile(JSON.stringify({
      version: 1,
      shows: [{}, { name: 'NoId' }, { id: 0 }],
      exportedAt: '2024-01-01',
    })));
    expect(lastToast()?.msg).toBe('Nessuna serie valida nel file');
  });

  it('import data is null → format error toast', () => {
    setFile(makeFile('null'));
    expect(lastToast()?.msg).toBe('Formato non valido: il file deve contenere un oggetto JSON');
  });

  it('import data is a string → format error toast', () => {
    setFile(makeFile('"hello world"'));
    expect(lastToast()?.msg).toBe('Formato non valido: il file deve contenere un oggetto JSON');
  });

  it('import data is a number → format error toast', () => {
    setFile(makeFile('42'));
    expect(lastToast()?.msg).toBe('Formato non valido: il file deve contenere un oggetto JSON');
  });

  it('import data.shows is an array of nulls → all invalid', () => {
    setFile(makeFile(JSON.stringify({
      version: 1,
      shows: [null, null, null],
      exportedAt: '2024-01-01',
    })));
    expect(lastToast()?.msg).toBe('Nessuna serie valida nel file');
  });

  // --- Edge cases: export ---

  it('export with shows → creates Blob and triggers download', () => {
    setShows([makeShow({ id: 1, name: 'X' })]);
    const createURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    document.getElementById('exportBtn')!.click();
    expect(createURLSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(lastToast()?.msg).toBe('Backup esportato');
    expect(lastToast()?.type).toBe('success');
    createURLSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it('export empty shows → confirm modal shown', () => {
    setShows([]);
    document.getElementById('exportBtn')!.click();
    expect(modalTitle()).toBe('Esporta backup');
    expect(document.getElementById('modalBody')!.innerHTML).toContain('Non hai nessuna serie');
  });

  // --- Edge cases: version validation ---

  it('import with version = 0 → no version warning (0 is finite, < SCHEMA_VERSION)', () => {
    const backup = { version: 0, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
    const versionToasts = showToastMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('versione'),
    );
    expect(versionToasts.length).toBe(0);
  });

  it('import with version = -1 → no version warning (negative is finite, < SCHEMA_VERSION)', () => {
    const backup = { version: -1, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
  });

  it('import with version = 1e308 (very large finite) → "versione futura" warning', () => {
    const backup = { version: 1e308, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
    const t = lastToast();
    expect(t).not.toBeNull();
    expect(t!.msg).toContain('versione futura');
    expect(t!.type).toBe('warning');
  });

  // --- Edge cases: merge ---

  it('merge: backup show with same id but fewer watched → existing kept (no merge)', () => {
    setShows([makeShow({
      id: 1,
      name: 'Local',
      seasons: { 1: [{ num: 1, id: 1, watched: true, airdate: null, name: null, runtime: null }] },
      totalEpisodes: 1,
    })]);
    const backup = {
      version: 1,
      shows: [makeShow({
        id: 1,
        name: 'Backup',
        seasons: { 1: [{ num: 1, id: 1, watched: false, airdate: null, name: null, runtime: null }] },
        totalEpisodes: 1,
      })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    expect(getState().shows[0].name).toBe('Local');
  });

  it('merge: backup show with same id and MORE watched → existing updated (seasons adopted)', () => {
    setShows([makeShow({
      id: 1,
      name: 'Local',
      seasons: { 1: [{ num: 1, id: 1, watched: false, airdate: null, name: null, runtime: null }] },
      totalEpisodes: 1,
    })]);
    const backup = {
      version: 1,
      shows: [makeShow({
        id: 1,
        name: 'Backup',
        seasons: { 1: [{ num: 1, id: 1, watched: true, airdate: null, name: null, runtime: null }] },
        totalEpisodes: 1,
      })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    expect(getState().shows[0].name).toBe('Local');
    expect(getState().shows[0].seasons[1][0].watched).toBe(true);
  });

  // --- Edge cases: replace flow rollback ---

  it('replace: saveData fails → full rollback to pre-replace state', () => {
    setShows([makeShow({ id: 1, name: 'Original' })]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 10, name: 'Backup' })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    saveDataMock.mockReturnValue(false);
    clickButton('Sostituisci tutto');
    clickButton('Sì, sostituisci tutto');
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].id).toBe(1);
    expect(getState().shows[0].name).toBe('Original');
    expect(lastToast()?.msg).toContain('Import annullato');
  });

  // --- Edge cases: dedup ---

  it('dedup: 3 shows with same id → 2 duplicates counted, 1 kept', () => {
    const backup = {
      version: 1,
      shows: [
        makeShow({ id: 5, name: 'First' }),
        makeShow({ id: 5, name: 'Second' }),
        makeShow({ id: 5, name: 'Third' }),
      ],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalBody()).toContain('1 serie valide');
    expect(modalBody()).toContain('2 duplicati saltati');
    clickButton('Unisci (smart)');
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].name).toBe('First');
  });

  it('dedup: 1000 duplicate ids → counted correctly (no overflow)', () => {
    const shows = Array.from({ length: 1000 }, (_, i) => makeShow({ id: 1, name: `S${i}` }));
    const backup = { version: 1, shows, exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalBody()).toContain('1 serie valide');
    expect(modalBody()).toContain('999 duplicati saltati');
  });

  // --- Edge cases: modal flow ---

  it('import modal "Annulla" closes modal without modifying state', () => {
    setShows([makeShow({ id: 1 })]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 10 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    expect(isModalOpen()).toBe(true);
    clickButton('Annulla');
    expect(isModalOpen()).toBe(false);
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].id).toBe(1);
  });

  it('replace confirm "Annulla" returns to parent import modal', () => {
    setShows([makeShow({ id: 1 })]);
    const backup = { version: 1, shows: [makeShow({ id: 10 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Sostituisci tutto');
    expect(modalTitle()).toBe('Conferma sostituzione');
    clickButton('Annulla');
    expect(modalTitle()).toBe('Importa backup');
    expect(isModalOpen()).toBe(true);
  });

  // --- Edge cases: reader error ---

  it('reader.onerror → error toast + input cleared', () => {
    const origFR = (globalThis as { FileReader: typeof FileReader }).FileReader;
    class ErrorFileReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: ArrayBuffer | string | null = null;
      readAsText(): void {
        if (this.onerror) this.onerror();
      }
      readAsArrayBuffer(): void {
        if (this.onerror) this.onerror();
      }
    }
    (globalThis as { FileReader: typeof FileReader }).FileReader =
      ErrorFileReader as unknown as typeof FileReader;
    setFile(makeFile('{"shows":[]}'));
    expect(lastToast()?.msg).toBe('Errore lettura file');
    expect(lastToast()?.type).toBe('error');
    const input = document.getElementById('importFile') as HTMLInputElement;
    expect(input.value).toBe('');
    (globalThis as { FileReader: typeof FileReader }).FileReader = origFR;
  });
});
