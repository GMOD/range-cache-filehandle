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
let activeCount = 0
const queue: (() => void)[] = []

function cacheKey(key: string, chunkIndex: number) {
  return `${key}:${chunkIndex}`
}

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

function putCached(key: string, chunk: Uint8Array) {
  // Delete before the size check, so that re-caching a key already present
  // neither evicts an innocent entry to make room for one already counted nor
  // leaves it at the rank it held before — `Map.set` on an existing key keeps
  // its position, so without this a chunk that was evicted and re-fetched goes
  // straight back to being first in line to be evicted again.
  cache.delete(key)
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) {
      cache.delete(oldestKey)
    }
  }
  cache.set(key, { bytes: chunk, lastTouched: Date.now() })
  startSweep()
}

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
 * nor `queue`, whose entries are by definition active, and it keeps `sizeCache`,
 * which is one number per key and costs a round trip to re-derive.
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

/**
 * Drop every cached chunk, every known size and every queued read.
 *
 * Mostly for tests, which need each case to start from an empty cache, and for a
 * consumer that knows it is finished with everything it has opened.
 */
export function clearCache() {
  cache = new Map<string, CacheEntry>()
  sizeCache = new Map<string, number>()
  // the new cache is empty, so nothing is left for the sweep to find; putCached
  // starts it again with the next chunk
  stopSweep()
  // A leaked fetch that settles after this still removes its own entry from the
  // new map only if it is still the owner, so dropping the old map is safe.
  inFlight = new Map<string, InFlightChunk>()
  // Reset concurrency state too. A leaked async fetch from a prior test that
  // resolves after clearCache will still decrement activeCount in its finally
  // block — so this can momentarily push activeCount negative, which is
  // harmless (runNext still allows new work) and self-corrects once any leaked
  // work has resolved.
  //
  // Queued waiters are RESUMED, not dropped: a dropped resolver strands its
  // limitConcurrency caller with no resolve and no reject, so the read neither
  // runs nor settles — a hang rather than a cancellation. Each resumed waiter
  // claims a slot the way runNext would and releases it in its own finally.
  const waiters = queue.splice(0)
  activeCount = waiters.length
  for (const resolve of waiters) {
    resolve()
  }
}

function runNext() {
  if (queue.length > 0 && activeCount < MAX_CONCURRENT) {
    // claim the slot on behalf of the work we're about to resume
    activeCount++
    queue.shift()!()
  }
}

export async function limitConcurrency<T>(fn: () => Promise<T>) {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++
  } else {
    // runNext claims the slot before resuming us, so nothing to increment here
    await new Promise<void>(resolve => {
      queue.push(resolve)
    })
  }
  try {
    return await fn()
  } finally {
    activeCount--
    runNext()
  }
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
    sizeCache.set(key, size)
  }
}

export function hasSize(key: string) {
  return sizeCache.has(key)
}

export function getSize(key: string) {
  return sizeCache.get(key)
}

/**
 * Record a file's total size from a `Content-Range` header — `bytes 0-255/12345`
 * on a 206, `bytes * /12345` on a 416. An already-known size is left alone (the
 * file is not expected to change under us mid-session).
 */
export function recordSizeFromContentRange(key: string, res: Response) {
  if (!sizeCache.has(key)) {
    const contentRange = res.headers.get('content-range')
    const match = contentRange ? /\/(\d+)$/.exec(contentRange) : null
    if (match) {
      sizeCache.set(key, Number.parseInt(match[1]!, 10))
    }
  }
}

export function recordSizeFromWholeBody(key: string, byteLength: number) {
  if (!sizeCache.has(key)) {
    sizeCache.set(key, byteLength)
  }
}

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
  }
  // The request runs under the run's own signal, not the opening reader's: it
  // is shared, so it must outlive any one reader giving up. joinRun registers
  // them, starting with the reader that opened it.
  const data = limitConcurrency(() =>
    doFetch(run.start * CHUNK_SIZE, (run.end + 1) * CHUNK_SIZE - 1, {
      ...init,
      signal: state.controller.signal,
    }),
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
      putCached(chunkKey, copy)
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
    pending.push({ index, chunk })
  }
  return pending
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
    if (!state.pinned && state.signals.size === 0) {
      state.controller.abort(signal.reason)
    }
  } else if (!state.signals.has(signal)) {
    // guarded so one signal joining twice — a read spanning several chunks of
    // the same run — does not add two listeners
    state.signals.add(signal)
    signal.addEventListener(
      'abort',
      () => {
        state.signals.delete(signal)
        if (!state.pinned && state.signals.size === 0) {
          state.controller.abort(signal.reason)
        }
      },
      // `once` covers the abort firing; `dispose` covers it never firing
      { once: true, signal: state.dispose.signal },
    )
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
  const size = sizeCache.get(key)
  const end =
    size === undefined ? start + length : Math.min(start + length, size)
  const startChunk = Math.floor(start / CHUNK_SIZE)
  const lastChunk = Math.floor((end - 1) / CHUNK_SIZE)

  // Hold a strong reference to every chunk we'll assemble from. Already-cached
  // chunks are captured here (before any await); fetched ones as their run
  // resolves below. Assembly reads only from this local map, never from the
  // module-global cache: that cache is capped and shared across every file, so
  // a concurrent read's putCached can evict a chunk we depend on during our
  // fetch await, and a later getCached would return undefined. Holding the
  // reference locally makes eviction from the Map harmless.
  const chunks = new Map<number, Uint8Array>()

  // Plan the fetches. Contiguous runs of missing chunks become one range
  // request each; a chunk another read is already fetching is awaited instead.
  // Planning and publishing run to completion without an await, so two reads
  // in the same tick can't both open a run for the same chunk.
  //
  // Stops at a cached chunk shorter than CHUNK_SIZE — the file ended inside it,
  // so every later chunk starts past EOF. That covers the over-read above even
  // when the size is unknown (CORS hiding Content-Range).
  const pending: PendingChunk[] = []
  const runs: ChunkRun[] = []
  let endChunk = lastChunk
  for (let index = startChunk; index <= lastChunk; index++) {
    const chunkKey = cacheKey(key, index)
    const cached = getCached(chunkKey)
    if (cached === undefined) {
      const flight = inFlight.get(chunkKey)
      const joined = flight ? joinChunk(flight, init) : undefined
      if (joined === undefined) {
        const lastRun = runs.at(-1)
        if (lastRun?.end === index - 1) {
          lastRun.end = index
        } else {
          runs.push({ start: index, end: index })
        }
      } else {
        pending.push({ index, chunk: joined })
      }
    } else {
      chunks.set(index, cached)
      if (cached.length < CHUNK_SIZE) {
        endChunk = index
        break
      }
    }
  }
  for (const run of runs) {
    pending.push(...fetchRun(key, run, init, doFetch))
  }

  await Promise.all(
    pending.map(async ({ index, chunk }) => {
      chunks.set(index, await chunk)
    }),
  )
  // The bytes arrived, but this read gave up while waiting for them — the
  // request it was sharing kept going because somebody else still wanted it.
  // Cancellation is per-reader even though the fetch is not.
  init?.signal?.throwIfAborted()

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
    } else {
      copyChunkInto({ result, start, end, chunkIndex: i, chunk })
      if (chunk.length < CHUNK_SIZE) {
        // the file ends inside this chunk, so nothing past that is real data
        dataEnd = Math.min(dataEnd, i * CHUNK_SIZE + chunk.length)
        break
      }
    }
  }
  // max(0) because a read wholly past EOF has dataEnd < start
  return result.subarray(0, Math.max(0, dataEnd - start))
}
