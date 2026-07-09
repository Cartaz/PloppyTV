// Renderer principale con code-splitting delle viste

import { getState, openShow, closeShow, switchView } from '../lib/store';
import { initImageFallback } from './imageFallback';
import { updateBadges } from './header';
import { showToast } from './toast';

let _mainEl: HTMLElement | null = null;
let _boundDelegated = false;

function getMain(): HTMLElement {
  if (!_mainEl) _mainEl = document.getElementById('mainContent') as HTMLElement;
  return _mainEl;
}

// Delegazione globale eventi click su [data-action] (un solo handler per tutto il main)
function bindDelegatedEvents(): void {
  if (_boundDelegated) return;
  _boundDelegated = true;
  const main = getMain();
  initImageFallback();

  main.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'openShow') {
      const id = Number(actionEl.dataset.showId);
      if (id) openShow(id);
      return;
    }
    if (action === 'closeShow') {
      closeShow();
      return;
    }
    if (action === 'switchView') {
      const view = actionEl.dataset.view;
      if (view) switchView(view);
      return;
    }
    // Azioni specifiche vista sono gestite nei rispettivi bindXxxEvents
  });
}

let _renderRAF: number | null = null;
let _renderToken = 0;

export function render(): void {
  if (_renderRAF) return;
  _renderRAF = requestAnimationFrame(() => {
    _renderRAF = null;
    _doRender();
  });
}

/**
 * Render di una vista via import dinamico.
 * CRITICAL FIX (C6): wrap in try/catch. Se il chunk 404 (o preview server
 * serve HTML 200 invece del JS), `import()` lancia SyntaxError. Senza
 * catch diventa unhandled rejection e l'UI resta bricked. Con catch
 * mostriamo un fallback UI + toast.
 */
async function safeImport<T>(chunkPromise: Promise<T>, main: HTMLElement): Promise<T | null> {
  try {
    return await chunkPromise;
  } catch (e) {
    console.error('[renderer] chunk load failed:', e);
    main.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-state-title">Errore caricamento vista</div>' +
      '<div class="empty-state-text">Ricarica la pagina per riprovare. Se il problema persiste, svuota la cache del browser.</div>' +
      '<button class="btn btn-primary" style="margin-top:12px;" onclick="location.reload()">Ricarica</button>' +
      '</div>';
    showToast('Errore caricamento modulo — ricarica la pagina', 'error');
    return null;
  }
}

async function _doRender(): Promise<void> {
  const myToken = ++_renderToken;
  const main = getMain();
  const state = getState();

  // Aggiorna nav active
  document.querySelectorAll<HTMLElement>('.nav-item[data-view]').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === state.currentView && !state.currentShowId);
  });

  if (state.currentShowId) {
    const mod = await safeImport(import('../views/showDetail'), main);
    if (myToken !== _renderToken) return;
    if (!mod) return;
    // CRITICAL FIX (C5): reset bound guard PRIMA del bind, così non accumuliamo
    // listener ad ogni re-render. Il modulo è cached, quindi l'oggetto `mod`
    // mantiene lo stato `_boundShowDetail` tra un render e l'altro.
    mod.resetBoundGuard();
    mod.renderShowDetail(main);
    mod.bindShowDetailEvents(main);
    return;
  }

  switch (state.currentView) {
    case 'dashboard': {
      const mod = await safeImport(import('../views/dashboard'), main);
      if (myToken !== _renderToken) return;
      if (!mod) return;
      mod.renderDashboard(main);
      break;
    }
    case 'watching':
    case 'towatch':
    case 'completed': {
      const mod = await safeImport(import('../views/showList'), main);
      const titles: Record<string, string> = { watching: 'In corso', towatch: 'Da vedere', completed: 'Completate' };
      if (myToken !== _renderToken) return;
      if (!mod) return;
      mod.renderShowList(main, state.currentView as 'watching' | 'towatch' | 'completed', titles[state.currentView]);
      break;
    }
    case 'discover': {
      const mod = await safeImport(import('../views/discover'), main);
      if (myToken !== _renderToken) return;
      if (!mod) return;
      mod.resetBoundGuard();
      mod.renderDiscover(main);
      mod.bindDiscoverEvents(main);
      break;
    }
    case 'calendar': {
      const mod = await safeImport(import('../views/calendar'), main);
      if (myToken !== _renderToken) return;
      if (!mod) return;
      mod.resetBoundGuard();
      await mod.renderCalendar(main);
      if (myToken !== _renderToken) return;
      mod.bindCalendarEvents(main);
      break;
    }
    case 'stats': {
      const mod = await safeImport(import('../views/stats'), main);
      if (myToken !== _renderToken) return;
      if (!mod) return;
      await mod.renderStats(main);
      break;
    }
    case 'library': {
      const mod = await safeImport(import('../views/library'), main);
      if (myToken !== _renderToken) return;
      if (!mod) return;
      mod.renderLibrary(main);
      break;
    }
    case 'yearreview': {
      const mod = await safeImport(import('../views/yearReview'), main);
      if (myToken !== _renderToken) return;
      if (!mod) return;
      mod.renderYearReview(main);
      break;
    }
    default: {
      const mod = await safeImport(import('../views/dashboard'), main);
      if (myToken !== _renderToken) return;
      if (!mod) return;
      mod.renderDashboard(main);
    }
  }
}

export function initRenderer(): void {
  bindDelegatedEvents();
  // Update badges al primo render
  updateBadges();
}
