// Persistenza localStorage con backup + gestione quota + multi-tab sync
//
// Multi-tab strategy: optimistic concurrency control (CAS).
// Ogni `SavedData` porta un `savedAt` (timestamp). Il modulo traccia
// `_lastSavedAt` = il `savedAt` dell'ultimo snapshot caricato dal localStorage.
// Prima di scrivere, rilegge `savedAt` da localStorage: se è cambiato, significa
// che un altro tab ha scritto nel frattempo → la scrittura viene rifiutata
// (ritorna `false`) e l'azione chiamante deve applicare il rollback.
// L'evento `storage` aggiorna `_lastSavedAt` dal valore ricevuto.
//
// FIXES applicati:
//  - BUG-04-01: storage event consulta `_localDirty` — se true, skip setShows + toast.
//  - BUG-04-02: `_lastSavedAt` avanzato solo DOPO un write di successo.
//  - BUG-04-03: storage event con newValue=null NON wipe se ci sono shows locali.
//  - BUG-04-04: storage event con modal-open o _localDirty NON avanza _lastSavedAt.
//  - BUG-04-05: QuotaExceeded recovery re-check CAS prima del stripped write.

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
 * - senza `immediate`: schedula un debounce di 300ms e ritorna `true`.
 *
 * CAS multi-tab: se il `savedAt` in localStorage è diverso da `_lastSavedAt`,
 * la scrittura viene rifiutata (ritorna `false`).
 */
export function saveData(opts?: { immediate?: boolean }): boolean | void {
  if (opts && opts.immediate) return _saveDataNow();
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveDataNow, 300);
  // BUG-04-09: debounced path returns void (not true) — il save non è ancora avvenuto.
  return;
}

function _saveDataNow(): boolean {
  _saveTimer = null;
  const state = getState();
  if (state._storageDisabled || !_storageOK) return false;

  // CAS multi-tab: rileggi savedAt da storage. Se diverso da _lastSavedAt,
  // un altro tab ha scritto. Rifiuta la nostra scrittura.
  const currentSavedAt = _readSavedAtFromStorage();
  if (_lastSavedAt !== null && currentSavedAt !== null && currentSavedAt !== _lastSavedAt) {
    showToast('Modifiche in un altro tab — ricarica per vedere i dati aggiornati', 'warning');
    return false;
  }

  let serialized: string;
  let newSavedAt: number;
  try {
    newSavedAt = Date.now();
    serialized = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: state.shows,
      savedAt: newSavedAt,
    } satisfies SavedData);
  } catch (e) {
    console.error('Serializzazione fallita:', e);
    showToast('Errore: dati non serializzabili', 'error');
    return false;
  }

  // BUG-04-07: size threshold uses UTF-8 byte length (TextEncoder), non char count.
  const sizeKB = Math.round(new TextEncoder().encode(serialized).length / 1024);
  if (sizeKB > 4500 && !state._quotaWarned) {
    showToast('Attenzione: dati vicini al limite (' + sizeKB + 'KB). Usa Esporta per backup.', 'warning');
    setQuotaWarned(true);
  }

  // BUG-04-02: NON avanzare _lastSavedAt qui — solo dopo un write di successo.
  const prevLastSavedAt = _lastSavedAt;

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
    // BUG-04-02: write di successo → avanza _lastSavedAt.
    _lastSavedAt = newSavedAt;
    return true;
  } catch (e: unknown) {
    const err = e as { name?: string; code?: number; message?: string };
    if (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014) {
      // BUG-04-05: re-check CAS prima del stripped write — se un altro tab ha
      // scritto tra il nostro CAS read e il write fallito, abort recovery.
      const recoverSavedAt = _readSavedAtFromStorage();
      if (prevLastSavedAt !== null && recoverSavedAt !== null && recoverSavedAt !== prevLastSavedAt) {
        showToast('Modifiche in un altro tab — ricarica per vedere i dati aggiornati', 'warning');
        return false;
      }
      const stripped: Show[] = state.shows.map((s) => ({ ...s, image: null }));
      try {
        const strippedSerialized = JSON.stringify({
          version: SCHEMA_VERSION,
          shows: stripped,
          savedAt: newSavedAt,
        } satisfies SavedData);
        localStorage.setItem(STORAGE_KEY, strippedSerialized);
        // BUG-04-02: stripped write OK → avanza _lastSavedAt.
        _lastSavedAt = newSavedAt;
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
    // BUG-04-02: write fallito → _lastSavedAt resta al valore pre-attempt.
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

/**
 * BUG-04-08: rimuove tutte le chiavi `ploppytv_corrupted_*` forensi da localStorage.
 * Chiamato dopo un loadData valido per evitare accumulo di chiavi inutili.
 */
function _cleanupCorruptedKeys(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ploppytv_corrupted_')) keysToRemove.push(k);
    }
    for (const k of keysToRemove) {
      try {
        localStorage.removeItem(k);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
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
  // BUG-04-08: pulisci le chiavi ploppytv_corrupted_* forensi dopo un load valido.
  _cleanupCorruptedKeys();
}

// Multi-tab sync via storage event
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== STORAGE_KEY) return;
    try {
      const state = getState();

      // BUG-04-03: storage event con newValue=null (altro tab ha cancellato).
      // Se ci sono shows locali (o _localDirty), NON wipe — mostra toast.
      if (ev.newValue === null) {
        if (state.shows.length > 0) {
          showToast('Dati cancellati in altro tab — ricarica per sincronizzare', 'warning');
          // BUG-04-04: NON avanza _lastSavedAt (resta al valore pre-event).
          return;
        }
        // Nessun show locale → safe to wipe.
        setShows([]);
        _lastSavedAt = null;
        emitChange();
        return;
      }

      const parsed = JSON.parse(ev.newValue) as SavedData;
      if (!parsed || !Array.isArray(parsed.shows)) return;
      const newShows = parsed.shows.map(normalizeShow).filter((s): s is Show => s !== null);
      reconcileAllLists(newShows);
      const newSavedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : null;

      // BUG-04-01: se _localDirty=true (modifiche locali non salvate), NON
      // sovrascrivere lo stato. Mostra toast e lascia _lastSavedAt al valore
      // pre-event (così il prossimo saveData CAS-fail e forza reload).
      if (state._localDirty) {
        showToast('Aggiornamento da altro tab — ricarica per sincronizzare', 'warning');
        return;
      }

      // H5 / BUG-04-04: se c'è una modale aperta, NON sovrascrivere lo stato.
      // Mostriamo un toast che invita a ricaricare a modale chiusa.
      // NON avanza _lastSavedAt (così i salvataggi successivi falliscono per CAS).
      if (isModalOpen()) {
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
