import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEpisode, makeShow } from './helpers';
import { setState } from '../src/lib/store';
import { loadData, saveData } from '../src/lib/storage';
import { PREFS_KEY } from '../src/lib/constants';
import { notificationsEnabled, disableNotifications } from '../src/lib/notifications';
import { renderLibrary, _resetLibraryFiltersForTesting } from '../src/views/library';
import { bindShowDetailEvents, renderShowDetail, resetBoundGuard } from '../src/views/showDetail';
import { closeAllModals, initModal, isModalOpen } from '../src/components/modal';

document.body.innerHTML =
  '<main id="mainContent"></main><div id="modal"><div class="modal">' +
  '<h2 id="modalTitle"></h2><div id="modalBody"></div><div id="modalActions"></div></div></div>' +
  '<div id="toast"></div>';
const main = document.getElementById('mainContent')!;
initModal();

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  setState({ shows: [], _storageDisabled: false, _localDirty: false, currentShowId: null, currentView: 'library' });
  loadData();
  _resetLibraryFiltersForTesting();
  document.getElementById('toast')!.innerHTML = '';
  vi.stubGlobal('Notification', { permission: 'granted' });
  setState({ shows: [makeShow({ seasons: { 1: [makeEpisode({ name: 'Pilot' })] }, totalEpisodes: 1 })] });
});

afterEach(() => {
  closeAllModals();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('library search owns only its active DOM', () => {
  it('keeps the search field focused, including the caret, after filtering', () => {
    renderLibrary(main);
    const input = main.querySelector<HTMLInputElement>('#libTextFilter')!;
    input.focus();
    input.value = 'Test';
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(200);
    const current = main.querySelector<HTMLInputElement>('#libTextFilter')!;
    expect(document.activeElement).toBe(current);
    expect(current.selectionStart).toBe(2);
  });

  it('does not overwrite the next view when a delayed filter fires', () => {
    renderLibrary(main);
    const input = main.querySelector<HTMLInputElement>('#libTextFilter')!;
    input.value = 'Test';
    input.dispatchEvent(new Event('input'));
    setState({ currentView: 'dashboard' });
    main.innerHTML = '<h1>Dashboard</h1>';
    vi.advanceTimersByTime(200);
    expect(main.textContent).toBe('Dashboard');
  });
});

describe('notification preferences tolerate unreadable data', () => {
  it.each(['null', '[]', '42', '"text"', '{broken'])('ignores malformed preferences (%s)', (raw) => {
    localStorage.setItem(PREFS_KEY, raw);
    expect(() => notificationsEnabled()).not.toThrow();
    expect(notificationsEnabled()).toBe(false);
    disableNotifications();
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ notificationsEnabled: false });
  });

  it('preserves language and other preferences when disabling notifications', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ lang: 'en', notificationsEnabled: true }));
    disableNotifications();
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ lang: 'en', notificationsEnabled: false });
  });
});

it('keeps an unsaved note editor open without a success message', () => {
  expect(saveData({ immediate: true })).toBe(true);
  setState({ currentShowId: 1 });
  renderShowDetail(main);
  resetBoundGuard();
  bindShowDetailEvents(main);
  main.querySelector<HTMLButtonElement>('[data-action="editNote"]')!.click();
  const textarea = document.getElementById('noteTextarea') as HTMLTextAreaElement;
  textarea.value = 'Do not lose this note';
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('unavailable');
  });
  const save = Array.from(document.querySelectorAll<HTMLButtonElement>('#modalActions button')).find(
    (b) => b.textContent === 'Salva',
  )!;
  save.click();
  expect(isModalOpen()).toBe(true);
  expect(textarea.value).toBe('Do not lose this note');
  expect(document.getElementById('toast')!.textContent).not.toContain('Nota salvata');
});

it('closes the note editor only after a successful save', () => {
  expect(saveData({ immediate: true })).toBe(true);
  setState({ currentShowId: 1 });
  renderShowDetail(main);
  resetBoundGuard();
  bindShowDetailEvents(main);
  main.querySelector<HTMLButtonElement>('[data-action="editNote"]')!.click();
  (document.getElementById('noteTextarea') as HTMLTextAreaElement).value = 'Saved note';
  Array.from(document.querySelectorAll<HTMLButtonElement>('#modalActions button'))
    .find((b) => b.textContent === 'Salva')!
    .click();
  expect(isModalOpen()).toBe(false);
  expect(document.getElementById('toast')!.textContent).toBe('Nota salvata');
});
