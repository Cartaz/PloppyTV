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
      const prefs = JSON.parse(raw) as { lang?: string };
      if (prefs.lang && SUPPORTED.includes(prefs.lang as Locale)) {
        _current = prefs.lang as Locale;
        return;
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
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const prefs = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    prefs.lang = locale;
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore — storage non disponibile
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
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let str = DICTS[_current][key];
  if (str === undefined) {
    // Fallback su italiano
    str = DICTS.it[key];
  }
  if (str === undefined) {
    // Chiave non trovata: ritorna la key stessa (visibile in dev per debugging)
    return key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
  }
  return str;
}
