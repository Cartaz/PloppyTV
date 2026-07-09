// Test entry: re-export internals needed for runtime tests
export { saveData, loadData, isStorageOK } from '../src/lib/storage';
export {
  getState,
  setState,
  setShows,
  subscribe,
  emitChange,
  replaceShow,
  removeShowFromState,
  setStorageDisabled,
  setQuotaWarned,
} from '../src/lib/store';
export { normalizeShow, reconcileAllLists, buildShowFromTvmaze } from '../src/lib/normalize';
export { getWatchedCount, localISODate } from '../src/lib/utils';
export { STORAGE_KEY, BACKUP_KEY, SCHEMA_VERSION, MAX_IMPORT_SIZE } from '../src/lib/constants';
