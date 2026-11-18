// Pulsanti Esporta/Importa: casi limite dell'interfaccia.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const showToast = vi.fn();
vi.mock('../src/components/toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

function setupDom(): void {
  document.body.innerHTML = `
    <button id="exportBtn"></button><button id="importBtn"></button><input type="file" id="importFile" />
    <div id="modal" aria-hidden="true"><div class="modal" tabindex="-1">
      <div id="modalTitle"></div><div id="modalBody"></div><div id="modalActions"></div>
    </div></div>`;
}

async function load() {
  vi.resetModules();
  const mod = await import('../src/components/exportImport');
  mod.initExportImport();
  (await import('../src/components/modal')).initModal();
}

async function importText(text: string): Promise<void> {
  const input = document.getElementById('importFile') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File([text], 'b.json')], configurable: true });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() =>
    expect(showToast.mock.calls.length + (document.getElementById('modalTitle')!.textContent ? 1 : 0)).toBeGreaterThan(
      0,
    ),
  );
}

beforeEach(() => {
  setupDom();
  showToast.mockReset();
  localStorage.clear();
});

describe('export/import buttons', () => {
  it('reports when the browser cannot export (no URL.createObjectURL)', async () => {
    const original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true, writable: true });
    try {
      await load();
      document.getElementById('exportBtn')!.click();
      expect(showToast).toHaveBeenCalledWith('Esportazione non supportata da questo browser', 'error');
    } finally {
      if (original) Object.defineProperty(URL, 'createObjectURL', original);
    }
  });

  it('reports a failure while creating the download', async () => {
    URL.createObjectURL = vi.fn(() => {
      throw new Error('blocked');
    });
    await load();
    document.getElementById('exportBtn')!.click();
    // Nessuna serie: conferma l'export vuoto.
    (
      Array.from(document.querySelectorAll('#modalActions button')).find(
        (b) => b.textContent === 'Esporta comunque',
      ) as HTMLButtonElement
    ).click();
    expect(showToast).toHaveBeenCalledWith('Errore esportazione: blocked', 'error');
  });

  it('"Importa" opens the file picker', async () => {
    await load();
    const input = document.getElementById('importFile') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    document.getElementById('importBtn')!.click();
    expect(click).toHaveBeenCalled();
  });

  it.each([
    ['not json', /^File JSON non valido/],
    ['[]', /^Formato non valido: il file deve contenere un oggetto JSON/],
    ['{"version":99,"shows":[]}', /versione più recente/],
    ['{"version":"x","shows":[]}', /versione schema non valida/],
    ['{"shows":{}}', /"shows" deve essere un array/],
    ['{"version":2,"shows":[{"id":0}]}', /^Nessuna serie valida nel file$/],
  ])('rejects %s with a specific message', async (text, message) => {
    await load();
    await importText(text);
    expect(showToast.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([expect.stringMatching(message)]));
  });
});
