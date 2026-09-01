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
});
