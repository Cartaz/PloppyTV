// Interazioni del dettaglio serie con moduli reali (store, shows, modal);
// solo la persistenza è finta.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../src/lib/storage', () => ({ saveData: vi.fn(() => true), isStorageOK: vi.fn(() => true) }));
vi.mock('../src/components/toast', () => ({ showToast: vi.fn() }));

import { getState, setShows, setState } from '../src/lib/store';
import { renderShowDetail, bindShowDetailEvents } from '../src/views/showDetail';
import { initModal, closeAllModals } from '../src/components/modal';
import { makeShowWithSeasons } from './helpers';

let main: HTMLElement;

function rerender(): void {
  renderShowDetail(main);
  bindShowDetailEvents(main);
}

function show() {
  return getState().shows.find((s) => s.id === 1)!;
}

function click(selector: string): void {
  const el = main.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error('missing ' + selector);
  el.click();
}

function modalButton(label: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('#modalActions button')).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error('missing modal button ' + label);
  return btn;
}

// Il modulo modal tiene i riferimenti al DOM: lo scheletro si crea una volta sola.
beforeAll(() => {
  document.body.innerHTML = `
    <main id="mainContent"></main>
    <div id="modal" aria-hidden="true"><div class="modal" tabindex="-1">
      <div id="modalTitle"></div><div id="modalBody"></div><div id="modalActions"></div>
    </div></div>
    <div id="toast"></div>`;
  main = document.getElementById('mainContent')!;
  initModal();
});

beforeEach(() => {
  vi.useFakeTimers();
  closeAllModals();
  const s = makeShowWithSeasons({ 1: 2, 2: 1 }, { id: 1, name: 'Serie' });
  const other = makeShowWithSeasons({ 1: 1 }, { id: 2, name: 'Altra', tags: ['Estate'] });
  setShows([s, other]);
  setState({ currentShowId: 1, currentSeason: 1, currentView: 'dashboard' });
  rerender();
});

describe('show detail interactions', () => {
  it('rates an episode and clicking the same star again clears the rating', () => {
    click('[data-action="rateEpisode"][data-ep="1"] [data-star="4"]');
    expect(show().seasons[1][0].rating).toBe(4);
    rerender();
    click('[data-action="rateEpisode"][data-ep="1"] [data-star="4"]');
    expect(show().seasons[1][0].rating).toBeUndefined();
  });

  it('edits a note through the modal, with a live character counter', async () => {
    click('[data-action="editNote"][data-ep="2"]');
    expect(document.getElementById('modalTitle')!.textContent).toBe('Nota episodio');
    await vi.advanceTimersByTimeAsync(60);
    const ta = document.getElementById('noteTextarea') as HTMLTextAreaElement;
    ta.value = 'Da rivedere';
    ta.dispatchEvent(new Event('input'));
    expect(document.getElementById('noteCharCount')!.textContent).toBe('11/500');
    modalButton('Salva').click();
    expect(show().seasons[1][1].note).toBe('Da rivedere');
  });

  it('adds a tag from the suggestions of other shows, with Enter, and removes it', async () => {
    click('[data-action="addTag"]');
    await vi.advanceTimersByTimeAsync(60);
    const suggestion = document.querySelector<HTMLButtonElement>('.tag-suggestion')!;
    expect(suggestion.textContent).toBe('Estate');
    suggestion.click();
    const input = document.getElementById('tagInput') as HTMLInputElement;
    expect(input.value).toBe('Estate');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(show().tags).toEqual(['Estate']);

    rerender();
    click('[data-action="removeTag"]');
    expect(show().tags).toEqual([]);
  });

  it('switches season and marks a whole season watched', () => {
    click('[data-action="switchSeason"][data-season="2"]');
    expect(getState().currentSeason).toBe(2);
    setState({ currentSeason: 1 });
    rerender();
    click('[data-action="markSeason"][data-watched="1"]');
    expect(show().seasons[1].every((e) => e.watched)).toBe(true);
  });

  it('activates role=button elements with the keyboard', () => {
    const tab = main.querySelector<HTMLElement>('[data-action="switchSeason"][data-season="2"]')!;
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(getState().currentSeason).toBe(2);
  });

  it('keeps the tag modal open on a duplicate tag and closes it on success', async () => {
    click('[data-action="addTag"]');
    await vi.advanceTimersByTimeAsync(60);
    const input = document.getElementById('tagInput') as HTMLInputElement;
    input.value = 'Rewatch';
    modalButton('Aggiungi').click();
    expect(show().tags).toEqual(['Rewatch']);
    expect(document.getElementById('modal')!.getAttribute('aria-hidden')).toBe('true');

    rerender();
    click('[data-action="addTag"]');
    await vi.advanceTimersByTimeAsync(60);
    (document.getElementById('tagInput') as HTMLInputElement).value = 'rewatch';
    modalButton('Aggiungi').click();
    expect(show().tags).toEqual(['Rewatch']);
    expect(document.getElementById('modal')!.getAttribute('aria-hidden')).toBe('false');
  });

  it('shows the existing note in the editor and clears it when saved empty', async () => {
    show().seasons[1][0].note = 'vecchia';
    rerender();
    expect(main.querySelector('.episode-note-preview')?.textContent).toBe('vecchia');
    click('[data-action="editNote"][data-ep="1"]');
    await vi.advanceTimersByTimeAsync(60);
    const ta = document.getElementById('noteTextarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('vecchia');
    ta.value = '   ';
    modalButton('Salva').click();
    expect(show().seasons[1][0].note).toBeUndefined();
  });
});
