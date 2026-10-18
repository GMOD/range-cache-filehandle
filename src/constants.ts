/**
 * Bytes the cache holds per module instance before it evicts the least
 * recently used. Each worker gets its own instance. `setCacheLimit` changes it.
 *
 * jbrowse measured panning twelve windows of a 105 MB BAM and panning back: the
 * second pass issues *zero* requests, because a region @gmod/bam has already
 * parsed never reaches this layer. That measurement was taken with the parsed
 * cache under its 1 GB budget, so it never evicted. On real data it does: a
 * single 1000x track panned across a 250 kb contig peaks past that budget, and
 * a re-read then falls through to here, the only thing between it and the
 * network. Do not shrink this on the strength of a workload that stayed inside
 * the parsed budget.
 */
export const CACHE_LIMIT = 256 * 1024 * 1024

/**
 * The planner's one length. A request shorter than this grows forward to it,
 * and gaps that reads plan in the same microtask turn and that lie within it of
 * each other share one request.
 *
 * Measured through @gmod/tabix, @gmod/bam, @gmod/bbi and @gmod/hic against a
 * counting server, 64 KiB is the knee: 32 KiB costs the bigWig and .hic
 * workloads requests (15 → 18 and 7 → 10), and 128 KiB adds bytes to the HPRC
 * gene lanes (3.38 MB → 4.04 MB) for no request saved anywhere.
 */
export const MIN_REQUEST = 64 * 1024

/**
 * The cache stores a fetched body in pieces no longer than this, each owning
 * its bytes, so eviction has a bounded unit: a 48 MB body for a 1000x BAM
 * window does not stay whole for as long as any byte of it is wanted.
 */
export const PIECE_SIZE = 1024 * 1024

/**
 * Drop an extent nothing has read for fifteen minutes.
 *
 * Longer than the three minutes the parsed caches above use (@gmod/bam,
 * @gmod/cram and @gmod/tabix all take a `cacheIdleTimeoutMs`), and deliberately
 * so: this is the cheap layer. Raw compressed bytes cost roughly an order of
 * magnitude less per unit of genomic coverage than the parsed features above
 * them, and they are what stands between a re-read and a re-download once those
 * caches expire. Matching their three minutes meant expiring at the exact moment
 * this became the only thing helping — measured, a reader who stepped away for
 * four minutes re-downloaded all 73.5 MB of a pan.
 *
 * Fifteen rather than forever because forever is what this was, and what the
 * whole sweep exists to end: 100 MB per worker, resident after the track closed,
 * after the tab hid, and after four minutes idle.
 */
export const CACHE_IDLE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * A quarter of the timeout, so the lag between an extent going idle and being
 * dropped is ~1.25x it rather than 2x.
 *
 * Chrome's intensive throttling of a hidden page — timers checked once a minute
 * after five minutes hidden — does not reach this where it matters: workers are
 * not throttled, and the workers are where the bytes are. On the main thread it
 * costs some lag on a cache measured holding nothing at all.
 */
export const SWEEP_INTERVAL_MS = CACHE_IDLE_TIMEOUT_MS / 4

/**
 * Requests in flight at once **per origin**, not per process.
 *
 * Held globally, the pool was a place one file could take the whole process
 * down: a server that answers the headers and then goes silent mid-body never
 * settles, so its request never gives the slot back, and twenty such requests —
 * the cap exactly — blocked every read of every other file indefinitely.
 * Measured, and permanent, since nothing here times a transfer out and nothing
 * should: this layer coalesces a contiguous run into one request, and a large
 * one is the normal case rather than the pathological one.
 *
 * Scoped per origin, that same dead server stalls only the host it lives on.
 * This is the standard shape rather than a local invention: a global limit
 * "will unnecessarily restrict requests to other endpoints as well", so the
 * advice is a semaphore per endpoint.
 * @see https://copdips.com/2023/01/python-aiohttp-rate-limit.html
 *
 * Per origin rather than per file, which is where this landed first and which
 * turned out to cap neither. A presigned S3 or GCS URL rotates its signature on
 * every read — the rotation {@link MAX_SIZE_ENTRIES} exists for — so a per-URL
 * pool is fresh each time and limits nothing; and with no key in common between
 * two files, the process-wide ceiling disappeared along with the head-of-line
 * blocking, leaving twenty requests times however many files are open. The
 * origin is both what a server experiences as load and a small, bounded set.
 *
 * Note what it does *not* fix, deliberately. A read of the stalled file still
 * waits forever, because nothing here puts a clock on a transfer and nothing
 * should — this layer coalesces a run of chunks into one request and those are
 * routinely large, so any duration limit would cut off a slow download rather
 * than a broken one. `fetch` has no timeout of its own either, by design and
 * after long discussion.
 * @see https://github.com/whatwg/fetch/issues/951
 * The escape hatch is the caller's `AbortSignal`, which this package carries
 * all the way to the socket.
 */
export const MAX_CONCURRENT = 20

/**
 * How many file sizes to remember.
 *
 * The byte cache is bounded and swept, so it self-heals; the size cache is
 * neither, because one number per file is cheap enough to keep and costs a
 * round trip to re-derive. That reasoning holds for a key per *file* and breaks
 * for a key per *URL*: presigned S3 and GCS URLs carry an expiring signature in
 * the query string, so a session re-signing its URLs mints a new key on every
 * read and this map grows without limit. Bounded, that becomes an eviction
 * rather than a leak.
 */
export const MAX_SIZE_ENTRIES = 5000

/**
 * How long a range request may go without the server beginning to answer.
 *
 * This bounds the wait for a RESPONSE, not for the bytes: `fetch` resolves when
 * the response headers arrive, and the deadline is cleared there, before a byte
 * of the body is read. That distinction is load-bearing rather than fussy,
 * because this layer makes range requests unusually large — a contiguous run of
 * missing chunks becomes one request, measured at 6.5 MiB for a single 4 kb
 * viewport over a 2000x BAM. A deadline over the whole transfer would cut that
 * read off on any link slower than about 2 Mbps, turning a slow session into a
 * broken one.
 *
 * What it does catch is the one failure that produces no error at all: a
 * connection that is open and silent. Nothing is wrong from the reader's point
 * of view — a fetch really is in flight — so the caller waits forever and never
 * gets the error it would retry on. Thirty seconds is deliberately generous; a
 * server that has not begun to answer by then is not about to.
 *
 * Both HTTP paths carry one: a range read, and a whole-file `readFile`, which
 * sends no range header and so takes the plain fetch. The whole-file path
 * matters more than its share of the traffic suggests — an assembly's
 * chrom.sizes, chromAlias and cytoband files are all read that way, and it was
 * the last path here with no clock on it at all.
 *
 * `CachedFilehandle` carries none: it sees its inner handle's `read`, never a
 * response. A local file or a Blob returns or throws, and a URL belongs in
 * `RemoteFileWithRangeCache`.
 */
export const RESPONSE_TIMEOUT_MS = 30_000

/**
 * Connections a browser opens to one HTTP/1.1 origin, shared by every worker
 * and tab of the page. A request past them waits, unsent, in the browser's own
 * queue, so a response deadline that fires while this many bodies are in
 * progress on the origin re-arms rather than failing.
 */
export const BROWSER_CONNECTIONS_PER_HOST = 6

/**
 * How many times a response deadline re-arms, so six bodies stalled forever
 * still end in an error: eleven periods of {@link RESPONSE_TIMEOUT_MS}.
 */
export const MAX_DEADLINE_REARMS = 10
