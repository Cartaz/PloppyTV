// Export/Import backup JSON

import type { ExportedData } from '../types';
import { SCHEMA_VERSION, MAX_IMPORT_SIZE } from '../lib/constants';
import { getState, setShows, emitChange } from '../lib/store';
import { mergeImportedShow } from '../lib/merge';
import { saveData } from '../lib/storage';
import { canonicalizeDataDocument } from '../lib/dataDocument';
import { localISODate } from '../lib/utils';
import { showToast } from './toast';
import { showModal, closeAllModals, type ModalAction } from './modal';
import { updateBadges } from './header';
import { t, tn } from '../lib/i18n';

const SUPPORTS_EXPORT =
  typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';

/**
 * Decodifica un ArrayBuffer in stringa gestendo BOM UTF-8/UTF-16 LE/BE.
 */
function decodeArrayBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // UTF-16 LE BOM: FF FE
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    } catch {
      // fallback below
    }
  }
  // UTF-16 BE BOM: FE FF
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    } catch {
      // fallback below
    }
  }
  // UTF-8 BOM: EF BB BF
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }
  return new TextDecoder('utf-8').decode(bytes.subarray(start));
}

export function initExportImport(): void {
  document.getElementById('exportBtn')?.addEventListener('click', () => {
    if (!SUPPORTS_EXPORT) {
      showToast(t('io.exportUnsupported'), 'error');
      return;
    }
    if (getState().shows.length === 0) {
      showModal(t('io.exportTitle'), '<p>' + t('io.exportEmptyConfirm') + '</p>', [
        { label: t('actions.cancel') },
        { label: t('io.exportAnyway'), style: 'btn-primary', onClick: doExport },
      ]);
      return;
    }
    doExport();
  });

  document.getElementById('importBtn')?.addEventListener('click', () => {
    document.getElementById('importFile')?.click();
  });

  document.getElementById('importFile')?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) {
      input.value = '';
      return;
    }
    if (file.size > MAX_IMPORT_SIZE) {
      showToast(t('io.fileTooBig', { max: Math.round(MAX_IMPORT_SIZE / 1024 / 1024) }), 'error');
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      showToast(t('io.readError'), 'error');
      input.value = '';
    };
    // readAsArrayBuffer + BOM detection per supportare UTF-16.
    reader.onload = (ev) => {
      const buf = (ev.target?.result as ArrayBuffer) || new ArrayBuffer(0);
      let text: string;
      try {
        text = decodeArrayBuffer(buf);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        showToast(t('io.invalidJson', { msg }), 'error');
        input.value = '';
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        // Non menzionare più UTF-16 (ora gestito).
        showToast(t('io.invalidJsonHint', { msg }), 'error');
        input.value = '';
        return;
      }
      // Wrap post-parse logic in try/catch. Se canonicalizeDataDocument
      // (o qualsiasi altra operazione sincrona dopo il parse) lancia per
      // un input malformato inatteso (defense-in-depth — canonicalizeDataDocument è
      // ben guarded ma un bug futuro o un oggetto Proxy-like potrebbe
      // causare un throw), il user non vedrebbe nulla (onload crash
      // silenziosamente, nessun toast). Mostriamo un toast e reset
      // dell'input.
      try {
        const canonical = canonicalizeDataDocument(data);
        if (!canonical.ok) {
          if (canonical.code === 'unsupported-version') {
            showToast(t('io.newerVersion'), 'error');
          } else if (canonical.code === 'invalid-version') {
            showToast(t('io.invalidVersion'), 'error');
          } else if (canonical.code === 'invalid-shows') {
            showToast(t('io.invalidShows'), 'error');
          } else {
            showToast(t('io.invalidDocument'), 'error');
          }
          input.value = '';
          return;
        }

        if (canonical.document.sourceVersion === null) {
          showToast(t('io.legacyBackup'), 'warning');
        }

        const dedupedShows = canonical.document.shows;
        const skipped = canonical.document.skippedShows;
        const duplicates = canonical.document.duplicateShows;
        if (dedupedShows.length === 0) {
          showToast(t('io.noValidShows'), 'error');
          input.value = '';
          return;
        }
        const skipParts: string[] = [];
        if (skipped > 0) skipParts.push(tn('io.skippedInvalid', skipped));
        if (duplicates > 0) skipParts.push(tn('io.skippedDuplicates', duplicates));
        const skipMsg = skipParts.length > 0 ? ' (' + skipParts.join(', ') + ')' : '';

        const mergeAction: ModalAction = {
          label: t('io.merge'),
          onClick: () => {
            // Snapshot per rollback in caso di save fallito
            const prevShows = getState().shows.map((s) => ({ ...s }));
            let added = 0;
            let updated = 0;
            const currentShows = getState().shows;
            for (const s of dedupedShows) {
              const existing = currentShows.find((x) => x.id === s.id);
              if (!existing) {
                currentShows.push(s);
                added++;
              } else if (mergeImportedShow(existing, s)) {
                updated++;
              }
            }
            if (!saveData()) {
              // Rollback: ripristina lo snapshot precedente
              setShows(prevShows);
              showToast(t('io.importCancelled'), 'error');
              return;
            }
            updateBadges();
            emitChange();
            showToast(tn('io.mergeAdded', added) + ', ' + tn('io.mergeUpdated', updated), 'success');
          },
        };

        const replaceAction: ModalAction = {
          label: t('io.replaceAll'),
          style: 'btn-danger',
          // keepOpen = true impedisce che il closeModal()
          // automatico dopo onClick chiuda il modale genitore prima che la
          // modale di conferma figlia sia visibile.
          keepOpen: true,
          onClick: () => {
            showModal(
              t('io.replaceConfirmTitle'),
              '<p><strong>' +
                t('io.warning') +
                '</strong> ' +
                t('io.replaceWarning', { current: getState().shows.length, incoming: dedupedShows.length }) +
                '</p><p>' +
                t('io.irreversible') +
                '</p>',
              [
                { label: t('actions.cancel') },
                {
                  label: t('io.replaceAllConfirm'),
                  style: 'btn-danger',
                  onClick: () => {
                    // Snapshot per rollback
                    const prev = getState().shows.map((s) => ({ ...s }));
                    setShows(dedupedShows);
                    if (!saveData()) {
                      // Rollback al precedente stato
                      setShows(prev);
                      showToast(t('io.importCancelled'), 'error');
                      return;
                    }
                    updateBadges();
                    emitChange();
                    showToast(t('io.importedReplace'), 'success');
                    // Chiudi entrambi i modali (genitore + figlia)
                    closeAllModals();
                  },
                },
              ],
            );
          },
        };

        showModal(
          t('io.importTitle'),
          '<p>' +
            t('io.found', { count: dedupedShows.length }) +
            skipMsg +
            '.</p>' +
            '<p>' +
            t('io.replaceOrMerge') +
            '</p>',
          [{ label: t('actions.cancel') }, mergeAction, replaceAction],
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        showToast(t('io.processError') + msg, 'error');
        input.value = '';
      }
    };
    reader.readAsArrayBuffer(file);
    input.value = '';
  });
}

function doExport(): void {
  let data: string;
  try {
    const payload: ExportedData = {
      version: SCHEMA_VERSION,
      shows: getState().shows,
      exportedAt: new Date().toISOString(),
    };
    // JSON minified (no indent) per file di backup più piccoli.
    data = JSON.stringify(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    showToast(t('io.serializeError') + msg, 'error');
    return;
  }
  try {
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ploppytv-backup-' + localISODate(new Date()) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(t('io.exported'), 'success');
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    showToast(t('io.exportError') + msg, 'error');
  }
}
