/**
 * The chunk machinery, as free functions over a {@link FetchByteRange}.
 *
 * None of it is about HTTP: it is chunk indexing, an LRU, in-flight
 * de-duplication and abort reference counting over byte ranges. That is what
 * lets the same cache sit in front of a remote file, a local file or a Blob.
 *
 * Every piece of shared mutable state lives here rather than being spread across
 * the package, because {@link clearCache} *reassigns* several of these maps and
 * an imported binding cannot be reassigned from another module.
 */
import {
  CACHE_IDLE_TIMEOUT_MS,
  CHUNK_SIZE,
  MAX_CACHE_ENTRIES,
  MAX_CONCURRENT,
  MAX_SIZE_ENTRIES,
  SWEEP_INTERVAL_MS,
} from './constants.ts'
import { copyChunkInto, unrefIfPossible } from './util.ts'

interface ChunkRun {
  start: number
  end: number
}

interface PendingChunk {
  index: number
  chunk: Promise<Uint8Array>
}

/**
 * Reference count for one range request. The unit of *fetching* is a run of
 * contiguous chunks covered by a single request, while the unit of *joining* is
 * a chunk — so the count lives on the run, and every chunk it produced points
 * back at it. The request is cancelled only once every reader interested in any
 * of its chunks has given up.
 */
interface RunState {
  /** signals of the readers still waiting on this request */
  signals: Set<AbortSignal>
  /** true once a reader joins without a signal, which pins the request */
  pinned: boolean
  /** aborts when every reader has given up. what the request runs under */
  controller: AbortController
  /** aborted to take this run's listeners back off its readers' signals */
  dispose: AbortController
  settled: boolean
  /**
   * set by a clear that happened while this run was in flight. Its readers
   * still get their bytes — they asked before the clear and are entitled to
   * them — but nothing it produces goes back into the cache the clear emptied.
   */
  stale: boolean
}

interface InFlightChunk {
  chunk: Promise<Uint8Array>
  run: RunState
}

interface CacheEntry {
  bytes: Uint8Array
  /**
   * When a read last looked at this chunk, for {@link sweepIdleCache}. Per entry
   * rather than one timestamp for the whole cache: a session polling one small
   * file would otherwise keep every cold chunk of every other file alive with
   * it.
   */
  lastTouched: number
}

/**
 * Requests in flight against one key, and the reads waiting for a turn.
 * See {@link MAX_CONCURRENT} for why the pool is per key rather than one pool
 * for the process.
 */
interface Pool {
  active: number
  queue: (() => void)[]
}

/**
 * Fetches an inclusive byte range `[start, end]`, however the underlying source
 * does that. The one thing the chunk cache needs from a file.
 */
export type FetchByteRange = (
  start: number,
  end: number,
  init?: RequestInit,
) => Promise<Uint8Array>

let cache = new Map<string, CacheEntry>()
/**
 * File size, keyed by cache key, parallel to the chunk cache. Per-instance state
 * cannot be used: a cache hit serving bytes from a previous instance's fetch
 * would otherwise leave a new instance's `stat()` with no Content-Range
 * observation, returning a bogus size of 0.
 */
let sizeCache = new Map<string, number>()
/**
 * Chunk fetches in progress, keyed like `cache`. A read that needs a chunk
 * another read is already fetching awaits that promise rather than requesting
 * the same bytes again: concurrent reads over adjacent genomic blocks routinely
 * land in one 256 KiB chunk, and each duplicate also burns one of the
 * MAX_CONCURRENT slots. A failed fetch rejects every waiter, which is what each
 * would have gotten on its own — except for a *cancellation*, which belongs to
 * the reader that issued it and says nothing about anyone joined to its fetch.
 * That is why the owning run is recorded here; see {@link joinChunk}.
 */
let inFlight = new Map<string, InFlightChunk>()
/** one {@link Pool} per key, created on demand and dropped when it empties */
const pools = new Map<string, Pool>()
/**
 * Lookups that must happen once per key however many callers ask at once —
 * `stat`, in practice. See {@link oncePerKey}.
 */
let singleFlight = new Map<string, Promise<unknown>>()

function cacheKey(key: string, chunkIndex: number) {
  return `${key}:${chunkIndex}`
}

// ---------------------------------------------------------------------------
// the chunk cache itself
// ---------------------------------------------------------------------------

function getCached(key: string) {
  const entry = cache.get(key)
  if (entry !== undefined) {
    // Re-insert to move this key to the end of the Map's iteration order, which
    // is the end putCached evicts from. Without it eviction is FIFO by first
    // fetch, so a constantly-read chunk (bgzf header, bam index block) is
    // dropped as readily as a one-shot one.
    cache.delete(key)
    cache.set(key, entry)
    entry.lastTouched = Date.now()
  }
  return entry?.bytes
}

/** drop the least recently used entry of `map` while it is at or over `max` */
function evictOldest(map: Map<string, unknown>, max: number) {
  while (map.size >= max) {
    const oldestKey = map.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    map.delete(oldestKey)
  }
}

function putCached(key: string, chunk: Uint8Array) {
  // Delete before the size check, so that re-caching a key already present
  // neither evicts an innocent entry to make room for one already counted nor
  // leaves it at the rank it held before — `Map.set` on an existing key keeps
  // its position, so without this a chunk that was evicted and re-fetched goes
  // straight back to being first in line to be evicted again.
  cache.delete(key)
  evictOldest(cache, MAX_CACHE_ENTRIES)
  cache.set(key, { bytes: chunk, lastTouched: Date.now() })
  startSweep()
}

/**
 * Whether the file is known to end at or before where this chunk starts.
 */
function isKnownPastEof(key: string, chunkIndex: number) {
  const size = sizeCache.get(key)
  return size !== undefined && chunkIndex * CHUNK_SIZE >= size
}

/**
 * Whether a chunk the run produced is worth keeping.
 *
 * Only an *empty* chunk is ever in question, and the question is whether it is
 * an EOF marker or an empty answer nobody can explain. Caching it is what stops
 * later reads asking for bytes past the end; caching one that cannot be
 * explained is indistinguishable from data loss, and it persists for the whole
 * idle window across every handle sharing the key. Measured: one spurious 416
 * made a read return zero bytes, and made the *next* read of the same offset
 * return zero bytes without going to the network at all.
 *
 * What separates them is the rest of the run. A run whose body came back with
 * data in it reached the end of the file — `assertBodyMatchesRange` has already
 * rejected a 206 that stops short of both the requested end and EOF — so a
 * chunk past that data is genuinely past EOF and the marker is real. A run that
 * came back **wholly** empty is the untrustworthy one: that is the shape of the
 * unexplained 416, and it is only believed where a known size confirms it.
 *
 * The distinction has to be drawn here rather than by size alone, because the
 * size is exactly what is missing in the case that matters — a cross-origin
 * server not exposing `Content-Range`. Left to `isKnownPastEof` on its own,
 * every read past the end of such a file re-requested, permanently: measured at
 * one wasted round trip per read, and every bgzf reader over-reads its last
 * block by construction.
 */
function isWorthCaching(
  key: string,
  chunkIndex: number,
  chunk: Uint8Array,
  runBody: Uint8Array,
) {
  return (
    chunk.length > 0 || runBody.length > 0 || isKnownPastEof(key, chunkIndex)
  )
}

// ---------------------------------------------------------------------------
// idle sweep
// ---------------------------------------------------------------------------

let sweepTimer: ReturnType<typeof setInterval> | undefined

/**
 * Drop every chunk no read has touched for {@link CACHE_IDLE_TIMEOUT_MS}.
 *
 * Safe to call at any moment, including mid-fetch, and that is not an accident:
 * `getCachedRange` holds a strong local reference to every chunk it will
 * assemble from before its first await, precisely so that eviction underneath it
 * is harmless. A chunk dropped here that somebody still wants is re-fetched.
 *
 * Deliberately narrower than {@link clearCache}: it touches neither `inFlight`
 * nor the pools, whose entries are by definition active, and it keeps
 * `sizeCache`, which is one number per key and costs a round trip to re-derive.
 *
 * Exported so a caller can reclaim on its own schedule — a tab going hidden,
 * say — rather than only on the interval. The interval is what makes this work
 * for the case it exists for, though: an idle consumer is calling nothing, so a
 * lazy check inside `getCached` would never fire for exactly the reader who has
 * walked away.
 */
export function sweepIdleCache() {
  const cutoff = Date.now() - CACHE_IDLE_TIMEOUT_MS
  for (const [key, entry] of cache) {
    if (entry.lastTouched <= cutoff) {
      cache.delete(key)
    }
  }
  if (cache.size === 0) {
    stopSweep()
  }
}

// Costs nothing while the cache is empty: the timer starts with the first chunk
// and the sweep that empties the cache stops it again.
function startSweep() {
  if (sweepTimer === undefined) {
    sweepTimer = setInterval(sweepIdleCache, SWEEP_INTERVAL_MS)
    unrefIfPossible(sweepTimer)
  }
}

function stopSweep() {
  if (sweepTimer !== undefined) {
    clearInterval(sweepTimer)
    sweepTimer = undefined
  }
}

// ---------------------------------------------------------------------------
// clearing
// ---------------------------------------------------------------------------

/**
 * Drop every cached chunk, every known size and every queued read.
 *
 * Mostly for tests, which need each case to start from an empty cache, and for a
 * consumer that knows it is finished with everything it has opened. To reclaim
 * one file rather than all of them, see {@link clearCacheFor}.
 *
 * Deliberately leaves each pool's `active` count alone. Resetting it is the bug
 * this cache had — assigning over a count of work that is genuinely still
 * running lets the next reads overshoot the cap, measured at forty concurrent
 * against a limit of twenty — and dropping the pools outright has the same
 * effect by another route, since the leaked work then decrements a pool nothing
 * consults. So a file whose transfer has wedged mid-body stays wedged across a
 * clear, which is the honest cost of putting no clock on a transfer; see
 * {@link MAX_CONCURRENT}. It is one file rather than the process, and a server
 * that never answers at all is still covered by {@link RESPONSE_TIMEOUT_MS}.
 */
export function clearCache() {
  cache = new Map<string, CacheEntry>()
  sizeCache = new Map<string, number>()
  singleFlight = new Map<string, Promise<unknown>>()
  // the new cache is empty, so nothing is left for the sweep to find; putCached
  // starts it again with the next chunk
  stopSweep()
  // A leaked fetch that settles after this still removes its own entry from the
  // new map only if it is still the owner, so dropping the old map is safe. It
  // would still repopulate the cache, though, which is what stale stops.
  markStale(inFlight.values())
  inFlight = new Map<string, InFlightChunk>()
  resumeAllWaiters()
}

/**
 * Take the runs behind `entries` out of the cache's future.
 *
 * A clear cannot cancel work in flight — a reader waiting on it asked before
 * the clear and is entitled to its bytes — but without this the run's
 * `putCached` lands after the clear and puts the file straight back. Measured:
 * one read, `clearCacheFor` while it was in flight, and the next read of the
 * same offset was served from the cache that had just been emptied.
 */
function markStale(entries: Iterable<InFlightChunk>) {
  for (const entry of entries) {
    entry.run.stale = true
  }
}

/**
 * Drop one file's cached chunks and its size, leaving every other file alone.
 *
 * What a consumer closing one track wants, and what {@link clearCache} is too
 * blunt for. Chunk keys are prefixed with the file key, so this is a scan of the
 * cache — bounded by {@link MAX_CACHE_ENTRIES}, and only on an explicit call.
 *
 * Deliberately does not *cancel* in-flight requests: a read still waiting on one
 * is entitled to its bytes, and its own cleanup removes it. What those requests
 * may no longer do is put the file back in the cache once they land, which is
 * what marking their runs stale prevents.
 */
export function clearCacheFor(key: string) {
  for (const chunkKey of cache.keys()) {
    if (isChunkOf(chunkKey, key)) {
      cache.delete(chunkKey)
    }
  }
  for (const [chunkKey, entry] of inFlight) {
    if (isChunkOf(chunkKey, key)) {
      entry.run.stale = true
    }
  }
  sizeCache.delete(key)
  if (cache.size === 0) {
    stopSweep()
  }
}

/**
 * Whether `chunkKey` is one of `key`'s chunks.
 *
 * The suffix has to be checked, not just the prefix. Keys with colons in them
 * are ordinary — a `host:port` URL, an S3 object name carrying a timestamp, a
 * `blob:` key — and `startsWith(`${key}:`)` alone also matches every chunk of
 * any key that merely *begins* with this one: measured, `clearCacheFor` on
 * `https://h/a` evicted the chunks of `https://h/a:2024` too.
 */
function isChunkOf(chunkKey: string, key: string) {
  return (
    chunkKey.startsWith(`${key}:`) &&
    /^\d+$/.test(chunkKey.slice(key.length + 1))
  )
}

// ---------------------------------------------------------------------------
// concurrency, per key
// ---------------------------------------------------------------------------

/**
 * The endpoint a key's requests are polite to, which is what the limit is about.
 *
 * Not the key itself. A presigned S3 or GCS URL carries an expiring signature in
 * the query string, so a session re-signing its URLs mints a new key on every
 * read — the same rotation {@link MAX_SIZE_ENTRIES} exists for — and keyed on
 * that, the pool is fresh every time and caps nothing. Collapsing to the origin
 * also puts a real ceiling back on the process, which per-URL scoping had
 * removed: a browser session talks to a handful of origins, not a handful per
 * file.
 *
 * Only for http(s). A `file://` URL has an origin of `"null"`, so every local
 * file in the process would share one pool of twenty for no reason — there is no
 * server to be polite to.
 */
function poolKeyFor(key: string) {
  try {
    const url = new URL(key)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.origin
      : key
  } catch {
    return key
  }
}

function poolFor(key: string) {
  let pool = pools.get(key)
  if (pool === undefined) {
    pool = { active: 0, queue: [] }
    pools.set(key, pool)
  }
  return pool
}

/** drop a pool once nothing is using it, so a rotating URL cannot accumulate */
function releasePool(key: string, pool: Pool) {
  if (pool.active === 0 && pool.queue.length === 0 && pools.get(key) === pool) {
    pools.delete(key)
  }
}

function runNext(key: string, pool: Pool) {
  if (pool.queue.length > 0 && pool.active < MAX_CONCURRENT) {
    // claim the slot on behalf of the work we're about to resume
    pool.active++
    pool.queue.shift()!()
  }
  releasePool(key, pool)
}

/**
 * Resume every queued read across every pool, claiming a slot for each the way
 * {@link runNext} would.
 *
 * Queued waiters are RESUMED, not dropped: a dropped resolver strands its
 * {@link limitConcurrency} caller with no resolve and no reject, so the read
 * neither runs nor settles — a hang rather than a cancellation.
 *
 * `active` is incremented rather than assigned. Assigning it discards the count
 * of work that is genuinely still running, so the pool believes it has room it
 * does not have: measured, twenty requests in flight through a `clearCache` let
 * the next reads reach forty concurrent against a cap of twenty, and left the
 * count negative afterwards to do it again.
 */
function resumeAllWaiters() {
  for (const [key, pool] of pools) {
    const waiters = pool.queue.splice(0)
    pool.active += waiters.length
    for (const resolve of waiters) {
      resolve()
    }
    releasePool(key, pool)
  }
}

/**
 * Wait for a slot in `pool`, giving up if `signal` aborts before one frees.
 *
 * Without the signal a queued read had no way out at all. The deadline in
 * {@link withResponseDeadline} does not cover this — it starts once the slot is
 * claimed and a request goes out — so against the wedged origin
 * {@link MAX_CONCURRENT} describes, a read behind the twenty stuck requests
 * waited forever *and ignored its caller's abort*, leaving the promise pending
 * and everything the reader closed over retained. `constants.ts` says the
 * caller's `AbortSignal` is the escape hatch; queued, it was not one.
 *
 * The waiter is spliced out of the queue rather than left in it as a resolver
 * that no longer does anything. {@link runNext} claims a slot *before* it
 * resumes whatever it shifts, so a no-op waiter would take a slot out of the
 * pool permanently — the same accounting {@link resumeAllWaiters} is careful
 * about, reached from the other direction.
 */
async function waitForSlot(pool: Pool, signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    return false
  }
  let claimed = false
  await new Promise<void>(resolve => {
    const resume = () => {
      // runNext has already claimed the slot on our behalf
      claimed = true
      signal?.removeEventListener('abort', giveUp)
      resolve()
    }
    const giveUp = () => {
      const index = pool.queue.indexOf(resume)
      if (index !== -1) {
        pool.queue.splice(index, 1)
      }
      resolve()
    }
    pool.queue.push(resume)
    signal?.addEventListener('abort', giveUp, { once: true })
  })
  // Deliberately not `!signal.aborted`. An abort that lands after runNext has
  // resumed us finds the listener already gone, so the slot is ours and giving
  // it back is the business of the `finally` below rather than of this call —
  // reported as claimed, `fn` then declines to use it.
  return claimed
}

export async function limitConcurrency<T>(
  key: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
) {
  const poolKey = poolKeyFor(key)
  const pool = poolFor(poolKey)
  if (pool.active < MAX_CONCURRENT) {
    pool.active++
  } else if (!(await waitForSlot(pool, signal))) {
    // Gave up before a slot freed, so nothing below may run: no slot was ever
    // claimed and the `finally` would hand back one this call never took. The
    // waiter just removed may also have been the last thing keeping the pool
    // alive.
    releasePool(poolKey, pool)
    // throwIfAborted rather than a reject inside waitForSlot, so the reason
    // reaches the caller exactly as every other abort in this package does
    signal?.throwIfAborted()
    // Unreachable: waitForSlot only declines to claim a slot when `signal`
    // aborted. Throw rather than assert, so a future refactor that breaks that
    // fails loudly instead of running the request without a slot.
    throw new Error(`internal: gave up waiting for a request slot for ${key}`)
  }
  try {
    return await fn()
  } finally {
    pool.active--
    runNext(poolKey, pool)
  }
}

/**
 * Run `fn` once per key however many callers ask for it at once, and let them
 * all await the same result.
 *
 * `stat` is the caller. It is guarded by `hasSize`, but that guard only sees
 * sizes that have already arrived, so N handles opening a file together each
 * found the size missing and each issued its own request — measured, ten
 * concurrent `stat()` calls made ten requests for one number.
 */
export function oncePerKey<T>(key: string, fn: () => Promise<T>) {
  const existing = singleFlight.get(key) as Promise<T> | undefined
  if (existing !== undefined) {
    return existing
  }
  const started = fn()
  const forget = () => {
    if (singleFlight.get(key) === started) {
      singleFlight.delete(key)
    }
  }
  started.then(forget, forget)
  singleFlight.set(key, started)
  return started
}

// ---------------------------------------------------------------------------
// file sizes
// ---------------------------------------------------------------------------

function putSize(key: string, size: number) {
  sizeCache.delete(key)
  evictOldest(sizeCache, MAX_SIZE_ENTRIES)
  sizeCache.set(key, size)
}

/**
 * Record a size a filehandle learned some way other than a range request — a
 * `stat` the underlying source answers directly, or one a subclass gets from a
 * metadata endpoint. Authoritative, so unlike the Content-Range observation
 * below it overwrites what is already there.
 *
 * Guarded on finiteness because a non-finite size does not fail, it *poisons*:
 * `Math.min(start + length, NaN)` is NaN, so `getCachedRange`'s chunk loop never
 * runs and every later read of that file returns empty with nothing said. A
 * metadata endpoint that populates `size` only for files that have one — not for
 * folders, shortcuts or native editor documents — makes `Number(undefined)` a
 * reachable input rather than a hypothetical.
 */
export function recordSize(key: string, size: number) {
  if (Number.isFinite(size)) {
    putSize(key, size)
  }
}

export function hasSize(key: string) {
  return sizeCache.has(key)
}

/**
 * Re-inserts on the way out, so the map is ordered by *use* rather than by first
 * write. Without that, `putSize` evicts the entry a session reads all day — it
 * was written first, so it goes first — while the five thousand rotating
 * presigned URLs that pushed it out are all newer and all stay. Losing it loses
 * the EOF clamp `getCachedRange` depends on.
 */
export function getSize(key: string) {
  const size = sizeCache.get(key)
  if (size !== undefined) {
    sizeCache.delete(key)
    sizeCache.set(key, size)
  }
  return size
}

/**
 * Record a file's total size once, from wherever it was observed. An
 * already-known size is left alone (the file is not expected to change under us
 * mid-session).
 */
export function recordSizeIfUnknown(key: string, size: number | undefined) {
  if (size !== undefined && !sizeCache.has(key)) {
    putSize(key, size)
  }
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

function fetchRun(
  key: string,
  run: ChunkRun,
  init: RequestInit | undefined,
  doFetch: FetchByteRange,
) {
  const state: RunState = {
    signals: new Set(),
    pinned: false,
    controller: new AbortController(),
    dispose: new AbortController(),
    settled: false,
    stale: false,
  }
  // The request runs under the run's own signal, not the opening reader's: it
  // is shared, so it must outlive any one reader giving up. joinRun registers
  // them, starting with the reader that opened it.
  const data = limitConcurrency(
    key,
    () => {
      // every reader gave up while this was queued, so there is nothing to ask
      // for. On a pan that is the ordinary case rather than a corner
      state.controller.signal.throwIfAborted()
      return doFetch(run.start * CHUNK_SIZE, (run.end + 1) * CHUNK_SIZE - 1, {
        ...init,
        signal: state.controller.signal,
      })
    },
    // and the same signal takes the run back out of the queue, rather than
    // leaving it waiting for a slot it no longer wants
    state.controller.signal,
  )
  joinRun(state, init?.signal)
  const settle = () => {
    state.settled = true
    // nothing reads these once the request has settled, and holding them
    // would pin each reader's AbortController behind this run
    state.dispose.abort()
    state.signals.clear()
  }
  data.then(settle, settle)
  const pending: PendingChunk[] = []
  for (let index = run.start; index <= run.end; index++) {
    pending.push({ index, chunk: publishChunk(key, run, index, data, state) })
  }
  return pending
}

/**
 * Derive one chunk from the run that covers it, publish it for other reads to
 * join, and cache it once it arrives.
 */
function publishChunk(
  key: string,
  run: ChunkRun,
  index: number,
  data: Promise<Uint8Array>,
  state: RunState,
) {
  const chunkKey = cacheKey(key, index)
  const offset = (index - run.start) * CHUNK_SIZE
  // A run crossing EOF comes back short: its last chunk with data is short
  // and any chunk past that is empty. Both are cached as-is, so a later read
  // sees the EOF marker instead of re-requesting past EOF.
  //
  // slice, not subarray: a view would keep the whole run buffer alive for as
  // long as any one of its chunks stays cached, so evicting a chunk would
  // free nothing and MAX_CACHE_ENTRIES would bound nothing.
  const chunk = data.then(buffer => {
    const copy = buffer.slice(offset, offset + CHUNK_SIZE)
    if (!state.stale && isWorthCaching(key, index, copy, buffer)) {
      putCached(chunkKey, copy)
    }
    return copy
  })
  const entry = { chunk, run: state }
  inFlight.set(chunkKey, entry)
  const forget = () => {
    // only if still the owner: clearCache, or a later run for the same
    // chunk, may have replaced this entry
    if (inFlight.get(chunkKey) === entry) {
      inFlight.delete(chunkKey)
    }
  }
  // runs after the putCached above, so a chunk is never absent from both the
  // cache and this map
  void chunk.then(forget, forget)
  return chunk
}

/**
 * Register a reader's interest in a run, so its request survives until that
 * reader has given up too.
 *
 * A reader with **no signal cannot give up**, so it pins the run: there is no
 * longer any set of aborts that should stop it. That is the honest reading of
 * a caller that never asked to be cancellable, and it means one signal-free
 * read makes that request uncancellable for everyone sharing it.
 */
function joinRun(state: RunState, signal: RequestInit['signal']) {
  if (!signal) {
    state.pinned = true
  } else if (signal.aborted) {
    // A reader that has already given up is not a waiter, and must not be
    // counted as one: an `abort` listener never fires on a signal that
    // aborted before it was added, so nothing would ever take this signal
    // back out of the set. The count would never reach zero and the request
    // would be uncancellable for everyone sharing it, silently.
    //
    // `getCachedRange` rejects such a reader before it gets here, so this is
    // the belt to that braces — the invariant is too quiet to fail to be left
    // resting on a check several frames away.
    abortIfUnwanted(state, signal.reason)
  } else if (!state.signals.has(signal)) {
    // guarded so one signal joining twice — a read spanning several chunks of
    // the same run — does not add two listeners
    state.signals.add(signal)
    signal.addEventListener(
      'abort',
      () => {
        state.signals.delete(signal)
        abortIfUnwanted(state, signal.reason)
      },
      // `once` covers the abort firing; `dispose` covers it never firing
      { once: true, signal: state.dispose.signal },
    )
  }
}

/** cancel a run's request once no reader is left who wants it */
function abortIfUnwanted(state: RunState, reason: unknown) {
  if (!state.pinned && state.signals.size === 0) {
    state.controller.abort(reason)
  }
}

/**
 * Await a chunk fetch another read already had in flight.
 *
 * Sharing one fetch between reads is what makes a row of adjacent genomic
 * blocks cheap. It used to mean another reader's `AbortSignal` could reject a
 * chunk this read still needed, which was handled by re-issuing the fetch —
 * correct, but it threw away a 256 KiB request that was already in flight and
 * that somebody still wanted. Joining the run's reference count instead means
 * the request is simply not cancelled while anyone is still waiting on it, so
 * there is nothing to re-issue. `@gmod/bam` and `@gmod/cram` do the same at
 * their own cache layers.
 *
 * Returns undefined when the run is not joinable, and the caller fetches the
 * chunk itself instead.
 */
function joinChunk(flight: InFlightChunk, init?: RequestInit) {
  if (flight.run.controller.signal.aborted) {
    // Every reader of this run gave up, so its request was cancelled — but the
    // rejection takes a tick to arrive and the entry is not removed until after
    // that, so in between it sits here looking joinable. Joining it hands this
    // reader somebody else's AbortError, which is the exact thing the reference
    // count exists to prevent. On a pan that window is the ordinary sequence
    // rather than a corner: the old blocks are aborted and the new ones
    // requested in the same tick, and adjacent blocks routinely want the same
    // 256 KiB chunk. Refusing is safe because fetchRun's cleanup removes only
    // its own entry, so the fresh run replacing this one survives the doomed
    // one settling.
    return undefined
  }
  // a settled run has dropped its abort listeners, so joining it would add a
  // signal nothing will ever take back out. Its chunk is still the one to await:
  // putCached runs after settle, so there is a window in which the bytes have
  // arrived and are in neither the cache nor this map.
  if (!flight.run.settled) {
    joinRun(flight.run, init?.signal)
  }
  return flight.chunk
}

// ---------------------------------------------------------------------------
// the read path
// ---------------------------------------------------------------------------

interface ReadPlan {
  /** chunks already in hand, held strongly so eviction cannot take them back */
  chunks: Map<number, Uint8Array>
  /** chunks arriving, whether joined from another read or fetched by this one */
  pending: PendingChunk[]
  /** last chunk assembly should look at; lowered when a cached chunk ends the file */
  endChunk: number
}

/**
 * Decide what this read needs and set it in motion.
 *
 * Contiguous runs of missing chunks become one range request each; a chunk
 * another read is already fetching is awaited instead. Planning and publishing
 * run to completion without an await, so two reads in the same tick cannot both
 * open a run for the same chunk.
 *
 * Stops at a cached chunk shorter than CHUNK_SIZE — the file ended inside it, so
 * every later chunk starts past EOF. That covers a read that runs past the end
 * even when the size is unknown (CORS hiding Content-Range).
 */
function planRead(
  key: string,
  startChunk: number,
  lastChunk: number,
  init: RequestInit | undefined,
  doFetch: FetchByteRange,
): ReadPlan {
  const chunks = new Map<number, Uint8Array>()
  const pending: PendingChunk[] = []
  const runs: ChunkRun[] = []
  let endChunk = lastChunk
  for (let index = startChunk; index <= lastChunk; index++) {
    const cached = getCached(cacheKey(key, index))
    if (cached !== undefined) {
      chunks.set(index, cached)
      if (cached.length < CHUNK_SIZE) {
        endChunk = index
        break
      }
    } else {
      const joined = joinInFlight(key, index, init)
      if (joined === undefined) {
        extendRuns(runs, index)
      } else {
        pending.push({ index, chunk: joined })
      }
    }
  }
  for (const run of runs) {
    pending.push(...fetchRun(key, run, init, doFetch))
  }
  return { chunks, pending, endChunk }
}

function joinInFlight(
  key: string,
  index: number,
  init: RequestInit | undefined,
) {
  const flight = inFlight.get(cacheKey(key, index))
  return flight ? joinChunk(flight, init) : undefined
}

/** append `index` to the run in progress, or start a new one */
function extendRuns(runs: ChunkRun[], index: number) {
  const lastRun = runs.at(-1)
  if (lastRun?.end === index - 1) {
    lastRun.end = index
  } else {
    runs.push({ start: index, end: index })
  }
}

/**
 * Copy every chunk this read covers into one buffer, and report where the real
 * data stops.
 *
 * Assembly reads only from `chunks`, never from the module-global cache: that
 * cache is capped and shared across every file, so a concurrent read's
 * `putCached` can evict a chunk we depend on while we await, and a later
 * `getCached` would return undefined. Holding the reference locally makes
 * eviction harmless.
 */
function assembleRange(
  key: string,
  { chunks, endChunk }: ReadPlan,
  start: number,
  end: number,
  startChunk: number,
) {
  const result = new Uint8Array(Math.max(0, end - start))
  let dataEnd = end
  for (let i = startChunk; i <= endChunk; i++) {
    const chunk = chunks.get(i)
    // Unreachable: every index in [startChunk, endChunk] was either captured
    // as an already-cached chunk or filled by the run covering it. Throw
    // rather than assert so a future refactor that breaks the invariant fails
    // loudly instead of silently assembling a buffer of zeros.
    if (chunk === undefined) {
      throw new Error(
        `internal: chunk ${i} missing during range assembly of ${key}`,
      )
    }
    copyChunkInto({ result, start, end, chunkIndex: i, chunk })
    if (chunk.length < CHUNK_SIZE) {
      // the file ends inside this chunk, so nothing past that is real data
      dataEnd = Math.min(dataEnd, i * CHUNK_SIZE + chunk.length)
      break
    }
  }
  // max(0) because a read wholly past EOF has dataEnd < start
  return result.subarray(0, Math.max(0, dataEnd - start))
}

export async function getCachedRange(
  key: string,
  start: number,
  length: number,
  init: RequestInit | undefined,
  doFetch: FetchByteRange,
) {
  // A read whose caller has already given up must not join, or even open, a
  // request. On a pan the abort routinely lands while the index is still
  // being read — nothing between there and here looks at the signal — so a
  // whole batch of reads arrives already cancelled, and letting them through
  // both wastes the fetch and poisons the reference count (see joinRun).
  init?.signal?.throwIfAborted()
  // Clamp to a known file size. @gmod/bam and @gmod/tabix compute
  // fetchedSize() = maxv.blockPosition + (1<<16) - minv.blockPosition to
  // guarantee they read the complete final bgzf block, so their last read of
  // a file routinely extends past EOF; unclamped, that tail asks for chunks
  // starting past EOF and the server answers 416.
  const size = getSize(key)
  const end =
    size === undefined ? start + length : Math.min(start + length, size)
  const startChunk = Math.floor(start / CHUNK_SIZE)
  const lastChunk = Math.floor((end - 1) / CHUNK_SIZE)

  const plan = planRead(key, startChunk, lastChunk, init, doFetch)
  await Promise.all(
    plan.pending.map(async ({ index, chunk }) => {
      plan.chunks.set(index, await chunk)
    }),
  )
  // The bytes arrived, but this read gave up while waiting for them — the
  // request it was sharing kept going because somebody else still wanted it.
  // Cancellation is per-reader even though the fetch is not.
  init?.signal?.throwIfAborted()

  return assembleRange(key, plan, start, end, startChunk)
}
