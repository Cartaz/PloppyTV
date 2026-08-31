import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../src/locales/en.json';
import itLocale from '../src/locales/it.json';

async function freshI18n() {
  vi.resetModules();
  const i18n = await import('../src/lib/i18n');
  i18n._resetI18nForTesting();
  return i18n;
}

function setBrowserLanguage(language: string): void {
  Object.defineProperty(navigator, 'language', { value: language, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  setBrowserLanguage('it-IT');
});

describe('i18n contracts', () => {
  it('uses a saved locale case-insensitively before browser language', async () => {
    const i18n = await freshI18n();
    setBrowserLanguage('it-IT');
    localStorage.setItem('ploppytv_prefs_v1', JSON.stringify({ lang: 'EN' }));
    i18n.initI18n();
    expect(i18n.getLocale()).toBe('en');

    i18n._resetI18nForTesting();
    localStorage.setItem('ploppytv_prefs_v1', JSON.stringify({ lang: 'It' }));
    setBrowserLanguage('en-US');
    i18n.initI18n();
    expect(i18n.getLocale()).toBe('it');
  });

  it('falls back to browser language when saved preferences are unusable', async () => {
    const i18n = await freshI18n();
    setBrowserLanguage('en-US');

    for (const raw of ['{bad json', JSON.stringify({ lang: 'fr' }), JSON.stringify({ lang: '' })]) {
      i18n._resetI18nForTesting();
      localStorage.setItem('ploppytv_prefs_v1', raw);
      i18n.initI18n();
      expect(i18n.getLocale()).toBe('en');
    }

    i18n._resetI18nForTesting();
    localStorage.clear();
    setBrowserLanguage('de-DE');
    i18n.initI18n();
    expect(i18n.getLocale()).toBe('it');
  });

  it('persists locale changes while preserving valid sibling preferences', async () => {
    const i18n = await freshI18n();
    localStorage.setItem('ploppytv_prefs_v1', JSON.stringify({ notificationsEnabled: true, lang: 'it' }));
    i18n.initI18n();
    i18n.setLocale('en');

    expect(i18n.getLocale()).toBe('en');
    expect(JSON.parse(localStorage.getItem('ploppytv_prefs_v1') ?? '{}')).toEqual({
      notificationsEnabled: true,
      lang: 'en',
    });
  });

  it('recovers corrupted or non-object preferences when saving a locale', async () => {
    const i18n = await freshI18n();

    for (const raw of ['<<<corrupted>>>', 'null', '[]']) {
      localStorage.setItem('ploppytv_prefs_v1', raw);
      i18n._resetI18nForTesting();
      i18n.initI18n();
      i18n.setLocale('en');
      expect(JSON.parse(localStorage.getItem('ploppytv_prefs_v1') ?? '{}')).toEqual({ lang: 'en' });
    }
  });

  it('interpolates in one pass without treating parameter names as regex', async () => {
    const i18n = await freshI18n();
    i18n.initI18n();

    expect(() => i18n.t('Hello {x}', { '(': 'Y' })).not.toThrow();
    expect(i18n.t('Hello {x}', { '(': 'Y' })).toBe('Hello {x}');
    expect(i18n.t('search.noResults', { query: '{count}' })).toContain('{count}');
    expect(i18n.t('search.noResultsAlt', { query: 'X' })).toContain('{alt}');
  });

  it('normalizes nullish parameters and returns unknown keys unchanged', async () => {
    const i18n = await freshI18n();
    i18n.initI18n();

    expect(i18n.t('library.results', { count: undefined as unknown as number })).toBe(' risultati');
    expect(i18n.t('library.results', { count: null as unknown as number })).toBe(' risultati');
    expect(i18n.t('library.results', { count: 0 })).toBe('0 risultati');
    expect(i18n.t('nonexistent.key.xyz')).toBe('nonexistent.key.xyz');
  });

  it('notifies subscribers once per real change and isolates listener failures', async () => {
    const i18n = await freshI18n();
    i18n.initI18n();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const goodListener = vi.fn();
    const unsubscribeBad = i18n.subscribeI18n(() => {
      throw new Error('listener failed');
    });
    const unsubscribeGood = i18n.subscribeI18n(goodListener);

    i18n.setLocale('en');
    i18n.setLocale('en');
    expect(goodListener).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();

    unsubscribeBad();
    unsubscribeGood();
    i18n.setLocale('it');
    expect(goodListener).toHaveBeenCalledTimes(1);
  });

  it('keeps locale dictionaries structurally aligned', () => {
    const enKeys = Object.keys(en).sort();
    const itKeys = Object.keys(itLocale).sort();
    expect(enKeys).toEqual(itKeys);

    const placeholders = (value: string): string[] => (value.match(/\{[^{}]+\}/g) ?? []).sort();
    for (const key of enKeys) {
      const enValue = en[key as keyof typeof en];
      const itValue = itLocale[key as keyof typeof itLocale];
      expect(typeof enValue).toBe('string');
      expect(typeof itValue).toBe('string');
      expect(placeholders(enValue)).toEqual(placeholders(itValue));
    }
  });
});
