// Notifiche locali per nuovi episodi (P2.9)
//
// Nessun backend e nessuna Push API: i timer vivono nel contesto della pagina.
// Quando scattano, preferiamo ServiceWorkerRegistration.showNotification(),
// necessario sui browser mobile; Notification() resta un fallback desktop.
// La pianificazione è best-effort: se la PWA è completamente chiusa, il Web
// platform non offre oggi un timer locale, preciso e cross-browser che possa
// riattivarla a un orario arbitrario.

import { getState } from './store';
import type { Show } from '../types';
import { unwatchedEpisodesByAirdate, type DatedEpisode } from './utils';
import { PREFS_KEY, NOTIF_HOUR, NOTIF_RESCHEDULE_INTERVAL_MS, NOTIF_MAX_DELAY_MS } from './constants';
import { t } from './i18n';

interface Prefs {
  notificationsEnabled?: boolean;
}

let _scheduledTimers: ReturnType<typeof setTimeout>[] = [];
let _rescheduleTimer: ReturnType<typeof setTimeout> | null = null;
let _initialized = false;
// Salviamo il riferimento al listener per poterlo
// rimuovere in disposeNotifications.
let _rescheduleListener: (() => void) | null = null;

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Prefs;
    }
  } catch {
    // ignore
  }
  return {};
}

function savePrefs(prefs: Prefs): void {
  try {
    const existing = { ...loadPrefs(), ...prefs };
    localStorage.setItem(PREFS_KEY, JSON.stringify(existing));
  } catch {
    // ignore
  }
}

/**
 * Verifica se l'app è in esecuzione come PWA installata (standalone).
 */
export function isPwaStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS Safari
  if ((window.navigator as unknown as { standalone?: boolean }).standalone === true) return true;
  // Android/Chrome
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  return false;
}

/**
 * Verifica se le notifiche sono supportate dal browser.
 */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Verifica se le notifiche sono attualmente abilitate (opt-in dell'utente + permission granted).
 */
export function notificationsEnabled(): boolean {
  if (!notificationsSupported()) return false;
  return Notification.permission === 'granted' && loadPrefs().notificationsEnabled === true;
}

/**
 * Richiede il permesso per le notifiche. Se concesso, attiva le notifiche
 * e schedula immediatamente.
 * Ritorna true se l'attivazione ha avuto successo.
 */
export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (!isPwaStandalone()) {
    // Permettiamo l'attivazione anche non in standalone, ma mostriamo un warning.
    // L'utente può decidere di installare la PWA dopo.
    console.warn('[notifications] Not in PWA standalone mode — notifications will only fire while app is open.');
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;
    savePrefs({ notificationsEnabled: true });
    scheduleNotifications();
    return true;
  } catch (e) {
    console.error('[notifications] requestPermission error:', e);
    return false;
  }
}

/**
 * Disattiva le notifiche (opt-out). Non revoca il permission a livello browser
 * (l'utente può farlo manualmente dalle impostazioni).
 */
export function disableNotifications(): void {
  savePrefs({ notificationsEnabled: false });
  clearScheduledNotifications();
}

/**
 * Cancella tutti i timer schedulati.
 */
function clearScheduledNotifications(): void {
  for (const timer of _scheduledTimers) {
    clearTimeout(timer);
  }
  _scheduledTimers = [];
  if (_rescheduleTimer) {
    clearTimeout(_rescheduleTimer);
    _rescheduleTimer = null;
  }
}

async function showLocalNotification(title: string, options: NotificationOptions): Promise<void> {
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.showNotification(title, options);
        return;
      }
    } catch (e) {
      console.warn('[notifications] service worker notification failed:', e);
    }
  }

  // Desktop fallback. Su molti browser mobile il costruttore Notification non
  // è disponibile anche quando il permesso è granted, da qui il path SW sopra.
  new Notification(title, options);
}

function notificationIconUrl(): string {
  try {
    return new URL('icons/icon-192.png', document.baseURI).href;
  } catch {
    return 'icons/icon-192.png';
  }
}

/** Mezzanotte locale di oggi: un episodio con airdate di oggi è ancora "in uscita". */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Prima uscita non vista da oggi in poi (chi è indietro riceve comunque l'avviso). */
function nextUpcomingEpisode(show: Show): DatedEpisode | null {
  const today = startOfToday();
  return unwatchedEpisodesByAirdate(show).find((ep) => ep.date >= today) ?? null;
}

/**
 * Schedula una notifica per la prossima uscita di ogni serie "watching".
 * TVMaze fornisce solo la data (senza orario), quindi l'avviso parte alle
 * NOTIF_HOUR locali del giorno di uscita.
 */
export function scheduleNotifications(): void {
  clearScheduledNotifications();

  if (!notificationsEnabled()) return;

  const state = getState();
  const now = Date.now();

  for (const show of state.shows) {
    if (show.list !== 'watching') continue;
    const nextEp = nextUpcomingEpisode(show);
    if (!nextEp) continue;

    const notifDate = new Date(nextEp.date);
    notifDate.setHours(NOTIF_HOUR, 0, 0, 0);
    const notifTime = notifDate.getTime();

    // Già passata (margine di 1 minuto) o oltre il limite di setTimeout
    // (2^31-1 ms): il re-schedule periodico la riprenderà più avanti.
    if (notifTime <= now + 60000) continue;
    if (notifTime > now + NOTIF_MAX_DELAY_MS) continue;

    const showName = show.name;
    const season = nextEp.season;
    const epNum = nextEp.num;

    const timer = setTimeout(() => {
      const title = t('notifications.episodeAirs', {
        show: showName,
        season: String(season),
        ep: String(epNum),
      });
      const body = showName + ' — S' + season + 'E' + epNum;
      const icon = notificationIconUrl();
      void showLocalNotification(title, {
        body,
        icon,
        badge: icon,
        tag: 'ploppytv-' + show.id + '-' + season + '-' + epNum,
      }).catch((e) => {
        console.warn('[notifications] show error:', e);
      });
    }, notifTime - now);

    _scheduledTimers.push(timer);
  }

  // Re-scheduling periodico per cogliere nuovi episodi/airdate
  _rescheduleTimer = setTimeout(() => {
    scheduleNotifications();
  }, NOTIF_RESCHEDULE_INTERVAL_MS);
}

/**
 * Inizializza il sistema notifiche. Da chiamare all'avvio dell'app.
 * Se l'utente aveva già attivato le notifiche, le re-schedula.
 * Idempotente.
 */
export function initNotifications(): () => void {
  if (_initialized) return disposeNotifications;
  _initialized = true;

  if (notificationsEnabled()) {
    scheduleNotifications();
  }

  // Re-schedula quando lo stato cambia (es. aggiunta/rimozione serie, toggle episodio)
  // Usiamo un evento custom per evitare import circolari con store.ts
  // Salviamo il riferimento per poterlo rimuovere.
  _rescheduleListener = () => {
    if (notificationsEnabled()) {
      scheduleNotifications();
    }
  };
  window.addEventListener('ploppytv:reschedule-notifications', _rescheduleListener);
  return disposeNotifications;
}

/** Annulla i timer e rimuove il listener di re-scheduling (cleanup di initNotifications). */
function disposeNotifications(): void {
  clearScheduledNotifications();
  if (_rescheduleListener) {
    window.removeEventListener('ploppytv:reschedule-notifications', _rescheduleListener);
    _rescheduleListener = null;
  }
  _initialized = false;
}

/**
 * Restituisce il prossimo episodio notificabile (per mostrare un'anteprima nell'UI).
 */
export function getNextNotifiableEpisode(): {
  showName: string;
  season: number;
  num: number;
  airdate: string;
} | null {
  const state = getState();
  let earliest: { showName: string; season: number; num: number; airdate: string; time: number } | null = null;

  for (const show of state.shows) {
    if (show.list !== 'watching') continue;
    const nextEp = nextUpcomingEpisode(show);
    if (!nextEp) continue;
    const time = nextEp.date.getTime();
    if (!earliest || time < earliest.time) {
      earliest = { showName: show.name, season: nextEp.season, num: nextEp.num, airdate: nextEp.airdate, time };
    }
  }
  if (!earliest) return null;
  return {
    showName: earliest.showName,
    season: earliest.season,
    num: earliest.num,
    airdate: earliest.airdate,
  };
}
