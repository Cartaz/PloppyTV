export const API_BASE = 'https://api.tvmaze.com';
export const STORAGE_KEY = 'ploppytv_data_v1';
export const BACKUP_KEY = 'ploppytv_data_backup';
export const SCHEMA_VERSION = 1;

export const API_TIMEOUT_MS = 10000;
export const MIN_SEARCH_INTERVAL_MS = 300;
export const MAX_QUERY_LENGTH = 100;
export const MAX_IMPORT_SIZE = 10 * 1024 * 1024;

export const DISCOVER_CACHE_KEY = 'ploppytv_discover_cache';
export const DISCOVER_RECENT_CACHE_KEY = 'ploppytv_discover_recent_cache';
export const DISCOVER_CACHE_TTL = 60 * 60 * 1000; // 1 ora

export const DISCOVER_TARGET_PER_GENRE = 20;
export const DISCOVER_TARGET_OTHER = 30;
export const DISCOVER_TOTAL_TARGET = 6 * DISCOVER_TARGET_PER_GENRE + DISCOVER_TARGET_OTHER;

// Pagine TVMaze `/shows?page=N`. TVMaze aggiunge ~250 show per pagina.
// Le pagine "recenti" sono state scelte empiricamente: corrispondono a show
// con `premiered` negli ultimi ~6 mesi al momento della scrittura.
// IMPORTANTE: page 372 era out-of-range (HTTP 404) ed è stata rimossa.
// Queste pagine dovrebbero essere refreshate periodicamente (o calcolate
// dinamicamente in base alla data corrente).
export const DISCOVER_POPULAR_PAGES = [0, 1, 2, 3, 4, 5, 6, 7, 8];
export const DISCOVER_RECENT_PAGES = [340, 345, 350, 355, 358, 360, 362, 365, 367, 370];

export const GENRE_CAROUSELS = ['Science-Fiction', 'Crime', 'Action', 'Thriller', 'Comedy', 'Drama'];
