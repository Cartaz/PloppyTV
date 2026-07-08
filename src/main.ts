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

// ===== INIT =====
function init(): void {
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
      [{ label: 'Ho capito', style: 'btn-primary' }]
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

  // PWA: register service worker (solo in production)
  // CRITICAL FIX (H2/T4): onNeedRefresh mostra un toast che permette
  // all'utente di triggerare l'update. Senza questo callback, il nuovo
  // SW resterebbe in stato "waiting" indefinitamente e l'utente non
  // riceverebbe mai la nuova versione finché non chiude tutti i tab.
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    const updateSW = registerSW({
      immediate: true,
      onRegistered(reg) {
        console.log('[PWA] SW registered:', reg?.scope);
      },
      onRegisterError(err) {
        console.warn('[PWA] SW registration failed:', err);
      },
      onNeedRefresh() {
        // Nuova versione del SW disponibile (in stato waiting).
        // Mostra un toast persistente con pulsante per aggiornare.
        showToast('Nuova versione disponibile — tocca per aggiornare', 'warning');
        const reloadBtn = document.createElement('button');
        reloadBtn.textContent = 'Aggiorna ora';
        reloadBtn.className = 'btn btn-primary btn-sm';
        reloadBtn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:10000;box-shadow:0 4px 12px rgba(0,0,0,.3);';
        reloadBtn.onclick = async () => {
          if (updateSW) {
            await updateSW(true);
          }
          window.location.reload();
        };
        document.body.appendChild(reloadBtn);
        // Auto-rimuovi dopo 30s se l'utente non clicca
        setTimeout(() => reloadBtn.remove(), 30000);
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
}

// Auto-save on unload (best-effort)
window.addEventListener('beforeunload', () => {
  saveData({ immediate: true });
});

init();

// Esponi getState per debug in dev
if (import.meta.env.DEV) {
  (window as unknown as { __ploppytv_state?: unknown }).__ploppytv_state = getState;
}
