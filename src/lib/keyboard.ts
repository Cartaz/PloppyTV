// Keyboard shortcuts globali per PloppyTV (P2.6)
//
// Shortcut implementati:
//   /          → focus search box
//   g d        → vai a Dashboard
//   g c        → vai a Calendario
//   g s        → vai a Statistiche
//   g l        → vai a Libreria
//   g y        → vai ad Anno in TV
//   j / k      → naviga episodi (successivo/precedente) nella vista dettaglio
//   w          → toggle watched sull'episodio focalizzato
//   ?          → mostra/nascondi cheat sheet
//   Escape     → chiudi cheat sheet (o modale)
//
// Design:
//   - Un solo keydown listener globale (document).
//   - Ignora eventi quando si sta scrivendo in input/textarea/contenteditable.
//   - Supporta sequenze (g + lettera) con timeout 800ms.
//   - Cheat sheet come modale (usa il sistema modale esistente).

import { switchView } from './store';
import { isModalOpen } from '../components/modal';
import { showModal } from '../components/modal';
import { t } from './i18n';

let _initialized = false;
let _gPending = false;
let _gTimer: ReturnType<typeof setTimeout> | null = null;

const G_TIMEOUT_MS = 800;

/**
 * Verifica se l'evento keydown originates da un campo di input editabile.
 * In quel caso, NON processiamo shortcut (l'utente sta scrivendo).
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Nell'elenco episodi del dettaglio serie, trova l'episodio focalizzato
 * e sposta il focus al successivo (j) o precedente (k).
 */
function navigateEpisode(direction: 'next' | 'prev'): void {
  const main = document.getElementById('mainContent');
  if (!main) return;
  const items = Array.from(main.querySelectorAll<HTMLElement>('.episode-item[role="button"]'));
  if (items.length === 0) return;
  const current = document.activeElement as HTMLElement | null;
  let idx = items.findIndex((el) => el === current);
  if (idx === -1) {
    // Nessun episodio focalizzato: parti dal primo (next) o ultimo (prev)
    idx = direction === 'next' ? -1 : items.length;
  }
  const nextIdx = direction === 'next' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
  items[nextIdx]?.focus();
}

/**
 * Toggle watched sull'episodio attualmente focalizzato.
 */
function toggleFocusedEpisode(): void {
  const main = document.getElementById('mainContent');
  if (!main) return;
  const focused = document.activeElement as HTMLElement | null;
  if (!focused) return;
  // L'episode-item ha data-action="toggleEpisode"
  const epItem = focused.closest('[data-action="toggleEpisode"]') as HTMLElement | null;
  if (!epItem) return;
  epItem.click();
}

/**
 * Mostra il cheat sheet delle scorciatoie come modale.
 */
export function showCheatSheet(): void {
  const rows: Array<[string, string]> = [
    ['/', t('keyboard.search')],
    ['g d', t('keyboard.dashboard')],
    ['g c', t('keyboard.calendar')],
    ['g s', t('keyboard.stats')],
    ['g l', t('keyboard.library')],
    ['g y', t('keyboard.yearReview')],
    ['j / k', t('keyboard.nextEp') + ' / ' + t('keyboard.prevEp')],
    ['w', t('keyboard.toggleWatched')],
    ['?', t('keyboard.cheatsheetToggle')],
  ];
  const bodyHtml =
    '<div class="cheatsheet">' +
    rows
      .map(
        ([key, desc]) =>
          '<div class="cheatsheet-row"><kbd class="cheatsheet-key">' +
          key +
          '</kbd><span class="cheatsheet-desc">' +
          desc +
          '</span></div>',
      )
      .join('') +
    '</div>';
  showModal(t('keyboard.cheatsheet'), bodyHtml, [{ label: t('keyboard.close') }]);
}

/**
 * Inizializza il listener globale per le scorciatoie da tastiera.
 * Idempotente: può essere chiamato più volte senza duplicare listener.
 */
export function initKeyboard(): void {
  if (_initialized) return;
  _initialized = true;

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Se c'è una modale aperta, lascia che il modal system gestisca ESC/Tab.
    // Permetti solo '?' come override per il cheat sheet.
    if (isModalOpen()) {
      return;
    }

    // Non intercettare shortcut quando si sta scrivendo in un campo.
    // Eccezione: Escape (per chiudere focus/blur) è gestito altrove.
    if (isEditableTarget(e.target)) {
      return;
    }

    // Sequenza "g + lettera"
    if (_gPending) {
      if (_gTimer) {
        clearTimeout(_gTimer);
        _gTimer = null;
      }
      _gPending = false;
      switch (e.key) {
        case 'd':
          e.preventDefault();
          switchView('dashboard');
          return;
        case 'c':
          e.preventDefault();
          switchView('calendar');
          return;
        case 's':
          e.preventDefault();
          switchView('stats');
          return;
        case 'l':
          e.preventDefault();
          switchView('library');
          return;
        case 'y':
          e.preventDefault();
          switchView('yearreview');
          return;
        default:
          // lettera non riconosciuta dopo g — ignora
          return;
      }
    }

    switch (e.key) {
      case 'g':
        e.preventDefault();
        _gPending = true;
        _gTimer = setTimeout(() => {
          _gPending = false;
        }, G_TIMEOUT_MS);
        break;
      case '/':
        e.preventDefault();
        (document.getElementById('searchInput') as HTMLInputElement | null)?.focus();
        break;
      case '?':
        e.preventDefault();
        showCheatSheet();
        break;
      case 'j':
        e.preventDefault();
        navigateEpisode('next');
        break;
      case 'k':
        e.preventDefault();
        navigateEpisode('prev');
        break;
      case 'w':
        e.preventDefault();
        toggleFocusedEpisode();
        break;
    }
  });
}
