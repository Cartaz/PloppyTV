// Tipi condivisi tra UI e worker

export type ListName = 'watching' | 'towatch' | 'completed';

export const ALLOWED_LISTS: readonly ListName[] = ['watching', 'towatch', 'completed'] as const;

export interface Episode {
  num: number;
  id: number;
  watched: boolean;
  airdate: string | null;
  name?: string | null;
  runtime?: number | null;
}

export interface Show {
  id: number;
  name: string;
  image: string | null;
  status: string;
  premiered: string | null;
  genres: string[];
  summary: string;
  network: string;
  runtime: number;
  list: ListName;
  seasons: Record<number, Episode[]>;
  totalSeasons: number;
  totalEpisodes: number;
  addedAt: number;
}

// Show grezzo da TVMaze (parziale, solo i campi usati)
export interface TvmazeShow {
  id: number;
  name?: string;
  status?: string;
  premiered?: string;
  genres?: string[];
  summary?: string;
  runtime?: number;
  averageRuntime?: number;
  weight?: number;
  image?: { medium?: string; original?: string } | null;
  network?: { name?: string } | null;
  webChannel?: { name?: string } | null;
  rating?: { average?: number | null } | null;
}

export interface TvmazeEpisode {
  id: number;
  season: number;
  number: number;
  name?: string;
  airdate?: string;
  runtime?: number;
}

export interface TvmazeSearchResult {
  score: number;
  show: TvmazeShow;
}

export interface SavedData {
  version: number;
  shows: Show[];
  savedAt: number;
}

export interface ExportedData {
  version: number;
  shows: Show[];
  exportedAt: string;
}

export interface NextEpisode {
  season: number;
  num: number;
  airdate: string | null;
}

export interface CalendarEpisode {
  showId: number;
  showName: string;
  totalEpisodes: number;
  watchedCount: number;
  season: number;
  num: number;
  name: string | null;
  date: string; // ISO date YYYY-MM-DD
}

export interface StatsResult {
  totalShows: number;
  totalWatched: number;
  totalEpisodes: number;
  completedShows: number;
  watchingShows: number;
  towatchShows: number;
  totalMinutes: number;
  totalDays: number;
  remHours: number;
  timeLabel: string;
  totalProgress: number;
  topGenres: Array<{ genre: string; episodes: number; shows: number }>;
  topShows: Array<{ showId: number; showName: string; image: string | null; watched: number; totalEpisodes: number; pct: number }>;
}

// Messaggi Worker
export type WorkerRequest =
  | { type: 'stats'; shows: Show[] }
  | { type: 'calendar'; shows: Show[]; weekOffset: number };

export type WorkerResponse =
  | { type: 'stats'; result: StatsResult }
  | { type: 'calendar'; result: CalendarEpisode[]; weekStart: string; weekEnd: string; afterWeek: CalendarEpisode[] };
