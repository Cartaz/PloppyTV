import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let rafQueue: FrameRequestCallback[];
let rafSpy: ReturnType<typeof vi.fn>;

let showToastSpy: ReturnType<typeof vi.fn>;
let renderDashboardSpy: ReturnType<typeof vi.fn>;
let renderShowListSpy: ReturnType<typeof vi.fn>;
let resetDiscoverSpy: ReturnType<typeof vi.fn>;
let renderDiscoverSpy: ReturnType<typeof vi.fn>;
let bindDiscoverSpy: ReturnType<typeof vi.fn>;
let resetCalendarSpy: ReturnType<typeof vi.fn>;
let renderCalendarSpy: ReturnType<typeof vi.fn>;
let bindCalendarSpy: ReturnType<typeof vi.fn>;
let renderStatsSpy: ReturnType<typeof vi.fn>;
let renderLibrarySpy: ReturnType<typeof vi.fn>;
let renderYearReviewSpy: ReturnType<typeof vi.fn>;

const VIEW_MODULES = [
  '../src/views/dashboard',
  '../src/views/showList',
  '../src/views/discover',
  '../src/views/calendar',
  '../src/views/stats',
  '../src/views/library',
  '../src/views/yearReview',
  '../src/views/showDetail',
];

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML =
    '<nav><button class="nav-item" data-view="dashboard"></button><button class="nav-item" data-view="stats"></button></nav>' +
    '<main id="mainContent"></main>';

  rafQueue = [];
  rafSpy = vi.fn((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('requestAnimationFrame', rafSpy);

  showToastSpy = vi.fn();
  renderDashboardSpy = vi.fn();
  renderShowListSpy = vi.fn();
  resetDiscoverSpy = vi.fn();
  renderDiscoverSpy = vi.fn();
  bindDiscoverSpy = vi.fn();
  resetCalendarSpy = vi.fn();
  renderCalendarSpy = vi.fn(async () => {});
  bindCalendarSpy = vi.fn();
  renderStatsSpy = vi.fn(async () => {});
  renderLibrarySpy = vi.fn();
  renderYearReviewSpy = vi.fn();

  vi.doMock('../src/components/imageFallback', () => ({ initImageFallback: vi.fn() }));
  vi.doMock('../src/components/header', () => ({ updateBadges: vi.fn() }));
  vi.doMock('../src/components/toast', () => ({ showToast: showToastSpy }));
  vi.doMock('../src/views/dashboard', () => ({ renderDashboard: renderDashboardSpy }));
  vi.doMock('../src/views/showList', () => ({ renderShowList: renderShowListSpy }));
  vi.doMock('../src/views/discover', () => ({
    resetBoundGuard: resetDiscoverSpy,
    renderDiscover: renderDiscoverSpy,
    bindDiscoverEvents: bindDiscoverSpy,
  }));
  vi.doMock('../src/views/calendar', () => ({
    resetBoundGuard: resetCalendarSpy,
    renderCalendar: renderCalendarSpy,
    bindCalendarEvents: bindCalendarSpy,
  }));
  vi.doMock('../src/views/stats', () => ({ renderStats: renderStatsSpy }));
  vi.doMock('../src/views/library', () => ({ renderLibrary: renderLibrarySpy }));
  vi.doMock('../src/views/yearReview', () => ({ renderYearReview: renderYearReviewSpy }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const path of VIEW_MODULES) vi.doUnmock(path);
});

async function flushFrame(): Promise<void> {
  const cb = rafQueue.shift();
  expect(cb).toBeDefined();
  cb?.(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('renderer contracts', () => {
  it('routes every top-level view to its owning renderer', async () => {
    const store = await import('../src/lib/store');
    const renderer = await import('../src/components/renderer');
    const main = document.getElementById('mainContent')!;

    store.setState({ currentShowId: null, currentView: 'dashboard' });
    renderer.render();
    await flushFrame();
    expect(renderDashboardSpy).toHaveBeenLastCalledWith(main);

    renderShowListSpy.mockClear();
    store.setState({ currentShowId: null, currentView: 'watching' });
    renderer.render();
    await flushFrame();
    expect(renderShowListSpy).toHaveBeenCalledWith(main, 'watching', expect.any(String));

    store.setState({ currentShowId: null, currentView: 'discover' });
    renderer.render();
    await flushFrame();
    expect(resetDiscoverSpy).toHaveBeenCalledTimes(1);
    expect(renderDiscoverSpy).toHaveBeenCalledWith(main);
    expect(bindDiscoverSpy).toHaveBeenCalledWith(main);

    store.setState({ currentShowId: null, currentView: 'calendar' });
    renderer.render();
    await flushFrame();
    expect(resetCalendarSpy).toHaveBeenCalledTimes(1);
    expect(renderCalendarSpy).toHaveBeenCalledWith(main);
    expect(bindCalendarSpy).toHaveBeenCalledWith(main);

    store.setState({ currentShowId: null, currentView: 'stats' });
    renderer.render();
    await flushFrame();
    expect(renderStatsSpy).toHaveBeenCalledWith(main);

    store.setState({ currentShowId: null, currentView: 'library' });
    renderer.render();
    await flushFrame();
    expect(renderLibrarySpy).toHaveBeenCalledWith(main);

    store.setState({ currentShowId: null, currentView: 'yearreview' });
    renderer.render();
    await flushFrame();
    expect(renderYearReviewSpy).toHaveBeenCalledWith(main);

    renderDashboardSpy.mockClear();
    store.setState({ currentShowId: null, currentView: 'unknown-view' });
    renderer.render();
    await flushFrame();
    expect(renderDashboardSpy).toHaveBeenCalledWith(main);
  });

  it('coalesces repeated render requests into one animation frame', async () => {
    const store = await import('../src/lib/store');
    const renderer = await import('../src/components/renderer');

    store.setState({ currentShowId: null, currentView: 'dashboard' });
    renderer.render();
    renderer.render();
    renderer.render();

    expect(rafSpy).toHaveBeenCalledTimes(1);
    expect(rafQueue).toHaveLength(1);

    await flushFrame();
    renderer.render();
    expect(rafSpy).toHaveBeenCalledTimes(2);
  });

  it('does not bind a superseded asynchronous view render', async () => {
    const pendingCalendar = deferred<void>();
    renderCalendarSpy.mockImplementationOnce(() => pendingCalendar.promise);

    const store = await import('../src/lib/store');
    const renderer = await import('../src/components/renderer');

    store.setState({ currentShowId: null, currentView: 'calendar' });
    renderer.render();
    await flushFrame();
    expect(renderCalendarSpy).toHaveBeenCalledTimes(1);
    expect(bindCalendarSpy).not.toHaveBeenCalled();

    store.setState({ currentShowId: null, currentView: 'dashboard' });
    renderer.render();
    await flushFrame();
    expect(renderDashboardSpy).toHaveBeenCalled();

    pendingCalendar.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(bindCalendarSpy).not.toHaveBeenCalled();
  });

  it('binds delegated actions only once across repeated initialization', async () => {
    const renderer = await import('../src/components/renderer');
    const main = document.getElementById('mainContent')!;
    const addSpy = vi.spyOn(main, 'addEventListener');

    renderer.initRenderer();
    renderer.initRenderer();
    renderer.initRenderer();

    const clickAdds = addSpy.mock.calls.filter(([type]) => type === 'click');
    expect(clickAdds).toHaveLength(1);
  });

  it('turns a rejected view chunk into recoverable UI', async () => {
    vi.doMock('../src/views/dashboard', () => {
      throw new Error('chunk unavailable');
    });
    vi.resetModules();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await import('../src/lib/store');
    const renderer = await import('../src/components/renderer');
    const main = document.getElementById('mainContent')!;

    store.setState({ currentShowId: null, currentView: 'dashboard' });
    renderer.render();
    await flushFrame();

    expect(errorSpy).toHaveBeenCalledWith('[renderer] chunk load failed:', expect.any(Error));
    expect(main.querySelector('[data-action="reloadPage"]')).not.toBeNull();
    expect(main.querySelector('[onclick]')).toBeNull();
    expect(showToastSpy).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it.each([
    ['dashboard', '../src/views/dashboard'],
    ['watching', '../src/views/showList'],
    ['discover', '../src/views/discover'],
    ['calendar', '../src/views/calendar'],
    ['stats', '../src/views/stats'],
    ['library', '../src/views/library'],
    ['yearreview', '../src/views/yearReview'],
    ['unknown-view', '../src/views/dashboard'],
    ['detail', '../src/views/showDetail'],
  ])('recovers from a failed chunk for %s', async (view, path) => {
    vi.doMock(path, () => {
      throw new Error('offline chunk');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await import('../src/lib/store');
    const renderer = await import('../src/components/renderer');
    store.setState({ currentView: view, currentShowId: view === 'detail' ? 1 : null });
    renderer.render();
    await flushFrame();
    expect(document.querySelector('[data-action="reloadPage"]')).not.toBeNull();
    expect(showToastSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['watching', '../src/views/showList'],
    ['discover', '../src/views/discover'],
    ['calendar', '../src/views/calendar'],
    ['stats', '../src/views/stats'],
    ['library', '../src/views/library'],
    ['yearreview', '../src/views/yearReview'],
    ['detail', '../src/views/showDetail'],
  ])('ignores a failed chunk after leaving %s', async (view, path) => {
    let reject!: (reason: Error) => void;
    vi.doMock(
      path,
      () =>
        new Promise((_resolve, rej) => {
          reject = rej;
        }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await import('../src/lib/store');
    const renderer = await import('../src/components/renderer');
    const main = document.getElementById('mainContent')!;
    store.setState({ currentView: view, currentShowId: view === 'detail' ? 1 : null });
    renderer.render();
    await flushFrame();
    store.setState({ currentView: 'dashboard', currentShowId: null });
    renderDashboardSpy.mockImplementationOnce(() => {
      main.textContent = 'Current dashboard';
    });
    renderer.render();
    await flushFrame();
    reject(new Error('late chunk failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(main.textContent).toBe('Current dashboard');
    expect(showToastSpy).not.toHaveBeenCalled();
  });

  it('recovers from an exception thrown while rendering a loaded view', async () => {
    renderDashboardSpy.mockImplementationOnce(() => {
      throw new Error('view failure');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await import('../src/lib/store');
    const renderer = await import('../src/components/renderer');
    store.setState({ currentView: 'dashboard', currentShowId: null });
    renderer.render();
    await flushFrame();
    expect(document.querySelector('[data-action="reloadPage"]')).not.toBeNull();
  });

  it.each([
    ['watching', '../src/views/showList', 'renderShowList'],
    ['discover', '../src/views/discover', 'renderDiscover'],
    ['calendar', '../src/views/calendar', 'renderCalendar'],
    ['stats', '../src/views/stats', 'renderStats'],
    ['library', '../src/views/library', 'renderLibrary'],
    ['yearreview', '../src/views/yearReview', 'renderYearReview'],
    ['detail', '../src/views/showDetail', 'renderShowDetail'],
  ])('ignores a successfully loaded chunk after leaving %s', async (view, path, renderName) => {
    const chunk = deferred<Record<string, unknown>>();
    const obsoleteRenderer = vi.fn();
    vi.doMock(path, () => chunk.promise);
    const store = await import('../src/lib/store');
    const renderer = await import('../src/components/renderer');
    store.setState({ currentView: view, currentShowId: view === 'detail' ? 1 : null });
    renderer.render();
    await flushFrame();
    store.setState({ currentView: 'dashboard', currentShowId: null });
    renderer.render();
    await flushFrame();
    chunk.resolve({ [renderName]: obsoleteRenderer, resetBoundGuard: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(obsoleteRenderer).not.toHaveBeenCalled();
    expect(renderDashboardSpy).toHaveBeenCalledTimes(1);
  });

  it('handles delegated navigation and rejects invalid show IDs', async () => {
    const store = await import('../src/lib/store');
    const renderer = await import('../src/components/renderer');
    renderer.initRenderer();
    const main = document.getElementById('mainContent')!;
    main.innerHTML =
      '<button data-action="switchView" data-view="library">Library</button>' +
      '<button data-action="switchView">Missing view</button><button data-action="closeShow">Back</button>' +
      '<button data-action="openShow" data-show-id="invalid">Invalid</button><button>Other</button>';
    store.setState({ currentView: 'dashboard', currentShowId: 1 });
    main.querySelector<HTMLButtonElement>('[data-view]')!.click();
    expect(store.getState().currentView).toBe('library');
    main.querySelectorAll<HTMLButtonElement>('button').forEach((button) => button.click());
    expect(store.getState().currentShowId).toBeNull();
    expect(store.getState().currentView).toBe('library');
  });

  it('tolerates a missing main element and can initialize after it appears', async () => {
    document.getElementById('mainContent')!.remove();
    const renderer = await import('../src/components/renderer');
    expect(() => renderer.initRenderer()).not.toThrow();
    renderer.render();
    await flushFrame();
    expect(renderDashboardSpy).not.toHaveBeenCalled();
    document.body.insertAdjacentHTML('beforeend', '<main id="mainContent"></main>');
    renderer.initRenderer();
    renderer.render();
    await flushFrame();
    expect(renderDashboardSpy).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('binds show detail only when the series still exists (%s)', async (exists) => {
    const store = await import('../src/lib/store');
    const bind = vi.fn();
    vi.doMock('../src/views/showDetail', () => ({
      resetBoundGuard: vi.fn(),
      renderShowDetail: () => {
        if (!exists) store.closeShow();
      },
      bindShowDetailEvents: bind,
    }));
    const renderer = await import('../src/components/renderer');
    store.setState({ currentShowId: 1 });
    renderer.render();
    await flushFrame();
    expect(bind).toHaveBeenCalledTimes(exists ? 1 : 0);
  });
});
