// Export/Import backup JSON

import type { ExportedData, Show } from '../types';
import { SCHEMA_VERSION } from '../lib/constants';
import { getState, setShows, emitChange } from '../lib/store';
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
      let text = (ev.target?.result as string) || '';
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      let data: ExportedData;
      try {
        data = JSON.parse(text) as ExportedData;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        showToast(
          'File JSON non valido: ' +
            msg +
            ' (controlla che sia un file JSON valido, non corrotto o in encoding UTF-16)',
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
      const skipMsg =
        skipped > 0
          ? ' (' +
            skipped +
            ' ignorate per dati non validi' +
            (duplicates > 0 ? ', ' + duplicates + ' duplicati saltati' : '') +
            ')'
          : duplicates > 0
            ? ' (' + duplicates + ' duplicati saltati)'
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
                Object.assign(existing, s);
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
          showToast('Importate ' + added + ' nuove, aggiornate ' + updated + ' serie', 'success');
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
    reader.readAsText(file, 'utf-8');
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
    data = JSON.stringify(payload, null, 2);
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
