// i18n framework leggero per PloppyTV (P2.7)
//
// Design:
//   - Due locale: 'it' (default) e 'en'.
//   - Lingua salvata in localStorage (PREFS_KEY) e inizializzata da navigator.language.
//   - `t(key, params?)` ritorna la stringa tradotta con interpolazione {param}.
//   - Fallback: se la chiave non esiste nella lingua corrente, prova 'it', poi ritorna la key.
//   - Subscribe pattern: i listener vengono notificati al cambio lingua (per re-render).

import it from '../locales/it.json';
import en from '../locales/en.json';
import { PREFS_KEY } from './constants';

export type Locale = 'it' | 'en';

type Dict = Record<string, string>;

const DICTS: Record<Locale, Dict> = {
  it: it as Dict,
  en: en as Dict,
};

const SUPPORTED: Locale[] = ['it', 'en'];

let _current: Locale = 'it';
let _prefsLoaded = false;

const _listeners = new Set<() => void>();

/**
 * Carica la lingua salvata da localStorage, con fallback su navigator.language.
 * Chiamato una volta all'init. Idempotente.
 */
export function initI18n(): void {
  if (_prefsLoaded) return;
  _prefsLoaded = true;

  // 1. Prova localStorage (scelta esplicita dell'utente)
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const prefs = JSON.parse(raw) as { lang?: unknown };
      // BUG-A8-02 (FIXED): normalizza la lingua salvata in lowercase prima
      // di confrontarla con SUPPORTED. Se l'utente (o una migrazione futura)
      // ha salvato "EN" o "En", veniva rifiutata e si ricadeva su navigator.
      if (typeof prefs.lang === 'string' && prefs.lang.length > 0) {
        const lang = prefs.lang.toLowerCase();
        if (SUPPORTED.includes(lang as Locale)) {
          _current = lang as Locale;
          return;
        }
      }
    }
  } catch {
    // ignore — localStorage non disponibile o JSON corrotto
  }

  // 2. Fallback su navigator.language
  const navLang = (typeof navigator !== 'undefined' && navigator.language) || 'it';
  const navShort = navLang.slice(0, 2).toLowerCase();
  if (navShort === 'en') {
    _current = 'en';
  } else {
    _current = 'it'; // default per tutte le altre lingue
  }
}

/**
 * Imposta la lingua corrente e la persiste in localStorage.
 * Notifica i listener per triggerare un re-render.
 */
export function setLocale(locale: Locale): void {
  if (!SUPPORTED.includes(locale)) return;
  if (_current === locale) return;
  _current = locale;
  // BUG-A8-03 (FIXED): se il JSON esistente in localStorage è corrotto,
  // il vecchio codice usciva dal try senza scrivere nulla, perdendo la
  // nuova preferenza lingua. Ora usiamo un nested try/catch: se il parse
  // fallisce, partiamo da un oggetto vuoto (le preferenze precedenti sono
  // già illeggibili) e salviamo almeno la nuova lingua.
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    let prefs: Record<string, unknown>;
    if (raw) {
      try {
        prefs = JSON.parse(raw) as Record<string, unknown>;
        if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
          prefs = {};
        }
      } catch {
        // JSON corrotto — partiamo da oggetto vuoto.
        prefs = {};
      }
    } else {
      prefs = {};
    }
    prefs.lang = locale;
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore — storage non disponibile (private mode, quota, ecc.)
  }
  _listeners.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.error('[i18n] listener error:', e);
    }
  });
}

export function getLocale(): Locale {
  return _current;
}

export function getAvailableLocales(): Locale[] {
  return [...SUPPORTED];
}

/**
 * Resetta lo stato i18n (solo per testing). NON usare in produzione.
 */
export function _resetI18nForTesting(): void {
  _current = 'it';
  _prefsLoaded = false;
  _listeners.clear();
}

export function subscribeI18n(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Traduce una chiave con interpolazione {param}.
 * Esempio: t('library.results', { count: 5 }) → "5 risultati" (it) / "5 results" (en)
 * Fallback: se la chiave non esiste in _current, prova 'it', poi ritorna la key.
 *
 * BUG-A8-01 (FIXED): l'interpolazione precedentemente costruiva una RegExp
 * per ogni chiave con `new RegExp('\\{' + k + '\\}', 'g')`. Se `k` conteneva
 * metacaratteri regex (es. `(`, `+`, `.`), poteva crashare con SyntaxError
 * ("Unterminated group") o sostituire placeholder errati (es. key `a+b`
 * matchava `{ab}`, `{aab}`). Ora si usa un'unica regex controllata
 * `\{([^{}]+)\}` con lookup in params — nessuna costruzione dinamica di
 * RegExp, nessuna crash, nessuna re-interpolazione di valori annidati.
 *
 * BUG-A8-01b (FIXED): valori null/undefined dei params venivano convertiti
 * in "null"/"undefined" letterali. Ora vengono trattati come stringa vuota.
 *
 * BUG-A8-01c (FIXED): se un valore nel dict era null/non-stringa (es. JSON
 * corrotto con `"key": null`), il `str.replace` crashava con TypeError.
 * Ora verifichiamo `typeof str !== 'string'` prima di interpolare.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let str = DICTS[_current][key];
  // BUG-A8-01c: tratta valori non-stringa (null, number, ecc.) come mancanti.
  if (typeof str !== 'string') {
    // Fallback su italiano
    str = DICTS.it[key];
  }
  if (typeof str !== 'string') {
    // Chiave non trovata: ritorna la key stessa (visibile in dev per debugging)
    return key;
  }
  if (params) {
    // BUG-A8-01: single-pass regex controllata — nessuna costruzione dinamica.
    // I valori sostituiti non vengono re-scansionati (no interpolazione annidata).
    str = str.replace(/\{([^{}]+)\}/g, (match, k: string) => {
      if (Object.prototype.hasOwnProperty.call(params, k)) {
        const v = params[k];
        // BUG-A8-01b: null/undefined → stringa vuota (più user-friendly di "undefined").
        return v == null ? '' : String(v);
      }
      return match; // placeholder non riconosciuto — lascia invariato
    });
  }
  return str;
}
