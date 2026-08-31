import { describe, expect, it } from 'vitest';
import { API_BASE, NOTIF_MAX_DELAY_MS, NOTIF_RESCHEDULE_INTERVAL_MS, normalizeApiBase } from '../src/lib/constants';

describe('constants contracts', () => {
  it('normalizes valid HTTP(S) API bases without a trailing slash', () => {
    expect(normalizeApiBase('https://api.tvmaze.com/')).toBe(API_BASE);
    expect(normalizeApiBase('https://api.tvmaze.com///')).toBe(API_BASE);
    expect(normalizeApiBase(' http://localhost:8080/ ')).toBe('http://localhost:8080');
    expect(normalizeApiBase(API_BASE)).toBe(API_BASE);
  });

  it('falls back to API_BASE for malformed or unsupported bases', () => {
    for (const input of [null, undefined, 123, '', '   ', 'api.tvmaze.com', 'ftp://api.tvmaze.com', 'http://', 'https:///']) {
      expect(normalizeApiBase(input)).toBe(API_BASE);
    }
  });

  it('keeps notification delays inside the safe setTimeout range', () => {
    expect(NOTIF_MAX_DELAY_MS).toBeGreaterThan(NOTIF_RESCHEDULE_INTERVAL_MS);
    expect(NOTIF_MAX_DELAY_MS).toBeLessThan(2 ** 31 - 1);
  });
});
