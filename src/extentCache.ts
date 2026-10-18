/**
 * The cache, as free functions over a {@link FetchByteRange}.
 *
 * Per file, it holds the byte extents fetched so far and the requests in
 * flight. A read is served from those and fetches only its gaps, so a parser's
 * many small adjacent reads cost a few requests and a region read once is never
 * fetched again while it stays cached. None of it is about HTTP, which is what
 * lets the same cache sit in front of a remote file, a local file or a Blob.
 *
 * Every piece of shared mutable state lives here rather than being spread across
 * the package, because {@link clearCache} *reassigns* several of these maps and
 * an imported binding cannot be reassigned from another module.
 */
import {
  CACHE_IDLE_TIMEOUT_MS,
  CACHE_LIMIT,
  MAX_CONCURRENT,
  MAX_SIZE_ENTRIES,
  MIN_REQUEST,
  PIECE_SIZE,
  SWEEP_INTERVAL_MS,
} from './constants.ts'
import { unrefIfPossible } from './util.ts'

/** a byte range `[start, end)` */
interface Span {
  start: number
  end: number
}

/**
 * Bytes the cache holds: one piece of a fetched body, no longer than
 * {@link PIECE_SIZE}, owning its buffer. Linked into one LRU list across every
 * file, `older` towards the next to evict.
 */
interface Extent extends Span {
  file: FileState
  bytes: Uint8Array
  lastTouched: number
  older: Extent | undefined
  newer: Extent | undefined
}

/**
 * One range request in flight, with the reference count that decides when it
 * is cancelled: only once every reader waiting on it has given up.
 */
interface Pending extends Span {
  body: Promise<Uint8Array<ArrayBuffer>>
  /** signals of the readers still waiting on this request */
  signals: Set<AbortSignal>
  /** true once a reader joins without a signal, which pins the request */
  pinned: boolean
  /** aborts when every reader has given up. what the request runs under */
  controller: AbortController
  /** aborted to take this request's listeners back off its readers' signals */
  dispose: AbortController
  settled: boolean
  /**
   * set by a clear that happened while this request was in flight. Its readers
   * still get their bytes — they asked before the clear and are entitled to
   * them — but nothing it produces goes back into the cache the clear emptied.
   */
  stale: boolean
  /** how many reads joined it, over its whole life */
  readers: number
}

/** a read waiting for its turn's flush to plan it */
interface Reader extends Span {
  signal: AbortSignal | undefined
  doFetch: FetchByteRange
  settle: (plan: Plan) => void
}

/** the reads that arrived in one microtask turn and have gaps to fetch */
interface Turn {
  readers: Reader[]
  stale: boolean
}

interface FileState {
  key: string
  /** sorted by start, disjoint */
  extents: Extent[]
  pending: Pending[]
  turn: Turn | undefined
}

/** what a read assembles its bytes from, captured before its first await */
interface Plan extends Span {
  extents: Extent[]
  pending: Pending[]
}

/** a gap one turn will fetch, and the fetch of the reader that planned it */
interface Gap extends Span {
  doFetch: FetchByteRange
}

/**
 * Requests in flight against one origin (one key, for a non-http URL), and the
 * reads waiting for a turn. See {@link MAX_CONCURRENT} for why the pool is per
 * origin rather than one pool for the process.
 */
interface Pool {
  active: number
  queue: (() => void)[]
}

/**
 * The bytes of a range, and the file's total length if the answer told us it.
 */
export interface FetchedRange {
  bytes: Uint8Array<ArrayBuffer>
  total?: number
}

/**
 * Fetches an inclusive byte range `[start, end]`, however the underlying source
 * does that, under the request's `signal`. The one thing the cache needs from a
 * file.
 */
export type FetchByteRange = (
  start: number,
  end: number,
  signal: AbortSignal,
) => Promise<FetchedRange>

/**
 * A `stat` request in flight. `stale` works as on {@link Pending}: a clear
 * during the request stops it recording the size it learns.
 */
interface SizeProbe {
  size: Promise<number | undefined>
  stale: boolean
}

let files = new Map<string, FileState>()
/** the LRU list over every extent of every file; `oldest` is evicted first */
let oldest: Extent | undefined
let newest: Extent | undefined
let held = 0
let limit = CACHE_LIMIT
/**
 * File size, keyed like `files`. Per-instance state cannot be used: a cache hit
 * serving bytes from a previous instance's fetch would otherwise leave a new
 * instance's `stat()` with no Content-Range observation, returning a bogus size
 * of 0.
 */
let sizeCache = new Map<string, number>()
/** one {@link Pool} per origin (per key for a non-http URL), created on demand and dropped when it empties */
const pools = new Map<string, Pool>()
/** size probes in flight, one per key; see {@link probeSize} */
let probes = new Map<string, SizeProbe>()

// ---------------------------------------------------------------------------
// the extents a file holds
// ---------------------------------------------------------------------------

function fileFor(key: string) {
  let file = files.get(key)
  if (file === undefined) {
    file = { key, extents: [], pending: [], turn: undefined }
    files.set(key, file)
  }
  return file
}

/** forget a file once it holds nothing, so a rotating key cannot accumulate */
function release(file: FileState) {
  if (
    file.extents.length === 0 &&
    file.pending.length === 0 &&
    file.turn === undefined &&
    files.get(file.key) === file
  ) {
    files.delete(file.key)
  }
}

/** index of the first extent ending after `at`; the extents are sorted and disjoint, so they are sorted by end too */
function firstEndingAfter(extents: Extent[], at: number) {
  let lo = 0
  let hi = extents.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (extents[mid]!.end <= at) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

function link(extent: Extent) {
  extent.older = newest
  extent.newer = undefined
  if (newest === undefined) {
    oldest = extent
  } else {
    newest.newer = extent
  }
  newest = extent
}

function unlink(extent: Extent) {
  if (extent.older === undefined) {
    oldest = extent.newer
  } else {
    extent.older.newer = extent.newer
  }
  if (extent.newer === undefined) {
    newest = extent.older
  } else {
    extent.newer.older = extent.older
  }
  extent.older = undefined
  extent.newer = undefined
}

function touch(extent: Extent, now: number) {
  if (extent !== newest) {
    unlink(extent)
    link(extent)
  }
  extent.lastTouched = now
}

function drop(extent: Extent) {
  unlink(extent)
  held -= extent.end - extent.start
  const { extents } = extent.file
  extents.splice(firstEndingAfter(extents, extent.start), 1)
  release(extent.file)
  if (held === 0) {
    stopSweep()
  }
}

/** drop the least recently used extents while the cache is over its limit */
function evict() {
  while (held > limit && oldest !== undefined) {
    drop(oldest)
  }
}

/**
 * Store a fetched body, in pieces of at most {@link PIECE_SIZE}, skipping the
 * parts another request landed first. Each piece is a copy: a view would keep
 * the whole body alive for as long as any one piece stayed cached, so evicting
 * a piece would free nothing and the limit would bound nothing.
 */
function insert(file: FileState, start: number, body: Uint8Array) {
  const end = start + body.length
  const now = Date.now()
  const { extents } = file
  let at = firstEndingAfter(extents, start)
  const put = (from: number, to: number) => {
    for (let a = from; a < to; a += PIECE_SIZE) {
      const b = Math.min(to, a + PIECE_SIZE)
      const piece: Extent = {
        file,
        start: a,
        end: b,
        bytes: body.slice(a - start, b - start),
        lastTouched: now,
        older: undefined,
        newer: undefined,
      }
      extents.splice(at, 0, piece)
      at++
      link(piece)
      held += b - a
    }
  }
  let cursor = start
  while (at < extents.length && extents[at]!.start < end) {
    const cached = extents[at]!
    if (cached.start > cursor) {
      put(cursor, cached.start)
    }
    cursor = Math.max(cursor, cached.end)
    at++
  }
  if (cursor < end) {
    put(cursor, end)
  }
  if (held > 0) {
    startSweep()
  }
  evict()
}

/**
 * Hold at most `bytes` of fetched data, evicting the least recently used at
 * once. The default is {@link CACHE_LIMIT}. 0 disables caching, though
 * concurrent reads still share requests in flight; `Infinity` leaves only the
 * idle sweep.
 */
export function setCacheLimit(bytes: number) {
  if (typeof bytes !== 'number' || !(bytes >= 0)) {
    throw new RangeError(`a cache limit is bytes >= 0, not ${bytes}`)
  }
  limit = bytes
  evict()
}

/** bytes of fetched data the cache holds now */
export function cachedBytes() {
  return held
}

// ---------------------------------------------------------------------------
// idle sweep
// ---------------------------------------------------------------------------

let sweepTimer: ReturnType<typeof setInterval> | undefined

/**
 * Drop every extent no read has touched for {@link CACHE_IDLE_TIMEOUT_MS}.
 *
 * Safe to call at any moment, including mid-fetch, and that is not an accident:
 * a read holds a strong reference to every extent it will assemble from before
 * its first await, precisely so that eviction underneath it is harmless. An
 * extent dropped here that somebody still wants is re-fetched.
 *
 * Deliberately narrower than {@link clearCache}: it touches neither the
 * requests in flight nor the pools, whose entries are by definition active, and
 * it keeps `sizeCache`, which is one number per key and costs a round trip to
 * re-derive.
 *
 * Exported so a caller can reclaim on its own schedule — a tab going hidden,
 * say — rather than only on the interval. The interval is what makes this work
 * for the case it exists for, though: an idle consumer is calling nothing, so a
 * lazy check on the read path would never fire for exactly the reader who has
 * walked away.
 */
export function sweepIdleCache() {
  const cutoff = Date.now() - CACHE_IDLE_TIMEOUT_MS
  // the list is in touch order, so the sweep stops at the first fresh extent
  while (oldest !== undefined && oldest.lastTouched <= cutoff) {
    drop(oldest)
  }
}

// Costs nothing while the cache is empty: the timer starts with the first
// extent and the drop that empties the cache stops it again.
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
 * Drop every cached extent and every known size.
 *
 * Mostly for tests, which need each case to start from an empty cache, and for a
 * consumer that knows it is finished with everything it has opened. To reclaim
 * one file rather than all of them, see {@link clearCacheFor}.
 *
 * Leaves the concurrency pools alone. Reads in flight or queued for a slot are
 * marked stale and settle in turn as slots free; resetting or bypassing a pool
 * would let the next reads overshoot {@link MAX_CONCURRENT}. A transfer wedged
 * mid-body therefore stays wedged across a clear.
 */
export function clearCache() {
  for (const file of files.values()) {
    forget(file)
  }
  files = new Map<string, FileState>()
  sizeCache = new Map<string, number>()
  markStale(probes.values())
  probes = new Map<string, SizeProbe>()
}

/**
 * Drop one file's cached extents and its size, leaving every other file alone.
 *
 * What a consumer closing one track wants, and what {@link clearCache} is too
 * blunt for.
 *
 * Deliberately does not *cancel* in-flight requests: a read still waiting on one
 * is entitled to its bytes, and its own cleanup removes it. What those requests
 * may no longer do is put the file back in the cache once they land, which is
 * what marking them stale prevents.
 */
export function clearCacheFor(key: string) {
  const file = files.get(key)
  if (file !== undefined) {
    forget(file)
    files.delete(key)
  }
  const probe = probes.get(key)
  if (probe !== undefined) {
    probe.stale = true
    probes.delete(key)
  }
  sizeCache.delete(key)
}

/**
 * Drop a file's extents and take its requests out of the cache's future.
 *
 * A clear cannot cancel work in flight — a reader waiting on it asked before
 * the clear and is entitled to its bytes — but without this the request lands
 * after the clear and puts the file straight back: its bytes, and its size.
 * Measured: one read, `clearCacheFor` while it was in flight, and the next read
 * of the same offset was served from the cache that had just been emptied. A
 * size put back is worse, because nothing overwrites it: a file that grew stays
 * clamped to its old length.
 */
function forget(file: FileState) {
  for (const extent of file.extents.splice(0)) {
    unlink(extent)
    held -= extent.end - extent.start
  }
  markStale(file.pending)
  if (file.turn !== undefined) {
    file.turn.stale = true
  }
  if (held === 0) {
    stopSweep()
  }
}

function markStale(entries: Iterable<{ stale: boolean }>) {
  for (const entry of entries) {
    entry.stale = true
  }
}

// ---------------------------------------------------------------------------
// concurrency, per origin
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
 * pool permanently.
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
 * The file's size, from the size cache or else from `fetchSize`, which runs
 * under the concurrency cap and once per key however many callers ask at once.
 *
 * Once per key because a check of the size cache only sees sizes that have
 * already arrived, so N handles opening a file together each found the size
 * missing and each issued its own request — measured, ten concurrent `stat()`
 * calls made ten requests for one number.
 */
export async function probeSize(
  key: string,
  fetchSize: () => Promise<number | undefined>,
) {
  const known = getSize(key)
  if (known !== undefined) {
    return known
  }
  let probe = probes.get(key)
  if (probe === undefined) {
    const started: SizeProbe = {
      size: limitConcurrency(key, fetchSize),
      stale: false,
    }
    const forget = () => {
      if (probes.get(key) === started) {
        probes.delete(key)
      }
    }
    started.size.then(size => {
      if (!started.stale && size !== undefined) {
        recordSize(key, size)
      }
      forget()
    }, forget)
    probes.set(key, started)
    probe = started
  }
  const size = await probe.size
  return getSize(key) ?? size
}

// ---------------------------------------------------------------------------
// file sizes
// ---------------------------------------------------------------------------

/**
 * Learn a file's size, from wherever it was observed: a `Content-Range`
 * total, a 416, a body that came back short, a `stat` the underlying source
 * answers directly, or one a subclass gets from a metadata endpoint.
 *
 * One monotone rule: the size only ever shrinks. Every source is an upper
 * bound on where the file ends — a 416 says nothing exists at its start, a
 * short body says nothing exists past its end — so the smallest is the truth,
 * and no source can undo what another learned. A file that grew needs
 * {@link clearCacheFor}.
 *
 * The one door into the size cache, and so where finiteness is checked. A
 * non-finite size does not fail, it *poisons*: `Math.min(start + length, NaN)`
 * is NaN, so every later read of that file returns empty with nothing said. A
 * metadata endpoint that populates `size` only for files that have one — not
 * for folders, shortcuts or native editor documents — makes `Number(undefined)`
 * a reachable input rather than a hypothetical.
 */
export function recordSize(key: string, size: number) {
  if (!Number.isFinite(size)) {
    return
  }
  const known = sizeCache.get(key)
  sizeCache.delete(key)
  evictOldest(sizeCache, MAX_SIZE_ENTRIES)
  sizeCache.set(key, known === undefined ? size : Math.min(known, size))
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

export function hasSize(key: string) {
  return sizeCache.has(key)
}

/**
 * Re-inserts on the way out, so the map is ordered by *use* rather than by first
 * write. Without that, `recordSize` evicts the entry a session reads all day — it
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

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

/**
 * Issue one range request for `[start, end)` and publish it for other reads to
 * join. Its body is stored once it lands, unless a clear has made it stale.
 */
function dispatch(
  file: FileState,
  { start, end, doFetch }: Gap,
  stale: boolean,
): Pending {
  // The request runs under its own signal, not any one reader's: it is shared,
  // so it must outlive any one reader giving up. `join` registers them.
  const controller = new AbortController()
  const fetched = limitConcurrency(
    file.key,
    () => {
      // every reader gave up while this was queued, so there is nothing to ask
      // for. On a pan that is the ordinary case rather than a corner
      controller.signal.throwIfAborted()
      return doFetch(start, end - 1, controller.signal)
    },
    // and the same signal takes the request back out of the queue, rather than
    // leaving it waiting for a slot it no longer wants
    controller.signal,
  )
  const pending: Pending = {
    start,
    end,
    signals: new Set(),
    pinned: false,
    controller,
    dispose: new AbortController(),
    settled: false,
    stale,
    readers: 0,
    body: fetched.then(({ bytes, total }) => {
      if (!pending.stale) {
        if (total !== undefined) {
          recordSize(file.key, total)
        }
        // a short body means the file ends there: only range-supporting
        // servers are served, and they clamp a range to the file
        if (bytes.length < end - start) {
          recordSize(file.key, start + bytes.length)
        }
        insert(file, start, bytes)
      }
      return bytes
    }),
  }
  const settle = () => {
    pending.settled = true
    // nothing reads these once the request has settled, and holding them would
    // pin each reader's AbortController behind this request
    pending.dispose.abort()
    pending.signals.clear()
    // runs after the insert above, so a byte is never absent from both the
    // cache and the pending list
    file.pending.splice(file.pending.indexOf(pending), 1)
    release(file)
  }
  pending.body.then(settle, settle)
  file.pending.push(pending)
  return pending
}

/**
 * Register a reader's interest in a request, so it survives until that reader
 * has given up too.
 *
 * A reader with **no signal cannot give up**, so it pins the request: there is
 * no longer any set of aborts that should stop it. That is the honest reading
 * of a caller that never asked to be cancellable, and it means one signal-free
 * read makes that request uncancellable for everyone sharing it.
 */
function join(pending: Pending, signal: AbortSignal | undefined) {
  pending.readers++
  if (!signal) {
    pending.pinned = true
  } else if (signal.aborted) {
    // A reader that has already given up is not a waiter, and must not be
    // counted as one: an `abort` listener never fires on a signal that aborted
    // before it was added, so nothing would ever take this signal back out of
    // the set. The count would never reach zero and the request would be
    // uncancellable for everyone sharing it, silently.
    //
    // `getCachedRange` rejects such a reader before it gets here, so this is
    // the belt to that braces — the invariant is too quiet to fail to be left
    // resting on a check several frames away.
    abortIfUnwanted(pending, signal.reason)
  } else if (!pending.signals.has(signal)) {
    // guarded so one signal joining twice does not add two listeners
    pending.signals.add(signal)
    signal.addEventListener(
      'abort',
      () => {
        pending.signals.delete(signal)
        abortIfUnwanted(pending, signal.reason)
      },
      // `once` covers the abort firing; `dispose` covers it never firing
      { once: true, signal: pending.dispose.signal },
    )
  }
}

/** cancel a request once no reader is left who wants it */
function abortIfUnwanted(pending: Pending, reason: unknown) {
  if (!pending.pinned && pending.signals.size === 0) {
    pending.controller.abort(reason)
  }
}

// ---------------------------------------------------------------------------
// the read path
// ---------------------------------------------------------------------------

interface Coverage {
  extents: Extent[]
  pending: Pending[]
  gaps: Span[]
}

/**
 * What covers `[start, end)` — cached extents, requests in flight, and gaps
 * earlier reads of the same turn have already planned — and the gaps left.
 *
 * A request whose readers have all given up is not cover. Its request was
 * cancelled, but the rejection takes a tick to arrive and the entry leaves the
 * list only after that, so in between it sits here looking joinable. Joining
 * it would hand this reader somebody else's AbortError, which is the exact
 * thing the reference count exists to prevent. On a pan that window is the
 * ordinary sequence rather than a corner: the old blocks are aborted and the
 * new ones requested in the same tick.
 */
function coverage(
  file: FileState,
  start: number,
  end: number,
  planned: Span[],
): Coverage {
  const extents: Extent[] = []
  for (
    let i = firstEndingAfter(file.extents, start);
    i < file.extents.length && file.extents[i]!.start < end;
    i++
  ) {
    extents.push(file.extents[i]!)
  }
  const pending = file.pending.filter(
    p => p.start < end && p.end > start && !p.controller.signal.aborted,
  )
  const covers: Span[] = [
    ...extents,
    ...pending,
    ...planned.filter(p => p.start < end && p.end > start),
  ].sort((a, b) => a.start - b.start)
  const gaps: Span[] = []
  let cursor = start
  for (const cover of covers) {
    if (cover.start > cursor) {
      gaps.push({ start: cursor, end: cover.start })
    }
    cursor = Math.max(cursor, cover.end)
    if (cursor >= end) {
      break
    }
  }
  if (cursor < end) {
    gaps.push({ start: cursor, end })
  }
  return { extents, pending, gaps }
}

/** where the next cached extent or live request begins, at or after `at` */
function nextCover(file: FileState, at: number) {
  let next = Infinity
  const i = firstEndingAfter(file.extents, at)
  if (i < file.extents.length) {
    next = Math.max(at, file.extents[i]!.start)
  }
  for (const p of file.pending) {
    if (p.end > at && !p.controller.signal.aborted) {
      next = Math.min(next, Math.max(at, p.start))
    }
  }
  return next
}

/**
 * Plan every read that arrived this turn, as one pass with no await in it.
 *
 * Each reader's gaps are what neither the cache, a request in flight nor an
 * earlier reader of this turn covers. A gap shorter than {@link MIN_REQUEST}
 * grows forward to it, over uncovered bytes only and never past a known end of
 * file. The gaps are then sorted and any two within {@link MIN_REQUEST} of each
 * other become one request.
 */
function flush(file: FileState, turn: Turn) {
  if (file.turn === turn) {
    file.turn = undefined
  }
  const now = Date.now()
  const size = getSize(file.key)
  const planned: Gap[] = []
  const plans: { reader: Reader; plan: Plan }[] = []
  for (const reader of turn.readers) {
    const end = size === undefined ? reader.end : Math.min(reader.end, size)
    const plan: Plan = { start: reader.start, end, extents: [], pending: [] }
    if (reader.start < end && !reader.signal?.aborted) {
      const found = coverage(file, reader.start, end, planned)
      plan.extents = found.extents
      plan.pending = found.pending
      for (const extent of found.extents) {
        touch(extent, now)
      }
      for (const gap of found.gaps) {
        if (gap.end - gap.start < MIN_REQUEST) {
          const want =
            size === undefined
              ? gap.start + MIN_REQUEST
              : Math.min(gap.start + MIN_REQUEST, size)
          gap.end = Math.max(gap.end, Math.min(want, nextCover(file, gap.end)))
        }
        planned.push({ ...gap, doFetch: reader.doFetch })
      }
    }
    plans.push({ reader, plan })
  }
  const requests = merge(planned).map(gap => dispatch(file, gap, turn.stale))
  for (const { reader, plan } of plans) {
    for (const request of requests) {
      if (request.start < plan.end && request.end > plan.start) {
        plan.pending.push(request)
      }
    }
    for (const pending of plan.pending) {
      join(pending, reader.signal)
    }
    reader.settle(plan)
  }
  release(file)
}

/** one request for every cluster of gaps within {@link MIN_REQUEST} of each other */
function merge(gaps: Gap[]) {
  gaps.sort((a, b) => a.start - b.start)
  const requests: Gap[] = []
  for (const gap of gaps) {
    const last = requests.at(-1)
    if (last !== undefined && gap.start - last.end <= MIN_REQUEST) {
      last.end = Math.max(last.end, gap.end)
    } else {
      requests.push({ ...gap })
    }
  }
  return requests
}

/**
 * Serve a read with no gaps at once, or report that it has some. A read that
 * needs nothing fetched does not wait for the turn: it holds its extents and
 * joins the requests it overlaps before returning.
 */
function planNow(
  file: FileState,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
): Plan | undefined {
  const { extents, pending, gaps } = coverage(file, start, end, [])
  if (gaps.length > 0) {
    return undefined
  }
  const now = Date.now()
  for (const extent of extents) {
    touch(extent, now)
  }
  for (const request of pending) {
    join(request, signal)
  }
  return { start, end, extents, pending }
}

/**
 * Defer a read with gaps to the turn's flush, one microtask on, so every read
 * issued in the same turn plans together and their gaps share requests.
 */
function enqueue(file: FileState, reader: Reader) {
  let { turn } = file
  if (turn === undefined) {
    const started: Turn = { readers: [], stale: false }
    file.turn = started
    queueMicrotask(() => {
      flush(file, started)
    })
    turn = started
  }
  turn.readers.push(reader)
}

/**
 * Copy what the read covers into one buffer, and stop where the file does.
 *
 * Assembly reads only from the extents and bodies the plan captured, never from
 * the shared cache: that cache is capped and shared across every file, so a
 * concurrent read's insert can evict an extent we depend on while we await.
 * Holding the reference locally makes eviction harmless.
 *
 * A body shorter than its request marks the end of the file, so nothing past
 * it is data, whatever the size cache says by now. A read whose one request is
 * exactly its range gets that body itself: the cache keeps copies, so nothing
 * else refers to it, and a caller may transfer its buffer freely.
 */
function assemble(
  { start, end, extents, pending }: Plan,
  bodies: Uint8Array<ArrayBuffer>[],
) {
  let dataEnd = end
  for (const [i, request] of pending.entries()) {
    const body = bodies[i]!
    if (body.length < request.end - request.start) {
      dataEnd = Math.min(dataEnd, request.start + body.length)
    }
  }
  // max(0) because a read wholly past EOF has dataEnd < start
  const length = Math.max(0, dataEnd - start)
  if (extents.length === 0 && pending.length === 1) {
    const request = pending[0]!
    const body = bodies[0]!
    if (
      request.readers === 1 &&
      request.start === start &&
      body.length === length &&
      body.byteOffset === 0 &&
      body.buffer.byteLength === length
    ) {
      return body
    }
  }
  const result = new Uint8Array(length)
  const put = (at: number, bytes: Uint8Array) => {
    const from = Math.max(start, at)
    const to = Math.min(dataEnd, at + bytes.length)
    if (to > from) {
      result.set(bytes.subarray(from - at, to - at), from - start)
    }
  }
  for (const extent of extents) {
    put(extent.start, extent.bytes)
  }
  for (const [i, request] of pending.entries()) {
    put(request.start, bodies[i]!)
  }
  return result
}

export async function getCachedRange(
  key: string,
  start: number,
  length: number,
  signal: AbortSignal | undefined,
  doFetch: FetchByteRange,
): Promise<Uint8Array<ArrayBuffer>> {
  // A read whose caller has already given up must not join, or even open, a
  // request. On a pan the abort routinely lands while the index is still
  // being read — nothing between there and here looks at the signal — so a
  // whole batch of reads arrives already cancelled, and letting them through
  // both wastes the fetch and poisons the reference count (see join).
  signal?.throwIfAborted()
  // Clamp to a known file size. @gmod/bam and @gmod/tabix compute
  // fetchedSize() = maxv.blockPosition + (1<<16) - minv.blockPosition to
  // guarantee they read the complete final bgzf block, so their last read of
  // a file routinely extends past EOF; unclamped, that tail asks for bytes
  // past EOF and the server answers 416.
  const size = getSize(key)
  const end =
    size === undefined ? start + length : Math.min(start + length, size)
  if (start >= end) {
    return new Uint8Array(0)
  }
  const file = fileFor(key)
  let plan = planNow(file, start, end, signal)
  if (plan === undefined) {
    plan = await new Promise<Plan>(settle => {
      enqueue(file, { start, end, signal, doFetch, settle })
    })
    // the flush plans nothing for a reader that gave up while it waited
    signal?.throwIfAborted()
  }
  let bodies: Uint8Array<ArrayBuffer>[] = []
  if (plan.pending.length > 0) {
    try {
      bodies = await waitAsCaller(
        Promise.all(plan.pending.map(request => request.body)),
        signal,
      )
    } finally {
      // the reader's own reason, whether the request failed or finished meanwhile
      signal?.throwIfAborted()
    }
  }
  return assemble(plan, bodies)
}

/**
 * Await `promise`, but reject with the reader's own reason as soon as `signal`
 * aborts: a shared request keeps going while anyone else wants it.
 */
function waitAsCaller<T>(promise: Promise<T>, signal: AbortSignal | undefined) {
  if (!signal) {
    return promise
  }
  const unsubscribe = new AbortController()
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason)
        },
        { once: true, signal: unsubscribe.signal },
      )
    }),
  ]).finally(() => {
    unsubscribe.abort()
  })
}
