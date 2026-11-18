// Toast notifications

let _toastTimer: ReturnType<typeof setTimeout> | null = null;
let _toastA11yApplied = false;

export function showToast(msg: string, type?: 'success' | 'error' | 'warning'): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  // ARIA attributes a runtime.
  if (!_toastA11yApplied) {
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'assertive');
    _toastA11yApplied = true;
  }
  if (_toastTimer) {
    clearTimeout(_toastTimer);
    _toastTimer = null;
  }
  // Coerce null/undefined a ''. Prima, `toast.textContent = msg`
  // con msg=null mostrava "null" e con undefined mostrava "undefined".
  // `msg == null` copre sia null che undefined (loose equality).
  toast.textContent = msg == null ? '' : String(msg);
  toast.className = 'toast show' + (type ? ' ' + type : '');
  _toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    _toastTimer = null;
  }, 3000);
}
