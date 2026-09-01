import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let showModalSpy: ReturnType<typeof vi.fn>;
let showToastSpy: ReturnType<typeof vi.fn>;
let notificationsSupportedSpy: ReturnType<typeof vi.fn>;
let notificationsEnabledSpy: ReturnType<typeof vi.fn>;
let enableNotificationsSpy: ReturnType<typeof vi.fn>;
let disableNotificationsSpy: ReturnType<typeof vi.fn>;
let isPwaStandaloneSpy: ReturnType<typeof vi.fn>;
let getNextNotifiableEpisodeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML =
    '<button id="aboutBtn"></button>' +
    '<button id="notifBtn"></button>' +
    '<button id="langBtn"></button>' +
    '<button id="menuToggle"></button>' +
    '<nav id="sidebar"></nav>' +
    '<div id="sidebarOverlay"></div>' +
    '<main id="mainContent"></main>';

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false })),
  });

  showModalSpy = vi.fn();
  showToastSpy = vi.fn();
  notificationsSupportedSpy = vi.fn(() => true);
  notificationsEnabledSpy = vi.fn(() => false);
  enableNotificationsSpy = vi.fn(async () => true);
  disableNotificationsSpy = vi.fn();
  isPwaStandaloneSpy = vi.fn(() => true);
  getNextNotifiableEpisodeSpy = vi.fn(() => null);

  vi.doMock('../src/lib/store', () => ({
    getState: () => ({ shows: [] }),
    switchView: vi.fn(),
  }));
  vi.doMock('../src/components/modal', () => ({ showModal: showModalSpy }));
  vi.doMock('../src/components/toast', () => ({ showToast: showToastSpy }));
  vi.doMock('../src/lib/i18n', () => ({
    getLocale: () => 'it',
    setLocale: vi.fn(),
    getAvailableLocales: () => ['it', 'en'],
    t: (key: string) => key,
  }));
  vi.doMock('../src/lib/notifications', () => ({
    notificationsSupported: () => notificationsSupportedSpy(),
    notificationsEnabled: () => notificationsEnabledSpy(),
    enableNotifications: () => enableNotificationsSpy(),
    disableNotifications: () => disableNotificationsSpy(),
    isPwaStandalone: () => isPwaStandaloneSpy(),
    getNextNotifiableEpisode: () => getNextNotifiableEpisodeSpy(),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function clickNotificationButton(): Promise<void> {
  document.getElementById('notifBtn')!.click();
  await Promise.resolve();
  await Promise.resolve();
}

describe('header contracts', () => {
  it('opens About with the product and policy links owned by the header', async () => {
    const { initHeader } = await import('../src/components/header');
    initHeader();

    document.getElementById('aboutBtn')!.click();

    expect(showModalSpy).toHaveBeenCalledTimes(1);
    const [title, body, actions] = showModalSpy.mock.calls[0];
    expect(title).toBe('Informazioni su PloppyTV');
    expect(body).toContain('local-first');
    expect(body).toContain('PRIVACY.md');
    expect(body).toContain('CONTRIBUTING.md');
    expect(body).toContain('LICENSE');
    expect(actions).toEqual([{ label: 'Chiudi' }]);
  });

  it('rejects notification activation when the platform does not support it', async () => {
    notificationsSupportedSpy.mockReturnValue(false);
    const { initHeader } = await import('../src/components/header');
    initHeader();

    await clickNotificationButton();

    expect(enableNotificationsSpy).not.toHaveBeenCalled();
    expect(showToastSpy).toHaveBeenCalledWith('notifications.pwaRequired', 'warning');
  });

  it('disables notifications as one complete preference action', async () => {
    notificationsEnabledSpy.mockReturnValue(true);
    const { initHeader } = await import('../src/components/header');
    initHeader();

    await clickNotificationButton();

    expect(disableNotificationsSpy).toHaveBeenCalledTimes(1);
    expect(enableNotificationsSpy).not.toHaveBeenCalled();
    expect(showToastSpy).toHaveBeenCalledWith('notifications.disabled', 'success');
  });

  it('enables notifications and reports the next scheduled episode', async () => {
    isPwaStandaloneSpy.mockReturnValue(false);
    getNextNotifiableEpisodeSpy.mockReturnValue({
      showName: 'Example Show',
      season: 2,
      num: 4,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { initHeader } = await import('../src/components/header');
    initHeader();

    await clickNotificationButton();

    expect(warnSpy).toHaveBeenCalledWith('[notifications] Not in standalone mode');
    expect(enableNotificationsSpy).toHaveBeenCalledTimes(1);
    expect(showToastSpy).toHaveBeenCalledWith(
      'notifications.scheduled — Example Show S2E4',
      'success',
    );
  });

  it('surfaces permission denial without reporting notifications as enabled', async () => {
    enableNotificationsSpy.mockResolvedValue(false);
    const { initHeader } = await import('../src/components/header');
    initHeader();

    await clickNotificationButton();

    expect(showToastSpy).toHaveBeenCalledWith('notifications.denied', 'warning');
    expect(getNextNotifiableEpisodeSpy).not.toHaveBeenCalled();
  });
});
