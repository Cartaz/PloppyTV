// Agent 10 probe: stress-test src/components/search.ts
// Mocks searchShows + addShowToList + showToast; drives search.ts via jsdom events.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks (vi.mock is hoisted; `mock*`-prefixed vars are allowed in factories) ---
const mockSearchShows = vi.fn();
const mockAddShowToList = vi.fn();

vi.mock('../src/lib/api', () => ({
  searchShows: (...args: any[]) => mockSearchShows(...args),
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
  addShowToList: (...args: any[]) => mockAddShowToList(...args),
}));

vi.mock('../src/components/toast', () => ({
  showToast: vi.fn(),
}));

// --- Helpers ---
function setupDom(): void {
  document.body.innerHTML = `
    <div class="search-wrap">
      <input type="text" id="searchInput" maxlength="100" autocomplete="off">
      <div class="search-results" id="searchResults"></div>
    </div>
    <div id="toast"></div>
  `;
}

function makeResult(id: number, name: string, premiered = '2020-01-01'): any {
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

function fireKeydown(key: string): void {
  const input = document.getElementById('searchInput') as HTMLInputElement;
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function pendingPromise<T>(_initial?: T): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: any) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
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

// Lazily-loaded initSearch — re-imported per test to reset module state
// (search.ts holds module-level `lastSearchTime`, `searchSeq`, etc.)
let initSearch: () => void;

// --- Tests ---
describe('search.ts probe', () => {
  beforeEach(async () => {
    setupDom();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mockSearchShows.mockReset();
    mockAddShowToList.mockReset();
    // Reset module-level state by re-importing search.ts fresh
    vi.resetModules();
    const mod = await import('../src/components/search');
    initSearch = mod.initSearch;
    initSearch();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounce: search fires after 350ms, not before', async () => {
    mockSearchShows.mockResolvedValue([]);
    fireInput('foo');
    expect(mockSearchShows).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(349);
    expect(mockSearchShows).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockSearchShows).toHaveBeenCalledTimes(1);
    expect(mockSearchShows).toHaveBeenCalledWith('foo', expect.any(AbortSignal));
  });

  it('debounce reset on each new input: only last query is searched', async () => {
    mockSearchShows.mockResolvedValue([]);
    fireInput('a');
    await vi.advanceTimersByTimeAsync(100);
    fireInput('ab');
    await vi.advanceTimersByTimeAsync(100);
    fireInput('abc');
    await vi.advanceTimersByTimeAsync(350);
    expect(mockSearchShows).toHaveBeenCalledTimes(1);
    expect(mockSearchShows).toHaveBeenCalledWith('abc', expect.any(AbortSignal));
  });

  it('passes an AbortSignal to searchShows', async () => {
    mockSearchShows.mockResolvedValue([]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    expect(mockSearchShows.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });

  it('new input aborts in-flight search signal', async () => {
    const fetchA = pendingPromise<any[]>([]);
    mockSearchShows.mockReturnValueOnce(fetchA.promise);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350); // doSearch('foo') fires, awaits fetchA
    expect(mockSearchShows).toHaveBeenCalledTimes(1);
    const signalA = mockSearchShows.mock.calls[0][1] as AbortSignal;
    expect(signalA.aborted).toBe(false);

    fireInput('foobar');
    // Input handler aborted the controller
    expect(signalA.aborted).toBe(true);
  });

  it('race: stale fetch resolved AFTER newer one is discarded (seq check)', async () => {
    const fetchA = pendingPromise<any[]>([makeResult(1, 'A Show')]);
    const fetchB = pendingPromise<any[]>([makeResult(2, 'B Show')]);
    mockSearchShows.mockReturnValueOnce(fetchA.promise);
    mockSearchShows.mockReturnValueOnce(fetchB.promise);

    fireInput('aaa');
    await vi.advanceTimersByTimeAsync(350); // doSearch('aaa') in flight
    fireInput('bbb');
    await vi.advanceTimersByTimeAsync(350); // doSearch('bbb') in flight

    // B resolves first → renders B
    fetchB.resolve([makeResult(2, 'B Show')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.search-result-name')?.textContent).toBe('B Show');

    // A resolves later → must be discarded (mySeq !== searchSeq)
    fetchA.resolve([makeResult(1, 'A Show')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.search-result-name')?.textContent).toBe('B Show');
  });

  it('fallback (altQuery): empty results triggers a second searchShows with longest word', async () => {
    mockSearchShows
      .mockResolvedValueOnce([]) // 'foo bar' → empty
      .mockResolvedValueOnce([makeResult(1, 'Foobar Show')]); // 'foo' → results

    fireInput('foo bar');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks for both awaits

    expect(mockSearchShows).toHaveBeenCalledTimes(2);
    expect(mockSearchShows.mock.calls[0][0]).toBe('foo bar');
    expect(mockSearchShows.mock.calls[1][0]).toBe('foo');
    expect(document.querySelector('.search-result-name')?.textContent).toBe('Foobar Show');
  });

  it('BUG-10-01 FIXED: fallback shows all altResults.slice(0,10) (dead filter removed)', async () => {
    // query 'foo bar', altQuery 'foo'. Previous filter (matching `name.includes('foo bar')`)
    // was dead code that always returned []; we now show altResults.slice(0,10) directly.
    mockSearchShows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeResult(1, 'Foo'), makeResult(2, 'Barbaz')]);

    fireInput('foo bar');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    // Both altResults are shown (filter removed → always slice(0,10))
    const names = Array.from(document.querySelectorAll('.search-result-name')).map((e) => e.textContent);
    expect(names).toContain('Foo');
    expect(names).toContain('Barbaz');
    // The fallback note mentions altQuery 'foo'
    expect(resultsEl().innerHTML).toContain('Risultati simili per');
    expect(resultsEl().innerHTML).toContain('foo');
  });

  it('fallback skips altQuery when query is a single word (== altQuery)', async () => {
    mockSearchShows.mockResolvedValueOnce([]); // 'foo' → empty
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    // Only one search (no fallback because words[0] === query)
    expect(mockSearchShows).toHaveBeenCalledTimes(1);
    expect(resultsEl().innerHTML).toContain('Nessuna serie trovata');
  });

  it('keyboard ArrowDown/Up changes selection', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A'), makeResult(2, 'B'), makeResult(3, 'C')]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const items = document.querySelectorAll('.search-result-item');
    expect(items.length).toBe(3);
    expect(items[0].classList.contains('selected')).toBe(false);

    fireKeydown('ArrowDown');
    expect(items[0].classList.contains('selected')).toBe(true);
    fireKeydown('ArrowDown');
    expect(items[1].classList.contains('selected')).toBe(true);
    fireKeydown('ArrowUp');
    expect(items[0].classList.contains('selected')).toBe(true);
  });

  it('keyboard Enter with no selection clicks first item primary button', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    mockAddShowToList.mockResolvedValue(null);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    fireKeydown('Enter');
    await vi.advanceTimersByTimeAsync(0);
    expect(mockAddShowToList).toHaveBeenCalledTimes(1);
    expect(mockAddShowToList.mock.calls[0][1]).toBe('watching');
  });

  it('keyboard Enter with active selection clicks selected primary button', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A'), makeResult(2, 'B')]);
    mockAddShowToList.mockResolvedValue(null);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    fireKeydown('ArrowDown');
    fireKeydown('ArrowDown'); // idx=1 → 'B'
    fireKeydown('Enter');
    await vi.advanceTimersByTimeAsync(0);
    expect(mockAddShowToList).toHaveBeenCalledTimes(1);
    expect(mockAddShowToList.mock.calls[0][0].name).toBe('B');
  });

  it('Escape hides results', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultsEl().classList.contains('active')).toBe(true);

    fireKeydown('Escape');
    expect(resultsEl().classList.contains('active')).toBe(false);
  });

  it('query < 2 chars clears results and aborts in-flight search', async () => {
    const fetch = pendingPromise<any[]>([makeResult(1, 'A')]);
    mockSearchShows.mockReturnValueOnce(fetch.promise);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    expect(mockSearchShows).toHaveBeenCalledTimes(1);
    const signal = mockSearchShows.mock.calls[0][1] as AbortSignal;

    fireInput('f'); // < 2 chars
    expect(signal.aborted).toBe(true);
    expect(resultsEl().classList.contains('active')).toBe(false);
    expect(resultsEl().innerHTML).toBe('');
  });

  it('loading indicator shown during in-flight search', async () => {
    const fetch = pendingPromise<any[]>([makeResult(1, 'A')]);
    mockSearchShows.mockReturnValueOnce(fetch.promise);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    expect(resultsEl().innerHTML).toContain('Ricerca in corso');
    expect(resultsEl().classList.contains('active')).toBe(true);

    fetch.resolve([makeResult(1, 'A')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultsEl().innerHTML).toContain('A');
  });

  // === BUG-VERIFICATION TESTS ===

  it('BUG-10-02 FIXED: Escape clears lastSearchResults/DOM + aborts in-flight — stale Enter is a no-op', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'Stale Show')]);
    mockAddShowToList.mockResolvedValue(null);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    expect(resultsEl().querySelectorAll('.search-result-item').length).toBe(1);

    // Escape now fully clears state (DOM, lastSearchResults, selection, abort)
    fireKeydown('Escape');
    expect(resultsEl().classList.contains('active')).toBe(false);
    expect(resultsEl().querySelectorAll('.search-result-item').length).toBe(0);
    expect(resultsEl().innerHTML).toBe('');
    // aria-expanded flipped back to false
    expect(inputEl().getAttribute('aria-expanded')).toBe('false');

    // Refocus and press Enter — nothing to select, no addShowToList call
    inputEl().focus();
    fireKeydown('Enter');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockAddShowToList).not.toHaveBeenCalled();
  });

  it('BUG-10-03 FIXED: click outside clears DOM/lastSearchResults — stale Enter is a no-op', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'Hidden Show')]);
    mockAddShowToList.mockResolvedValue(null);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    expect(resultsEl().classList.contains('active')).toBe(true);

    // Click outside .search-wrap — now clears DOM + state + aborts in-flight
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(resultsEl().classList.contains('active')).toBe(false);
    expect(resultsEl().querySelectorAll('.search-result-item').length).toBe(0);
    expect(resultsEl().innerHTML).toBe('');
    expect(inputEl().getAttribute('aria-expanded')).toBe('false');

    // Refocus input (value unchanged) and press Enter — no-op
    inputEl().focus();
    fireKeydown('Enter');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockAddShowToList).not.toHaveBeenCalled();
  });

  it('BUG-10-05 FIXED: selectSearchResult retains input when addShowToList fails (already in list)', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'Dup Show')]);
    mockAddShowToList.mockResolvedValue(null); // simulate "already in list" failure
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    expect(inputEl().value).toBe('foo');

    const btn = document.querySelector('button[data-idx="0"][data-list="watching"]') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    // Input is retained on failure so the user can retry / pick another list
    expect(inputEl().value).toBe('foo');
    expect(mockAddShowToList).toHaveBeenCalledTimes(1);
  });

  it('BUG-10-05 (success path): selectSearchResult clears input after addShowToList succeeds', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'New Show')]);
    // Simulate success: addShowToList returns a Show object (truthy)
    mockAddShowToList.mockResolvedValue({ id: 1, name: 'New Show' } as any);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    expect(inputEl().value).toBe('foo');

    const btn = document.querySelector('button[data-idx="0"][data-list="watching"]') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    // Input is cleared on success
    expect(inputEl().value).toBe('');
    expect(mockAddShowToList).toHaveBeenCalledTimes(1);
  });

  it('race: altQuery fetch aborted when new input arrives during fallback', async () => {
    // First searchShows returns [] (empty), triggering fallback altQuery search.
    // New input during altQuery fetch → signal aborted → AbortError → return.
    const altFetch = pendingPromise<any[]>([makeResult(1, 'X')]);
    mockSearchShows.mockResolvedValueOnce([]).mockReturnValueOnce(altFetch.promise);

    fireInput('foo bar');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0); // first fetch resolves (empty)
    // now altQuery fetch is in flight
    expect(mockSearchShows).toHaveBeenCalledTimes(2);
    const altSignal = mockSearchShows.mock.calls[1][1] as AbortSignal;
    expect(altSignal.aborted).toBe(false);

    fireInput('baz');
    expect(altSignal.aborted).toBe(true);

    // Resolving the aborted altFetch should NOT render results (seq check)
    altFetch.resolve([makeResult(1, 'X')]);
    await vi.advanceTimersByTimeAsync(0);
    // 'baz' debounce will fire next
    mockSearchShows.mockResolvedValueOnce([makeResult(2, 'BazShow')]);
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.search-result-name')?.textContent).toBe('BazShow');
  });

  it('does not double-fire doSearch on debounce timer (no stale-timeout double-trigger)', async () => {
    mockSearchShows.mockResolvedValue([]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSearchShows).toHaveBeenCalledTimes(1);
    // Advance well past throttle window — should NOT re-trigger
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockSearchShows).toHaveBeenCalledTimes(1);
  });

  it('click on result button calls selectSearchResult with correct list', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    mockAddShowToList.mockResolvedValue(null);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const btn = document.querySelector('button[data-idx="0"][data-list="towatch"]') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockAddShowToList).toHaveBeenCalledTimes(1);
    expect(mockAddShowToList.mock.calls[0][1]).toBe('towatch');
  });

  it('click on result item (not button) selects with list=watching', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    mockAddShowToList.mockResolvedValue(null);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const item = document.querySelector('.search-result-item') as HTMLElement;
    item.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockAddShowToList).toHaveBeenCalledTimes(1);
    expect(mockAddShowToList.mock.calls[0][1]).toBe('watching');
  });

  it('MAX_QUERY_LENGTH branch triggers only when > 100 chars (dead code under input maxlength)', async () => {
    // Setting value to 101 chars directly (bypassing maxlength) DOES trigger the branch.
    mockSearchShows.mockResolvedValue([]);
    const long = 'a'.repeat(101);
    fireInput(long);
    // No debounce scheduled; immediate error shown
    expect(mockSearchShows).not.toHaveBeenCalled();
    expect(resultsEl().innerHTML).toContain('Query troppo lunga');
    await vi.advanceTimersByTimeAsync(500);
    expect(mockSearchShows).not.toHaveBeenCalled();
  });

  it('query of exactly 100 chars is allowed (boundary)', async () => {
    mockSearchShows.mockResolvedValue([]);
    const q = 'a'.repeat(100);
    fireInput(q);
    await vi.advanceTimersByTimeAsync(350);
    expect(mockSearchShows).toHaveBeenCalledTimes(1);
    expect(mockSearchShows.mock.calls[0][0]).toBe(q);
  });

  it('BUG-10-07 FIXED: fallback altQuery NetworkError propagates → shows connection error message', async () => {
    // First searchShows returns [] → triggers fallback.
    // AltQuery searchShows rejects with NetworkError → inner catch re-throws →
    // outer catch shows "Connessione internet non disponibile."
    const netErr = new Error('Network error');
    (netErr as any).name = 'NetworkError';
    mockSearchShows.mockResolvedValueOnce([]).mockRejectedValueOnce(netErr);

    fireInput('foo bar');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    // The user now sees the network error (consistent with first-fetch failure)
    expect(resultsEl().innerHTML).toContain('Connessione');
    expect(resultsEl().innerHTML).not.toContain('Nessuna serie trovata');
  });

  it('BUG-10-07 (TimeoutError): fallback altQuery TimeoutError propagates → shows timeout message', async () => {
    const timeoutErr = new Error('Timeout');
    (timeoutErr as any).name = 'TimeoutError';
    mockSearchShows.mockResolvedValueOnce([]).mockRejectedValueOnce(timeoutErr);

    fireInput('foo bar');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    expect(resultsEl().innerHTML).toContain('timeout');
    expect(resultsEl().innerHTML).not.toContain('Nessuna serie trovata');
  });

  it('first-fetch NetworkError shows connection error message (contrast with BUG-10-07)', async () => {
    const netErr = new Error('Network error');
    (netErr as any).name = 'NetworkError';
    mockSearchShows.mockRejectedValueOnce(netErr);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    expect(resultsEl().innerHTML).toContain('Connessione');
  });

  // === BUG-20-08: WAI-ARIA listbox semantics ===

  it('BUG-20-08: initSearch sets ARIA combobox/listbox attributes on input + results', () => {
    expect(inputEl().getAttribute('role')).toBe('combobox');
    expect(inputEl().getAttribute('aria-expanded')).toBe('false');
    expect(inputEl().getAttribute('aria-autocomplete')).toBe('list');
    expect(inputEl().getAttribute('aria-controls')).toBe('searchResults');
    expect(resultsEl().getAttribute('role')).toBe('listbox');
    expect(resultsEl().getAttribute('aria-label')).toBe('Risultati di ricerca');
  });

  it('BUG-20-08: aria-expanded toggles true when results are shown, false when cleared', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    expect(inputEl().getAttribute('aria-expanded')).toBe('false');

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    // Loading state → expanded
    expect(inputEl().getAttribute('aria-expanded')).toBe('true');

    await vi.advanceTimersByTimeAsync(0);
    expect(inputEl().getAttribute('aria-expanded')).toBe('true');

    // Escape → collapsed
    fireKeydown('Escape');
    expect(inputEl().getAttribute('aria-expanded')).toBe('false');
  });

  it('BUG-20-08: each result item has role=option and aria-selected=false initially', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A'), makeResult(2, 'B')]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const items = document.querySelectorAll('.search-result-item');
    expect(items.length).toBe(2);
    items.forEach((item) => {
      expect(item.getAttribute('role')).toBe('option');
      expect(item.getAttribute('aria-selected')).toBe('false');
    });
  });

  it('BUG-20-08: ArrowDown toggles aria-selected on the active option', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A'), makeResult(2, 'B')]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const items = document.querySelectorAll('.search-result-item');
    expect(items[0].getAttribute('aria-selected')).toBe('false');
    expect(items[1].getAttribute('aria-selected')).toBe('false');

    fireKeydown('ArrowDown'); // idx=0
    expect(items[0].getAttribute('aria-selected')).toBe('true');
    expect(items[1].getAttribute('aria-selected')).toBe('false');

    fireKeydown('ArrowDown'); // idx=1
    expect(items[0].getAttribute('aria-selected')).toBe('false');
    expect(items[1].getAttribute('aria-selected')).toBe('true');

    fireKeydown('ArrowUp'); // idx=0
    expect(items[0].getAttribute('aria-selected')).toBe('true');
    expect(items[1].getAttribute('aria-selected')).toBe('false');
  });

  it('BUG-20-08: aria-expanded=false when query drops below 2 chars', async () => {
    mockSearchShows.mockResolvedValue([makeResult(1, 'A')]);
    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);
    expect(inputEl().getAttribute('aria-expanded')).toBe('true');

    fireInput('f'); // < 2 chars
    expect(inputEl().getAttribute('aria-expanded')).toBe('false');
  });

  // === BUG-20-03: safeImageUrl blocks javascript:/data: URLs ===

  it('BUG-20-03: javascript: URL in show.image.medium is blocked (no <img src="javascript:">)', async () => {
    const malicious = makeResult(1, 'Evil') as any;
    malicious.show.image = { medium: 'javascript:alert(1)', original: null };
    mockSearchShows.mockResolvedValueOnce([malicious]);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const imgs = document.querySelectorAll('.search-result-img');
    expect(imgs.length).toBe(1);
    // The malicious URL was stripped → falls back to the "N/D" placeholder div,
    // not an <img> with a javascript: src.
    expect(imgs[0].tagName).toBe('DIV');
    expect(resultsEl().innerHTML).not.toContain('javascript:');
  });

  it('BUG-20-03: data: URL in show.image.medium is blocked', async () => {
    const malicious = makeResult(1, 'Evil') as any;
    malicious.show.image = { medium: 'data:text/html,<script>alert(1)</script>', original: null };
    mockSearchShows.mockResolvedValueOnce([malicious]);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    expect(resultsEl().innerHTML).not.toContain('data:');
    expect(resultsEl().innerHTML).not.toContain('<script>');
    // Falls back to placeholder div
    const imgs = document.querySelectorAll('.search-result-img');
    expect(imgs[0].tagName).toBe('DIV');
  });

  it('BUG-20-03: valid https: poster URL is preserved', async () => {
    const ok = makeResult(1, 'Good') as any;
    ok.show.image = { medium: 'https://example.com/poster.jpg', original: null };
    mockSearchShows.mockResolvedValueOnce([ok]);

    fireInput('foo');
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    const imgs = document.querySelectorAll('.search-result-img');
    expect(imgs.length).toBe(1);
    expect(imgs[0].tagName).toBe('IMG');
    expect((imgs[0] as HTMLImageElement).getAttribute('src')).toBe('https://example.com/poster.jpg');
  });
});
