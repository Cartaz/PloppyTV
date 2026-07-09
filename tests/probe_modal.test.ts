// Agent 09 — probe tests for src/components/modal.ts (FIXED version)
// Covers: keepOpen trap (FIXED: default is now safe), closeModal/closeAllModals
// on empty stack, focus restore (FIXED: _firstFocusTarget tracking), focus trap
// (FIXED: covers whole modal card incl. modalBody), ESC handler, no-actions
// modal focus (FIXED: title tabindex=-1), showModal warns when DOM not ready
// (FIXED: console.warn), overlay click close, multiple rapid showModals.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  showModal,
  closeModal,
  closeAllModals,
  initModal,
  isModalOpen,
} from '../src/components/modal';

// DOM mirroring index.html modal structure + an outside button for focus-restore tests.
const MODAL_HTML = `
<div class="modal-overlay" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" aria-hidden="true">
  <div class="modal" tabindex="-1">
    <div class="modal-title" id="modalTitle"></div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-actions" id="modalActions"></div>
  </div>
</div>
<button id="outsideBtn">Outside</button>
`;

beforeAll(() => {
  document.body.innerHTML = MODAL_HTML;
  initModal();
});

beforeEach(() => {
  closeAllModals();
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
// BUG-09-01: keepOpen trap — FIXED.
// The default behavior is now SAFE: an action that opens a nested modal
// (without keepOpen:true) no longer has its child popped instantly. The
// framework detects the stack depth change and skips the auto-close.
// keepOpen remains as an explicit override for callers that manipulate the
// stack in other ways inside onClick.
// =====================================================================
describe('BUG-09-01: keepOpen trap — FIXED (default is now safe)', () => {
  it('WITHOUT keepOpen: child STAYS OPEN (default behavior detects nested push)', () => {
    let childOpenedCount = 0;
    showModal('Parent', '<p>parent</p>', [
      {
        label: 'Open child',
        onClick: () => {
          showModal('Child', '<p>child</p>', [{ label: 'Close' }]);
          childOpenedCount++;
        },
        // keepOpen defaults to false — but the fix detects the nested push
      },
    ]);
    expect(currentTitle()).toBe('Parent');

    actionButtons()[0].click();

    expect(childOpenedCount).toBe(1); // child WAS opened
    // FIXED: the child is NOT popped — closeModal() is skipped because the
    // onClick pushed a new entry (depth increased).
    expect(currentTitle()).toBe('Child'); // child stays on top
    expect(isModalOpen()).toBe(true); // stack = [Parent, Child]
    expect(isOverlayActive()).toBe(true);
  });

  it('WITH keepOpen=true: child stays open (still works, redundant but harmless)', () => {
    showModal('Parent', '<p>parent</p>', [
      {
        label: 'Open child',
        keepOpen: true,
        onClick: () => {
          showModal('Child', '<p>child</p>', [{ label: 'Close' }]);
        },
      },
    ]);
    expect(currentTitle()).toBe('Parent');

    actionButtons()[0].click();

    expect(currentTitle()).toBe('Child'); // child stays
    expect(isModalOpen()).toBe(true);
  });

  it('WITHOUT keepOpen, no nested push: closeModal still fires (depth unchanged)', () => {
    // Regression guard: the fix must NOT break the common case where an action
    // just does some work and the modal should close.
    let clicked = false;
    showModal('A', '<p>a</p>', [
      {
        label: 'Done',
        onClick: () => {
          clicked = true;
        },
      },
    ]);
    expect(isModalOpen()).toBe(true);
    actionButtons()[0].click();
    expect(clicked).toBe(true);
    expect(isModalOpen()).toBe(false); // closed as expected
  });
});

// =====================================================================
// BUG-09-02: closeModal / closeAllModals on empty stack (harmless)
// =====================================================================
describe('BUG-09-02: closeModal/closeAllModals on empty stack (harmless)', () => {
  it('closeModal on empty stack does not throw', () => {
    expect(() => closeModal()).not.toThrow();
    expect(isModalOpen()).toBe(false);
    expect(isOverlayActive()).toBe(false);
  });

  it('closeAllModals on empty stack does not throw', () => {
    expect(() => closeAllModals()).not.toThrow();
    expect(isModalOpen()).toBe(false);
  });
});

// =====================================================================
// BUG-09-03: closeAllModals focus-restore footgun — FIXED.
// The module now tracks _firstFocusTarget (the element focused before the
// FIRST modal opened) and restores focus to it on closeAllModals / final
// closeModal, instead of to the top modal's previouslyFocused (which may be
// a detached button inside the hidden overlay).
// =====================================================================
describe('BUG-09-03: closeAllModals focus-restore — FIXED', () => {
  it('closeAllModals restores focus to the original pre-modal element', () => {
    const outside = document.getElementById('outsideBtn') as HTMLButtonElement;
    outside.focus();
    expect(document.activeElement).toBe(outside);

    showModal('Parent', '<p>p</p>', [{ label: 'ParentBtn' }]);
    const parentBtn = actionButtons()[0];
    expect(document.activeElement).toBe(parentBtn);

    showModal('Child', '<p>c</p>', [{ label: 'ChildBtn' }]);
    const childBtn = actionButtons()[0];
    expect(document.activeElement).toBe(childBtn);

    closeAllModals();

    expect(isModalOpen()).toBe(false);
    expect(isOverlayActive()).toBe(false);

    // FIXED: focus is restored to the original outside element.
    expect(document.activeElement).toBe(outside);
  });

  it('final closeModal (stack -> empty) also restores to the original pre-modal element', () => {
    const outside = document.getElementById('outsideBtn') as HTMLButtonElement;
    outside.focus();
    expect(document.activeElement).toBe(outside);

    showModal('Parent', '<p>p</p>', [{ label: 'P' }]);
    showModal('Child', '<p>c</p>', [{ label: 'C' }]);
    expect(document.activeElement).toBe(actionButtons()[0]); // childBtn

    closeModal(); // pops child, stack = [parent], NOT empty -> renderTop focuses parent btn
    expect(currentTitle()).toBe('Parent');
    expect(document.activeElement).toBe(actionButtons()[0]); // parent's recreated btn

    closeModal(); // pops parent, stack = [] -> restore _firstFocusTarget
    expect(isModalOpen()).toBe(false);
    expect(document.activeElement).toBe(outside); // FIXED: restored to outside
  });
});

// =====================================================================
// BUG-09-04: Focus trap — FIXED.
// The trap now queries focusables across the WHOLE modal card (body +
// actions), so Tab/Shift+Tab from a focusable in modalBody (e.g. About
// modal's <a> links) wraps correctly instead of escaping.
// =====================================================================
describe('BUG-09-04: focus trap covers modalBody — FIXED', () => {
  it('Shift+Tab from a link in modalBody IS trapped (wraps to last focusable)', () => {
    showModal('About', '<a href="https://x.example" id="bodyLink">Link</a>', [
      { label: 'Chiudi' },
    ]);
    const link = document.getElementById('bodyLink') as HTMLAnchorElement;
    link.focus();
    expect(document.activeElement).toBe(link);

    const ev = fireKey('Tab', true); // Shift+Tab
    // FIXED: link is the FIRST focusable in the modal card; Shift+Tab wraps
    // to the LAST focusable (Chiudi button) and prevents the escape.
    expect(ev.defaultPrevented).toBe(true);
    const btns = actionButtons();
    expect(document.activeElement).toBe(btns[btns.length - 1]);
  });

  it('Tab from a link in modalBody that is NOT the last focusable is allowed (natural Tab)', () => {
    // The link is the FIRST focusable; Chiudi button is the LAST. Tab from
    // the link moves naturally to the next focusable (Chiudi) — no wrap,
    // no preventDefault needed. This is correct WAI-ARIA behavior.
    showModal('About', '<a href="https://x.example" id="bodyLink">Link</a>', [
      { label: 'Chiudi' },
    ]);
    const link = document.getElementById('bodyLink') as HTMLAnchorElement;
    link.focus();

    const ev = fireKey('Tab', false);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('Tab from the last action button IS trapped (wraps to first, which may be a body link)', () => {
    showModal('About', '<a href="https://x.example" id="bodyLink">Link</a>', [
      { label: 'Chiudi' },
    ]);
    const btns = actionButtons();
    btns[0].focus(); // Chiudi button — the LAST focusable in the modal card

    const ev = fireKey('Tab', false);
    expect(ev.defaultPrevented).toBe(true);
    // wraps to FIRST focusable, which is the body link (not the button itself)
    expect(document.activeElement).toBe(document.getElementById('bodyLink'));
  });

  it('Tab from the only action button IS trapped (single button = first & last → wraps)', () => {
    showModal('Test', '<p>body</p>', [{ label: 'Only' }]);
    const btn = actionButtons()[0];
    expect(document.activeElement).toBe(btn); // renderTop focused it

    const ev = fireKey('Tab', false);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Shift+Tab from the first action button IS trapped (wraps)', () => {
    showModal('Test', '<p>body</p>', [{ label: 'Only' }, { label: 'Two' }]);
    const btns = actionButtons();
    expect(document.activeElement).toBe(btns[0]); // renderTop focused first

    const ev = fireKey('Tab', true); // Shift+Tab on first
    expect(ev.defaultPrevented).toBe(true);
  });
});

// =====================================================================
// BUG-09-05: Modal with empty actions — FIXED.
// _modalTitle now gets tabindex="-1" in ensureRefs, so .focus() on it
// actually moves focus (per HTML spec) into the dialog. Keyboard / screen
// reader users now get a focus entry point even with no action buttons.
// =====================================================================
describe('BUG-09-05: empty actions → title focus works (tabindex=-1) — FIXED', () => {
  it('showModal with [] actions moves focus into the dialog (onto the title)', () => {
    const outside = document.getElementById('outsideBtn') as HTMLButtonElement;
    outside.focus();
    expect(document.activeElement).toBe(outside);

    showModal('NoActions', '<p>body</p>', []);

    expect(isOverlayActive()).toBe(true);
    expect(currentTitle()).toBe('NoActions');
    // FIXED: _modalTitle has tabindex=-1, so .focus() moves focus into the dialog.
    const titleEl = document.getElementById('modalTitle')!;
    expect(titleEl.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(titleEl);
    expect(document.activeElement).not.toBe(outside);
  });
});

// =====================================================================
// BUG-09-06: ESC handler — pops one modal at a time, no way for an
// action to prevent ESC.
// =====================================================================
describe('BUG-09-06: ESC handler', () => {
  it('ESC closes the top modal', () => {
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    expect(isModalOpen()).toBe(true);
    fireKey('Escape');
    expect(isModalOpen()).toBe(false);
    expect(isOverlayActive()).toBe(false);
  });

  it('ESC on nested modals pops one at a time (child first, then parent)', () => {
    showModal('Parent', '<p>p</p>', [{ label: 'OK' }]);
    showModal('Child', '<p>c</p>', [{ label: 'OK' }]);
    expect(currentTitle()).toBe('Child');

    fireKey('Escape');
    expect(currentTitle()).toBe('Parent');
    expect(isModalOpen()).toBe(true);

    fireKey('Escape');
    expect(isModalOpen()).toBe(false);
  });

  it('ESC when no modal open is a no-op (no throw)', () => {
    expect(() => fireKey('Escape')).not.toThrow();
    expect(isModalOpen()).toBe(false);
  });
});

// =====================================================================
// BUG-09-07: overlay click closes; inner card click does NOT close.
// =====================================================================
describe('BUG-09-07: overlay click vs inner card click', () => {
  it('clicking the overlay background (id=modal) closes the modal', () => {
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    expect(isModalOpen()).toBe(true);

    const overlay = document.getElementById('modal')!;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(isModalOpen()).toBe(false);
  });

  it('clicking the inner .modal card does NOT close', () => {
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    const card = document.querySelector('.modal') as HTMLElement;
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(isModalOpen()).toBe(true);
  });

  it('clicking modalBody content does NOT close', () => {
    showModal('A', '<p id="bp">content</p>', [{ label: 'OK' }]);
    const bp = document.getElementById('bp')!;
    bp.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(isModalOpen()).toBe(true);
  });
});

// =====================================================================
// BUG-09-09: multiple rapid showModals (synchronous push push push).
// =====================================================================
describe('BUG-09-09: multiple rapid showModals', () => {
  it('three showModals push three entries; top is visible', () => {
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    showModal('B', '<p>b</p>', [{ label: 'OK' }]);
    showModal('C', '<p>c</p>', [{ label: 'OK' }]);
    expect(currentTitle()).toBe('C');
    expect(isModalOpen()).toBe(true);

    closeModal();
    expect(currentTitle()).toBe('B');
    closeModal();
    expect(currentTitle()).toBe('A');
    closeModal();
    expect(isModalOpen()).toBe(false);
  });
});

// =====================================================================
// BUG-09-10: focus restore on closing LAST modal (single-level).
// =====================================================================
describe('BUG-09-10: focus restore on last-modal close (single level)', () => {
  it('closing the only modal restores focus to previouslyFocused', () => {
    const outside = document.getElementById('outsideBtn') as HTMLButtonElement;
    outside.focus();
    showModal('A', '<p>a</p>', [{ label: 'OK' }]);
    expect(document.activeElement).not.toBe(outside); // moved to action btn

    closeModal();
    expect(document.activeElement).toBe(outside); // restored
  });
});

// =====================================================================
// BUG-09-11: nested close — focus goes to parent's first action button
// via renderTop (NOT via previouslyFocused restore, which is skipped
// because stack.length > 0).
// =====================================================================
describe('BUG-09-11: nested close focuses parent firstBtn via renderTop', () => {
  it('closing child → renderTop focuses parent first action button', () => {
    const outside = document.getElementById('outsideBtn') as HTMLButtonElement;
    outside.focus();
    showModal('Parent', '<p>p</p>', [{ label: 'P' }]);
    const parentBtnV1 = actionButtons()[0];
    expect(document.activeElement).toBe(parentBtnV1);

    showModal('Child', '<p>c</p>', [{ label: 'C' }]);
    const childBtn = actionButtons()[0];
    expect(document.activeElement).toBe(childBtn);

    closeModal(); // pops child; stack=[parent]; renderTop RECREATES parent's
    // buttons (innerHTML='') so parentBtnV1 is detached and a new button is
    // created + focused.
    expect(currentTitle()).toBe('Parent');
    const parentBtnV2 = actionButtons()[0];
    expect(parentBtnV2.textContent).toBe('P');
    expect(document.activeElement).toBe(parentBtnV2);
  });
});

// =====================================================================
// BUG-09-12: body innerHTML is set via innerHTML (caller-controlled).
// Title is textContent (XSS-safe). Verify behavior.
// =====================================================================
describe('BUG-09-12: body innerHTML injection surface (caller responsibility)', () => {
  it('body HTML is injected as-is (raw HTML in bodyHtml)', () => {
    showModal('T', '<span id="injected">hi</span>', [{ label: 'OK' }]);
    const injected = document.getElementById('injected');
    expect(injected).not.toBeNull();
    expect(injected!.textContent).toBe('hi');
  });

  it('title is set via textContent (HTML escaped)', () => {
    showModal('<img src=x onerror=alert(1)>', '<p>b</p>', [{ label: 'OK' }]);
    const titleEl = document.getElementById('modalTitle')!;
    expect(titleEl.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(titleEl.querySelectorAll('img').length).toBe(0); // not parsed as HTML
  });
});

// =====================================================================
// BUG-09-08: showModal when DOM refs are missing — FIXED.
// showModal now logs a console.warn (instead of being a silent no-op) when
// ensureRefs() fails, so developers notice the missed modal. It still does
// not throw and does not change state.
// NOTE: This test MUST be last — it uses vi.resetModules() + DOM clearing
// which invalidates the static import's cached refs for any later test.
// =====================================================================
describe('BUG-09-08: showModal warns (not silent) when DOM not ready — FIXED', () => {
  it('showModal with missing DOM does nothing but logs a console.warn', async () => {
    const saved = document.body.innerHTML;
    document.body.innerHTML = '';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnSpy.mockClear();

    // Fresh module instance — no cached refs, DOM empty.
    vi.resetModules();
    const fresh = await import('../src/components/modal');

    expect(() => fresh.showModal('Ghost', '<p>nope</p>', [{ label: 'X' }])).not.toThrow();
    expect(fresh.isModalOpen()).toBe(false);
    // FIXED: a warning is logged instead of a silent no-op.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('modal');

    warnSpy.mockRestore();

    // Restore DOM (good citizenship).
    document.body.innerHTML = saved;
  });
});
