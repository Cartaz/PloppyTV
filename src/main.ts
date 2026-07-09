// Entry point: inizializza tutti i moduli e avvia l'app
//
// FIXES applicati (Agent A18):
//  - BUG-A18-01: registerSW wrappato in try/catch — se la registrazione SW
//    lancia (navigator.serviceWorker rotto, virtual module buggy), init non
//    crasha e l'app continua a funzionare senza PWA offline.
//  - BUG-A18-02: init() body wrappato in try/catch con fallback UI. Il
//    listener beforeunload è spostato DENTRO init() DOPO loadData: se init
//    lancia prima di loadData, il listener non viene attaccato, evitando
//    che saveData sovrascriva localStorage valido con state vuoto.
//  - BUG-A18-03: onNeedRefresh dedup — multiple chiamate mostrano un solo
//    bottone "Aggiorna ora". Il flag dedup è resettato dopo l'auto-remove
//    (30s) così un secondo update può mostrare un nuovo bottone.
//  - BUG-A18-04: reloadBtn.onclick catcha reject di updateSW — reload
//    avviene comunque, no unhandled rejection.
//  - BUG-A18-05: toast message chiaro ("vedi pulsante in basso a destra")
//    invece del precedente "tocca per aggiornare" (il toast non è cliccabile).
//  - BUG-A18-06: beforeunload handler wrappa saveData in try/catch.
//  - BUG-A18-07: idempotency guard via __ploppytvInit flag su window —
//    sopravvive a vi.resetModules() (HMR / re-import), evitando listener
//    duplication e double-init.
//  - BUG-A18-08: global error handlers (window.error + unhandledrejection)
//    catturano errori in async chunks (renderer imports, worker client).

import './styles/main.css';
import { getState, subscribe, switchView, openShow } from './lib/store';
import { isStorageOK, loadData, saveData } from './lib/storage';
import { initModal, showModal } from './components/modal';
import { initHeader, updateBadges } from './components/header';
import { initSearch } from './components/search';
import { initExportImport } from './components/exportImport';
import { initRenderer, render } from './components/renderer';
import { preloadDiscover } from './lib/discover';
import { showToast } from './components/toast';
import { initI18n, subscribeI18n } from './lib/i18n';
import { initKeyboard } from './lib/keyboard';
import { initNotifications } from './lib/notifications';
import { registerSW } from 'virtual:pwa-register';

// ===== Hash routing minimale per PWA shortcuts e deep link =====
// PWA shortcuts in vite.config.ts puntano a ./index.html#dashboard, #discover,
// #calendar. Senza handler, l'hash viene ignorato. Qui mappiamo gli hash
// noti alle viste corrispondenti. Supporta anche back/forward del browser.
function applyHash(): void {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return;
  const state = getState();
  // Mappa hash → view
  const knownViews = [
    'dashboard',
    'watching',
    'towatch',
    'completed',
    'discover',
    'calendar',
    'stats',
    'library',
    'yearreview',
  ];
  if (knownViews.includes(hash)) {
    if (state.currentView !== hash || state.currentShowId !== null) {
      switchView(hash);
    }
    return;
  }
  // Deep link a show: #show/<id>
  const showMatch = /^show\/(\d+)$/.exec(hash);
  if (showMatch) {
    const id = Number(showMatch[1]);
    if (id > 0 && state.currentShowId !== id) {
      openShow(id);
    }
    return;
  }
}

function setupHashRouting(): void {
  window.addEventListener('hashchange', applyHash);
  // Applica l'hash iniziale (es. se l'utente apre la PWA da uno shortcut)
  // dopo che i dati sono caricati e il primo render è stato fatto.
  setTimeout(applyHash, 0);
}

// BUG-A18-08: global error handlers per errori non catturati e rejection
// non gestite. Questi catturano errori in async chunks (renderer imports,
// worker client) che altrimenti diventerebbero failure silenti.
function registerGlobalErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    console.error('[PloppyTV] uncaught error:', event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { name?: string } | undefined;
    // AbortError sono attesi (search aborts) — non loggare come errore.
    if (reason && typeof reason === 'object' && reason.name === 'AbortError') {
      return;
    }
    console.error('[PloppyTV] unhandled rejection:', event.reason);
    try {
      showToast('Si è verificato un errore inatteso', 'error');
    } catch {
      // ignore — showToast potrebbe non essere disponibile
    }
  });
}

// BUG-A18-02: fallback UI quando init() fallisce. Mostra un messaggio
// user-friendly nel main content area + logga l'errore in console.
function showFatalError(err: unknown): void {
  console.error('[PloppyTV] init failed:', err);
  try {
    const main = document.getElementById('mainContent');
    if (main) {
      main.innerHTML =
        '<div class="empty-state">' +
        '<div class="empty-state-title">Errore di avvio</div>' +
        '<div class="empty-state-text">Si è verificato un errore imprevisto. Ricarica la pagina per riprovare.</div>' +
        '<button class="btn btn-primary" style="margin-top:12px;" onclick="location.reload()">Ricarica</button>' +
        '</div>';
    }
  } catch {
    // ignore — DOM non disponibile
  }
}

// BUG-A18-01: PWA registration wrappata in try/catch. Se registerSW lancia
// (navigator.serviceWorker rotto, virtual module buggy), init non crasha.
// BUG-A18-03: onNeedRefresh dedup — un solo bottone "Aggiorna ora" alla volta.
// BUG-A18-04: reloadBtn.onclick catcha reject di updateSW.
// BUG-A18-05: toast message chiaro.
function registerPWA(): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  try {
    // BUG-A18-03: track se un bottone è già visibile per evitare duplicati.
    let updateBtn: HTMLButtonElement | null = null;
    let autoRemoveTimer: ReturnType<typeof setTimeout> | null = null;
    const updateSW = registerSW({
      immediate: true,
      onRegistered(reg) {
        // Intenzionalmente silenzioso: il log in console è rumore in produzione.
        void reg;
      },
      onRegisterError(err) {
        console.warn('[PWA] SW registration failed:', err);
      },
      onNeedRefresh() {
        // Nuova versione del SW disponibile (in stato waiting).
        // BUG-A18-05: toast message chiaro — il toast non è cliccabile,
        // il bottone di aggiornamento è in basso a destra.
        showToast('Nuova versione disponibile (vedi pulsante in basso a destra)', 'warning');
        // BUG-A18-03: dedup — se un bottone è già visibile, non aggiungerne un altro.
        // Il toast è comunque re-mostrato ogni volta per ricordare all'utente.
        if (updateBtn) return;
        const reloadBtn = document.createElement('button');
        reloadBtn.textContent = 'Aggiorna ora';
        reloadBtn.className = 'btn btn-primary btn-sm';
        reloadBtn.style.cssText =
          'position:fixed;bottom:20px;right:20px;z-index:10000;box-shadow:0 4px 12px rgba(0,0,0,.3);';
        reloadBtn.onclick = async () => {
          // BUG-A18-03: cancella l'auto-remove timer visto che l'utente ha cliccato.
          if (autoRemoveTimer) {
            clearTimeout(autoRemoveTimer);
            autoRemoveTimer = null;
          }
          // BUG-A18-04: catch updateSW rejection — reload deve comunque avvenire.
          try {
            if (updateSW) {
              await updateSW(true);
            }
          } catch (e) {
            console.warn('[PWA] updateSW failed:', e);
          }
          // Reload anyway (updateSW(true) may or may not have reloaded).
          try {
            window.location.reload();
          } catch {
            // jsdom: "Not implemented" — ignore in test env
          }
        };
        document.body.appendChild(reloadBtn);
        updateBtn = reloadBtn;
        // Auto-rimuovi dopo 30s se l'utente non clicca.
        // BUG-A18-03 follow-up: reset del flag dedup così un successivo
        // onNeedRefresh può mostrare un nuovo bottone (es. secondo SW update).
        autoRemoveTimer = setTimeout(() => {
          if (updateBtn) {
            updateBtn.remove();
            updateBtn = null;
          }
          autoRemoveTimer = null;
        }, 30000);
      },
    });
    // Esponi updateSW per permettere reload programmatico
    (window as unknown as { __ploppytvUpdateSW?: () => Promise<void> }).__ploppytvUpdateSW = () =>
      updateSW ? updateSW(true) : Promise.resolve();
  } catch (e) {
    // BUG-A18-01: registerSW non deve crashare init.
    console.warn('[PWA] registerSW threw:', e);
  }
}

function detectStandalone(): void {
  try {
    // iOS: rileva standalone per nascondere elementi ridondanti
    if (
      (window.navigator &&
        (window.navigator as unknown as { standalone?: boolean }).standalone === true) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    ) {
      document.documentElement.classList.add('pwa-standalone');
    }
  } catch (e) {
    // Safari può lanciare su matchMedia in casi rari.
    console.warn('[PWA] standalone detection failed:', e);
  }
}

// ===== INIT =====
function init(): void {
  // BUG-A18-07: idempotency guard. Il flag su window sopravvive a
  // vi.resetModules() (HMR / re-import), così il secondo import non
  // re-registra listener (hashchange, beforeunload, error, unhandledrejection)
  // e non re-runna initX (evitando double-bind, double-save, ecc.).
  const w = window as unknown as { __ploppytvInit?: boolean };
  if (w.__ploppytvInit) return;
  w.__ploppytvInit = true;

  // BUG-A18-08: registra gli error handler globali PRIMA di qualsiasi init
  // step che potrebbe lanciare. Così catturano anche errori durante init.
  registerGlobalErrorHandlers();

  try {
    // P2.7: inizializza i18n PRIMA del render (le viste usano t()).
    initI18n();

    initModal();
    initHeader();
    initSearch();
    initExportImport();
    initRenderer();

    // P2.6: keyboard shortcuts
    initKeyboard();

    // Modalità privata: avvisa l'utente
    if (!isStorageOK()) {
      showModal(
        'Modalità di navigazione privata',
        '<p>Il tuo browser non permette il salvataggio locale (modalità privata o storage disabilitato).</p>' +
          '<p>Puoi usare PloppyTV, ma <strong>tutti i dati andranno persi al ricaricamento</strong>.</p>' +
          '<p>Per la persistenza, disattiva la modalità privata o abilita i cookie/storage nelle impostazioni.</p>',
        [{ label: 'Ho capito', style: 'btn-primary' }],
      );
    }

    // Carica dati dal localStorage
    loadData();
    updateBadges();

    // Render iniziale + subscribe ai cambi di stato
    render();
    subscribe(() => {
      render();
      // P2.9: re-schedula notifiche quando lo stato cambia
      window.dispatchEvent(new CustomEvent('ploppytv:reschedule-notifications'));
    });

    // P2.7: re-render al cambio lingua
    subscribeI18n(() => {
      render();
    });

    // Hash routing per PWA shortcuts e deep link
    setupHashRouting();

    // P2.9: inizializza notifiche (se l'utente le aveva attivate)
    initNotifications();

    // PWA: register service worker (solo in production)
    registerPWA();

    detectStandalone();

    // Preload in background dei dati Discover (serie popolari + recenti).
    // Delay di 1.5s per non competere con il render iniziale e il caricamento
    // della dashboard. In questo modo, quando l'utente clicca su "Scopri",
    // i dati sono già pronti (o in corso di caricamento) e non c'è attesa.
    // Salto il preload in modalità privata (storage disabilitato): Discover è
    // già disabilitato lì.
    if (isStorageOK()) {
      setTimeout(() => {
        try {
          preloadDiscover();
        } catch (e) {
          console.warn('[discover] preload error:', e);
        }
      }, 1500);
    }

    // BUG-A18-02: beforeunload registrato DENTRO init() DOPO loadData.
    // Se init lancia prima di loadData (es. initRenderer throw), il listener
    // non viene attaccato → saveData NON viene chiamato su tab close →
    // evita di sovrascrivere localStorage valido con state vuoto.
    // BUG-A18-06: saveData avvolto in try/catch — un throw del modulo storage
    // (es. SecurityError in casi rari) non deve crashare il listener.
    window.addEventListener('beforeunload', () => {
      try {
        saveData({ immediate: true });
      } catch (e) {
        console.warn('[PloppyTV] saveData on beforeunload failed:', e);
      }
    });
  } catch (e) {
    // BUG-A18-02: init() non deve lanciare. Mostra fallback UI + logga.
    showFatalError(e);
  }
}

init();

// Esponi getState per debug in dev
if (import.meta.env.DEV) {
  (window as unknown as { __ploppytv_state?: unknown }).__ploppytv_state = getState;
}
