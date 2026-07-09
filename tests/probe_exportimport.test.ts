// Agent 11 — probe tests for src/components/exportImport.ts (FIXED versions)
// Covers: BOM detection (UTF-8/UTF-16 LE/BE), JSON parse errors, dedup,
// merge (smart, field-level), replace, rollback, export, version validation,
// size limit, modal flow, Italian grammar, input.value reset.
//
// Strategy: mock storage.saveData (controllable success/failure) + toast.showToast
// (capture calls). Use REAL store/normalize/modal/header so merge/replace logic
// runs against actual state. Mock globalThis.FileReader to control decoded bytes.
//
// FIXES APPLIED (per agent-11-exportimport.md):
//  - H12/BUG-11-01/BUG-11-04: merge is now field-level (preserve addedAt, image,
//    name, etc.) and calls updateShowListStatus to reconcile list.
//  - BUG-11-02: readAsArrayBuffer + BOM detection (UTF-8/UTF-16 LE/BE).
//  - BUG-11-03: data.version validated (warning toast on missing/future).
//  - BUG-11-05: replace flow still calls reconcileAllLists (now respects
//    manualList — fixed in normalize.ts by agent 02). Cross-cutting test
//    updated to assert the FIXED behavior.
//  - BUG-11-06: Italian singular/plural.
//  - BUG-11-08: minified JSON export.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Buffer } from 'buffer';
import type { Episode, Show } from '../src/types';
import { getState, setShows } from '../src/lib/store';
import { initModal, closeAllModals, isModalOpen } from '../src/components/modal';

// ===== Polyfill URL.createObjectURL/revokeObjectURL BEFORE exportImport.ts
// is imported (SUPPORTS_EXPORT is evaluated at module-load time). vi.hoisted
// runs before ESM imports, so the polyfill is in place when the module loads.
vi.hoisted(() => {
  const g = globalThis as { URL?: typeof URL };
  if (g.URL && !g.URL.createObjectURL) {
    g.URL.createObjectURL = (() => 'blob:fake-url') as typeof URL.createObjectURL;
  }
  if (g.URL && !g.URL.revokeObjectURL) {
    g.URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  }
});

// ===== Mocks =====
const saveDataMock = vi.fn((_opts?: { immediate?: boolean }) => true);
vi.mock('../src/lib/storage', () => ({
  saveData: (opts?: { immediate?: boolean }) => saveDataMock(opts),
  isStorageOK: () => true,
}));

const showToastMock = vi.fn();
vi.mock('../src/components/toast', () => ({
  showToast: (msg: string, type?: string) => showToastMock(msg, type),
}));

import { initExportImport } from '../src/components/exportImport';
import { MAX_IMPORT_SIZE } from '../src/lib/constants';

// ===== DOM setup (mirrors index.html relevant elements) =====
const APP_HTML = `
<button id="exportBtn">Export</button>
<button id="importBtn">Import</button>
<input type="file" id="importFile" accept=".json,application/json" />
<div class="modal-overlay" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" aria-hidden="true">
  <div class="modal" tabindex="-1">
    <div class="modal-title" id="modalTitle"></div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-actions" id="modalActions"></div>
  </div>
</div>
<span id="badge-watching">0</span>
<span id="badge-towatch">0</span>
<span id="badge-completed">0</span>
<div id="toast"></div>
`;

// ===== Mock FileReader =====
// Stores `_content` (string) or `_bytes` (ArrayBuffer) on the File and returns
// them synchronously. readAsArrayBuffer encodes string content as UTF-8 bytes
// (TextEncoder); pre-encoded raw bytes are returned verbatim.
class MockFileReader {
  onload: ((ev: { target: { result: ArrayBuffer | string | null } | null }) => void) | null = null;
  onerror: (() => void) | null = null;
  result: ArrayBuffer | string | null = null;
  readAsText(file: File & { _content?: string }, _encoding?: string): void {
    const content = (file as { _content?: string })._content ?? '';
    this.result = content;
    if (this.onload) {
      this.onload({ target: { result: this.result } });
    }
  }
  readAsArrayBuffer(file: File & { _content?: string; _bytes?: ArrayBuffer }): void {
    const f = file as { _content?: string; _bytes?: ArrayBuffer };
    if (f._bytes) {
      this.result = f._bytes;
    } else {
      const content = f._content ?? '';
      this.result = new TextEncoder().encode(content).buffer as ArrayBuffer;
    }
    if (this.onload) {
      this.onload({ target: { result: this.result } });
    }
  }
}

// ===== Helpers =====
function makeFile(content: string, sizeOverride?: number): File {
  const file = new File([content], 'test.json', { type: 'application/json' }) as File & { _content: string };
  (file as { _content: string })._content = content;
  if (sizeOverride !== undefined) {
    Object.defineProperty(file, 'size', { value: sizeOverride, configurable: true });
  }
  return file;
}

/** Build a File from raw bytes (for UTF-16 / pre-encoded content). */
function makeRawFile(bytes: Uint8Array, sizeOverride?: number): File {
  // Copy bytes into a standalone ArrayBuffer (in case `bytes` is a view).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const file = new File([ab], 'test.json', { type: 'application/json' }) as File & { _bytes: ArrayBuffer };
  (file as { _bytes: ArrayBuffer })._bytes = ab;
  if (sizeOverride !== undefined) {
    Object.defineProperty(file, 'size', { value: sizeOverride, configurable: true });
  }
  return file;
}

function makeShow(over: Partial<Show> = {}): Show {
  return {
    id: 1,
    name: 'Test Show',
    image: null,
    status: 'Running',
    premiered: '2024-01-01',
    genres: ['Drama'],
    summary: '',
    network: 'N/D',
    runtime: 45,
    list: 'towatch',
    manualList: false,
    seasons: {},
    totalSeasons: 0,
    totalEpisodes: 0,
    addedAt: 1700000000000,
    ...over,
  };
}

/** Episode literal helper (airdate/runtime required by type but irrelevant for merge tests). */
function ep(num: number, watched: boolean, id?: number): Episode {
  return { num, id: id ?? num, watched, airdate: null, name: null, runtime: null };
}

function setFile(file: File): void {
  const input = document.getElementById('importFile') as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function modalButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('#modalActions button'));
}

function modalTitle(): string {
  return document.getElementById('modalTitle')!.textContent || '';
}

function modalBody(): string {
  return document.getElementById('modalBody')!.innerHTML || '';
}

function clickButton(label: string): void {
  const btn = modalButtons().find((b) => b.textContent === label);
  if (!btn) {
    throw new Error(
      `Button "${label}" not found. Available: [${modalButtons().map((b) => b.textContent).join(', ')}]`,
    );
  }
  btn.click();
}

/** Capture the first Blob constructor argument's string content by
 *  temporarily wrapping globalThis.Blob. jsdom Blob lacks .text()/.arrayBuffer(),
 *  so we intercept the constructor to grab the parts array. */
function captureBlobContent(fn: () => void): string {
  const realBlob = globalThis.Blob;
  let captured = '';
  class CapturingBlob extends realBlob {
    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      captured = parts.length > 0 ? String(parts[0]) : '';
    }
  }
  (globalThis as { Blob: typeof Blob }).Blob = CapturingBlob as unknown as typeof Blob;
  try {
    fn();
  } finally {
    (globalThis as { Blob: typeof Blob }).Blob = realBlob;
  }
  return captured;
}

function lastToast(): { msg: string; type?: string } | null {
  const calls = showToastMock.mock.calls;
  if (calls.length === 0) return null;
  return {
    msg: calls[calls.length - 1][0] as string,
    type: calls[calls.length - 1][1] as string | undefined,
  };
}

// ===== Setup =====
beforeAll(() => {
  document.body.innerHTML = APP_HTML;
  (globalThis as { FileReader: typeof FileReader }).FileReader =
    MockFileReader as unknown as typeof FileReader;
  initModal();
  initExportImport();
});

beforeEach(() => {
  closeAllModals();
  // Clear stale modal DOM content (closeAllModals does not clear title/body).
  document.getElementById('modalTitle')!.textContent = '';
  document.getElementById('modalBody')!.innerHTML = '';
  document.getElementById('modalActions')!.innerHTML = '';
  setShows([]);
  saveDataMock.mockReturnValue(true);
  saveDataMock.mockClear();
  showToastMock.mockClear();
});

// =====================================================================
// BUG-11-01 (FIXED): BOM detection now handles UTF-8 (with/without BOM),
// UTF-16 LE (BOM FF FE), and UTF-16 BE (BOM FE FF). Previously only UTF-8
// BOM was stripped and readAsText(file,'utf-8') mangled UTF-16 files.
// =====================================================================
describe('BUG-11-01: BOM detection (UTF-8/UTF-16 LE/BE) — FIXED', () => {
  it('UTF-8 BOM (\\uFEFF) is stripped, JSON parses (empty shows → toast)', () => {
    const json = '{"shows":[]}';
    setFile(makeFile('\uFEFF' + json));
    // dedupedShows.length === 0 → "Nessuna serie valida" toast
    expect(lastToast()?.msg).toBe('Nessuna serie valida nel file');
  });

  it('UTF-16 LE file (BOM FF FE) → detected and decoded, JSON parses', () => {
    const json = '{"version":1,"shows":[],"exportedAt":"2024-01-01"}';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]);
    setFile(makeRawFile(bytes));
    // JSON parsed successfully → "Nessuna serie valida" toast (empty shows)
    expect(lastToast()?.msg).toBe('Nessuna serie valida nel file');
  });

  it('UTF-16 BE file (BOM FE FF) → detected and decoded, JSON parses', () => {
    const json = '{"version":1,"shows":[],"exportedAt":"2024-01-01"}';
    // Build UTF-16 BE bytes (swap LE pairs).
    const le = Buffer.from(json, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    setFile(makeRawFile(bytes));
    expect(lastToast()?.msg).toBe('Nessuna serie valida nel file');
  });

  it('UTF-16 LE file with valid show → import modal opens', () => {
    const backup = { version: 1, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    const json = JSON.stringify(backup);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]);
    setFile(makeRawFile(bytes));
    expect(modalTitle()).toBe('Importa backup');
  });

  it('text without BOM parses normally', () => {
    setFile(makeFile('{"shows":[]}'));
    expect(lastToast()?.msg).toBe('Nessuna serie valida nel file');
  });

  it('UTF-8 BOM + valid show → import modal opens', () => {
    const backup = { version: 1, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile('\uFEFF' + JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
  });
});

// =====================================================================
// BUG-11-02 (FIXED): data.version is now validated. Missing version (or
// non-number) → warning toast; future version → warning toast. Import
// still proceeds best-effort (modal still opens).
// =====================================================================
describe('BUG-11-02: Version validation — FIXED', () => {
  it('data.version = 99 (future) → warning toast about future version, modal still opens', () => {
    const backup = { version: 99, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
    expect(modalBody()).toContain('1 serie valide');
    const t = lastToast();
    expect(t).not.toBeNull();
    expect(t!.msg).toContain('versione futura');
    expect(t!.msg).toContain('99');
    expect(t!.type).toBe('warning');
  });

  it('data.version missing (undefined) → warning toast about missing schema version', () => {
    const backup = { shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
    const t = lastToast();
    expect(t).not.toBeNull();
    expect(t!.msg).toContain('senza versione schema');
    expect(t!.type).toBe('warning');
  });

  it('data.version = "v2" (string, not number) → warning toast about missing schema version', () => {
    const backup = { version: 'v2', shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
    const t = lastToast();
    expect(t).not.toBeNull();
    expect(t!.msg).toContain('senza versione schema');
    expect(t!.type).toBe('warning');
  });

  it('data.version = 1 (current) → no version warning toast', () => {
    const backup = { version: 1, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalTitle()).toBe('Importa backup');
    expect(lastToast()).toBeNull();
  });
});

// =====================================================================
// BUG-11-03 (FIXED): Merge is now field-level. When newWatched >
// existingWatched, the backup's seasons/totalEpisodes/totalSeasons/list/
// manualList are adopted, but the user's local addedAt/image/name/status/
// premiered/genres/summary/network/runtime are PRESERVED.
// =====================================================================
describe('BUG-11-03: merge is field-level (preserves user metadata) — FIXED', () => {
  it('PRESERVES existing.addedAt (backup.addedAt ignored)', () => {
    setShows([makeShow({ id: 1, addedAt: 1000, seasons: { 1: [ep(1, false, 1)] }, totalEpisodes: 1 })]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1, addedAt: 9999, seasons: { 1: [ep(1, true, 1)] }, totalEpisodes: 1 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    // addedAt preserved (was 1000; previously overwritten to 9999).
    expect(getState().shows[0].addedAt).toBe(1000);
  });

  it('PRESERVES existing.image (backup.image=null does not lose local poster)', () => {
    setShows([
      makeShow({
        id: 1,
        image: 'https://example.com/a.jpg',
        seasons: { 1: [ep(1, false, 1)] },
        totalEpisodes: 1,
      }),
    ]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1, image: null, seasons: { 1: [ep(1, true, 1)] }, totalEpisodes: 1 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    // image preserved (was 'https://example.com/a.jpg'; previously lost to null).
    expect(getState().shows[0].image).toBe('https://example.com/a.jpg');
  });

  it('PRESERVES existing.name (local metadata fresher)', () => {
    setShows([
      makeShow({ id: 1, name: 'My Local Name', seasons: { 1: [ep(1, false, 1)] }, totalEpisodes: 1 }),
    ]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1, name: 'Backup Name', seasons: { 1: [ep(1, true, 1)] }, totalEpisodes: 1 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    // name preserved (was 'My Local Name'; previously overwritten to 'Backup Name').
    expect(getState().shows[0].name).toBe('My Local Name');
  });

  it('ADOPTS backup.seasons (more watched progress) when newWatched > existingWatched', () => {
    const localSeasons = { 1: [ep(1, false, 1)] };
    setShows([makeShow({ id: 1, seasons: localSeasons, totalEpisodes: 1 })]);
    const backupSeasons = { 1: [ep(1, true, 1)] };
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1, seasons: backupSeasons, totalEpisodes: 1 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    const s = getState().shows[0];
    expect(s.seasons).not.toBe(localSeasons);
    expect(s.seasons[1][0].watched).toBe(true);
  });

  it('does NOT merge when newWatched === existingWatched (keeps existing entirely)', () => {
    setShows([makeShow({ id: 1, name: 'Local', addedAt: 1000, seasons: { 1: [ep(1, true, 1)] }, totalEpisodes: 1 })]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1, name: 'Backup', addedAt: 9999, seasons: { 1: [ep(1, true, 1)] }, totalEpisodes: 1 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    // Equal watched → no merge → existing kept
    expect(getState().shows[0].name).toBe('Local');
    expect(getState().shows[0].addedAt).toBe(1000);
  });

  it('does NOT merge when newWatched < existingWatched (keeps existing)', () => {
    setShows([makeShow({ id: 1, name: 'Local', seasons: { 1: [ep(1, true, 1), ep(2, true, 2)] }, totalEpisodes: 2 })]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1, name: 'Backup', seasons: { 1: [ep(1, true, 1)] }, totalEpisodes: 2 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    expect(getState().shows[0].name).toBe('Local');
  });
});

// =====================================================================
// BUG-11-04 (FIXED): Merge now calls updateShowListStatus to reconcile
// list with the new watched count. E.g. all-watched-but-towatch is
// auto-promoted to 'completed'; some-watched-but-towatch becomes 'watching'.
// =====================================================================
describe('BUG-11-04: merge reconciles list status — FIXED', () => {
  it('all episodes watched after merge → list becomes "completed" (was "towatch")', () => {
    setShows([
      makeShow({ id: 1, list: 'towatch', seasons: { 1: [ep(1, false, 1), ep(2, false, 2)] }, totalEpisodes: 2 }),
    ]);
    const backup = {
      version: 1,
      shows: [
        makeShow({ id: 1, list: 'towatch', seasons: { 1: [ep(1, true, 1), ep(2, true, 2)] }, totalEpisodes: 2 }),
      ],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    const s = getState().shows[0];
    const watchedCount = Object.values(s.seasons).flat().filter((e) => e.watched).length;
    expect(watchedCount).toBe(2);
    expect(s.totalEpisodes).toBe(2);
    // FIXED: watched === totalEpisodes → list reconciled to 'completed'
    expect(s.list).toBe('completed');
  });

  it('some watched after merge → list becomes "watching" (was "towatch")', () => {
    setShows([
      makeShow({ id: 1, list: 'towatch', seasons: { 1: [ep(1, false, 1), ep(2, false, 2)] }, totalEpisodes: 2 }),
    ]);
    const backup = {
      version: 1,
      shows: [
        makeShow({ id: 1, list: 'towatch', seasons: { 1: [ep(1, true, 1), ep(2, false, 2)] }, totalEpisodes: 2 }),
      ],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    const s = getState().shows[0];
    const watchedCount = Object.values(s.seasons).flat().filter((e) => e.watched).length;
    expect(watchedCount).toBe(1);
    // FIXED: watched > 0 but not all → list reconciled to 'watching'
    expect(s.list).toBe('watching');
  });
});

// =====================================================================
// Merge replaces seasons wholesale when newWatched > existingWatched —
// this is intentional (the backup is "ahead" so we adopt its progress).
// Previously the implementation used Object.assign (which also clobbered
// addedAt/image/name); the field-level merge now ONLY replaces seasons/
// totalEpisodes/totalSeasons/list/manualList, preserving other metadata.
// =====================================================================
describe('merge: seasons replaced when backup is ahead (intentional)', () => {
  it('user local seasons (partially watched) replaced by backup seasons (fully watched)', () => {
    const localSeasons = { 1: [ep(1, true, 1), ep(2, false, 2)] };
    setShows([makeShow({ id: 1, seasons: localSeasons, totalEpisodes: 2 })]);
    const backupSeasons = { 1: [ep(1, true, 1), ep(2, true, 2)] };
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1, seasons: backupSeasons, totalEpisodes: 2 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    const s = getState().shows[0];
    expect(s.seasons).not.toBe(localSeasons);
    expect(s.seasons[1].every((e) => e.watched)).toBe(true);
  });
});

// =====================================================================
// Merge: basic flows (new show push, rollback on saveData failure).
// =====================================================================
describe('merge: basic flows', () => {
  it('new show (not in state) is pushed, added count = 1', () => {
    setShows([makeShow({ id: 1 })]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 2, name: 'New Show' })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    expect(getState().shows).toHaveLength(2);
    expect(getState().shows.map((s) => s.id).sort()).toEqual([1, 2]);
    expect(saveDataMock).toHaveBeenCalledWith({ immediate: true });
    // BUG-11-06 fix: singular feminine "Importata 1 nuova"
    expect(lastToast()?.msg).toContain('Importata 1 nuova');
  });

  it('saveData fails → rollback to pre-merge state, toast shown', () => {
    const original = makeShow({ id: 1, list: 'towatch', seasons: { 1: [ep(1, false, 1)] }, totalEpisodes: 1 });
    setShows([original]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 2, name: 'New' })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    saveDataMock.mockReturnValue(false);
    clickButton('Unisci (smart)');
    // Rolled back
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].id).toBe(1);
    expect(getState().shows[0].list).toBe('towatch');
    expect(lastToast()?.msg).toContain('Import annullato');
    expect(lastToast()?.type).toBe('error');
  });

  it('merge with no existing shows: all backup shows pushed', () => {
    setShows([]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1 }), makeShow({ id: 2 }), makeShow({ id: 3 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    expect(getState().shows).toHaveLength(3);
  });

  it('merge success toast uses plural for added=2', () => {
    setShows([]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1 }), makeShow({ id: 2 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    expect(lastToast()?.msg).toContain('Importate 2 nuove');
  });
});

// =====================================================================
// Replace flow: dedupedShows replace state.shows, reconcileAllLists
// called, closeAllModals on success, rollback on failure.
// =====================================================================
describe('replace flow', () => {
  it('replaces all shows with backup, closes all modals on success', () => {
    setShows([makeShow({ id: 1, list: 'towatch' })]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 10 }), makeShow({ id: 20 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Sostituisci tutto');
    // Nested confirm appears
    expect(modalTitle()).toBe('Conferma sostituzione');
    expect(modalBody()).toContain('1 serie attuali');
    expect(modalBody()).toContain('2 del backup');
    clickButton('Sì, sostituisci tutto');
    // Replaced
    expect(getState().shows).toHaveLength(2);
    expect(getState().shows.map((s) => s.id).sort()).toEqual([10, 20]);
    // All modals closed
    expect(isModalOpen()).toBe(false);
    expect(lastToast()?.msg).toBe('Backup importato (sostituzione)');
    expect(lastToast()?.type).toBe('success');
  });

  it('saveData fails → rollback to pre-replace state, nested confirm closes, parent stays', () => {
    setShows([makeShow({ id: 1, list: 'towatch' })]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 10 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    saveDataMock.mockReturnValue(false);
    clickButton('Sostituisci tutto');
    clickButton('Sì, sostituisci tutto');
    // Rolled back
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].id).toBe(1);
    expect(lastToast()?.msg).toContain('Import annullato');
  });

  it('replace calls reconcileAllLists on dedupedShows (mutates list based on watched)', () => {
    setShows([makeShow({ id: 1 })]);
    // Backup show: list='towatch' but all episodes watched → reconcile sets 'completed'
    const backup = {
      version: 1,
      shows: [
        makeShow({
          id: 10,
          list: 'towatch',
          seasons: { 1: [ep(1, true, 1), ep(2, true, 2)] },
          totalEpisodes: 2,
        }),
      ],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Sostituisci tutto');
    clickButton('Sì, sostituisci tutto');
    expect(getState().shows[0].list).toBe('completed');
  });

  it('replace confirm modal "Annulla" returns to parent import modal', () => {
    setShows([makeShow({ id: 1 })]);
    const backup = { version: 1, shows: [makeShow({ id: 10 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Sostituisci tutto');
    expect(modalTitle()).toBe('Conferma sostituzione');
    clickButton('Annulla');
    // Parent import modal still open
    expect(modalTitle()).toBe('Importa backup');
    expect(isModalOpen()).toBe(true);
    // State unchanged
    expect(getState().shows[0].id).toBe(1);
  });
});

// =====================================================================
// BUG-11-06 (cross-cutting, FIXED by agent 02 in normalize.ts):
// replace flow's reconcileAllLists now RESPECTS manualList. A backup show
// with manualList=true, list='completed', 0 watched keeps its 'completed'
// list placement (previously downgraded to 'towatch').
// =====================================================================
describe('BUG-11-06: replace reconcileAllLists respects manualList — FIXED (agent 02)', () => {
  it('backup show with manualList=true, list="completed", 0 watched → list preserved as "completed"', () => {
    setShows([makeShow({ id: 1 })]);
    const backup = {
      version: 1,
      shows: [
        makeShow({
          id: 10,
          list: 'completed',
          manualList: true,
          seasons: {},
          totalEpisodes: 0,
        }),
      ],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Sostituisci tutto');
    clickButton('Sì, sostituisci tutto');
    // FIXED: reconcileAllLists respects manualList — manual "completed" placement preserved
    expect(getState().shows[0].list).toBe('completed');
    expect(getState().shows[0].manualList).toBe(true);
  });
});

// =====================================================================
// Dedup logic: by id, duplicates counted, invalid shows filtered.
// =====================================================================
describe('dedup logic', () => {
  it('duplicate ids within backup are deduped (first wins)', () => {
    setShows([]);
    const backup = {
      version: 1,
      shows: [
        makeShow({ id: 1, name: 'First' }),
        makeShow({ id: 1, name: 'Second' }), // duplicate id
      ],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalBody()).toContain('1 serie valide');
    // BUG-11-06 fix: singular masculine "1 duplicato saltato"
    expect(modalBody()).toContain('1 duplicato saltato');
    clickButton('Unisci (smart)');
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].name).toBe('First'); // first occurrence wins
  });

  it('invalid shows (normalizeShow returns null) are counted in skipped', () => {
    setShows([]);
    const backup = {
      version: 1,
      shows: [
        makeShow({ id: 1 }),
        { id: 'not-a-number' }, // invalid id → normalizeShow returns null
        null, // invalid
        { foo: 'bar' }, // no id
      ],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalBody()).toContain('1 serie valide');
    // 3 invalid → plural feminine "3 ignorate"
    expect(modalBody()).toContain('3 ignorate per dati non validi');
  });

  it('all invalid shows → "Nessuna serie valida" toast, no modal', () => {
    setShows([]);
    const backup = {
      version: 1,
      shows: [null, { foo: 'bar' }, { id: 0 }],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    expect(lastToast()?.msg).toBe('Nessuna serie valida nel file');
    expect(isModalOpen()).toBe(false);
  });

  it('empty shows array → "Nessuna serie valida" toast', () => {
    setShows([]);
    setFile(makeFile('{"version":1,"shows":[],"exportedAt":"2024-01-01"}'));
    expect(lastToast()?.msg).toBe('Nessuna serie valida nel file');
  });
});

// =====================================================================
// BUG-11-07 (FIXED): Italian grammar — singular/plural now handled
// correctly. "1 ignorata" (not "1 ignorate"), "1 duplicato saltato"
// (not "1 duplicati saltati"), "Importata 1 nuova" (not "Importate 1 nuove").
// =====================================================================
describe('BUG-11-07: Italian grammar (singular vs plural) — FIXED', () => {
  it('1 invalid show → "1 ignorata per dati non validi" (singular feminine)', () => {
    setShows([]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1 }), { invalid: true }],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalBody()).toContain('1 ignorata per dati non validi');
    expect(modalBody()).not.toContain('1 ignorate per dati non validi');
  });

  it('2 invalid shows → "2 ignorate per dati non validi" (plural feminine)', () => {
    setShows([]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1 }), { invalid: true }, { also: 'bad' }],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalBody()).toContain('2 ignorate per dati non validi');
  });

  it('1 duplicate → "1 duplicato saltato" (singular masculine)', () => {
    setShows([]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1 }), makeShow({ id: 1 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalBody()).toContain('1 duplicato saltato');
    expect(modalBody()).not.toContain('1 duplicati saltati');
  });

  it('2 duplicates → "2 duplicati saltati" (plural masculine)', () => {
    setShows([]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1 }), makeShow({ id: 1 }), makeShow({ id: 1 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    expect(modalBody()).toContain('2 duplicati saltati');
  });

  it('merge toast: "Importata 1 nuova, aggiornate 0 serie" (singular feminine)', () => {
    setShows([]);
    const backup = { version: 1, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Unisci (smart)');
    expect(lastToast()?.msg).toContain('Importata 1 nuova');
    expect(lastToast()?.msg).not.toContain('Importate 1 nuove');
  });
});

// =====================================================================
// Format validation: data null/non-object, data.shows not array.
// =====================================================================
describe('format validation', () => {
  it('data is null → "Formato non valido: il file deve contenere un oggetto JSON"', () => {
    setFile(makeFile('null'));
    expect(lastToast()?.msg).toBe('Formato non valido: il file deve contenere un oggetto JSON');
  });

  it('data is a number → invalid format', () => {
    setFile(makeFile('42'));
    expect(lastToast()?.msg).toBe('Formato non valido: il file deve contenere un oggetto JSON');
  });

  it('data is a string → invalid format', () => {
    setFile(makeFile('"hello"'));
    expect(lastToast()?.msg).toBe('Formato non valido: il file deve contenere un oggetto JSON');
  });

  it('data is an array (typeof object, but data.shows undefined) → shows not array', () => {
    setFile(makeFile('[1,2,3]'));
    expect(lastToast()?.msg).toContain('"shows" deve essere un array');
    expect(lastToast()?.msg).toContain('era undefined');
  });

  it('data.shows is null → "shows deve essere un array (era null)"', () => {
    setFile(makeFile('{"version":1,"shows":null}'));
    expect(lastToast()?.msg).toContain('"shows" deve essere un array');
    expect(lastToast()?.msg).toContain('era null');
  });

  it('data.shows is an object → "shows deve essere un array (era object)"', () => {
    setFile(makeFile('{"version":1,"shows":{"a":1}}'));
    expect(lastToast()?.msg).toContain('"shows" deve essere un array');
    expect(lastToast()?.msg).toContain('era object');
  });

  it('empty file → JSON.parse fails → "File JSON non valido"', () => {
    setFile(makeFile(''));
    expect(lastToast()?.msg).toContain('File JSON non valido');
  });

  it('non-JSON text → JSON.parse fails', () => {
    setFile(makeFile('this is not json {'));
    expect(lastToast()?.msg).toContain('File JSON non valido');
  });

  it('JSON parse error message no longer mentions UTF-16 (now handled)', () => {
    setFile(makeFile('this is not json {'));
    expect(lastToast()?.msg).not.toContain('UTF-16');
  });
});

// =====================================================================
// MAX_IMPORT_SIZE boundary check (file.size before read).
// =====================================================================
describe('MAX_IMPORT_SIZE boundary', () => {
  it('file.size === MAX_IMPORT_SIZE (10MB) → passes size check', () => {
    setFile(makeFile('{"shows":[]}', MAX_IMPORT_SIZE));
    // Passes size check → reads → empty shows → "Nessuna serie valida"
    expect(lastToast()?.msg).toBe('Nessuna serie valida nel file');
  });

  it('file.size === MAX_IMPORT_SIZE + 1 → rejected with "File troppo grande"', () => {
    setFile(makeFile('{"shows":[]}', MAX_IMPORT_SIZE + 1));
    expect(lastToast()?.msg).toContain('File troppo grande');
    expect(lastToast()?.msg).toContain('10MB');
    expect(lastToast()?.type).toBe('error');
  });

  it('toast message uses Math.round(MAX_IMPORT_SIZE / 1024 / 1024) = 10', () => {
    setFile(makeFile('x', MAX_IMPORT_SIZE + 1));
    expect(lastToast()?.msg).toBe('File troppo grande (max 10MB)');
  });
});

// =====================================================================
// BUG-11-08: input.value is cleared at end of change handler, BEFORE
// the import modal interaction. If user cancels the modal, the file is
// gone — they must re-select it. (Low priority — left as-is per task.)
// =====================================================================
describe('BUG-11-08: input.value cleared before modal interaction (left as-is)', () => {
  it('input.value is "" after change event (before user clicks merge/replace)', () => {
    const backup = { version: 1, shows: [makeShow({ id: 1 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    // Modal is open (file was valid)
    expect(modalTitle()).toBe('Importa backup');
    // But input.value is already cleared
    const input = document.getElementById('importFile') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('input.value cleared on size error', () => {
    setFile(makeFile('x', MAX_IMPORT_SIZE + 1));
    const input = document.getElementById('importFile') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('input.value cleared on JSON parse error', () => {
    setFile(makeFile('not json'));
    const input = document.getElementById('importFile') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('input.value cleared when no file selected (empty files list)', () => {
    const input = document.getElementById('importFile') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(input.value).toBe('');
  });
});

// =====================================================================
// Export flow: Blob + createObjectURL + a.click + revokeObjectURL.
// =====================================================================
describe('export flow', () => {
  it('export with shows → creates Blob, object URL, clicks anchor, success toast', () => {
    setShows([makeShow({ id: 1 })]);
    const createURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    document.getElementById('exportBtn')!.click();
    expect(createURLSpy).toHaveBeenCalledTimes(1);
    // Blob passed
    const blob = createURLSpy.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/json');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(lastToast()?.msg).toBe('Backup esportato');
    expect(lastToast()?.type).toBe('success');
    // revokeObjectURL scheduled via setTimeout(1000) — not called yet
    expect(revokeSpy).not.toHaveBeenCalled();
    createURLSpy.mockRestore();
    clickSpy.mockRestore();
    revokeSpy.mockRestore();
  });

  it('export empty shows → confirm modal "Esporta backup"', () => {
    setShows([]);
    document.getElementById('exportBtn')!.click();
    expect(modalTitle()).toBe('Esporta backup');
    expect(modalBody()).toContain('Non hai nessuna serie');
    expect(modalBody()).toContain('esportare un backup vuoto');
  });

  it('export empty: click "Esporta comunque" → doExport runs', () => {
    setShows([]);
    const createURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    document.getElementById('exportBtn')!.click();
    clickButton('Esporta comunque');
    expect(createURLSpy).toHaveBeenCalledTimes(1);
    expect(lastToast()?.msg).toBe('Backup esportato');
    createURLSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it('export empty: click "Annulla" → no export', () => {
    setShows([]);
    const createURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    document.getElementById('exportBtn')!.click();
    clickButton('Annulla');
    expect(createURLSpy).not.toHaveBeenCalled();
    createURLSpy.mockRestore();
  });

  it('export payload includes version, shows, exportedAt (ISO string)', () => {
    setShows([makeShow({ id: 1, name: 'X' })]);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const text = captureBlobContent(() => {
      document.getElementById('exportBtn')!.click();
    });
    clickSpy.mockRestore();
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.shows)).toBe(true);
    expect(parsed.shows).toHaveLength(1);
    expect(parsed.shows[0].name).toBe('X');
    expect(typeof parsed.exportedAt).toBe('string');
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO
  });

  it('export filename uses local ISO date prefix', () => {
    setShows([makeShow({ id: 1 })]);
    let capturedDownload: string | undefined;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      capturedDownload = this.download;
    });
    document.getElementById('exportBtn')!.click();
    clickSpy.mockRestore();
    expect(capturedDownload).toMatch(/^ploppytv-backup-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

// =====================================================================
// BUG-11-09 (FIXED): export uses minified JSON (no indentation) for
// smaller backup files. Previously used 2-space indent (~2x larger).
// =====================================================================
describe('BUG-11-09: export uses minified JSON — FIXED', () => {
  it('JSON.stringify(payload) → single-line minified output (no newlines, no 2-space indent)', () => {
    setShows([makeShow({ id: 1, name: 'X' })]);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const text = captureBlobContent(() => {
      document.getElementById('exportBtn')!.click();
    });
    clickSpy.mockRestore();
    // Minified: no newlines, no 2-space indentation
    expect(text).not.toContain('\n');
    expect(text).not.toContain('  "');
    // Verify it's the same length as minified (no extra whitespace)
    const minified = JSON.stringify(JSON.parse(text));
    expect(text.length).toBe(minified.length);
  });
});

// =====================================================================
// Merge: prevShows snapshot is shallow — seasons object shared.
// After field-level merge, existing.seasons = s.seasons (new ref).
// prevShows[i].seasons still points to OLD ref → rollback restores old.
// (Verifies rollback correctness — NOT a bug.)
// =====================================================================
describe('merge rollback: shallow snapshot preserves old seasons', () => {
  it('rollback after field-level merge restores old seasons reference and addedAt', () => {
    const oldSeasons = { 1: [ep(1, false, 1)] };
    const existing = makeShow({ id: 1, seasons: oldSeasons, totalEpisodes: 1, addedAt: 1000 });
    setShows([existing]);
    const backup = {
      version: 1,
      shows: [makeShow({ id: 1, seasons: { 1: [ep(1, true, 1)] }, totalEpisodes: 1, addedAt: 9999 })],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    saveDataMock.mockReturnValue(false);
    clickButton('Unisci (smart)');
    // Rolled back
    const s = getState().shows[0];
    expect(s.addedAt).toBe(1000); // original, not 9999
    expect(s.seasons).toBe(oldSeasons); // same ref restored
    expect(s.seasons[1][0].watched).toBe(false); // old value
  });
});

// =====================================================================
// Cross-cutting: merge mutates state.shows array directly (push) then
// calls setShows(prevShows) on rollback — live array discarded.
// (Verifies correctness — NOT a bug.)
// =====================================================================
describe('merge: direct push on state.shows then rollback', () => {
  it('push mutates state.shows; rollback replaces with prevShows (separate array)', () => {
    const original = makeShow({ id: 1 });
    setShows([original]);
    const backup = { version: 1, shows: [makeShow({ id: 2 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    saveDataMock.mockReturnValue(false);
    const stateArrayBefore = getState().shows;
    clickButton('Unisci (smart)');
    // After rollback, state.shows is a DIFFERENT array (prevShows)
    expect(getState().shows).not.toBe(stateArrayBefore);
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].id).toBe(1);
  });
});

// =====================================================================
// Replace flow: reconcileAllLists mutates dedupedShows BEFORE saveData
// check. If saveData fails, dedupedShows is already mutated but discarded
// (rollback to prev). This is safe — the mutation is wasted but no leak.
// =====================================================================
describe('replace: reconcileAllLists mutates dedupedShows before save', () => {
  it('on saveData failure, mutated dedupedShows is discarded (no leak)', () => {
    setShows([makeShow({ id: 1 })]);
    const backup = {
      version: 1,
      shows: [
        makeShow({
          id: 10,
          list: 'towatch',
          seasons: { 1: [ep(1, true, 1), ep(2, true, 2)] },
          totalEpisodes: 2,
        }),
      ],
      exportedAt: '2024-01-01',
    };
    setFile(makeFile(JSON.stringify(backup)));
    saveDataMock.mockReturnValue(false);
    clickButton('Sostituisci tutto');
    clickButton('Sì, sostituisci tutto');
    // Rolled back to original
    expect(getState().shows).toHaveLength(1);
    expect(getState().shows[0].id).toBe(1);
  });
});

// =====================================================================
// Modal keepOpen behavior: replaceAction has keepOpen=true so parent
// stays open when nested confirm appears.
// =====================================================================
describe('modal keepOpen on replaceAction', () => {
  it('replaceAction.keepOpen = true → parent stays open when nested confirm appears', () => {
    setShows([makeShow({ id: 1 })]);
    const backup = { version: 1, shows: [makeShow({ id: 10 })], exportedAt: '2024-01-01' };
    setFile(makeFile(JSON.stringify(backup)));
    clickButton('Sostituisci tutto');
    // Nested confirm is on top, parent still in stack
    expect(modalTitle()).toBe('Conferma sostituzione');
    expect(isModalOpen()).toBe(true);
  });
});

// =====================================================================
// reader.onerror: shows toast and resets input.
// =====================================================================
describe('reader.onerror', () => {
  it('reader.onerror → "Errore lettura file" toast + input cleared', () => {
    // Override readAsArrayBuffer to call onerror instead
    const origFR = (globalThis as { FileReader: typeof FileReader }).FileReader;
    class ErrorFileReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      result: ArrayBuffer | string | null = null;
      readAsText(): void {
        if (this.onerror) this.onerror();
      }
      readAsArrayBuffer(): void {
        if (this.onerror) this.onerror();
      }
    }
    (globalThis as { FileReader: typeof FileReader }).FileReader =
      ErrorFileReader as unknown as typeof FileReader;
    setFile(makeFile('{"shows":[]}'));
    expect(lastToast()?.msg).toBe('Errore lettura file');
    expect(lastToast()?.type).toBe('error');
    const input = document.getElementById('importFile') as HTMLInputElement;
    expect(input.value).toBe('');
    // Restore
    (globalThis as { FileReader: typeof FileReader }).FileReader = origFR;
  });
});
