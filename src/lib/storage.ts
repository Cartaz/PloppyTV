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
import {
  getState,
  setShows,
  setStorageDisabled,
  setQuotaWarned,
  emitChange,
} from './store';
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
 * - senza `immediate`: schedula un debounce di 300ms e ritorna `true`.
 *   ATTENZIONE: il ritorno `true` non garantisce che il salvataggio debounced
 *   andrà a buon fine. Per azioni critiche usare sempre `{ immediate: true }`.
 *
 * CAS multi-tab: se il `savedAt` in localStorage è diverso da `_lastSavedAt`,
 * la scrittura viene rifiutata (ritorna `false`). Il chiamante deve applicare
 * il rollback dello stato e notificare l'utente.
 */
export function saveData(opts?: { immediate?: boolean }): boolean {
  if (opts && opts.immediate) return _saveDataNow();
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveDataNow, 300);
  return true;
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
  try {
    const savedAt = Date.now();
    serialized = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: state.shows,
      savedAt,
    } satisfies SavedData);
    // Aggiorna il nostro baseline subito dopo la serializzazione OK
    _lastSavedAt = savedAt;
  } catch (e) {
    console.error('Serializzazione fallita:', e);
    showToast('Errore: dati non serializzabili', 'error');
    return false;
  }

  const sizeKB = Math.round(serialized.length / 1024);
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
        // ignore
      }
    }
    localStorage.setItem(STORAGE_KEY, serialized);
    return true;
  } catch (e: unknown) {
    const err = e as { name?: string; code?: number; message?: string };
    if (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014) {
      const stripped: Show[] = state.shows.map((s) => ({ ...s, image: null }));
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ version: SCHEMA_VERSION, shows: stripped, savedAt: _lastSavedAt } satisfies SavedData)
        );
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
}

// Multi-tab sync via storage event
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== STORAGE_KEY) return;
    try {
      let newShows: Show[];
      let newSavedAt: number | null = null;
      if (ev.newValue === null) {
        newShows = [];
      } else {
        const parsed = JSON.parse(ev.newValue) as SavedData;
        if (!parsed || !Array.isArray(parsed.shows)) return;
        newShows = parsed.shows.map(normalizeShow).filter((s): s is Show => s !== null);
        reconcileAllLists(newShows);
        newSavedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : null;
      }

      // H5: se c'è una modale aperta o modifiche locali non salvate,
      // NON sovrascrivere lo stato (sarebbe disastroso per l'UX).
      // Mostriamo invece un toast che invita a ricaricare a modale chiusa.
      if (isModalOpen()) {
        showToast('Aggiornamento da altro tab — chiusa la finestra ricarica la pagina', 'warning');
        // Aggiorna comunque _lastSavedAt così i salvataggi successivi falliscono per CAS
        _lastSavedAt = newSavedAt;
        // Aggiorna solo i badge
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
