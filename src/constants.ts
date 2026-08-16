export const CHUNK_SIZE = 256 * 1024

/**
 * Cached chunks own their bytes (see `fetchRun`), so this entry count is a true
 * bound on retained memory: `MAX_CACHE_ENTRIES * CHUNK_SIZE` = 256 MB per module
 * instance, and each worker gets its own.
 *
 * It looks oversized and is not. jbrowse measured panning twelve windows of a
 * 105 MB BAM and panning back: the second pass issues *zero* requests — a region
 * @gmod/bam has already parsed never reaches this layer — and on that workload
 * dropping this to 4 entries cost one extra range request and 1.3 MB. But that
 * measurement was taken with @gmod/bam's parsed cache under its 1 GB budget, so
 * it never evicted. On real data it does: a single 1000x track panned across a
 * 250 kb contig already peaks past that. Once the layer above is evicting, a
 * re-read falls through to here, and this is the only thing between it and the
 * network. Do not shrink it on the strength of a workload that stayed inside the
 * parsed budget.
 */
export const MAX_CACHE_ENTRIES = 1000

/**
 * Drop a chunk nothing has read for fifteen minutes.
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
 * A quarter of the timeout, so the lag between a chunk going idle and being
 * dropped is ~1.25x it rather than 2x.
 *
 * Chrome's intensive throttling of a hidden page — timers checked once a minute
 * after five minutes hidden — does not reach this where it matters: workers are
 * not throttled, and the workers are where the bytes are. On the main thread it
 * costs some lag on a cache measured holding no chunks at all.
 */
export const SWEEP_INTERVAL_MS = CACHE_IDLE_TIMEOUT_MS / 4

export const MAX_CONCURRENT = 20

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
 * Only the HTTP path carries one. `CachedFilehandle` wraps a local file or a
 * Blob, which return or throw; there is no socket there to sit open on.
 */
export const RESPONSE_TIMEOUT_MS = 30_000
