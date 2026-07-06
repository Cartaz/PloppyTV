// Persistenza localStorage con backup + gestione quota + multi-tab sync

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

  let serialized: string;
  try {
    serialized = JSON.stringify({
      version: SCHEMA_VERSION,
      shows: state.shows,
      savedAt: Date.now(),
    } satisfies SavedData);
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
          JSON.stringify({ version: SCHEMA_VERSION, shows: stripped, savedAt: Date.now() } satisfies SavedData)
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
      setShows(shows);
      showToast('Dati corrotti. Ripristinato backup precedente.', 'warning');
      saveData({ immediate: true });
      return;
    }
    setShows([]);
    showToast('Dati corrotti. Usa Importa per ripristinare.', 'error');
    return;
  }

  if (!parsed || typeof parsed !== 'object') {
    setShows([]);
    return;
  }
  if (!Array.isArray(parsed.shows)) {
    setShows([]);
    return;
  }
  const shows = parsed.shows.map(normalizeShow).filter((s): s is Show => s !== null);
  reconcileAllLists(shows);
  setShows(shows);
}

// Multi-tab sync via storage event
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== STORAGE_KEY) return;
    try {
      let newShows: Show[];
      if (ev.newValue === null) {
        newShows = [];
      } else {
        const parsed = JSON.parse(ev.newValue) as SavedData;
        if (!parsed || !Array.isArray(parsed.shows)) return;
        newShows = parsed.shows.map(normalizeShow).filter((s): s is Show => s !== null);
        reconcileAllLists(newShows);
      }
      setShows(newShows);
      // Skip render se modal aperto (per non perdere interazione)
      const modal = document.getElementById('modal');
      if (!modal || !modal.classList.contains('active')) {
        emitChange();
      } else {
        // Aggiorna solo i badge, non il main
        const evBadges = new CustomEvent('ploppytv:badges');
        window.dispatchEvent(evBadges);
      }
    } catch (e) {
      console.warn('Sync multi-tab fallita:', e);
    }
  });
}
