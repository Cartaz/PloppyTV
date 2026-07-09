// Toast notifications
//
// FIXES applicati:
//  - BUG-20-07: imposta role=status e aria-live=assertive a runtime (non in
//    index.html, perché il toast è un singolo elemento riutilizzato).
//  - BUG-A15-05: showToast coerce null/undefined msg a stringa vuota. Prima,
//    toast.textContent = undefined settava il testo a "undefined" (stringa)
//    in alcuni engine; idem per null → "null". Ora sempre stringa pulita.
//  - BUG-A15-07: dismissToast() API — permette di chiudere programmaticamente
//    il toast prima dello scadere del timer (es. dopo click su un'action button
//    "Aggiorna"). Prima non esisteva modo: il toast restava visibile 3s anche
//    se l'utente aveva già interagito.

let _toastTimer: ReturnType<typeof setTimeout> | null = null;
let _toastA11yApplied = false;

export function showToast(msg: string, type?: 'success' | 'error' | 'warning'): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  // BUG-20-07: ARIA attributes a runtime.
  if (!_toastA11yApplied) {
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'assertive');
    _toastA11yApplied = true;
  }
  if (_toastTimer) {
    clearTimeout(_toastTimer);
    _toastTimer = null;
  }
  // BUG-A15-05: coerce null/undefined a ''. Prima, `toast.textContent = msg`
  // con msg=null mostrava "null" e con undefined mostrava "undefined".
  // `msg == null` copre sia null che undefined (loose equality).
  toast.textContent = msg == null ? '' : String(msg);
  toast.className = 'toast show' + (type ? ' ' + type : '');
  _toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    _toastTimer = null;
  }, 3000);
}

/**
 * BUG-A15-07: chiude programmaticamente il toast corrente e cancella il
 * timer pendente. Idempotente (no-op se non c'è toast visibile o se l'elemento
 * non esiste). Utile dopo che l'utente ha interagito con un'action collegata
 * al toast (es. bottone "Aggiorna ora") o quando si naviga via.
 */
export function dismissToast(): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  if (_toastTimer) {
    clearTimeout(_toastTimer);
    _toastTimer = null;
  }
  toast.classList.remove('show');
}
