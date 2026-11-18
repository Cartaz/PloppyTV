// Contratto di sicurezza del rendering: qualsiasi testo (dati TVMaze, note,
// tag, nomi) arriva nel DOM come testo, mai come markup eseguibile. Gli
// oggetti Show sono costruiti a mano, senza passare da normalizeShow, per
// simulare il caso peggiore (backup manomesso o dati legacy).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type * as ApiModule from '../src/lib/api';
import type { Show } from '../src/types';

vi.mock('../src/components/modal', () => ({
  showModal: vi.fn(),
  closeModal: vi.fn(),
  closeAllModals: vi.fn(),
  initModal: vi.fn(),
  isModalOpen: vi.fn(() => false),
}));
vi.mock('../src/components/toast', () => ({ showToast: vi.fn() }));
vi.mock('../src/lib/storage', () => ({
  saveData: vi.fn(() => true),
  isStorageOK: vi.fn(() => true),
  loadData: vi.fn(),
}));
const searchShows = vi.fn();
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  searchShows: (...args: unknown[]) => searchShows(...args),
  getShowEpisodes: vi.fn(async () => []),
  ApiError: class ApiError extends Error {},
}));

import { setShows, setState } from '../src/lib/store';
import { renderDashboard } from '../src/views/dashboard';
import { renderShowDetail } from '../src/views/showDetail';
import { renderShowList } from '../src/views/showList';
import { renderLibrary } from '../src/views/library';
import { initSearch } from '../src/components/search';

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  "' onmouseover='alert(1)",
  '<a href="javascript:alert(1)">x</a>',
];
const EVIL = PAYLOADS.join(' ');

function hostileShow(): Show {
  return {
    id: 1,
    name: EVIL,
    image: null,
    status: EVIL,
    premiered: '2024-01-01',
    genres: [EVIL],
    summary: EVIL,
    network: EVIL,
    runtime: 45,
    list: 'watching',
    manualList: false,
    seasons: {
      1: [
        { num: 1, id: 11, watched: true, airdate: '2024-01-01', name: EVIL, runtime: 45, note: EVIL, rating: 5 },
        { num: 2, id: 12, watched: false, airdate: '2024-01-08', name: EVIL, runtime: 45 },
      ],
    },
    totalSeasons: 1,
    totalEpisodes: 2,
    addedAt: 1,
    tags: [EVIL, PAYLOADS[3]],
  };
}

function assertNoExecutableMarkup(root: ParentNode): void {
  expect(root.querySelectorAll('script, iframe, object, embed').length).toBe(0);
  // Le icone SVG dell'app non hanno attributi on*: il controllo sotto copre
  // anche un <svg onload> iniettato.
  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name, `<${el.tagName.toLowerCase()} ${attr.name}>`).not.toMatch(/^on/i);
      if (attr.name === 'href' || attr.name === 'src') expect(attr.value).not.toMatch(/^\s*javascript:/i);
    }
  }
}

let main: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `
    <main id="mainContent"></main>
    <div class="search-wrap"><input id="searchInput" type="text" /><div id="searchResults"></div></div>
    <div id="toast"></div>`;
  main = document.getElementById('mainContent')!;
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  setShows([hostileShow()]);
  setState({ currentShowId: null, currentSeason: 1, currentView: 'dashboard' });
});

describe('hostile text is rendered inert', () => {
  it('dashboard', () => {
    renderDashboard(main);
    assertNoExecutableMarkup(main);
    expect(main.textContent).toContain('<script>alert(1)</script>');
  });

  it('show detail (name, summary, genres, episode names, notes, tags)', () => {
    setState({ currentShowId: 1 });
    renderShowDetail(main);
    assertNoExecutableMarkup(main);
    // Note e tag sono testo dell'utente: visibili così come scritti.
    expect(main.querySelector('.episode-note-preview')?.textContent).toBe(EVIL);
    expect(main.querySelector('.user-tag')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(main.querySelector('[data-action="removeTag"]')?.getAttribute('data-tag')).toBe(EVIL);
  });

  it('show list with tag filter chips', () => {
    renderShowList(main, 'watching', 'In corso');
    assertNoExecutableMarkup(main);
    const chipTags = Array.from(main.querySelectorAll<HTMLElement>('.tag-filter-chip')).map((c) => c.dataset.tag);
    expect(chipTags).toContain(EVIL);
    expect(chipTags).toContain(PAYLOADS[3]);
  });

  it('library with filters', () => {
    renderLibrary(main);
    assertNoExecutableMarkup(main);
  });

  it('search results and the "no results" message', async () => {
    vi.useFakeTimers();
    initSearch();
    const input = document.getElementById('searchInput') as HTMLInputElement;
    const results = document.getElementById('searchResults')!;

    searchShows.mockResolvedValue([
      { score: 1, show: { id: 2, name: EVIL, image: null, network: { name: EVIL }, premiered: '2024-01-01' } },
    ]);
    input.value = 'evil';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(400);
    assertNoExecutableMarkup(results);
    expect(results.querySelector('.search-result-name')?.textContent).toBe(EVIL);

    searchShows.mockResolvedValue([]);
    input.value = '<img src=x onerror=alert(1)>';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(1000);
    assertNoExecutableMarkup(results);
    expect(results.textContent).toContain('<img src=x onerror=alert(1)>');
    vi.useRealTimers();
  });
});
