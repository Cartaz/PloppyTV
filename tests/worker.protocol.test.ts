import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Show, WorkerResponse } from '../src/types';
import '../src/worker/stats.worker';

let responses: WorkerResponse[];
let originalPostMessage: typeof self.postMessage;

beforeEach(() => {
  responses = [];
  originalPostMessage = self.postMessage;
  (self as unknown as { postMessage: (message: WorkerResponse) => void }).postMessage = (message) => {
    responses.push(message);
  };
});

afterEach(() => {
  (self as unknown as { postMessage: typeof self.postMessage }).postMessage = originalPostMessage;
  vi.restoreAllMocks();
});

function send(data: unknown): WorkerResponse {
  responses = [];
  const handler = (self as unknown as { onmessage: ((event: { data: unknown }) => void) | null }).onmessage;
  expect(handler).not.toBeNull();
  handler?.({ data });
  expect(responses).toHaveLength(1);
  return responses[0];
}

describe('worker protocol contracts', () => {
  it('returns a stats response with the request id', () => {
    const response = send({ type: 'stats', id: 7, shows: [] });

    expect(response.type).toBe('stats');
    if (response.type !== 'stats') return;
    expect(response.id).toBe(7);
    expect(response.result.totalShows).toBe(0);
    expect(response.result.totalWatched).toBe(0);
  });

  it('returns a calendar response with week metadata', () => {
    const response = send({ type: 'calendar', id: 11, shows: [], weekOffset: 0 });

    expect(response.type).toBe('calendar');
    if (response.type !== 'calendar') return;
    expect(response.id).toBe(11);
    expect(response.result).toEqual([]);
    expect(response.afterWeek).toEqual([]);
    expect(response.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(response.weekEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('converts a compute failure into an error response instead of throwing', () => {
    const bomb = {
      id: 91,
      name: 'Corrupt show',
      seasons: {},
      list: 'watching',
      runtime: 45,
      genres: [],
      image: null,
    } as unknown as Show;
    Object.defineProperty(bomb, 'totalEpisodes', {
      configurable: true,
      get() {
        throw new Error('corrupt totalEpisodes');
      },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = send({ type: 'stats', id: 91, shows: [bomb] });

    expect(errorSpy).toHaveBeenCalledWith('[worker] error:', expect.any(Error));
    expect(response.type).toBe('error');
    if (response.type !== 'error') return;
    expect(response.id).toBe(91);
    expect(response.message).toBe('corrupt totalEpisodes');
  });
});
