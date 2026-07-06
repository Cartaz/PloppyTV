// Renderer principale con code-splitting delle viste

import { getState, openShow, closeShow, switchView } from '../lib/store';
import { initImageFallback } from './imageFallback';
import { updateBadges } from './header';

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

async function _doRender(): Promise<void> {
  const myToken = ++_renderToken;
  const main = getMain();
  const state = getState();

  // Aggiorna nav active
  document.querySelectorAll<HTMLElement>('.nav-item[data-view]').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === state.currentView && !state.currentShowId);
  });

  if (state.currentShowId) {
    const { renderShowDetail, bindShowDetailEvents } = await import('../views/showDetail');
    if (myToken !== _renderToken) return;
    renderShowDetail(main);
    bindShowDetailEvents(main);
    return;
  }

  switch (state.currentView) {
    case 'dashboard': {
      const { renderDashboard } = await import('../views/dashboard');
      if (myToken !== _renderToken) return;
      renderDashboard(main);
      break;
    }
    case 'watching':
    case 'towatch':
    case 'completed': {
      const { renderShowList } = await import('../views/showList');
      const titles: Record<string, string> = { watching: 'In corso', towatch: 'Da vedere', completed: 'Completate' };
      if (myToken !== _renderToken) return;
      renderShowList(main, state.currentView as 'watching' | 'towatch' | 'completed', titles[state.currentView]);
      break;
    }
    case 'discover': {
      const { renderDiscover, bindDiscoverEvents } = await import('../views/discover');
      if (myToken !== _renderToken) return;
      renderDiscover(main);
      bindDiscoverEvents(main);
      break;
    }
    case 'calendar': {
      const { renderCalendar, bindCalendarEvents } = await import('../views/calendar');
      if (myToken !== _renderToken) return;
      await renderCalendar(main);
      if (myToken !== _renderToken) return;
      bindCalendarEvents(main);
      break;
    }
    case 'stats': {
      const { renderStats } = await import('../views/stats');
      if (myToken !== _renderToken) return;
      await renderStats(main);
      break;
    }
    default: {
      const { renderDashboard } = await import('../views/dashboard');
      if (myToken !== _renderToken) return;
      renderDashboard(main);
    }
  }
}

export function initRenderer(): void {
  bindDelegatedEvents();
  // Update badges al primo render
  updateBadges();
}
