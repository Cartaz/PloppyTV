import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let loadDiscoverSpy: ReturnType<typeof vi.fn>;
let invalidateDiscoverCacheSpy: ReturnType<typeof vi.fn>;
let resetDiscoverLoadSpy: ReturnType<typeof vi.fn>;
let findShowInDiscoverGroupsSpy: ReturnType<typeof vi.fn>;
let addShowToListSpy: ReturnType<typeof vi.fn>;
let showModalSpy: ReturnType<typeof vi.fn>;
let showToastSpy: ReturnType<typeof vi.fn>;

const show = {
  id: 42,
  name: 'Boundary Show',
  weight: 50,
  image: null,
  genres: ['Drama'],
  premiered: '2026-01-01',
  rating: { average: 8 },
  network: { name: 'Network' },
  webChannel: null,
  summary: '<p>Summary</p>',
  status: 'Running',
  runtime: 45,
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<main id="mainContent"></main>';

  loadDiscoverSpy = vi.fn(async () => ({ Drama: [show], _other: [] }));
  invalidateDiscoverCacheSpy = vi.fn();
  resetDiscoverLoadSpy = vi.fn();
  findShowInDiscoverGroupsSpy = vi.fn(() => show);
  addShowToListSpy = vi.fn(async () => null);
  showModalSpy = vi.fn();
  showToastSpy = vi.fn();

  vi.doMock('../src/lib/discover', () => ({
    loadDiscover: (tab: 'popular' | 'recent') => loadDiscoverSpy(tab),
    invalidateDiscoverCache: (tab: 'popular' | 'recent') => invalidateDiscoverCacheSpy(tab),
    resetDiscoverLoad: (tab: 'popular' | 'recent') => resetDiscoverLoadSpy(tab),
    findShowInDiscoverGroups: (id: number, groups: unknown[]) => findShowInDiscoverGroupsSpy(id, groups),
  }));
  vi.doMock('../src/lib/shows', () => ({
    addShowToList: (candidate: unknown, list: 'towatch' | 'watching') => addShowToListSpy(candidate, list),
  }));
  vi.doMock('../src/components/modal', () => ({ showModal: showModalSpy }));
  vi.doMock('../src/components/toast', () => ({ showToast: showToastSpy }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('discover interaction contracts', () => {
  it('refreshes the recent tab through the recent cache owner', async () => {
    const store = await import('../src/lib/store');
    const discover = await import('../src/views/discover');
    const main = document.getElementById('mainContent')!;

    store.setState({
      shows: [],
      currentView: 'discover',
      currentShowId: null,
      _discoverTab: 'recent',
      _storageDisabled: false,
    });
    discover.renderDiscover(main);
    discover.bindDiscoverEvents(main);
    await flushMicrotasks();

    loadDiscoverSpy.mockClear();
    invalidateDiscoverCacheSpy.mockClear();
    resetDiscoverLoadSpy.mockClear();
    (main.querySelector('[data-action="refreshDiscover"]') as HTMLButtonElement).click();
    await flushMicrotasks();

    expect(invalidateDiscoverCacheSpy).toHaveBeenCalledWith('recent');
    expect(resetDiscoverLoadSpy).toHaveBeenCalledWith('recent');
    expect(loadDiscoverSpy).toHaveBeenCalledWith('recent');
  });

  it('fails safely when a previewed show disappears from cache before add', async () => {
    const store = await import('../src/lib/store');
    const discover = await import('../src/views/discover');
    const main = document.getElementById('mainContent')!;

    store.setState({
      shows: [],
      currentView: 'discover',
      currentShowId: null,
      _discoverTab: 'popular',
      _storageDisabled: false,
    });
    discover.renderDiscover(main);
    discover.bindDiscoverEvents(main);
    await flushMicrotasks();

    findShowInDiscoverGroupsSpy.mockReturnValueOnce(show).mockReturnValueOnce(null);
    (main.querySelector('.carousel-card') as HTMLElement).click();

    expect(showModalSpy).toHaveBeenCalledTimes(1);
    const actions = showModalSpy.mock.calls[0][2] as Array<{
      label: string;
      onClick?: () => Promise<void> | void;
    }>;
    const addAction = actions.find((action) => action.label === 'Da vedere');
    expect(addAction?.onClick).toBeTypeOf('function');
    await addAction?.onClick?.();

    expect(addShowToListSpy).not.toHaveBeenCalled();
    expect(showToastSpy).toHaveBeenCalledWith(
      'Serie non trovata nella cache, usa la ricerca',
      'error',
    );
  });
});
