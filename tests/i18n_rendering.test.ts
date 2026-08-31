import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeShow } from './helpers';

function installDeferredRaf(): () => void {
  let frame: FrameRequestCallback | null = null;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      frame = cb;
      return 1;
    }),
  );
  return () => {
    if (!frame) throw new Error('renderer did not request a frame');
    const cb = frame;
    frame = null;
    cb(0);
  };
}

async function useEnglishLocale() {
  const i18n = await import('../src/lib/i18n');
  i18n._resetI18nForTesting();
  i18n.setLocale('en');
  return i18n;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.doUnmock('../src/views/dashboard');
  vi.doUnmock('../src/components/toast');
  document.body.innerHTML = '';
});

describe('localized show-list rendering', () => {
  it('renders the empty list in the selected locale', async () => {
    vi.resetModules();
    const i18n = await useEnglishLocale();
    const store = await import('../src/lib/store');
    const showList = await import('../src/views/showList');

    store.setState({ shows: [], currentView: 'watching', currentShowId: null });
    showList._resetShowListStateForTesting();

    const main = document.createElement('main');
    showList.renderShowList(main, 'watching', i18n.t('nav.watching'));

    expect(main.querySelector('.page-title')?.textContent).toBe('Watching');
    expect(main.querySelector('.empty-state-title')?.textContent).toBe('No shows');
    expect(main.querySelector('.empty-state-text')?.textContent).toBe('You have no shows in this list.');
  });

  it('keeps the active-tag empty state localized and escaped', async () => {
    vi.resetModules();
    const i18n = await useEnglishLocale();
    const store = await import('../src/lib/store');
    const showList = await import('../src/views/showList');

    store.setState({
      shows: [makeShow({ list: 'watching', tags: ['<drama>'] })],
      currentView: 'watching',
      currentShowId: null,
    });
    showList._resetShowListStateForTesting();

    const main = document.createElement('main');
    showList.renderShowList(main, 'watching', i18n.t('nav.watching'));
    (main.querySelector('[data-tag="<drama>"]') as HTMLButtonElement).click();

    store.setState({ shows: [] });
    showList.renderShowList(main, 'watching', i18n.t('nav.watching'));

    expect(main.querySelector('[data-tag=""]')?.textContent).toBe('All');
    expect(main.querySelector('.empty-state-text')?.textContent).toBe(
      'No shows with the tag "<drama>" in this list.',
    );
    expect(main.querySelector('.empty-state-text script')).toBeNull();
  });
});

describe('renderer i18n boundary', () => {
  it('owns the localized title passed to list views', async () => {
    vi.resetModules();
    await useEnglishLocale();
    const store = await import('../src/lib/store');
    const runFrame = installDeferredRaf();

    document.body.innerHTML = '<main id="mainContent"></main>';
    store.setState({ shows: [], currentView: 'watching', currentShowId: null });

    const renderer = await import('../src/components/renderer');
    renderer.render();
    runFrame();

    await vi.waitFor(() => {
      expect(document.querySelector('.page-title')?.textContent).toBe('Watching');
    });
  });

  it('localizes the chunk-load fallback instead of embedding Italian strings', async () => {
    vi.resetModules();
    const showToast = vi.fn();
    vi.doMock('../src/components/toast', () => ({ showToast }));
    vi.doMock('../src/views/dashboard', () => {
      throw new Error('chunk failed');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await useEnglishLocale();
    const store = await import('../src/lib/store');
    const runFrame = installDeferredRaf();

    document.body.innerHTML = '<main id="mainContent"></main>';
    store.setState({ shows: [], currentView: 'dashboard', currentShowId: null });

    const renderer = await import('../src/components/renderer');
    renderer.render();
    runFrame();

    await vi.waitFor(() => {
      expect(document.querySelector('.empty-state-title')?.textContent).toBe('View load error');
    });
    expect(document.querySelector('[data-action="reloadPage"]')?.textContent).toBe('Reload');
    expect(showToast).toHaveBeenCalledWith('Module load error — reload the page', 'error');
    expect(errorSpy).toHaveBeenCalled();
  });
});
