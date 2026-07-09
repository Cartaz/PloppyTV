// Toast notifications

let _toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(msg: string, type?: 'success' | 'error' | 'warning'): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  // BUG-20-07 fix: assicura che il toast sia annunciato dagli screen reader.
  // L'elemento #toast in index.html non ha role/aria-live; li impostiamo
  // qui in modo idempotente (non sovrascrive se già presenti, così un
  // futuro tweak in index.html resta rispettato). aria-live="assertive"
  // è appropriato perché i toast includono anche messaggi di errore.
  if (!toast.getAttribute('role')) {
    toast.setAttribute('role', 'status');
  }
  if (!toast.getAttribute('aria-live')) {
    toast.setAttribute('aria-live', 'assertive');
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
