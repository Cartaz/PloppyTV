// Export/Import backup JSON

import type { ExportedData, Show } from '../types';
import { SCHEMA_VERSION } from '../lib/constants';
import { getState, setShows, emitChange, updateShowListStatus } from '../lib/store';
import { saveData, isStorageOK } from '../lib/storage';
import { normalizeShow } from '../lib/normalize';
import { reconcileAllLists } from '../lib/normalize';
import { getWatchedCount } from '../lib/utils';
import { showToast } from './toast';
import { showModal, closeAllModals, type ModalAction } from './modal';
import { updateBadges } from './header';
import { localISODate } from '../lib/utils';
import { MAX_IMPORT_SIZE } from '../lib/constants';

const SUPPORTS_EXPORT =
  typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';

/**
 * Decode a backup file's raw bytes to a string, detecting BOM and using the
 * correct encoding. Handles UTF-8 (with or without BOM), UTF-16 LE (BOM
 * 0xFF 0xFE), and UTF-16 BE (BOM 0xFE 0xFF). For unknown/missing BOMs we
 * fall back to UTF-8 (the most common encoding for JSON).
 *
 * BUG-11-02: previously the code called `reader.readAsText(file, 'utf-8')`
 * which forced UTF-8 decoding — UTF-16 files were silently mangled into
 * replacement chars and JSON.parse failed with a confusing "UTF-16" toast.
 */
function decodeBackupBytes(buf: ArrayBuffer): string {
  let text: string;
  if (buf.byteLength >= 2) {
    const view = new Uint8Array(buf);
    // UTF-16 LE BOM: FF FE
    if (view[0] === 0xff && view[1] === 0xfe) {
      text = new TextDecoder('utf-16le').decode(buf);
    } else if (view[0] === 0xfe && view[1] === 0xff) {
      // UTF-16 BE BOM: FE FF
      text = new TextDecoder('utf-16be').decode(buf);
    } else {
      text = new TextDecoder('utf-8').decode(buf);
    }
  } else {
    text = new TextDecoder('utf-8').decode(buf);
  }
  // Strip a leftover UTF-8 BOM (U+FEFF) if the decoder didn't consume it.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * Singular/plural helper for Italian nouns. Returns the singular form when
 * n === 1, otherwise the plural form. (BUG-11-06: previously the code used
 * hardcoded plural nouns even for n=1.)
 */
function itPlural(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

export function initExportImport(): void {
  document.getElementById('exportBtn')?.addEventListener('click', () => {
    if (!SUPPORTS_EXPORT) {
      showToast('Esportazione non supportata da questo browser', 'error');
      return;
    }
    if (getState().shows.length === 0) {
      showModal('Esporta backup', '<p>Non hai nessuna serie. Vuoi comunque esportare un backup vuoto?</p>', [
        { label: 'Annulla' },
        { label: 'Esporta comunque', style: 'btn-primary', onClick: doExport },
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
      showToast('File troppo grande (max ' + Math.round(MAX_IMPORT_SIZE / 1024 / 1024) + 'MB)', 'error');
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      showToast('Errore lettura file', 'error');
      input.value = '';
    };
    reader.onload = (ev) => {
      const buf = (ev.target?.result as ArrayBuffer) || new ArrayBuffer(0);
      const text = decodeBackupBytes(buf);
      let data: ExportedData;
      try {
        data = JSON.parse(text) as ExportedData;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        showToast(
          'File JSON non valido: ' +
            msg +
            ' (controlla che sia un file JSON valido e non corrotto)',
          'error',
        );
        input.value = '';
        return;
      }
      if (!data || typeof data !== 'object') {
        showToast('Formato non valido: il file deve contenere un oggetto JSON', 'error');
        input.value = '';
        return;
      }
      if (!Array.isArray(data.shows)) {
        showToast(
          'Formato non valido: "shows" deve essere un array (era ' +
            (data.shows === null ? 'null' : typeof data.shows) +
            ')',
          'error',
        );
        input.value = '';
        return;
      }
      // BUG-11-03: validate schema version. Best-effort: warn on mismatch but
      // still let the user import (normalizeShow is forward-compatible-ish).
      if (typeof data.version !== 'number') {
        showToast('File senza versione schema: procedo con cautela', 'warning');
      } else if (data.version > SCHEMA_VERSION) {
        showToast(
          'File di versione futura (v' + data.version + '): alcuni campi potrebbero essere ignorati',
          'warning',
        );
      }
      const validShows = data.shows.map(normalizeShow).filter((s): s is Show => s !== null);
      const skipped = data.shows.length - validShows.length;
      const seenIds = new Set<number>();
      const dedupedShows: Show[] = [];
      let duplicates = 0;
      for (const s of validShows) {
        if (seenIds.has(s.id)) {
          duplicates++;
          continue;
        }
        seenIds.add(s.id);
        dedupedShows.push(s);
      }
      if (dedupedShows.length === 0) {
        showToast('Nessuna serie valida nel file', 'error');
        input.value = '';
        return;
      }
      // BUG-11-06: proper singular/plural for Italian skip message.
      const skipMsg =
        skipped > 0
          ? ' (' +
            skipped +
            ' ' +
            itPlural(skipped, 'ignorata', 'ignorate') +
            ' per dati non validi' +
            (duplicates > 0
              ? ', ' + duplicates + ' ' + itPlural(duplicates, 'duplicato saltato', 'duplicati saltati')
              : '') +
            ')'
          : duplicates > 0
            ? ' (' + duplicates + ' ' + itPlural(duplicates, 'duplicato saltato', 'duplicati saltati') + ')'
            : '';

      const mergeAction: ModalAction = {
        label: 'Unisci (smart)',
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
            } else {
              const existingWatched = getWatchedCount(existing);
              const newWatched = getWatchedCount(s);
              if (newWatched > existingWatched) {
                // H12 / BUG-11-01: field-level merge — adopt the backup's
                // watched progress (seasons/totalEpisodes/totalSeasons and
                // its list/manualList intent) but PRESERVE the user's local
                // metadata (addedAt, image, name, status, premiered, genres,
                // summary, network, runtime) which is fresher than the
                // backup's snapshot.
                existing.seasons = s.seasons;
                existing.totalEpisodes = s.totalEpisodes;
                existing.totalSeasons = s.totalSeasons;
                existing.list = s.list;
                existing.manualList = s.manualList;
                // BUG-11-04: reconcile list with the new watched count so
                // e.g. all-watched-but-towatch is auto-promoted to completed.
                updateShowListStatus(existing);
                updated++;
              }
            }
          }
          if (!saveData({ immediate: true })) {
            // Rollback: ripristina lo snapshot precedente
            setShows(prevShows);
            showToast('Import annullato: storage insufficiente o modifiche in altro tab', 'error');
            return;
          }
          updateBadges();
          emitChange();
          // BUG-11-06: proper singular/plural for Italian success toast.
          showToast(
            itPlural(added, 'Importata', 'Importate') +
              ' ' +
              added +
              ' ' +
              itPlural(added, 'nuova', 'nuove') +
              ', ' +
              itPlural(updated, 'aggiornata', 'aggiornate') +
              ' ' +
              updated +
              ' serie',
            'success',
          );
        },
      };

      const replaceAction: ModalAction = {
        label: 'Sostituisci tutto',
        style: 'btn-danger',
        // CRITICAL FIX (C2/T6): keepOpen = true impedisce che il closeModal()
        // automatico dopo onClick chiuda il modale genitore prima che la
        // modale di conferma figlia sia visibile.
        keepOpen: true,
        onClick: () => {
          showModal(
            'Conferma sostituzione',
            '<p><strong>Attenzione:</strong> tutte le ' +
              getState().shows.length +
              ' serie attuali verranno cancellate e sostituite con le ' +
              dedupedShows.length +
              ' del backup.</p><p>Questa azione non può essere annullata.</p>',
            [
              { label: 'Annulla' },
              {
                label: 'Sì, sostituisci tutto',
                style: 'btn-danger',
                onClick: () => {
                  // Snapshot per rollback
                  const prev = getState().shows.map((s) => ({ ...s }));
                  reconcileAllLists(dedupedShows);
                  setShows(dedupedShows);
                  if (!saveData({ immediate: true })) {
                    // Rollback al precedente stato
                    setShows(prev);
                    showToast('Import annullato: storage insufficiente o modifiche in altro tab', 'error');
                    return;
                  }
                  updateBadges();
                  emitChange();
                  showToast('Backup importato (sostituzione)', 'success');
                  // Chiudi entrambi i modali (genitore + figlia)
                  closeAllModals();
                },
              },
            ],
          );
        },
      };

      showModal(
        'Importa backup',
        '<p>Trovate ' +
          dedupedShows.length +
          ' serie valide' +
          skipMsg +
          '.</p>' +
          '<p>Vuoi sostituire i dati attuali o unirli?</p>',
        [{ label: 'Annulla' }, mergeAction, replaceAction],
      );
    };
    // BUG-11-02: read as ArrayBuffer so we can detect UTF-16 BOMs and decode
    // with the correct encoding. (Previously: readAsText forced UTF-8.)
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
    // BUG-11-08: minified JSON for smaller backup files (machine-consumed).
    data = JSON.stringify(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    showToast('Errore serializzazione: ' + msg, 'error');
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
    showToast('Backup esportato', 'success');
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    showToast('Errore esportazione: ' + msg, 'error');
  }
}

export { isStorageOK };
