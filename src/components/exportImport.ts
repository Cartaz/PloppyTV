// Export/Import backup JSON
//
// FIXES applicati:
//  - BUG-11-01: BOM detection UTF-8/UTF-16 LE/BE via readAsArrayBuffer + TextDecoder.
//  - BUG-11-02: validazione `data.version` (warning toast su mancante/non-numero/futuro).
//  - BUG-11-03: merge field-level — preserva addedAt/image/name/status/premiered/
//    genres/summary/network/runtime locali; adotta solo seasons/totalEpisodes/
//    totalSeasons/list/manualList dal backup.
//  - BUG-11-04: merge chiama `updateShowListStatus` per riconciliare la list.
//  - BUG-11-07: grammatica italiana singolare/plurale.
//  - BUG-11-09: export JSON minified (no indent).

import type { ExportedData, Show } from '../types';
import { SCHEMA_VERSION } from '../lib/constants';
import { getState, setShows, emitChange, updateShowListStatus } from '../lib/store';
import { saveData, isStorageOK } from '../lib/storage';
import { normalizeShow, reconcileAllLists } from '../lib/normalize';
import { getWatchedCount, localISODate } from '../lib/utils';
import { showToast } from './toast';
import { showModal, closeAllModals, type ModalAction } from './modal';
import { updateBadges } from './header';
import { MAX_IMPORT_SIZE } from '../lib/constants';

const SUPPORTS_EXPORT =
  typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';

/**
 * Decodifica un ArrayBuffer in stringa gestendo BOM UTF-8/UTF-16 LE/BE.
 * BUG-11-01: prima veniva usato readAsText(file,'utf-8') che mangle i file
 * UTF-16. Ora usiamo readAsArrayBuffer e detectiamo il BOM.
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

/**
 * Pluralizza una parola italiana in base al numero.
 * feminine: 1 → "ignorata", 2+ → "ignorate", "nuova"/"nuove".
 * masculine: 1 → "duplicato"/"saltato", 2+ → "duplicati"/"saltati".
 */
function pluralize(n: number, singular: string, plural: string): string {
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
    // BUG-11-01: readAsArrayBuffer + BOM detection per supportare UTF-16.
    reader.onload = (ev) => {
      const buf = (ev.target?.result as ArrayBuffer) || new ArrayBuffer(0);
      let text: string;
      try {
        text = decodeArrayBuffer(buf);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        showToast('File JSON non valido: ' + msg, 'error');
        input.value = '';
        return;
      }
      let data: ExportedData;
      try {
        data = JSON.parse(text) as ExportedData;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        // BUG-11-01: non menzionare più UTF-16 (ora gestito).
        showToast('File JSON non valido: ' + msg + ' (controlla che sia un file JSON valido e non corrotto)', 'error');
        input.value = '';
        return;
      }
      // BUG-A16-02: wrap post-parse logic in try/catch. Se normalizeShow
      // (o qualsiasi altra operazione sincrona dopo il parse) lancia per
      // un input malformato inatteso (defense-in-depth — normalizeShow è
      // ben guarded ma un bug futuro o un oggetto Proxy-like potrebbe
      // causare un throw), il user non vedrebbe nulla (onload crash
      // silenziosamente, nessun toast). Mostriamo un toast e reset
      // dell'input.
      try {
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
        // BUG-11-02: validazione version.
        const hasVersion = typeof data.version === 'number' && Number.isFinite(data.version);
        if (!hasVersion) {
          showToast('Backup senza versione schema — importo comunque best-effort', 'warning');
        } else if (data.version > SCHEMA_VERSION) {
          showToast(
            'Backup con versione futura (' + data.version + ') — potrebbero esserci incompatibilità',
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
        // BUG-11-07: grammatica italiana singolare/plurale.
        const skipMsg =
          skipped > 0
            ? ' (' +
              skipped +
              ' ' +
              pluralize(skipped, 'ignorata per dati non validi', 'ignorate per dati non validi') +
              (duplicates > 0
                ? ', ' + duplicates + ' ' + pluralize(duplicates, 'duplicato saltato', 'duplicati saltati')
                : '') +
              ')'
            : duplicates > 0
              ? ' (' + duplicates + ' ' + pluralize(duplicates, 'duplicato saltato', 'duplicati saltati') + ')'
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
                  // BUG-11-03: merge field-level — preserva i metadati locali,
                  // adotta solo seasons/totalEpisodes/totalSeasons/list/manualList.
                  existing.seasons = s.seasons;
                  existing.totalEpisodes = s.totalEpisodes;
                  existing.totalSeasons = s.totalSeasons;
                  existing.list = s.list;
                  existing.manualList = s.manualList;
                  // BUG-11-04: riconcilia list in base al nuovo watched count.
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
            // BUG-11-07: grammatica italiana.
            const addedWord = pluralize(added, 'Importata', 'Importate');
            const nuoveWord = pluralize(added, 'nuova', 'nuove');
            const aggiornateWord = pluralize(updated, 'aggiornata', 'aggiornate');
            const serieWord = pluralize(updated, 'serie', 'serie');
            showToast(
              addedWord + ' ' + added + ' ' + nuoveWord + ', ' + aggiornateWord + ' ' + updated + ' ' + serieWord,
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        showToast('Errore elaborazione backup: ' + msg, 'error');
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
    // BUG-11-09: JSON minified (no indent) per file di backup più piccoli.
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
