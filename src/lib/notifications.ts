// Notifiche push per nuovi episodi (P2.9)
//
// Design:
//   - Usa la Notification API (non Push API con server, che richiederebbe un backend).
//   - Schedula notifiche locali 1 ora prima dell'airdate degli episodi delle serie in "watching".
//   - Permission richiesta esplicitamente dall'utente (opt-in).
//   - Funziona solo se l'app è installata come PWA (display-mode: standalone).
//   - Re-scheduling automatico ogni 6 ore per cogliere nuovi episodi/airdate.
//   - Persiste lo stato (enabled/disabled) in localStorage (PREFS_KEY).
//
// Limiti:
//   - Le notifiche programmate con setTimeout non sopravvivono al reload della pagina.
//     Al reload, re-scheduliamo tutto. Questo è accettabile per una PWA hobby.
//   - Se l'app è chiusa (non in background), le notifiche non vengono mostrate.
//     Per notifiche true background servirebbe il Push API + server, che è out of scope.

import { getState } from './store';
import { findNextEpisode, parseISODateLocal } from './utils';
import { PREFS_KEY, NOTIF_LEAD_TIME_MS, NOTIF_RESCHEDULE_INTERVAL_MS, NOTIF_MAX_DELAY_MS } from './constants';
import { t } from './i18n';

interface Prefs {
  notificationsEnabled?: boolean;
}

let _scheduledTimers: ReturnType<typeof setTimeout>[] = [];
let _rescheduleTimer: ReturnType<typeof setTimeout> | null = null;
let _initialized = false;
// BUG-A8-09 (FIXED): salviamo il riferimento al listener per poterlo
// rimuovere in _resetNotificationsForTesting (e in futuro in un eventuale
// destroyNotifications per HMR). Prima il listener era anonimo e accumulava
// in test con module reload.
let _rescheduleListener: (() => void) | null = null;

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return JSON.parse(raw) as Prefs;
  } catch {
    // ignore
  }
  return {};
}

function savePrefs(prefs: Prefs): void {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const existing = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    Object.assign(existing, prefs);
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

/**
 * Schedula notifiche per i prossimi episodi delle serie in "watching".
 * Per ogni serie, prende il nextEpisode (se ha airdate nel futuro) e
 * schedula una notifica 1 ora prima.
 *
 * Le notifiche con tempo negativo (episodio già passato o lead time superato)
 * vengono saltate.
 */
export function scheduleNotifications(): void {
  clearScheduledNotifications();

  if (!notificationsEnabled()) return;

  const state = getState();
  const now = Date.now();
  let scheduledCount = 0;

  for (const show of state.shows) {
    if (show.list !== 'watching') continue;
    const nextEp = findNextEpisode(show);
    if (!nextEp || !nextEp.airdate) continue;

    // Parsa l'airdate. Gli episodi TVMaze hanno solo data (senza orario),
    // quindi assumiamo ora di messa in onda = mezzanotte locale.
    // Una notifica 1h prima della mezzanotte = 23:00 del giorno precedente.
    // Questo è un limite accettabile per una PWA hobby.
    const epDate = parseISODateLocal(nextEp.airdate);
    if (!epDate) continue;

    const epTime = epDate.getTime();
    const notifTime = epTime - NOTIF_LEAD_TIME_MS;

    // Salta se la notifica dovrebbe già essere passata (con un margine di 1 minuto)
    if (notifTime <= now + 60000) continue;

    // BUG-A8-04 (FIXED): salta se la notifica eccede il delay massimo sicuro
    // per setTimeout (2^31-1 ms ~ 24.85 giorni). Prima il guard era 30 giorni
    // (2.59B ms > 2^31-1), causando overflow int32 e fire immediato del timer.
    // Ora usiamo NOTIF_MAX_DELAY_MS (24 giorni) — il re-schedule periodico
    // ogni 6h riprendera' le notifiche quando rientrano in finestra.
    if (notifTime > now + NOTIF_MAX_DELAY_MS) continue;

    const showName = show.name;
    const season = nextEp.season;
    const epNum = nextEp.num;

    // BUG-A8-11 (FIXED): defense-in-depth — se season/epNum non sono finiti
    // (non dovrebbe succedere dopo BUG-A3-07, ma per sicurezza), salta la
    // notifica invece di creare un body/tag malformato ("SNaNEInfinity").
    if (!Number.isFinite(season) || !Number.isFinite(epNum)) continue;

    const timer = setTimeout(() => {
      try {
        const title = t('notifications.episodeAirs', {
          show: showName,
          season: String(season),
          ep: String(epNum),
        });
        const body = showName + ' — S' + season + 'E' + epNum;
        new Notification(title, {
          body,
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          tag: 'ploppytv-' + show.id + '-' + season + '-' + epNum,
        });
      } catch (e) {
        console.warn('[notifications] show error:', e);
      }
    }, notifTime - now);

    _scheduledTimers.push(timer);
    scheduledCount++;
  }

  // Re-scheduling periodico per cogliere nuovi episodi/airdate
  _rescheduleTimer = setTimeout(() => {
    scheduleNotifications();
  }, NOTIF_RESCHEDULE_INTERVAL_MS);

  if (scheduledCount > 0) {
    console.warn('[notifications] ' + scheduledCount + ' notifications scheduled');
  }
}

/**
 * Inizializza il sistema notifiche. Da chiamare all'avvio dell'app.
 * Se l'utente aveva già attivato le notifiche, le re-schedula.
 * Idempotente.
 */
export function initNotifications(): void {
  if (_initialized) return;
  _initialized = true;

  if (notificationsEnabled()) {
    scheduleNotifications();
  }

  // Re-schedula quando lo stato cambia (es. aggiunta/rimozione serie, toggle episodio)
  // Usiamo un evento custom per evitare import circolari con store.ts
  // BUG-A8-09 (FIXED): salviamo il riferimento per poterlo rimuovere.
  _rescheduleListener = () => {
    if (notificationsEnabled()) {
      scheduleNotifications();
    }
  };
  window.addEventListener('ploppytv:reschedule-notifications', _rescheduleListener);
}

/**
 * Resetta lo stato delle notifiche (solo per testing). Rimuove il listener
 * window, cancella tutti i timer e resetta il flag _initialized.
 * NON usare in produzione.
 */
export function _resetNotificationsForTesting(): void {
  clearScheduledNotifications();
  if (_rescheduleListener) {
    try {
      window.removeEventListener('ploppytv:reschedule-notifications', _rescheduleListener);
    } catch {
      // ignore — window non disponibile o listener già rimosso
    }
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
  const now = Date.now();

  for (const show of state.shows) {
    if (show.list !== 'watching') continue;
    const nextEp = findNextEpisode(show);
    if (!nextEp || !nextEp.airdate) continue;
    const epDate = parseISODateLocal(nextEp.airdate);
    if (!epDate) continue;
    const time = epDate.getTime();
    if (time <= now) continue;
    if (!earliest || time < earliest.time) {
      earliest = {
        showName: show.name,
        season: nextEp.season,
        num: nextEp.num,
        airdate: nextEp.airdate,
        time,
      };
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
