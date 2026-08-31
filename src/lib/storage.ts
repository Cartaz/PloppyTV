// Persistenza localStorage con backup + gestione quota + multi-tab sync
//
// Multi-tab strategy: optimistic concurrency control (CAS). Ogni tab mantiene
// la revisione del documento che ha caricato: presenza della chiave + savedAt.
// Prima di scrivere, la revisione corrente viene riletta da localStorage. Se
// differisce dalla baseline, la scrittura viene rifiutata e il chiamante può
// invitare l'utente a ricaricare. La presenza fa parte della revisione: anche
// una cancellazione in un altro tab è quindi un conflitto, non uno stato vuoto
// indistinguibile da quello iniziale.

import type { SavedData, Show } from '../types';
import { SCHEMA_VERSION, STORAGE_KEY, BACKUP_KEY } from './constants';
import { getState, setShows, setStorageDisabled, setQuotaWarned, emitChange } from './store';
import { canonicalizeDataDocument } from './dataDocument';
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

type StorageRevision = { present: false } | { present: true; savedAt: number | null };

let _lastRevision: StorageRevision = { present: false };

function _validSavedAt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function _revisionFromRaw(raw: string | null): StorageRevision {
  if (raw === null) return { present: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    const savedAt =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).savedAt
        : undefined;
    return { present: true, savedAt: _validSavedAt(savedAt) };
  } catch {
    // La chiave esiste anche se il documento è corrotto. Questo è importante
    // per distinguere una corruzione da una cancellazione concorrente.
    return { present: true, savedAt: null };
  }
}

function _readStorageRevision(): StorageRevision | null {
  try {
    return _revisionFromRaw(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function _sameRevision(a: StorageRevision, b: StorageRevision): boolean {
  if (a.present !== b.present) return false;
  if (!a.present || !b.present) return true;
  return a.savedAt === b.savedAt;
}

function _setRevisionFromRaw(raw: string | null): void {
  _lastRevision = _revisionFromRaw(raw);
}

/**
 * Salva lo stato corrente su localStorage.
 * - `{ immediate: true }`: scrive sincronamente, ritorna `false` se la
 *   scrittura fallisce (quota, serializzazione, conflitto multi-tab).
 * - senza `immediate`: schedula un debounce di 300ms e ritorna `true`.
 *
 * CAS multi-tab: se la revisione corrente (presenza + `savedAt`) differisce
 * da quella caricata dal tab, la scrittura viene rifiutata.
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

  const currentRevision = _readStorageRevision();
  if (currentRevision === null || !_sameRevision(currentRevision, _lastRevision)) {
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

  // La baseline avanza solo dopo una scrittura riuscita.
  const expectedRevision = _lastRevision;

  try {
    const prev = localStorage.getItem(STORAGE_KEY);
    if (prev) {
      // BUG-A4-02: valida che `prev` sia JSON valido prima di backarlo up.
      // Altrimenti, dopo un corruption-recovery path in loadData (dove
      // STORAGE_KEY contiene ancora il raw corrotto quando saveData viene
      // chiamato), BACKUP_KEY verrebbe sovrascritto con JSON corrotto,
      // distruggendo la safety net per le future corruzioni.
      try {
        JSON.parse(prev);
        localStorage.setItem(BACKUP_KEY, prev);
      } catch {
        // prev è corrotto (o setItem fallito) — skip backup, non clobberare
        // il backup valido eventualmente già presente in BACKUP_KEY.
      }
    }
    localStorage.setItem(STORAGE_KEY, serialized);
    _lastRevision = { present: true, savedAt: newSavedAt };
    return true;
  } catch (e: unknown) {
    const err = e as { name?: string; code?: number; message?: string };
    if (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014) {
      // Re-check CAS prima del recovery senza poster: tra il primo controllo
      // e il write fallito un altro tab potrebbe aver scritto o cancellato.
      const recoverRevision = _readStorageRevision();
      if (recoverRevision === null || !_sameRevision(recoverRevision, expectedRevision)) {
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
        _lastRevision = { present: true, savedAt: newSavedAt };
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

function _loadFromBackup(): unknown | null {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function _loadCanonicalBackup(): Show[] | null {
  const result = canonicalizeDataDocument(_loadFromBackup());
  return result.ok && result.document.shows.length > 0 ? result.document.shows : null;
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
  // BUG-A4-01: localStorage.getItem può lanciare SecurityError in modalità
  // privata (Safari) o dopo revoca mid-session dei permessi storage. Senza
  // questo wrap, loadData crasherebbe e il caller (main.ts) non recupererebbe.
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    _storageOK = false;
    setShows([]);
    setStorageDisabled(true);
    showToast('Archiviazione non disponibile.', 'error');
    return;
  }
  if (!raw) {
    _lastRevision = { present: false };
    setShows([]);
    return;
  }

  // Baseline del documento effettivamente letto. I path di recovery possono
  // sostituire questo snapshot, ma non uno modificato nel frattempo.
  _setRevisionFromRaw(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('JSON corrotto in localStorage:', e);
    try {
      localStorage.setItem('ploppytv_corrupted_' + Date.now(), raw);
    } catch {
      // ignore
    }
    const backupShows = _loadCanonicalBackup();
    if (backupShows) {
      setShows(backupShows);
      showToast('Dati corrotti. Ripristinato backup precedente.', 'warning');
      saveData({ immediate: true });
      return;
    }
    setShows([]);
    showToast('Dati corrotti. Usa Importa per ripristinare.', 'error');
    return;
  }

  const canonical = canonicalizeDataDocument(parsed);
  if (!canonical.ok) {
    const unsupported = canonical.code === 'unsupported-version';
    if (unsupported) {
      console.warn('[PloppyTV] Schema version futura:', canonical.version, '— atteso', SCHEMA_VERSION);
    } else {
      console.warn('[PloppyTV] Documento storage non valido:', canonical.code);
    }

    const backupShows = _loadCanonicalBackup();
    if (backupShows) {
      setShows(backupShows);
      showToast(
        unsupported
          ? 'Versione dati non supportata. Ripristinato backup.'
          : 'Dati non validi. Ripristinato backup precedente.',
        'warning',
      );
      saveData({ immediate: true });
      return;
    }

    setShows([]);
    showToast(
      unsupported
        ? 'Versione dati non supportata. Usa Importa per ripristinare.'
        : 'Dati non validi. Usa Importa per ripristinare.',
      'error',
    );
    return;
  }

  const sourceVersion = canonical.document.sourceVersion;
  if (sourceVersion === null) {
    console.warn('[PloppyTV] Documento storage senza schema version — normalizzato al formato corrente');
  } else if (sourceVersion < SCHEMA_VERSION) {
    console.warn('[PloppyTV] Schema version passata:', sourceVersion, '— atteso', SCHEMA_VERSION);
  }
  setShows(canonical.document.shows);
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
          // BUG-04-04: NON avanza _lastRevision (resta al valore pre-event).
          return;
        }
        // Nessun show locale → safe to wipe.
        setShows([]);
        _lastRevision = { present: false };
        emitChange();
        return;
      }

      const parsed = JSON.parse(ev.newValue) as unknown;
      const canonical = canonicalizeDataDocument(parsed);
      if (!canonical.ok) {
        if (canonical.code === 'unsupported-version') {
          console.warn('[PloppyTV] storage event con version futura:', canonical.version);
        } else {
          console.warn('[PloppyTV] storage event ignorato:', canonical.code, canonical.version ?? '');
        }
        return;
      }
      const sourceVersion = canonical.document.sourceVersion;
      if (sourceVersion === null) {
        console.warn('[PloppyTV] storage event senza schema version — normalizzato');
      } else if (sourceVersion < SCHEMA_VERSION) {
        console.warn('[PloppyTV] storage event con version passata:', sourceVersion);
      }
      const newShows = canonical.document.shows;
      const newSavedAt = _validSavedAt((parsed as Record<string, unknown>).savedAt);

      // BUG-04-01: se _localDirty=true (modifiche locali non salvate), NON
      // sovrascrivere lo stato. Mostra toast e lascia _lastRevision al valore
      // pre-event (così il prossimo saveData CAS-fail e forza reload).
      if (state._localDirty) {
        showToast('Aggiornamento da altro tab — ricarica per sincronizzare', 'warning');
        return;
      }

      // H5 / BUG-04-04: se c'è una modale aperta, NON sovrascrivere lo stato.
      // Mostriamo un toast che invita a ricaricare a modale chiusa.
      // NON avanza _lastRevision (così i salvataggi successivi falliscono per CAS).
      if (isModalOpen()) {
        showToast('Aggiornamento da altro tab — ricarica per sincronizzare', 'warning');
        const evBadges = new CustomEvent('ploppytv:badges');
        window.dispatchEvent(evBadges);
        return;
      }

      setShows(newShows);
      _lastRevision = { present: true, savedAt: newSavedAt };
      emitChange();
    } catch (e) {
      console.warn('Sync multi-tab fallita:', e);
    }
  });
}
