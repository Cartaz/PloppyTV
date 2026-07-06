// Modal dialog

export interface ModalAction {
  label: string;
  style?: 'btn-primary' | 'btn-secondary' | 'btn-danger';
  onClick?: () => void;
  keepOpen?: boolean;
}

let _modalOverlay: HTMLElement | null = null;
let _modalTitle: HTMLElement | null = null;
let _modalBody: HTMLElement | null = null;
let _modalActions: HTMLElement | null = null;

function ensureRefs(): boolean {
  if (!_modalOverlay) _modalOverlay = document.getElementById('modal');
  if (!_modalTitle) _modalTitle = document.getElementById('modalTitle');
  if (!_modalBody) _modalBody = document.getElementById('modalBody');
  if (!_modalActions) _modalActions = document.getElementById('modalActions');
  return !!(_modalOverlay && _modalTitle && _modalBody && _modalActions);
}

export function showModal(title: string, bodyHtml: string, actions: ModalAction[]): void {
  if (!ensureRefs()) return;
  _modalTitle!.textContent = title;
  _modalBody!.innerHTML = bodyHtml;
  _modalActions!.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (a.style || 'btn-secondary');
    btn.textContent = a.label;
    btn.onclick = () => {
      if (a.onClick) a.onClick();
      if (!a.keepOpen) closeModal();
    };
    _modalActions!.appendChild(btn);
  }
  _modalOverlay!.classList.add('active');
}

export function closeModal(): void {
  if (_modalOverlay) _modalOverlay.classList.remove('active');
}

export function initModal(): void {
  if (!ensureRefs()) return;
  _modalOverlay!.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'modal') closeModal();
  });
}

export function isModalOpen(): boolean {
  return !!_modalOverlay?.classList.contains('active');
}
