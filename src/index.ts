export { CachedFilehandle } from './CachedFilehandle.ts'
export { RemoteFileWithRangeCache } from './RemoteFileWithRangeCache.ts'
export {
  cachedBytes,
  clearCache,
  clearCacheFor,
  setCacheLimit,
  sweepIdleCache,
} from './extentCache.ts'
export {
  CACHE_IDLE_TIMEOUT_MS,
  CACHE_LIMIT,
  MAX_CONCURRENT,
  MAX_SIZE_ENTRIES,
  MIN_REQUEST,
  PIECE_SIZE,
  RESPONSE_TIMEOUT_MS,
} from './constants.ts'
