// Persistenza localStorage con backup + gestione quota + multi-tab sync
//
// Multi-tab strategy: optimistic concurrency control (CAS).
// Ogni `SavedData` porta un `savedAt` (timestamp). Il modulo traccia
// `_lastSavedAt` = il `savedAt` dell'ultimo snapshot caricato dal localStorage.
// Prima di scrivere, rilegge `savedAt` da localStorage: se è cambiato, significa
// che un altro tab ha scritto nel frattempo → la scrittura viene rifiutata
// (ritorna `false`) e l'azione chiamante deve applicare il rollback.
// L'evento `storage` aggiorna `_lastSavedAt` dal valore ricevuto.

import type { SavedData, Show } from '../types';
import { SCHEMA_VERSION, STORAGE_KEY, BACKUP_KEY } from './constants';
import { getState, setShows, setStorageDisabled, setQuotaWarned, emitChange } from './store';
import { normalizeShow, reconcileAllLists } from './normalize';
import { showToast } from '../components/toast';
import { isModalOpen } from '../components/modal';

let _storageOK = true;

export function isStorageOK(): boolean {
  return _storageOK;
}

(function detectStorage() {
  try {
    const k = '__ploppytv_test_' + Date.now();
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
  } catch {
    _storageOK = false;
    console.warn('[PloppyTV] localStorage non disponibile');
  }
})();

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * `savedAt` dell'ultimo snapshot caricato dal localStorage (in questo tab).
 * Usato per CAS multi-tab: se prima di salvare leggiamo un `savedAt` diverso,
 * significa che un altro tab ha scritto → rifiutiamo la scrittura.
 */
let _lastSavedAt: number | null = null;

function _readSavedAtFromStorage(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedData;
    return typeof parsed.savedAt === 'number' ? parsed.savedAt : null;
  } catch {
    return null;
  }
}

/**
 * Salva lo stato corrente su localStorage.
 * - `{ immediate: true }`: scrive sincronamente, ritorna `false` se la
 *   scrittura fallisce (quota, serializzazione, conflitto multi-tab).
 * - senza `immediate`: schedula un debounce di 300ms e ritorna `void`.
 *   ATTENZIONE: non c'è ritorno booleano per la path debounced — il
 *   salvataggio avviene in background e può fallire (CAS, quota,
 *   serializzazione). Per azioni critiche usare sempre `{ immediate: true }`
 *   e controllare il ritorno booleano.
 *
 * CAS multi-tab: se il `savedAt` in localStorage è diverso da `_lastSavedAt`,
 * la scrittura viene rifiutata (ritorna `false`). Il chiamante deve applicare
 * il rollback dello stato e notificare l'utente.
 */
export function saveData(opts: { immediate: true }): boolean;
export function saveData(opts?: { immediate?: boolean }): void;
export function saveData(opts?: { immediate?: boolean }): boolean | void {
  if (opts && opts.immediate) return _saveDataNow();
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveDataNow, 300);
  // BUG-04-09: debounced path returns void (scheduled, not succeeded).
  // Callers needing success/failure feedback must use { immediate: true }.
}

function _saveDataNow(): boolean {
  _saveTimer = null;
  const state = getState();
  if (state._storageDisabled || !_storageOK) return false;

  // CAS multi-tab: rileggi savedAt da storage. Se diverso da _lastSavedAt,
  // un altro tab ha scritto. Rifiuta la nostra scrittura per evitare
  // di sovrascrivere silenziosamente le sue modifiche.
  const currentSavedAt = _readSavedAtFromStorage();
  if (_lastSavedAt !== null && currentSavedAt !== null && currentSavedAt !== _lastSavedAt) {
    showToast('Modifiche in un altro tab — ricarica per vedere i dati aggiornati', 'warning');
    return false;
  }

  let serialized: string;
  let savedAt: number;
  try {
    // H3 (BUG-04-02): _lastSavedAt is advanced ONLY after a successful write
    // (below). Advancing it here would leave it stale-high on write failure,
    // falsely failing CAS on the next save attempt.
    savedAt = Date.now();
    serialized = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: state.shows,
      savedAt,
    } satisfies SavedData);
  } catch (e) {
    console.error('Serializzazione fallita:', e);
    showToast('Errore: dati non serializzabili', 'error');
    return false;
  }

  // BUG-04-07: use UTF-8 byte length (TextEncoder) instead of char count.
  // Italian accented chars and emoji are multibyte in UTF-8 — char count
  // underestimates actual storage size and the quota warning fires too late.
  const sizeKB = Math.round(new TextEncoder().encode(serialized).length / 1024);
  if (sizeKB > 4500 && !state._quotaWarned) {
    showToast('Attenzione: dati vicini al limite (' + sizeKB + 'KB). Usa Esporta per backup.', 'warning');
    setQuotaWarned(true);
  }

  try {
    const prev = localStorage.getItem(STORAGE_KEY);
    if (prev) {
      try {
        localStorage.setItem(BACKUP_KEY, prev);
      } catch {
        // ignore — best-effort backup
      }
    }
    localStorage.setItem(STORAGE_KEY, serialized);
    // H3 (BUG-04-02): advance _lastSavedAt only AFTER the successful write.
    _lastSavedAt = savedAt;
    // BUG-04-06: best-effort TOCTOU detection. localStorage has no atomic
    // CAS, so another tab could have written between our CAS read (above)
    // and this write. Re-read savedAt; if it doesn't match what we just
    // wrote, a race occurred — warn the user (can't fully fix without Web
    // Locks; this only surfaces the loss, doesn't prevent it).
    try {
      const postWriteSavedAt = _readSavedAtFromStorage();
      if (postWriteSavedAt !== null && postWriteSavedAt !== savedAt) {
        showToast('Conflitto multi-tab rilevato, ricarica', 'warning');
      }
    } catch {
      // ignore — best-effort detection
    }
    return true;
  } catch (e: unknown) {
    const err = e as { name?: string; code?: number; message?: string };
    if (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014) {
      // BUG-04-05: re-check CAS before the stripped recovery write. Another
      // tab may have written between our CAS read (above) and this failing
      // write. If so, abort recovery to avoid overwriting their newer data.
      const recoverySavedAt = _readSavedAtFromStorage();
      if (
        _lastSavedAt !== null &&
        recoverySavedAt !== null &&
        recoverySavedAt !== _lastSavedAt
      ) {
        showToast('Modifiche in un altro tab — ricarica per vedere i dati aggiornati', 'warning');
        return false;
      }
      const stripped: Show[] = state.shows.map((s) => ({ ...s, image: null }));
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ version: SCHEMA_VERSION, shows: stripped, savedAt } satisfies SavedData),
        );
        // H3: advance _lastSavedAt only after the successful stripped write.
        _lastSavedAt = savedAt;
        showToast('Salvato senza immagini (spazio limitato).', 'warning');
        return true;
      } catch {
        showToast('Spazio esaurito. Esporta backup e rimuovi serie vecchie.', 'error');
      }
    } else if (err.name === 'SecurityError' || err.code === 18) {
      setStorageDisabled(true);
      showToast('Salvataggio non disponibile (modalità privata?).', 'error');
    } else {
      showToast('Errore salvataggio: ' + (err.message || 'unknown'), 'error');
    }
    return false;
  }
}

function _loadFromBackup(): SavedData | null {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? (JSON.parse(raw) as SavedData) : null;
  } catch {
    return null;
  }
}

export function loadData(): void {
  if (!_storageOK) {
    console.warn('[PloppyTV] Modalità in-memory');
    setShows([]);
    setStorageDisabled(true);
    return;
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    _lastSavedAt = null;
    setShows([]);
    return;
  }

  let parsed: SavedData;
  try {
    parsed = JSON.parse(raw) as SavedData;
  } catch (e) {
    console.error('JSON corrotto in localStorage:', e);
    try {
      localStorage.setItem('ploppytv_corrupted_' + Date.now(), raw);
    } catch {
      // ignore
    }
    const backup = _loadFromBackup();
    if (backup && Array.isArray(backup.shows) && backup.shows.length > 0) {
      const shows = backup.shows.map(normalizeShow).filter((s): s is Show => s !== null);
      reconcileAllLists(shows);
      _lastSavedAt = backup.savedAt ?? null;
      setShows(shows);
      showToast('Dati corrotti. Ripristinato backup precedente.', 'warning');
      saveData({ immediate: true });
      return;
    }
    _lastSavedAt = null;
    setShows([]);
    showToast('Dati corrotti. Usa Importa per ripristinare.', 'error');
    return;
  }

  if (!parsed || typeof parsed !== 'object') {
    _lastSavedAt = null;
    setShows([]);
    return;
  }
  if (!Array.isArray(parsed.shows)) {
    _lastSavedAt = null;
    setShows([]);
    return;
  }
  const shows = parsed.shows.map(normalizeShow).filter((s): s is Show => s !== null);
  reconcileAllLists(shows);
  _lastSavedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : null;
  setShows(shows);

  // BUG-04-08: on successful load, clean up accumulated `ploppytv_corrupted_*`
  // forensic keys. Repeated corruption could otherwise spam localStorage and
  // contribute to quota exhaustion. Forensic value is low; cleanliness matters.
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ploppytv_corrupted_')) keysToRemove.push(k);
    }
    for (const k of keysToRemove) localStorage.removeItem(k);
  } catch {
    // ignore — best-effort cleanup
  }
}

// Multi-tab sync via storage event
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== STORAGE_KEY) return;
    try {
      let newShows: Show[];
      let newSavedAt: number | null = null;
      if (ev.newValue === null) {
        // H4 (BUG-04-03): storage was cleared elsewhere (devtools, "clear site
        // data", another PWA instance, browser extension). Do NOT silently wipe
        // this tab's in-memory shows — that would lose unsaved edits and
        // existing loaded data. Only wipe if we have nothing locally.
        if (getState().shows.length > 0) {
          showToast('Dati cancellati in altro tab — ricarica per sincronizzare', 'warning');
          const evBadges = new CustomEvent('ploppytv:badges');
          window.dispatchEvent(evBadges);
          return;
        }
        newShows = [];
      } else {
        const parsed = JSON.parse(ev.newValue) as SavedData;
        if (!parsed || !Array.isArray(parsed.shows)) return;
        newShows = parsed.shows.map(normalizeShow).filter((s): s is Show => s !== null);
        reconcileAllLists(newShows);
        newSavedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : null;
      }

      // H2 (BUG-04-01) + H5 (BUG-04-04): if a modal is open OR there are
      // unsaved local edits, do NOT overwrite in-memory shows — that would
      // lose the user's in-progress work or silently corrupt the other tab's
      // newer write via a stale-overwrite on the next save.
      //
      // H5: do NOT advance _lastSavedAt to newSavedAt here. Leaving it at the
      // pre-event value ensures the next saveData CAS check mismatches
      // (storage has newSavedAt, _lastSavedAt has the older pre-event value)
      // → CAS fails → user is forced to reload rather than overwrite the
      // other tab's data. (Advancing _lastSavedAt to newSavedAt would make
      // CAS pass and silently corrupt the other tab's write — the original bug.)
      if (isModalOpen() || getState()._localDirty) {
        showToast('Aggiornamento da altro tab — ricarica per sincronizzare', 'warning');
        const evBadges = new CustomEvent('ploppytv:badges');
        window.dispatchEvent(evBadges);
        return;
      }

      setShows(newShows);
      _lastSavedAt = newSavedAt;
      emitChange();
    } catch (e) {
      console.warn('Sync multi-tab fallita:', e);
    }
  });
}
