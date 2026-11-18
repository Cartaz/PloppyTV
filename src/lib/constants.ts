/** Base URL TVMaze, senza slash finale (api.ts concatena path che iniziano con `/`). */
export const API_BASE = 'https://api.tvmaze.com';

export const STORAGE_KEY = 'ploppytv_data_v1';
export const BACKUP_KEY = 'ploppytv_data_backup';
export const SCHEMA_VERSION = 2;
/** Avviso spazio: il documento salvato (×2 con il backup) si avvicina a ~5 MB. */
export const QUOTA_WARN_KB = 2250;

export const API_TIMEOUT_MS = 10000;
export const MAX_QUERY_LENGTH = 100;
export const MAX_IMPORT_SIZE = 10 * 1024 * 1024;

export const DISCOVER_CACHE_KEY = 'ploppytv_discover_cache';
export const DISCOVER_RECENT_CACHE_KEY = 'ploppytv_discover_recent_cache';
export const DISCOVER_CACHE_TTL = 60 * 60 * 1000; // 1 ora

export const DISCOVER_TARGET_PER_GENRE = 20;
export const DISCOVER_TARGET_OTHER = 30;
export const DISCOVER_TOTAL_TARGET = 6 * DISCOVER_TARGET_PER_GENRE + DISCOVER_TARGET_OTHER;

// Pagine TVMaze `/shows?page=N`: 250 serie per pagina, ordinate per ID
// (pagina = floor(id / 250)), quindi le ultime pagine contengono le serie
// aggiunte più di recente. "Ultimi arrivi" ricava l'ultima pagina dall'ID più
// alto in `/updates/shows` e legge le DISCOVER_RECENT_PAGE_COUNT precedenti.
export const TVMAZE_SHOWS_PER_PAGE = 250;
export const DISCOVER_POPULAR_PAGES = [0, 1, 2, 3, 4, 5, 6, 7, 8];
export const DISCOVER_RECENT_PAGE_COUNT = 8;
/** Usate solo se `/updates/shows` non risponde (ultima pagina valida al 18/11/2026: 382). */
export const DISCOVER_RECENT_FALLBACK_PAGES = [375, 376, 377, 378, 379, 380, 381, 382];

export const GENRE_CAROUSELS = ['Science-Fiction', 'Crime', 'Action', 'Thriller', 'Comedy', 'Drama'];

// ===== P2 constants =====

/** Lunghezza massima nota privata per episodio (P2.2). */
export const MAX_EPISODE_NOTE_LENGTH = 500;
/** Rating massimo per episodio (P2.1). */
export const MAX_EPISODE_RATING = 5;
/** Lunghezza massima di un tag (P2.3). */
export const MAX_TAG_LENGTH = 40;
/** Numero massimo di tag per serie (P2.3). */
export const MAX_TAGS_PER_SHOW = 20;

/** Chiave localStorage per le preferenze utente (lingua, notifiche, ecc.). P2.7/P2.9 */
export const PREFS_KEY = 'ploppytv_prefs_v1';

/** Ora locale (0-23) della notifica nel giorno di uscita: TVMaze dà solo la data. */
export const NOTIF_HOUR = 9;
/** Intervallo di re-scheduling delle notifiche (ogni 6 ore). P2.9 */
export const NOTIF_RESCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Delay massimo sicuro per setTimeout (ms). Valori superiori a 2^31-1
 * (2,147,483,647 ms ~ 24.85 giorni) causano overflow int32 e il timer
 * viene clamped a 1ms da Node.js/browser -> fire immediato.
 */
export const NOTIF_MAX_DELAY_MS = 24 * 24 * 60 * 60 * 1000; // 24 giorni, safe < 2^31-1
