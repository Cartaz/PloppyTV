import { describe, expect, it } from 'vitest';
import { NOTIF_MAX_DELAY_MS, NOTIF_RESCHEDULE_INTERVAL_MS } from '../src/lib/constants';

describe('constants contracts', () => {
  it('keeps notification delays inside the safe setTimeout range', () => {
    expect(NOTIF_MAX_DELAY_MS).toBeGreaterThan(NOTIF_RESCHEDULE_INTERVAL_MS);
    expect(NOTIF_MAX_DELAY_MS).toBeLessThan(2 ** 31 - 1);
  });
});
