// Entry point: inizializza tutti i moduli e avvia l'app

import './styles/main.css';
import { getState, subscribe } from './lib/store';
import { isStorageOK, loadData, saveData } from './lib/storage';
import { initModal, showModal } from './components/modal';
import { initHeader, updateBadges } from './components/header';
import { initSearch } from './components/search';
import { initExportImport } from './components/exportImport';
import { initRenderer, render } from './components/renderer';
import { preloadDiscover } from './lib/discover';
import { registerSW } from 'virtual:pwa-register';

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

  // PWA: register service worker (solo in production)
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    registerSW({
      immediate: true,
      onRegistered(reg) {
        console.log('[PWA] SW registered:', reg?.scope);
      },
      onRegisterError(err) {
        console.warn('[PWA] SW registration failed:', err);
      },
    });
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
