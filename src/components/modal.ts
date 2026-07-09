// Modal dialog con supporto a stack di modali nested, focus trap, ESC, ARIA.
//
// FIXES applicati:
//  - BUG-09-01: il default è ora SICURO — un'action che apre una modale nested
//    (senza keepOpen) NON viene chiusa dal closeModal automatico. Il framework
//    rileva il cambio di profondità dello stack e skip il pop.
//  - BUG-09-03: traccia _firstFocusTarget (l'elemento focusato prima della
//    PRIMA modale) e ripristina il focus lì su closeAllModals / closeModal finale.
//  - BUG-09-04: focus trap query su tutta la modal card (body + actions).
//  - BUG-09-05: _modalTitle ha tabindex=-1 → .focus() entra nel dialog.
//  - BUG-09-08: showModal warn (non silent) quando ensureRefs fallisce.

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
  // BUG-09-05: _modalTitle ha tabindex=-1 per permettere .focus().
  if (_modalTitle && !_modalTitle.hasAttribute('tabindex')) {
    _modalTitle.setAttribute('tabindex', '-1');
  }
  return !!(_modalOverlay && _modalTitle && _modalBody && _modalActions);
}

// Stack di modali nested. Il top è quello correntemente visibile.
const _stack: ModalState[] = [];
// BUG-09-03: l'elemento focusato prima della PRIMA modale (per ripristino finale).
let _firstFocusTarget: HTMLElement | null = null;

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
      const depthBefore = _stack.length;
      if (a.onClick) a.onClick();
      const depthAfter = _stack.length;
      // BUG-09-01: se l'onClick ha pushato una nuova modale (depth aumentata),
      // NON chiamare closeModal — il figlio deve restare aperto.
      // keepOpen=true è ancora rispettato come override esplicito.
      if (depthAfter > depthBefore) return; // nested push — skip auto-close
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
  // BUG-09-05: con tabindex=-1, anche il titolo può ricevere focus.
  const firstBtn = _modalActions!.querySelector('button');
  if (firstBtn) (firstBtn as HTMLElement).focus();
  else _modalTitle!.focus();
}

export function showModal(title: string, bodyHtml: string, actions: ModalAction[]): void {
  // BUG-09-08: warn (non silent) quando ensureRefs fallisce.
  if (!ensureRefs()) {
    console.warn(
      '[modal] DOM refs non trovati — showModal non può procedere. Assicurati che initModal() sia stato chiamato dopo che il DOM è pronto.',
    );
    return;
  }
  // BUG-09-03: salva l'elemento focusato prima della PRIMA modale.
  if (_stack.length === 0) {
    _firstFocusTarget = document.activeElement as HTMLElement | null;
  }
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
  // BUG-09-03: ripristina il focus all'elemento che lo aveva prima dell'apertura
  // della PRIMA modale (non della top). Usa _firstFocusTarget quando lo stack
  // è vuoto, altrimenti l'elemento focusato prima della modale che stiamo chiudendo.
  if (_stack.length === 0) {
    const restoreTo = top?.previouslyFocused ?? _firstFocusTarget;
    if (restoreTo) {
      try {
        restoreTo.focus();
      } catch {
        // ignore
      }
    }
    _firstFocusTarget = null;
  }
}

/**
 * Chiude tutte le modali (utile per "Annulla" da una catena di conferme).
 * BUG-09-03: ripristina il focus a _firstFocusTarget (l'elemento focusato
 * prima della PRIMA modale), non al top.previouslyFocused (che potrebbe
 * essere un bottone detached dentro l'overlay nascosto).
 */
export function closeAllModals(): void {
  _stack.length = 0;
  renderTop();
  if (_firstFocusTarget) {
    try {
      _firstFocusTarget.focus();
    } catch {
      // ignore
    }
    _firstFocusTarget = null;
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
  // BUG-09-04: query su tutta la modal card (body + actions), non solo actions.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    if (_stack.length === 0) return;
    if (!_modalElement) return;
    const focusables = _modalElement.querySelectorAll<HTMLElement>(
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
