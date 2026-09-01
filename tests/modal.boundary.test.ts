import { describe, expect, it, vi } from 'vitest';
import { isModalOpen, showModal } from '../src/components/modal';

describe('modal DOM boundary', () => {
  it('warns and stays closed when the modal shell is unavailable', () => {
    document.body.innerHTML = '';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => showModal('Missing DOM', '<p>body</p>', [{ label: 'OK' }])).not.toThrow();
    expect(isModalOpen()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DOM refs non trovati'));

    warn.mockRestore();
  });
});
