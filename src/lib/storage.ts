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

type StorageRevision = { present: false } | { present: true; savedAt: number | null };

let _lastRevision: StorageRevision = { present: false };

function _validSavedAt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function _revisionFromRaw(raw: string | null): StorageRevision {
  if (raw === null) return { present: false };
  try {
    const parsed = JSON.parse(raw) as SavedData;
    return { present: true, savedAt: _validSavedAt(parsed?.savedAt) };
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
 * BUG-A19-04: dedup show per id (keep first).
 * localStorage corrotto o race multi-tab può produrre show duplicati per id;
 * senza dedup, toggleEpisode/stats/calendar ne risentono (conteggi doppi,
 * show orfani, toggle ambiguo). Allineato al behaviour di exportImport.
 */
function _dedupShowsById(shows: Show[]): Show[] {
  const seen = new Set<number>();
  const out: Show[] = [];
  for (const s of shows) {
    if (!s || typeof s.id !== 'number' || !Number.isFinite(s.id)) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
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
      // BUG-A4-06: valida tipo di backup.savedAt — non trustare stringhe/NaN
      // (un backup vecchio o malevolo con savedAt="abc" romperebbe il CAS
      // perché "abc" !== <numero> è sempre true → ogni save futuro rifiutato).
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
  // BUG-A4-03: valida schema version.
  // - `version` presente ma non numero finito → dato inatteso/malevolo → scarta.
  // - `version > SCHEMA_VERSION` (futura) → non sappiamo interpretare il formato
  //   → tratta come corruption, prova backup, fallback empty.
  // - `version < SCHEMA_VERSION` (passata) → prosegui con warning (normalizeShow
  //   è defensive e gestisce formati vecchi con defaults sensati).
  // - `version` mancante (undefined) → dato molto vecchio, prosegui lenient.
  if (parsed.version !== undefined) {
    if (typeof parsed.version !== 'number' || !Number.isFinite(parsed.version)) {
      setShows([]);
      return;
    }
    if (parsed.version > SCHEMA_VERSION) {
      console.warn('[PloppyTV] Schema version futura:', parsed.version, '— atteso', SCHEMA_VERSION);
      const backup = _loadFromBackup();
      if (backup && Array.isArray(backup.shows) && backup.shows.length > 0) {
        const rawShows = backup.shows.map(normalizeShow).filter((s): s is Show => s !== null);
        // BUG-A19-04: dedup by id anche sul path backup recovery.
        const shows = _dedupShowsById(rawShows);
        reconcileAllLists(shows);
        setShows(shows);
        showToast('Versione dati non supportata. Ripristinato backup.', 'warning');
        saveData({ immediate: true });
        return;
      }
      setShows([]);
      showToast('Versione dati non supportata. Usa Importa per ripristinare.', 'error');
      return;
    }
    if (parsed.version < SCHEMA_VERSION) {
      console.warn('[PloppyTV] Schema version passata:', parsed.version, '— atteso', SCHEMA_VERSION);
      // Prosegui — normalizeShow gestisce formati vecchi con defaults.
    }
  }
  if (!Array.isArray(parsed.shows)) {
    setShows([]);
    return;
  }
  const rawShows = parsed.shows.map(normalizeShow).filter((s): s is Show => s !== null);
  // BUG-A19-04: dedup by id (keep first) — localStorage corrotto o race
  // multi-tab può contenere show duplicati per id.
  const shows = _dedupShowsById(rawShows);
  reconcileAllLists(shows);
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
          // BUG-04-04: NON avanza _lastRevision (resta al valore pre-event).
          return;
        }
        // Nessun show locale → safe to wipe.
        setShows([]);
        _lastRevision = { present: false };
        emitChange();
        return;
      }

      const parsed = JSON.parse(ev.newValue) as SavedData;
      if (!parsed || !Array.isArray(parsed.shows)) return;
      // BUG-A19-05b: rigetta version non-numerica (consistente con loadData).
      // Prima un event con version='bad' (stringa) era silenziosamente accettato
      // e sovrascriveva lo stato locale con dati potenzialmente malformati.
      if (parsed.version !== undefined && (typeof parsed.version !== 'number' || !Number.isFinite(parsed.version))) {
        console.warn('[PloppyTV] storage event con version non valida:', parsed.version);
        return;
      }
      // BUG-A4-03: ignora eventi con versione futura non supportata (il formato
      // potrebbe non essere interpretabile da questa versione dell'app).
      if (typeof parsed.version === 'number' && parsed.version > SCHEMA_VERSION) {
        console.warn('[PloppyTV] storage event con version futura:', parsed.version);
        return;
      }
      // BUG-A19-05a: avverte su version passata (consistente con loadData,
      // che logga un warning). Il dato è comunque accettato (normalizeShow è
      // defensive sui formati vecchi).
      if (typeof parsed.version === 'number' && parsed.version < SCHEMA_VERSION) {
        console.warn('[PloppyTV] storage event con version passata:', parsed.version);
      }
      const rawNewShows = parsed.shows.map(normalizeShow).filter((s): s is Show => s !== null);
      // BUG-A19-04: dedup by id (keep first) — consistente con loadData.
      const newShows = _dedupShowsById(rawNewShows);
      reconcileAllLists(newShows);
      // BUG-A4-07: valida savedAt con Number.isFinite (NaN rompe CAS).
      const newSavedAt = _validSavedAt(parsed.savedAt);

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
