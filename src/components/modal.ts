// Modal dialog con supporto a stack di modali nested, focus trap, ESC, ARIA.

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
// Guard contro initModal chiamato più volte (HMR, doppio init).
let _modalInitialized = false;

function ensureRefs(): boolean {
  if (!_modalOverlay) _modalOverlay = document.getElementById('modal');
  if (!_modalTitle) _modalTitle = document.getElementById('modalTitle');
  if (!_modalBody) _modalBody = document.getElementById('modalBody');
  if (!_modalActions) _modalActions = document.getElementById('modalActions');
  if (!_modalElement && _modalOverlay) {
    _modalElement = _modalOverlay.querySelector('.modal') as HTMLElement | null;
  }
  // _modalTitle ha tabindex=-1 per permettere .focus().
  if (_modalTitle && !_modalTitle.hasAttribute('tabindex')) {
    _modalTitle.setAttribute('tabindex', '-1');
  }
  return !!(_modalOverlay && _modalTitle && _modalBody && _modalActions);
}

// Stack di modali nested. Il top è quello correntemente visibile.
const _stack: ModalState[] = [];
// L'elemento focusato prima della PRIMA modale (per ripristino finale).
let _firstFocusTarget: HTMLElement | null = null;

function renderTop(): void {
  if (!ensureRefs()) return;
  const top = _stack[_stack.length - 1];
  if (!top) {
    _modalOverlay!.classList.remove('active');
    _modalOverlay!.setAttribute('aria-hidden', 'true');
    // Pulisce body/actions quando nessuna modale è visibile.
    // Prima il contenuto dell'ultima modale restava nel DOM nascosto.
    _modalBody!.innerHTML = '';
    _modalActions!.innerHTML = '';
    // Nessun titolo da annunciare → rimuovi aria-labelledby.
    _modalOverlay!.removeAttribute('aria-labelledby');
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
      // Identity-based check. Cattura il riferimento al top
      // dello stack PRIMA di onClick; dopo, se il top è cambiato (push di
      // un figlio, pop esplicito, o swap close+reopen), skip l'auto-close.
      // Il check depth-based precedente gestiva solo il push: pop e swap
      // causavano double-pop o chiusura della modale sbagliata.
      const topBefore = _stack[_stack.length - 1];
      if (a.onClick) a.onClick();
      if (_stack[_stack.length - 1] !== topBefore) return; // stack changed
      if (!a.keepOpen) closeModal();
    };
    _modalActions!.appendChild(btn);
  }
  _modalOverlay!.classList.add('active');
  _modalOverlay!.setAttribute('aria-hidden', 'false');
  // ARIA: annuncia il dialog
  _modalOverlay!.setAttribute('role', 'dialog');
  _modalOverlay!.setAttribute('aria-modal', 'true');
  // Aria-labelledby solo se c'è un titolo da annunciare.
  if (top.title) {
    _modalOverlay!.setAttribute('aria-labelledby', 'modalTitle');
  } else {
    _modalOverlay!.removeAttribute('aria-labelledby');
  }
  // Focus al primo bottone (o al titolo) per screen reader + keyboard nav
  // Con tabindex=-1, anche il titolo può ricevere focus.
  const firstBtn = _modalActions!.querySelector('button');
  if (firstBtn) (firstBtn as HTMLElement).focus();
  else _modalTitle!.focus();
}

export function showModal(title: string, bodyHtml: string, actions: ModalAction[]): void {
  // Warn (non silent) quando ensureRefs fallisce.
  if (!ensureRefs()) {
    console.warn(
      '[modal] DOM refs non trovati — showModal non può procedere. Assicurati che initModal() sia stato chiamato dopo che il DOM è pronto.',
    );
    return;
  }
  // Salva l'elemento focusato prima della PRIMA modale.
  if (_stack.length === 0) {
    _firstFocusTarget = document.activeElement as HTMLElement | null;
  }
  _stack.push({
    title,
    bodyHtml,
    // Guard difensivo — actions null/undefined non crashano
    // il for-of in renderTop (TypeError: top.actions is not iterable).
    actions: Array.isArray(actions) ? actions : [],
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
  // Guard contro double-init. Senza questo, i listener ESC/Tab/click
  // verrebbero aggiunti ogni volta (HMR, ri-chiamata accidentale), causando
  // double-pop su ESC (due entry poppate per keypress) e focus trap duplicato.
  if (_modalInitialized) return;
  if (!ensureRefs()) return;
  _modalInitialized = true;
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
  // Query su tutta la modal card (body + actions), non solo actions.
  // Selector espanso con textarea, select, summary.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    if (_stack.length === 0) return;
    if (!_modalElement) return;
    const focusables = _modalElement.querySelectorAll<HTMLElement>(
      'button, [href], input, textarea, select, summary, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) {
      // Nessun focusable nel dialog — previeni Tab per non
      // far uscire il focus (il titolo con tabindex=-1 è già focusato).
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (active && _modalElement.contains(active) && !Array.from(focusables).includes(active)) {
      // activeElement è dentro il dialog ma non è focusable
      // (es. il titolo con tabindex=-1, o un <p>). Wrap per mantenere il
      // focus dentro il dialog invece di farlo uscire con Tab naturale.
      e.preventDefault();
      if (e.shiftKey) last.focus();
      else first.focus();
    }
  });
}

export function isModalOpen(): boolean {
  return _stack.length > 0;
}
