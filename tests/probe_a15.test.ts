// Agent A15 — probe tests for src/components/modal.ts + src/components/toast.ts
//
// Copre i BUG-A15-0X fixati in questo task:
//  - BUG-A15-01: initModal double-bind guard (no duplicate ESC/Tab/click listeners)
//  - BUG-A15-02: onClick reentrancy (pop, swap, closeAllModals) — identity check
//  - BUG-A15-03: focus trap selector include textarea, select, summary
//  - BUG-A15-04: focus trap quando non ci sono focusable o activeElement non
//    focusable ma dentro il dialog (es. titolo tabindex=-1)
//  - BUG-A15-05: body/actions puliti quando lo stack si svuota
//  - BUG-A15-06: aria-labelledby rimosso quando titolo vuoto / stack vuoto
//  - BUG-A15-07: dismissToast API + timer cleared
//  - BUG-A15-08: showToast null/undefined → stringa vuota (non "null"/"undefined")
//
// Inoltre: stack 3+ livelli, ESC chiude solo top, memory (no duplicate listener
// su reopen), toast replacement (timer reset).

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  showModal,
  closeModal,
  closeAllModals,
  initModal,
  isModalOpen,
} from '../src/components/modal';
import { showToast, dismissToast } from '../src/components/toast';

// DOM speculare a index.html (modal + toast) + outside button per focus-restore.
const MODAL_HTML = `
<div class="modal-overlay" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" aria-hidden="true">
  <div class="modal" tabindex="-1">
    <div class="modal-title" id="modalTitle"></div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-actions" id="modalActions"></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<button id="outsideBtn">Outside</button>
`;

beforeAll(() => {
  document.body.innerHTML = MODAL_HTML;
  initModal();
});

beforeEach(() => {
  closeAllModals();
  dismissToast();
  // Reset toast class/text (dismissToast rimuove solo 'show')
  const toast = document.getElementById('toast')!;
  toast.className = 'toast';
  toast.textContent = '';
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- helpers ----
function currentTitle(): string {
  return document.getElementById('modalTitle')!.textContent || '';
}
function isOverlayActive(): boolean {
  return document.getElementById('modal')!.classList.contains('active');
}
function actionButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('#modalActions button'));
}
function fireKey(key: string, shiftKey = false): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey,
  });
  document.dispatchEvent(ev);
  return ev;
}

// =====================================================================
// BUG-A15-01: initModal double-bind guard
// =====================================================================
describe('BUG-A15-01: initModal double-bind guard', () => {
  it('chiamare initModal più volte NON duplica il listener ESC (single pop per ESC)', () => {
    initModal();
    initModal();
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    showModal('B', '<p>b</p>', [{ label: 'OK' }]);
    expect(currentTitle()).toBe('B');
    // ESC deve poppare UNA sola modale (B), non due.
    fireKey('Escape');
    expect(currentTitle()).toBe('A');
    expect(isModalOpen()).toBe(true);
    closeModal();
  });

  it('initModal multipla NON duplica il click handler (single close per backdrop click)', () => {
    initModal();
    initModal();
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    showModal('B', '<p>b</p>', [{ label: 'OK' }]);
    const overlay = document.getElementById('modal')!;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Deve chiudere solo B (un pop), non entrambe.
    expect(currentTitle()).toBe('A');
    expect(isModalOpen()).toBe(true);
    closeModal();
  });

  it('initModal multipla NON duplica il focus trap (Tab wrappa una sola volta)', () => {
    initModal();
    showModal('T', '<p>x</p>', [{ label: 'Only' }]);
    const btn = actionButtons()[0];
    btn.focus();
    // Tab sul last focusable (btn, che è anche first) → preventDefault + focus first.
    // Se il trap fosse duplicato, il secondo handler sposterebbe il focus ancora.
    fireKey('Tab', false);
    expect(document.activeElement).toBe(btn);
  });
});

// =====================================================================
// BUG-A15-02: onClick reentrancy — identity-based check
// =====================================================================
describe('BUG-A15-02: onClick reentrancy (pop / swap / closeAll gestiti)', () => {
  it('onClick che chiama closeModal NON causa double-pop', () => {
    showModal('A', '<p>a</p>', [
      {
        label: 'Close self',
        onClick: () => closeModal(),
      },
    ]);
    expect(isModalOpen()).toBe(true);
    expect(() => actionButtons()[0].click()).not.toThrow();
    expect(isModalOpen()).toBe(false);
  });

  it('onClick che chiama closeModal da una modale nested NON chiude anche il parent', () => {
    showModal('Parent', '<p>p</p>', [{ label: 'OK' }]);
    showModal('Child', '<p>c</p>', [
      {
        label: 'Close me only',
        onClick: () => closeModal(), // dovrebbe chiudere solo Child
      },
    ]);
    expect(currentTitle()).toBe('Child');
    actionButtons()[0].click();
    // FIXED: solo Child è chiusa; Parent resta aperta.
    expect(currentTitle()).toBe('Parent');
    expect(isModalOpen()).toBe(true);
    closeModal();
  });

  it('onClick che chiude e riapre (swap) NON chiude la nuova modale', () => {
    let swappedTo = '';
    showModal('A', '<p>a</p>', [
      {
        label: 'Swap',
        onClick: () => {
          closeModal();
          showModal('B', '<p>b</p>', [{ label: 'OK' }]);
          swappedTo = 'B';
        },
      },
    ]);
    actionButtons()[0].click();
    expect(swappedTo).toBe('B');
    // FIXED: la nuova modale B resta aperta. Senza fix, l'auto-close
    // poppava B (depth invariato: 1 → 1).
    expect(currentTitle()).toBe('B');
    expect(isModalOpen()).toBe(true);
    closeModal();
  });

  it('onClick che chiama closeAllModals NON causa extra pop', () => {
    showModal('Parent', '<p>p</p>', [{ label: 'OK' }]);
    showModal('Child', '<p>c</p>', [
      {
        label: 'Close all',
        onClick: () => closeAllModals(),
      },
    ]);
    expect(() => actionButtons()[0].click()).not.toThrow();
    expect(isModalOpen()).toBe(false);
  });

  it('regression: onClick no-op + no keepOpen → auto-close依然 fires', () => {
    let clicked = false;
    showModal('A', '<p>a</p>', [
      {
        label: 'Done',
        onClick: () => {
          clicked = true;
        },
      },
    ]);
    actionButtons()[0].click();
    expect(clicked).toBe(true);
    expect(isModalOpen()).toBe(false);
  });

  it('regression: onClick che pusha un figlio → skip auto-close (BUG-09-01)', () => {
    showModal('Parent', '<p>p</p>', [
      {
        label: 'Open child',
        onClick: () => showModal('Child', '<p>c</p>', [{ label: 'OK' }]),
      },
    ]);
    actionButtons()[0].click();
    expect(currentTitle()).toBe('Child');
    expect(isModalOpen()).toBe(true);
    closeAllModals();
  });
});

// =====================================================================
// BUG-A15-03: focus trap include textarea, select, summary
// =====================================================================
describe('BUG-A15-03: focus trap include textarea/select/summary', () => {
  it('Tab dall\'ultimo focusable (button) wraps al primo (textarea)', () => {
    showModal('Note', '<textarea id="note" class="note-textarea"></textarea>', [{ label: 'Save' }]);
    const ta = document.getElementById('note') as HTMLTextAreaElement;
    const btn = actionButtons()[0];
    // focusables: [textarea, button]. Tab dal button (last) → textarea (first).
    btn.focus();
    const ev = fireKey('Tab', false);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ta);
  });

  it('Shift+Tab dal primo focusable (textarea) wraps all\'ultimo (button)', () => {
    showModal('Note', '<textarea id="note" class="note-textarea"></textarea>', [{ label: 'Save' }]);
    const ta = document.getElementById('note') as HTMLTextAreaElement;
    const btn = actionButtons()[0];
    ta.focus();
    const ev = fireKey('Tab', true);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(btn);
  });

  it('Tab dal button (last) wraps alla select (first) quando body ha una select', () => {
    showModal('Pick', '<select id="sel"><option>A</option><option>B</option></select>', [
      { label: 'OK' },
    ]);
    const sel = document.getElementById('sel') as HTMLSelectElement;
    const btn = actionButtons()[0];
    // focusables: [select, button]. Tab dal button → select.
    btn.focus();
    const ev = fireKey('Tab', false);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sel);
  });

  it('Tab naturale dal primo al secondo focusable NON è bloccato', () => {
    showModal('Form', '<input id="i1"><input id="i2">', [{ label: 'OK' }]);
    const i1 = document.getElementById('i1') as HTMLInputElement;
    i1.focus();
    // focusables: [i1, i2, button]. Tab da i1 (primo, non ultimo) → naturale.
    const ev = fireKey('Tab', false);
    expect(ev.defaultPrevented).toBe(false);
  });
});

// =====================================================================
// BUG-A15-04: focus trap quando non ci sono focusable / activeElement non focusable
// =====================================================================
describe('BUG-A15-04: focus trap con no focusable / title focused', () => {
  it('Tab è bloccato quando la modale non ha elementi focusable', () => {
    showModal('Info', '<p>just text, no inputs</p>', []);
    const titleEl = document.getElementById('modalTitle')!;
    expect(document.activeElement).toBe(titleEl); // renderTop ha focusato il titolo
    const ev = fireKey('Tab', false);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Shift+Tab è bloccato quando la modale non ha elementi focusable', () => {
    showModal('Info', '<p>just text</p>', []);
    const ev = fireKey('Tab', true);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Tab dal titolo (no buttons, body ha link) sposta il focus al primo focusable', () => {
    showModal('About', '<a href="https://x.example" id="link">Link</a>', []);
    const titleEl = document.getElementById('modalTitle')!;
    const link = document.getElementById('link') as HTMLAnchorElement;
    // renderTop focusa il titolo (no buttons). Titolo è dentro il dialog ma
    // non è nei focusables (tabindex=-1 escluso).
    expect(document.activeElement).toBe(titleEl);
    const ev = fireKey('Tab', false);
    // FIXED: Tab non esce dal dialog — wrappa al primo focusable (link).
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(link);
  });

  it('Shift+Tab dal titolo (no buttons, body ha link) wraps all\'ultimo focusable', () => {
    showModal('About', '<a href="https://x.example" id="link">Link</a>', []);
    const titleEl = document.getElementById('modalTitle')!;
    const link = document.getElementById('link') as HTMLAnchorElement;
    expect(document.activeElement).toBe(titleEl);
    const ev = fireKey('Tab', true);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(link);
  });

  it('Tab dal titolo con 2 focusable nel body va al primo (non esce)', () => {
    showModal('Multi', '<a href="x" id="l1">L1</a><a href="y" id="l2">L2</a>', []);
    const titleEl = document.getElementById('modalTitle')!;
    expect(document.activeElement).toBe(titleEl);
    const l1 = document.getElementById('l1') as HTMLAnchorElement;
    fireKey('Tab', false);
    expect(document.activeElement).toBe(l1);
  });
});

// =====================================================================
// BUG-A15-05: body e actions puliti quando lo stack si svuota
// =====================================================================
describe('BUG-A15-05: body/actions puliti su stack empty', () => {
  it('modalBody e modalActions sono vuoti dopo closeModal (stack empty)', () => {
    showModal('A', '<p id="stale">sensitive data</p>', [{ label: 'OK' }]);
    expect(document.getElementById('stale')).not.toBeNull();
    closeModal();
    expect(isModalOpen()).toBe(false);
    // FIXED: il contenuto stale è rimosso, non solo nascosto.
    expect(document.getElementById('stale')).toBeNull();
    expect(document.getElementById('modalBody')!.innerHTML).toBe('');
    expect(document.getElementById('modalActions')!.innerHTML).toBe('');
  });

  it('body è pulito dopo closeAllModals', () => {
    showModal('A', '<p id="stale">data</p>', [{ label: 'OK' }]);
    showModal('B', '<p id="stale2">more</p>', [{ label: 'OK' }]);
    closeAllModals();
    expect(document.getElementById('stale')).toBeNull();
    expect(document.getElementById('stale2')).toBeNull();
  });

  it('body NON è pulito quando una modale figlia chiude (parent resta visibile)', () => {
    showModal('Parent', '<p id="parent-content">parent</p>', [{ label: 'OK' }]);
    showModal('Child', '<p id="child-content">child</p>', [{ label: 'OK' }]);
    closeModal(); // chiude child, parent resta
    expect(currentTitle()).toBe('Parent');
    expect(document.getElementById('parent-content')).not.toBeNull();
    // child-content è sovrascritto dal re-render del parent.
    expect(document.getElementById('child-content')).toBeNull();
  });
});

// =====================================================================
// BUG-A15-06: aria-labelledby rimosso quando titolo vuoto / stack empty
// =====================================================================
describe('BUG-A15-06: aria-labelledby condizionato al titolo', () => {
  it('showModal con titolo vuoto → aria-labelledby assente', () => {
    showModal('', '<p>body</p>', [{ label: 'OK' }]);
    const overlay = document.getElementById('modal')!;
    expect(overlay.hasAttribute('aria-labelledby')).toBe(false);
    closeModal();
  });

  it('showModal con titolo non vuoto → aria-labelledby presente', () => {
    showModal('Hello', '<p>body</p>', [{ label: 'OK' }]);
    const overlay = document.getElementById('modal')!;
    expect(overlay.hasAttribute('aria-labelledby')).toBe(true);
    expect(overlay.getAttribute('aria-labelledby')).toBe('modalTitle');
    closeModal();
  });

  it('aria-labelledby è rimosso quando lo stack si svuota', () => {
    showModal('Hello', '<p>body</p>', [{ label: 'OK' }]);
    closeModal();
    const overlay = document.getElementById('modal')!;
    expect(overlay.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('aria-labelledby è rimosso dopo closeAllModals', () => {
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    showModal('B', '<p>b</p>', [{ label: 'OK' }]);
    closeAllModals();
    expect(document.getElementById('modal')!.hasAttribute('aria-labelledby')).toBe(false);
  });
});

// =====================================================================
// BUG-A15-07: dismissToast API
// =====================================================================
describe('BUG-A15-07: dismissToast API', () => {
  it('dismissToast rimuove la classe show', () => {
    vi.useFakeTimers();
    showToast('Hello', 'success');
    const toast = document.getElementById('toast')!;
    expect(toast.classList.contains('show')).toBe(true);
    dismissToast();
    expect(toast.classList.contains('show')).toBe(false);
  });

  it('dismissToast cancella il timer pendente (no late hide)', () => {
    vi.useFakeTimers();
    showToast('Hello', 'success');
    dismissToast();
    // Avanza oltre il timer originale (3s). Se non fosse cancellato,
    // il callback girerebbe (innocuo, ma indica leak). Verifica no-throw.
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    const toast = document.getElementById('toast')!;
    expect(toast.classList.contains('show')).toBe(false);
  });

  it('dismissToast su toast non visibile è no-op', () => {
    expect(() => dismissToast()).not.toThrow();
  });

  it('dismissToast con elemento toast mancante è no-op', () => {
    const saved = document.getElementById('toast')!;
    saved.remove();
    expect(() => dismissToast()).not.toThrow();
    document.body.appendChild(saved);
  });

  it('showToast dopo dismissToast ripristina correttamente', () => {
    vi.useFakeTimers();
    showToast('First', 'success');
    dismissToast();
    showToast('Second', 'error');
    const toast = document.getElementById('toast')!;
    expect(toast.textContent).toBe('Second');
    expect(toast.classList.contains('show')).toBe(true);
    expect(toast.classList.contains('error')).toBe(true);
  });
});

// =====================================================================
// BUG-A15-08: showToast null/undefined msg
// =====================================================================
describe('BUG-A15-08: showToast null/undefined msg → empty string', () => {
  it('showToast(undefined) mostra testo vuoto, non "undefined"', () => {
    vi.useFakeTimers();
    showToast(undefined as unknown as string, 'success');
    const toast = document.getElementById('toast')!;
    expect(toast.textContent).toBe('');
    expect(toast.textContent).not.toBe('undefined');
  });

  it('showToast(null) mostra testo vuoto, non "null"', () => {
    vi.useFakeTimers();
    showToast(null as unknown as string, 'success');
    const toast = document.getElementById('toast')!;
    expect(toast.textContent).toBe('');
    expect(toast.textContent).not.toBe('null');
  });

  it('showToast(0) mostra "0" (numero coercito a stringa)', () => {
    vi.useFakeTimers();
    showToast(0 as unknown as string, 'success');
    const toast = document.getElementById('toast')!;
    expect(toast.textContent).toBe('0');
  });

  it('showToast("") mostra testo vuoto con classe show', () => {
    vi.useFakeTimers();
    showToast('', 'success');
    const toast = document.getElementById('toast')!;
    expect(toast.textContent).toBe('');
    expect(toast.classList.contains('show')).toBe(true);
  });

  it('showToast con msg HTML-safe (textContent, no XSS)', () => {
    vi.useFakeTimers();
    const malicious = '<img src=x onerror=alert(1)>';
    showToast(malicious, 'error');
    const toast = document.getElementById('toast')!;
    // textContent non parse HTML: il tag img non viene creato.
    expect(toast.textContent).toBe(malicious);
    expect(toast.querySelectorAll('img').length).toBe(0);
  });
});

// =====================================================================
// BUG-A15-09: showModal con actions null/undefined (defensive guard)
// =====================================================================
describe('BUG-A15-09: showModal con actions null/undefined', () => {
  it('showModal con null actions non crasha', () => {
    expect(() => showModal('T', '<p>x</p>', null as unknown as [])).not.toThrow();
    expect(isModalOpen()).toBe(true);
    expect(actionButtons().length).toBe(0);
    closeModal();
  });

  it('showModal con undefined actions non crasha', () => {
    expect(() => showModal('T', '<p>x</p>', undefined as unknown as [])).not.toThrow();
    expect(isModalOpen()).toBe(true);
    closeModal();
  });
});

// =====================================================================
// Toast queue: replace, timer reset
// =====================================================================
describe('Toast queue: showToast replace, timer reset', () => {
  it('secondo showToast sostituisce il primo (testo + classe)', () => {
    vi.useFakeTimers();
    showToast('First', 'success');
    const toast = document.getElementById('toast')!;
    expect(toast.textContent).toBe('First');
    expect(toast.classList.contains('success')).toBe(true);
    showToast('Second', 'error');
    expect(toast.textContent).toBe('Second');
    expect(toast.classList.contains('success')).toBe(false);
    expect(toast.classList.contains('error')).toBe(true);
  });

  it('il timer del primo toast è cancellato (toast visibile a metà durata)', () => {
    vi.useFakeTimers();
    showToast('First', 'success');
    vi.advanceTimersByTime(1500); // metà del timer originale
    showToast('Second', 'success');
    // Avanza 1.5s: se il primo timer non fosse cancellato, il toast si
    // nasconderebbe ora (a 3s dal primo). Con il fix, resta visibile
    // (a 1.5s dal secondo).
    vi.advanceTimersByTime(1500);
    const toast = document.getElementById('toast')!;
    expect(toast.classList.contains('show')).toBe(true);
    // Avanza a 3s dal secondo → si nasconde.
    vi.advanceTimersByTime(1500);
    expect(toast.classList.contains('show')).toBe(false);
  });

  it('toast sparisce dopo 3 secondi senza dismiss manuale', () => {
    vi.useFakeTimers();
    showToast('Hello', 'success');
    expect(document.getElementById('toast')!.classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(2999);
    expect(document.getElementById('toast')!.classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(document.getElementById('toast')!.classList.contains('show')).toBe(false);
  });
});

// =====================================================================
// Stack: 3+ livelli, chiusura intermedia, ESC solo top
// =====================================================================
describe('Stack: 3+ livelli + ESC', () => {
  it('3 livelli: closeModal poppa solo il top', () => {
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    showModal('B', '<p>b</p>', [{ label: 'OK' }]);
    showModal('C', '<p>c</p>', [{ label: 'OK' }]);
    expect(currentTitle()).toBe('C');
    closeModal();
    expect(currentTitle()).toBe('B');
    closeModal();
    expect(currentTitle()).toBe('A');
    closeModal();
    expect(isModalOpen()).toBe(false);
  });

  it('ESC in stack 3-livelli chiude solo il top', () => {
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    showModal('B', '<p>b</p>', [{ label: 'OK' }]);
    showModal('C', '<p>c</p>', [{ label: 'OK' }]);
    fireKey('Escape');
    expect(currentTitle()).toBe('B');
    expect(isModalOpen()).toBe(true);
    fireKey('Escape');
    expect(currentTitle()).toBe('A');
    expect(isModalOpen()).toBe(true);
    fireKey('Escape');
    expect(isModalOpen()).toBe(false);
  });

  it('ESC quando nessuna modale è aperta è no-op', () => {
    expect(() => fireKey('Escape')).not.toThrow();
    expect(isModalOpen()).toBe(false);
  });
});

// =====================================================================
// Memory: no listener duplicati su reopen ripetuti
// =====================================================================
describe('Memory: no duplicate listeners su reopen', () => {
  it('aprire/chiudere 5 volte NON duplica il listener ESC', () => {
    for (let i = 0; i < 5; i++) {
      showModal('T' + i, '<p>x</p>', [{ label: 'OK' }]);
      closeModal();
    }
    // Ora apri 2 modali e verifica ESC poppi esattamente una.
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    showModal('B', '<p>b</p>', [{ label: 'OK' }]);
    fireKey('Escape');
    expect(currentTitle()).toBe('A');
    expect(isModalOpen()).toBe(true);
    closeModal();
  });

  it('aprire/chiudere 5 volte NON duplica il click handler overlay', () => {
    for (let i = 0; i < 5; i++) {
      showModal('T' + i, '<p>x</p>', [{ label: 'OK' }]);
      closeModal();
    }
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    showModal('B', '<p>b</p>', [{ label: 'OK' }]);
    const overlay = document.getElementById('modal')!;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Solo B deve essere chiusa.
    expect(currentTitle()).toBe('A');
    expect(isModalOpen()).toBe(true);
    closeModal();
  });
});

// =====================================================================
// Focus restore: stack vuoto → _firstFocusTarget
// =====================================================================
describe('Focus restore: stack nested → outsideBtn', () => {
  it('closeModal finale su stack 3-livelli ripristina focus all\'outsideBtn', () => {
    const outside = document.getElementById('outsideBtn') as HTMLButtonElement;
    outside.focus();
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    showModal('B', '<p>b</p>', [{ label: 'OK' }]);
    showModal('C', '<p>c</p>', [{ label: 'OK' }]);
    closeModal();
    closeModal();
    closeModal();
    expect(isModalOpen()).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it('closeAllModals su stack 3-livelli ripristina focus all\'outsideBtn', () => {
    const outside = document.getElementById('outsideBtn') as HTMLButtonElement;
    outside.focus();
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    showModal('B', '<p>b</p>', [{ label: 'OK' }]);
    showModal('C', '<p>c</p>', [{ label: 'OK' }]);
    closeAllModals();
    expect(isModalOpen()).toBe(false);
    expect(isOverlayActive()).toBe(false);
    expect(document.activeElement).toBe(outside);
  });
});

// =====================================================================
// aria-hidden toggle corretto
// =====================================================================
describe('aria-hidden + active class toggle', () => {
  it('overlay ha aria-hidden=false e active quando modale aperta', () => {
    showModal('T', '<p>x</p>', [{ label: 'OK' }]);
    const overlay = document.getElementById('modal')!;
    expect(overlay.classList.contains('active')).toBe(true);
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    closeModal();
  });

  it('overlay ha aria-hidden=true e no active quando modale chiusa', () => {
    showModal('T', '<p>x</p>', [{ label: 'OK' }]);
    closeModal();
    const overlay = document.getElementById('modal')!;
    expect(overlay.classList.contains('active')).toBe(false);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
  });
});
