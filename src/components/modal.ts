// Modal dialog con supporto a stack di modali nested, focus trap, ESC, ARIA.
//
// Lo stack permette di aprire una modale da dentro un'altra modale senza
// che la chiusura del figlio chiuda anche il padre (bug C2/T6). Ogni
// `showModal` pusha uno stato sullo stack; `closeModal` fa pop.
// Il flag `keepOpen` su un'azione impedisce il pop (utile quando l'azione
// apre una seconda modale e il padre deve restare visibile).

export interface ModalAction {
  label: string;
  style?: 'btn-primary' | 'btn-secondary' | 'btn-danger';
  onClick?: () => void;
  keepOpen?: boolean;
}

interface ModalState {
  title: string;
  bodyHtml: string;
  actions: ModalAction[];
  previouslyFocused: HTMLElement | null;
}

let _modalOverlay: HTMLElement | null = null;
let _modalTitle: HTMLElement | null = null;
let _modalBody: HTMLElement | null = null;
let _modalActions: HTMLElement | null = null;
let _modalElement: HTMLElement | null = null; // la card interna

function ensureRefs(): boolean {
  if (!_modalOverlay) _modalOverlay = document.getElementById('modal');
  if (!_modalTitle) _modalTitle = document.getElementById('modalTitle');
  if (!_modalBody) _modalBody = document.getElementById('modalBody');
  if (!_modalActions) _modalActions = document.getElementById('modalActions');
  if (!_modalElement && _modalOverlay) {
    _modalElement = _modalOverlay.querySelector('.modal') as HTMLElement | null;
  }
  return !!(_modalOverlay && _modalTitle && _modalBody && _modalActions);
}

// Stack di modali nested. Il top è quello correntemente visibile.
const _stack: ModalState[] = [];

function renderTop(): void {
  if (!ensureRefs()) return;
  const top = _stack[_stack.length - 1];
  if (!top) {
    _modalOverlay!.classList.remove('active');
    _modalOverlay!.setAttribute('aria-hidden', 'true');
    return;
  }
  _modalTitle!.textContent = top.title;
  _modalBody!.innerHTML = top.bodyHtml;
  _modalActions!.innerHTML = '';
  for (const a of top.actions) {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (a.style || 'btn-secondary');
    btn.textContent = a.label;
    btn.onclick = () => {
      if (a.onClick) a.onClick();
      if (!a.keepOpen) closeModal();
    };
    _modalActions!.appendChild(btn);
  }
  _modalOverlay!.classList.add('active');
  _modalOverlay!.setAttribute('aria-hidden', 'false');
  // ARIA: annuncia il dialog
  _modalOverlay!.setAttribute('role', 'dialog');
  _modalOverlay!.setAttribute('aria-modal', 'true');
  _modalOverlay!.setAttribute('aria-labelledby', 'modalTitle');
  // Focus al primo bottone (o al titolo) per screen reader + keyboard nav
  const firstBtn = _modalActions!.querySelector('button');
  if (firstBtn) (firstBtn as HTMLElement).focus();
  else _modalTitle!.focus();
}

export function showModal(title: string, bodyHtml: string, actions: ModalAction[]): void {
  if (!ensureRefs()) return;
  _stack.push({
    title,
    bodyHtml,
    actions,
    previouslyFocused: document.activeElement as HTMLElement | null,
  });
  renderTop();
}

/**
 * Chiude la modale corrente (top dello stack). Se ci sono modali nested,
 * mostra quella sotto.
 */
export function closeModal(): void {
  const top = _stack.pop();
  renderTop();
  // Ripristina il focus all'elemento che lo aveva prima dell'apertura
  // (solo se non ci sono più modali aperte)
  if (_stack.length === 0 && top?.previouslyFocused) {
    try {
      top.previouslyFocused.focus();
    } catch {
      // ignore
    }
  }
}

/**
 * Chiude tutte le modali (utile per "Annulla" da una catena di conferme).
 */
export function closeAllModals(): void {
  const last = _stack[_stack.length - 1];
  _stack.length = 0;
  renderTop();
  if (last?.previouslyFocused) {
    try {
      last.previouslyFocused.focus();
    } catch {
      // ignore
    }
  }
}

export function initModal(): void {
  if (!ensureRefs()) return;
  // Click sull'overlay (ma non sulla card interna) → close
  _modalOverlay!.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'modal') closeModal();
  });
  // ESC per chiudere (rispetta WAI-ARIA Dialog Pattern)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (_stack.length === 0) return;
    // Se l'azione corrente ha senso di "annulla" (tipicamente il primo bottone),
    // simula il click; altrimenti chiudi e basta.
    e.preventDefault();
    closeModal();
  });
  // Focus trap: Tab sull'ultimo/primo elemento resta dentro il dialog
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    if (_stack.length === 0) return;
    if (!_modalActions) return;
    const focusables = _modalActions.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

export function isModalOpen(): boolean {
  return _stack.length > 0;
}
