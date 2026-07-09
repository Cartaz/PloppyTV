// Toast notifications
//
// BUG-20-07: imposta role=status e aria-live=assertive a runtime (non in
// index.html, perché il toast è un singolo elemento riutilizzato).

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
  toast.textContent = msg;
  toast.className = 'toast show' + (type ? ' ' + type : '');
  _toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    _toastTimer = null;
  }, 3000);
}
