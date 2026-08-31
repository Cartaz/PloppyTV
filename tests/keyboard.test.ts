import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { switchView, modalState, showModal } = vi.hoisted(() => ({
  switchView: vi.fn(),
  modalState: { open: false },
  showModal: vi.fn(),
}));

vi.mock('../src/lib/store', () => ({ switchView }));
vi.mock('../src/components/modal', () => ({
  isModalOpen: () => modalState.open,
  showModal,
}));

function dispatchKey(
  key: string,
  options: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {},
  target: Document | HTMLElement = document,
): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ctrlKey: options.ctrl ?? false,
      metaKey: options.meta ?? false,
      altKey: options.alt ?? false,
      shiftKey: options.shift ?? false,
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  switchView.mockReset();
  showModal.mockReset();
  modalState.open = false;
  localStorage.clear();
  document.body.innerHTML = '<main id="mainContent"></main>';
});

afterEach(async () => {
  const keyboard = await import('../src/lib/keyboard');
  keyboard._resetKeyboardForTesting();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('keyboard contracts', () => {
  it('has one global listener and can be reset and initialized again', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const keyboard = await import('../src/lib/keyboard');

    keyboard.initKeyboard();
    keyboard.initKeyboard();
    keyboard.initKeyboard();
    expect(addSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);

    keyboard._resetKeyboardForTesting();
    expect(removeSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);

    keyboard.initKeyboard();
    expect(addSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(2);
  });

  it('routes every g-sequence to its semantic view', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();

    const routes = [
      ['d', 'dashboard'],
      ['c', 'calendar'],
      ['s', 'stats'],
      ['l', 'library'],
      ['y', 'yearreview'],
    ] as const;
    for (const [key, view] of routes) {
      dispatchKey('g');
      dispatchKey(key);
      expect(switchView).toHaveBeenLastCalledWith(view);
    }
    expect(switchView).toHaveBeenCalledTimes(routes.length);
  });

  it('ignores browser modifier shortcuts and cancels a pending g-sequence', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();

    for (const modifiers of [{ ctrl: true }, { meta: true }, { alt: true }]) {
      dispatchKey('g', modifiers);
      dispatchKey('d');
    }
    dispatchKey('g');
    dispatchKey('d', { ctrl: true });
    dispatchKey('d');

    expect(switchView).not.toHaveBeenCalled();
  });

  it('expires or rejects an incomplete g-sequence', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();

    dispatchKey('g');
    dispatchKey('x');
    dispatchKey('d');
    expect(switchView).not.toHaveBeenCalled();

    dispatchKey('g');
    vi.advanceTimersByTime(801);
    dispatchKey('d');
    expect(switchView).not.toHaveBeenCalled();
  });

  it('does not hijack keys from editable controls', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();

    for (const tag of ['input', 'textarea', 'select'] as const) {
      const element = document.createElement(tag);
      document.body.appendChild(element);
      element.focus();
      dispatchKey('g', {}, element);
      dispatchKey('d', {}, element);
      element.remove();
    }

    const editable = document.createElement('div');
    editable.tabIndex = 0;
    Object.defineProperty(editable, 'isContentEditable', { value: true, configurable: true });
    document.body.appendChild(editable);
    editable.focus();
    dispatchKey('g', {}, editable);
    dispatchKey('d', {}, editable);

    expect(switchView).not.toHaveBeenCalled();
  });

  it('opens the cheat sheet only when no modal is already open', async () => {
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();

    dispatchKey('?', { shift: true });
    expect(showModal).toHaveBeenCalledTimes(1);

    modalState.open = true;
    dispatchKey('?');
    dispatchKey('g');
    dispatchKey('d');
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(switchView).not.toHaveBeenCalled();
  });

  it('focuses search with the slash shortcut', async () => {
    const input = document.createElement('input');
    input.id = 'searchInput';
    document.body.appendChild(input);
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();

    dispatchKey('/');
    expect(document.activeElement).toBe(input);
  });

  it('navigates episode focus with j/k and clamps at both boundaries', async () => {
    const main = document.getElementById('mainContent')!;
    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();

    expect(() => {
      dispatchKey('j');
      dispatchKey('k');
    }).not.toThrow();

    main.innerHTML =
      '<div class="episode-item" role="button" tabindex="0">E1</div>' +
      '<div class="episode-item" role="button" tabindex="0">E2</div>';
    const items = main.querySelectorAll<HTMLElement>('.episode-item');

    dispatchKey('j');
    expect(document.activeElement).toBe(items[0]);
    dispatchKey('j');
    expect(document.activeElement).toBe(items[1]);
    dispatchKey('j');
    expect(document.activeElement).toBe(items[1]);
    dispatchKey('k');
    expect(document.activeElement).toBe(items[0]);
    dispatchKey('k');
    expect(document.activeElement).toBe(items[0]);
  });

  it('toggles the focused episode through its existing click contract', async () => {
    const main = document.getElementById('mainContent')!;
    main.innerHTML = '<div class="episode-item" role="button" tabindex="0" data-action="toggleEpisode">E1</div>';
    const episode = main.querySelector<HTMLElement>('.episode-item')!;
    const clickSpy = vi.fn();
    episode.addEventListener('click', clickSpy);
    episode.focus();

    const { initKeyboard } = await import('../src/lib/keyboard');
    initKeyboard();
    dispatchKey('w');

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
