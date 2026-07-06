// Client TVMaze con timeout, abort, errori tipizzati

import type { TvmazeEpisode, TvmazeSearchResult, TvmazeShow } from '../types';
import { API_BASE, API_TIMEOUT_MS } from './constants';

export class ApiError extends Error {
  status?: number;
  override name: string;
  constructor(message: string, name: string, status?: number) {
    super(message);
    this.name = name;
    this.status = status;
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      controller.abort();
    } else {
      signal.addEventListener('abort', () => controller.abort());
    }
  }
  try {
    const res = await fetch(API_BASE + path, { signal: controller.signal });
    if (!res.ok) {
      const err = new ApiError('API error ' + res.status, res.status === 429 ? 'RateLimitError' : 'ApiError', res.status);
      throw err;
    }
    return (await res.json()) as T;
  } catch (e: unknown) {
    if (e instanceof ApiError) throw e;
    const err = e as { name?: string };
    if (err.name === 'AbortError') {
      if (!signal || !signal.aborted) {
        throw new ApiError('Request timeout', 'TimeoutError');
      }
      throw e;
    }
    if (err.name === 'TypeError') {
      throw new ApiError('Network error', 'NetworkError');
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function searchShows(query: string, signal?: AbortSignal): Promise<TvmazeSearchResult[]> {
  return apiGet<TvmazeSearchResult[]>('/search/shows?q=' + encodeURIComponent(query), signal);
}

export async function getShowEpisodes(showId: number, signal?: AbortSignal): Promise<TvmazeEpisode[]> {
  return apiGet<TvmazeEpisode[]>('/shows/' + encodeURIComponent(showId) + '/episodes', signal);
}

export async function getShowsPage(page: number, signal?: AbortSignal): Promise<TvmazeShow[]> {
  return apiGet<TvmazeShow[]>('/shows?page=' + page, signal);
}
