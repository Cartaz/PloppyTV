// Entry point: inizializza tutti i moduli e avvia l'app

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
  const knownViews = ['dashboard', 'watching', 'towatch', 'completed', 'discover', 'calendar', 'stats'];
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

// ===== PWA update button dedup (BUG-18-03 fix) =====
// onNeedRefresh può fired multiple volte; evita di stackare N pulsanti.
let _refreshBtnShown = false;

// ===== INIT =====
function init(): void {
  // BUG-18-08 fix: idempotency guard. In dev (HMR) o in qualsiasi meccanismo
  // di re-import del modulo, init() verrebbe rieseguito accumulando listener
  // (hashchange, beforeunload, ploppytv:badges) e duplicando i side effect.
  // Il flag vive su window così sopravvive a vi.resetModules() / HMR.
  const w0 = window as unknown as { __ploppytvInit?: boolean };
  if (w0.__ploppytvInit) return;
  w0.__ploppytvInit = true;

  try {
    initModal();
    initHeader();
    initSearch();
    initExportImport();
    initRenderer();

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
    });

    // Hash routing per PWA shortcuts e deep link
    setupHashRouting();

    // C3 / BUG-18-02 / BUG-18-06 fix: registra beforeunload SOLO dopo che
    // loadData() è andato a buon fine. In precedenza il listener era
    // registrato a livello modulo PRIMA di init(): se init() throwava
    // (es. initRenderer fallisce), lo state restava shows=[] con
    // _lastSavedAt=null → al beforeunload saveData skippava il CAS
    // (both null) e sovrascriveva il localStorage dell'utente con [].
    // Ora il listener viene aggiunto solo se init ha caricato i dati.
    // BUG-18-06: try/catch difensivo attorno a saveData (event-listener
    // throws sono particolarmente hard da debuggare).
    window.addEventListener('beforeunload', () => {
      try {
        saveData({ immediate: true });
      } catch (e) {
        console.warn('[PloppyTV] beforeunload save failed:', e);
      }
    });

    // PWA: register service worker (solo in production)
    // CRITICAL FIX (H2/T4): onNeedRefresh mostra un toast che permette
    // all'utente di triggerare l'update. Senza questo callback, il nuovo
    // SW resterebbe in stato "waiting" indefinitamente e l'utente non
    // riceverebbe mai la nuova versione finché non chiude tutti i tab.
    if ('serviceWorker' in navigator && import.meta.env.PROD) {
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
          // BUG-18-07 fix: il toast NON è cliccabile (toast.ts non registra
          // click handler). Il messaggio precedente diceva "tocca per
          // aggiornare" ma il toast era inerte. Ora indichiamo all'utente
          // dove si trova il pulsante reale (in basso a destra).
          showToast('Nuova versione disponibile (vedi pulsante in basso a destra)', 'warning');
          // BUG-18-03 fix: dedup. Se onNeedRefresh fired N volte, mostra
          // un solo pulsante. Il toast viene ri-mostrato ogni volta per
          // ricordare all'utente la disponibilità dell'update.
          if (_refreshBtnShown) return;
          _refreshBtnShown = true;
          const reloadBtn = document.createElement('button');
          reloadBtn.textContent = 'Aggiorna ora';
          reloadBtn.className = 'btn btn-primary btn-sm';
          reloadBtn.style.cssText =
            'position:fixed;bottom:20px;right:20px;z-index:10000;box-shadow:0 4px 12px rgba(0,0,0,.3);';
          // BUG-18-04 fix: try/catch attorno a updateSW. Se updateSW
          // rejecta (es. skipWaiting fallisce), reload() viene comunque
          // chiamato — il nuovo SW potrebbe attivarsi al load successivo
          // tramite il lifecycle nativo del browser.
          reloadBtn.onclick = async () => {
            try {
              if (updateSW) {
                await updateSW(true);
              }
            } catch (e) {
              console.warn('[PWA] updateSW failed:', e);
            }
            window.location.reload();
          };
          document.body.appendChild(reloadBtn);
          // Auto-rimuovi dopo 30s se l'utente non clicca
          setTimeout(() => {
            reloadBtn.remove();
            _refreshBtnShown = false;
          }, 30000);
        },
      });
      // Esponi updateSW per permettere reload programmatico
      (window as unknown as { __ploppytvUpdateSW?: () => Promise<void> }).__ploppytvUpdateSW = () =>
        updateSW ? updateSW(true) : Promise.resolve();
    }

    // iOS: rileva standalone per nascondere elementi ridondanti
    if (
      (window.navigator && (window.navigator as unknown as { standalone?: boolean }).standalone === true) ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    ) {
      document.documentElement.classList.add('pwa-standalone');
    }

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
  } catch (e) {
    // H13 / BUG-18-01 fix: init() è guarded. Un throw in qualsiasi initX
    // (initRenderer → bindDelegatedEvents → getMain è il sito più probabile)
    // non lascia l'app bricked: logga l'errore e mostra una fallback UI
    // con un pulsante per ricaricare. Senza questo, l'utente vedrebbe una
    // pagina vuota o parzialmente renderizzata senza messaggio.
    console.error('[PloppyTV] init failed:', e);
    const main = document.getElementById('mainContent');
    if (main) {
      main.innerHTML =
        '<div class="empty-state">' +
        '<div class="empty-state-title">Errore di avvio</div>' +
        '<div class="empty-state-text">Ricarica la pagina. Se il problema persiste, svuota la cache del browser.</div>' +
        '<button class="btn btn-primary" style="margin-top:12px;" onclick="location.reload()">Ricarica</button>' +
        '</div>';
    }
  }
}

init();

// Esponi getState per debug in dev
if (import.meta.env.DEV) {
  (window as unknown as { __ploppytv_state?: unknown }).__ploppytv_state = getState;
}
