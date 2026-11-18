// Flusso utente completo con i moduli reali (store, storage su localStorage
// jsdom, normalize, shows, modal, export/import). L'unica dipendenza finta è
// la rete: fetch risponde come TVMaze.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { STORAGE_KEY } from '../src/lib/constants';

const EPISODES = [
  { id: 101, season: 1, number: 1, name: 'Pilot', airdate: '2024-01-01', runtime: 45 },
  { id: 102, season: 1, number: 2, name: 'Second', airdate: '2024-01-08', runtime: 45 },
  { id: 201, season: 2, number: 1, name: 'Return', airdate: '2025-01-01', runtime: 50 },
];
const TVMAZE_SHOW = {
  id: 7,
  name: 'Flow Show',
  status: 'Running',
  premiered: '2024-01-01',
  genres: ['Drama'],
  summary: '<p>Una serie</p>',
  runtime: 45,
  image: { medium: 'https://static.tvmaze.com/uploads/images/medium_portrait/1/1.jpg' },
  network: { name: 'Net' },
};

function setupDom(): void {
  document.body.innerHTML = `
    <button id="exportBtn"></button><button id="importBtn"></button>
    <input type="file" id="importFile" />
    <main id="mainContent"></main>
    <div id="modal" aria-hidden="true"><div class="modal" tabindex="-1">
      <div id="modalTitle"></div><div id="modalBody"></div><div id="modalActions"></div>
    </div></div>
    <div id="toast"></div>
    <span id="badge-watching"></span><span id="badge-towatch"></span><span id="badge-completed"></span>`;
}

async function freshApp() {
  vi.resetModules();
  const store = await import('../src/lib/store');
  const storage = await import('../src/lib/storage');
  const shows = await import('../src/lib/shows');
  const modal = await import('../src/components/modal');
  const exportImport = await import('../src/components/exportImport');
  modal.initModal();
  exportImport.initExportImport();
  storage.loadData();
  return { store, storage, shows, modal };
}

function clickModalAction(label: string): void {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('#modalActions button')).find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error('modal action not found: ' + label);
  btn.click();
}

beforeEach(() => {
  localStorage.clear();
  setupDom();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(EPISODES), { status: 200 })),
  );
});

let exported = '';

beforeEach(() => {
  // jsdom non implementa createObjectURL: exportImport lo rileva al caricamento.
  exported = '';
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const reader = new FileReader();
    reader.onload = () => (exported = String(reader.result));
    reader.readAsText(blob);
    return 'blob:backup';
  });
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

describe('user flow: track → reload → export → import', () => {
  it('keeps progress, ratings, notes and tags across reload and a backup round-trip', async () => {
    // 1. Aggiungi la serie e registra i progressi.
    let app = await freshApp();
    const added = await app.shows.addShowToList(TVMAZE_SHOW, 'watching');
    expect(added?.totalEpisodes).toBe(3);
    app.shows.toggleEpisode(7, 1, 1);
    app.shows.setEpisodeRating(7, 1, 1, 5);
    expect(app.shows.setEpisodeNote(7, 1, 1, 'Da rivedere: 2 < 3 & co')).toBe(true);
    expect(app.shows.addShowTag(7, 'Rewatch <3')).toBe(true);

    // 2. "Ricarica": moduli nuovi, stato letto da localStorage.
    app = await freshApp();
    const reloaded = app.store.getState().shows[0];
    expect(reloaded.list).toBe('watching');
    expect(reloaded.seasons[1][0]).toMatchObject({ watched: true, rating: 5, note: 'Da rivedere: 2 < 3 & co' });
    expect(reloaded.tags).toEqual(['Rewatch <3']);

    // 3. Esporta il backup.
    document.getElementById('exportBtn')!.click();
    await vi.waitFor(() => expect(exported).not.toBe(''));

    // 4. Perdita dei dati locali, poi import con "Sostituisci tutto".
    localStorage.removeItem(STORAGE_KEY);
    app = await freshApp();
    expect(app.store.getState().shows).toEqual([]);

    const input = document.getElementById('importFile') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File([exported], 'backup.json', { type: 'application/json' })],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.getElementById('modalTitle')!.textContent).toBe('Importa backup'));
    clickModalAction('Sostituisci tutto');
    clickModalAction('Sì, sostituisci tutto');

    // 5. Ricarica di nuovo: i dati ripristinati sono persistiti.
    app = await freshApp();
    const restored = app.store.getState().shows[0];
    expect(restored.name).toBe('Flow Show');
    expect(restored.seasons[1][0]).toMatchObject({ watched: true, rating: 5, note: 'Da rivedere: 2 < 3 & co' });
    expect(restored.tags).toEqual(['Rewatch <3']);
  });

  it('marks a show completed when the last episode is watched and survives reload', async () => {
    let app = await freshApp();
    await app.shows.addShowToList(TVMAZE_SHOW, 'watching');
    app.shows.markSeasonWatched(7, 1, true);
    app.shows.markSeasonWatched(7, 2, true);
    expect(app.store.getState().shows[0].list).toBe('completed');

    app = await freshApp();
    expect(app.store.getState().shows[0].list).toBe('completed');
  });
});
