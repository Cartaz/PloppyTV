// Toast notifications

let _toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(msg: string, type?: 'success' | 'error' | 'warning'): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
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
