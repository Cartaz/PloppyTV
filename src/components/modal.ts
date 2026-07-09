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

// BUG-09-02: track the element focused BEFORE the first modal opened, so
// closeAllModals / final closeModal can restore to it instead of to a
// (possibly detached) intermediate modal button.
let _firstFocusTarget: HTMLElement | null = null;

function ensureRefs(): boolean {
  if (!_modalOverlay) _modalOverlay = document.getElementById('modal');
  if (!_modalTitle) _modalTitle = document.getElementById('modalTitle');
  if (!_modalBody) _modalBody = document.getElementById('modalBody');
  if (!_modalActions) _modalActions = document.getElementById('modalActions');
  if (!_modalElement && _modalOverlay) {
    _modalElement = _modalOverlay.querySelector('.modal') as HTMLElement | null;
  }
  // BUG-09-04: allow programmatic focus on the title <div> when there are no
  // action buttons. tabindex=-1 makes it focus()-able without being a Tab stop.
  if (_modalTitle && !_modalTitle.hasAttribute('tabindex')) {
    _modalTitle.setAttribute('tabindex', '-1');
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
    // BUG-09-01: snapshot stack depth before onClick; only auto-close if the
    // onClick did NOT push a nested modal (depth unchanged). This makes the
    // default behavior SAFE: opening a nested modal from an action no longer
    // requires keepOpen:true to avoid the child being popped instantly.
    // keepOpen remains as an explicit override for callers that manipulate the
    // stack in other ways inside onClick.
    btn.onclick = () => {
      const depthBefore = _stack.length;
      if (a.onClick) a.onClick();
      if (!a.keepOpen && _stack.length <= depthBefore) closeModal();
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
  // BUG-09-05: surface the missing-DRefs case with a console.warn instead of
  // a silent no-op, so callers (and tests) notice when showModal is invoked
  // before initModal / before the DOM is ready.
  if (!ensureRefs()) {
    console.warn('[modal] DOM refs missing, cannot show modal');
    return;
  }
  // BUG-09-02: capture the original focus target when the FIRST modal opens
  // (stack transitions from empty → 1). On closeAllModals / final closeModal
  // we restore focus here, not to an intermediate modal's possibly-detached
  // previouslyFocused button.
  const wasEmpty = _stack.length === 0;
  const preFocus = document.activeElement as HTMLElement | null;
  _stack.push({
    title,
    bodyHtml,
    actions,
    previouslyFocused: preFocus,
  });
  if (wasEmpty) {
    _firstFocusTarget = preFocus;
  }
  renderTop();
}

/**
 * Chiude la modale corrente (top dello stack). Se ci sono modali nested,
 * mostra quella sotto.
 */
export function closeModal(): void {
  _stack.pop();
  renderTop();
  // BUG-09-02: when the stack becomes empty, restore focus to the ORIGINAL
  // pre-modal target (captured when the first modal opened), NOT to the popped
  // modal's previouslyFocused (which may have been a button in a parent modal
  // that got detached when this modal was rendered on top).
  if (_stack.length === 0) {
    const target = _firstFocusTarget;
    _firstFocusTarget = null;
    if (target) {
      try {
        target.focus();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Chiude tutte le modali (utile per "Annulla" da una catena di conferme).
 */
export function closeAllModals(): void {
  // BUG-09-02: restore focus to the ORIGINAL pre-modal target (the element
  // focused before the FIRST modal opened), not to the top modal's
  // previouslyFocused (which may be a detached button inside the hidden
  // overlay after the stack clears).
  const target = _firstFocusTarget;
  _firstFocusTarget = null;
  _stack.length = 0;
  renderTop();
  if (target) {
    try {
      target.focus();
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
    // BUG-09-03: query focusables across the WHOLE modal card (body +
    // actions), not just modalActions. This prevents Tab/Shift+Tab from
    // escaping through focusable elements (e.g. <a href> links) injected into
    // modalBody, which is what the About modal does.
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
