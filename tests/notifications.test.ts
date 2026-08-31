import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeShowWithSeasons } from './helpers';
import { NOTIF_RESCHEDULE_INTERVAL_MS, PREFS_KEY } from '../src/lib/constants';

const storeState = vi.hoisted(() => ({ shows: [] as unknown[] }));
vi.mock('../src/lib/store', () => ({
  getState: () => ({ shows: storeState.shows }),
}));

interface NotificationRecord {
  title: string;
  options?: NotificationOptions;
}

function installNotification(permission: NotificationPermission, requestResult: NotificationPermission = permission) {
  const records: NotificationRecord[] = [];
  let currentPermission = permission;
  const requestPermission = vi.fn(async () => {
    currentPermission = requestResult;
    return requestResult;
  });
  class MockNotification {
    static get permission(): NotificationPermission {
      return currentPermission;
    }
    static requestPermission = requestPermission;

    constructor(title: string, options?: NotificationOptions) {
      records.push({ title, options });
    }
  }
  Object.defineProperty(globalThis, 'Notification', {
    value: MockNotification,
    configurable: true,
    writable: true,
  });
  return { records, requestPermission };
}

function setStandalone(value: boolean): void {
  Object.defineProperty(navigator, 'standalone', { value, configurable: true });
}

function setMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn(() => ({
      matches,
      media: '(display-mode: standalone)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
    configurable: true,
    writable: true,
  });
}

function installServiceWorker(getRegistration: () => Promise<ServiceWorkerRegistration | undefined>): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { getRegistration: vi.fn(getRegistration) },
    configurable: true,
  });
}

function enablePreference(): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ notificationsEnabled: true }));
}

function eligibleShow(id: number, name: string, airdate: string) {
  const show = makeShowWithSeasons({ 1: 1 }, { id, name, list: 'watching' });
  show.seasons[1][0].airdate = airdate;
  return show;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 1, 12, 0, 0));
  localStorage.clear();
  storeState.shows = [];
  setStandalone(false);
  setMatchMedia(false);
  Reflect.deleteProperty(navigator, 'serviceWorker');
  installNotification('default', 'granted');
});

afterEach(async () => {
  const notifications = await import('../src/lib/notifications');
  notifications._resetNotificationsForTesting();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Reflect.deleteProperty(navigator, 'standalone');
});

describe('notification contracts', () => {
  it('detects notification support and both standalone signals', async () => {
    const notifications = await import('../src/lib/notifications');

    expect(notifications.notificationsSupported()).toBe(true);
    expect(notifications.isPwaStandalone()).toBe(false);

    setStandalone(true);
    expect(notifications.isPwaStandalone()).toBe(true);
    setStandalone(false);
    setMatchMedia(true);
    expect(notifications.isPwaStandalone()).toBe(true);

    Reflect.deleteProperty(globalThis, 'Notification');
    expect(notifications.notificationsSupported()).toBe(false);
  });

  it('requires both browser permission and explicit opt-in', async () => {
    const notifications = await import('../src/lib/notifications');

    installNotification('denied');
    enablePreference();
    expect(notifications.notificationsEnabled()).toBe(false);

    installNotification('granted');
    expect(notifications.notificationsEnabled()).toBe(true);

    localStorage.setItem(PREFS_KEY, JSON.stringify({ notificationsEnabled: false }));
    expect(notifications.notificationsEnabled()).toBe(false);

    localStorage.setItem(PREFS_KEY, '{corrupted');
    expect(notifications.notificationsEnabled()).toBe(false);
  });

  it('enables and disables notifications as one preference lifecycle', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const notifications = await import('../src/lib/notifications');
    installNotification('default', 'denied');
    expect(await notifications.enableNotifications()).toBe(false);
    expect(localStorage.getItem(PREFS_KEY)).toBeNull();

    const { requestPermission } = installNotification('default', 'granted');
    expect(await notifications.enableNotifications()).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}').notificationsEnabled).toBe(true);
    expect(setTimeoutSpy.mock.calls.map((call) => call[1])).toContain(NOTIF_RESCHEDULE_INTERVAL_MS);

    notifications.disableNotifications();
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}').notificationsEnabled).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('schedules only eligible episodes plus the periodic reschedule', async () => {
    installNotification('granted');
    enablePreference();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const eligible = eligibleShow(1, 'Eligible', '2026-09-04');
    const past = eligibleShow(2, 'Past', '2026-08-30');
    const far = eligibleShow(3, 'Far', '2026-10-10');
    const noDate = eligibleShow(4, 'No date', '2026-09-04');
    noDate.seasons[1][0].airdate = null;
    const completed = eligibleShow(5, 'Completed', '2026-09-04');
    completed.list = 'completed';
    storeState.shows = [eligible, past, far, noDate, completed];

    const { scheduleNotifications } = await import('../src/lib/notifications');
    scheduleNotifications();

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
    expect(delays.filter((delay) => delay === NOTIF_RESCHEDULE_INTERVAL_MS)).toHaveLength(1);
    expect(delays.filter((delay) => delay !== NOTIF_RESCHEDULE_INTERVAL_MS)).toHaveLength(1);
  });

  it('delivers a scheduled reminder through the service worker when available', async () => {
    vi.setSystemTime(new Date(2026, 8, 1, 22, 0, 0));
    const notification = installNotification('granted');
    enablePreference();
    storeState.shows = [eligibleShow(42, 'Soon Show', '2026-09-02')];

    let deliveredTitle = '';
    let deliveredOptions: NotificationOptions | undefined;
    const showNotification = vi.fn(async (title: string, options?: NotificationOptions) => {
      deliveredTitle = title;
      deliveredOptions = options;
    });
    installServiceWorker(async () => ({ showNotification } as unknown as ServiceWorkerRegistration));

    const { scheduleNotifications } = await import('../src/lib/notifications');
    scheduleNotifications();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(deliveredTitle).toContain('Soon Show');
    expect(deliveredOptions?.body).toBe('Soon Show — S1E1');
    expect(deliveredOptions?.tag).toBe('ploppytv-42-1-1');
    expect(deliveredOptions?.icon).toContain('icons/icon-192.png');
    expect(notification.records).toHaveLength(0);
  });

  it('falls back to the desktop Notification constructor if service-worker delivery fails', async () => {
    vi.setSystemTime(new Date(2026, 8, 1, 22, 0, 0));
    const notification = installNotification('granted');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enablePreference();
    storeState.shows = [eligibleShow(7, 'Fallback Show', '2026-09-02')];
    installServiceWorker(async () => {
      throw new Error('service worker unavailable');
    });

    const { scheduleNotifications } = await import('../src/lib/notifications');
    scheduleNotifications();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(notification.records).toHaveLength(1);
    expect(notification.records[0].title).toContain('Fallback Show');
    expect(warnSpy).toHaveBeenCalledWith(
      '[notifications] service worker notification failed:',
      expect.any(Error),
    );
  });

  it('keeps initialization idempotent and removes its reschedule listener on reset', async () => {
    vi.setSystemTime(new Date(2026, 8, 1, 22, 0, 0));
    installNotification('granted');
    enablePreference();
    storeState.shows = [eligibleShow(9, 'Lifecycle Show', '2026-09-02')];
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const notifications = await import('../src/lib/notifications');

    notifications.initNotifications();
    notifications.initNotifications();
    notifications.initNotifications();
    expect(
      addSpy.mock.calls.filter(([type]) => String(type) === 'ploppytv:reschedule-notifications'),
    ).toHaveLength(1);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event('ploppytv:reschedule-notifications'));
    expect(setTimeoutSpy).toHaveBeenCalledTimes(4);
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    notifications._resetNotificationsForTesting();
    expect(
      removeSpy.mock.calls.filter(([type]) => String(type) === 'ploppytv:reschedule-notifications'),
    ).toHaveLength(1);
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('returns the earliest future episode from watching shows', async () => {
    installNotification('granted');
    const later = eligibleShow(1, 'Later', '2026-09-04');
    const earliest = eligibleShow(2, 'Earliest', '2026-09-02');
    const completed = eligibleShow(3, 'Completed', '2026-09-01');
    completed.list = 'completed';
    const past = eligibleShow(4, 'Past', '2026-08-31');
    storeState.shows = [later, completed, past, earliest];

    const { getNextNotifiableEpisode } = await import('../src/lib/notifications');
    expect(getNextNotifiableEpisode()).toEqual({
      showName: 'Earliest',
      season: 1,
      num: 1,
      airdate: '2026-09-02',
    });
  });
});
