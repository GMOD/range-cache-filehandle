# The constants, and what measured them

Five constants are exported for reading, not setting: `CHUNK_SIZE`,
`MAX_CACHE_ENTRIES`, `CACHE_IDLE_TIMEOUT_MS`, `MAX_CONCURRENT` and
`RESPONSE_TIMEOUT_MS`. There is no per-instance override, because the cache is
module-global — a knob on one filehandle would set policy for every other one in
the process. `src/constants.ts` carries the same reasoning next to the values,
and is the copy to update if a measurement changes.

| constant                | value         | bounds                              |
| ----------------------- | ------------- | ----------------------------------- |
| `CHUNK_SIZE`            | 256 KiB       | the grid a read snaps to            |
| `MAX_CACHE_ENTRIES`     | 1000 (256 MB) | retained bytes, per module instance |
| `CACHE_IDLE_TIMEOUT_MS` | 15 min        | how long an unread chunk survives   |
| `MAX_CONCURRENT`        | 20            | requests in flight, all files       |
| `RESPONSE_TIMEOUT_MS`   | 30 s          | wait for a response to _begin_      |

Every one of them was chosen against one workload: a genome browser panning a
track in a browser tab. [Where this runs](#where-this-runs) is what changes if
that is not what you are doing.

## `MAX_CACHE_ENTRIES` looks oversized and is not

Cached chunks own their bytes — `fetchRun` copies rather than views, so no chunk
holds a run buffer alive — which makes the entry count a true bound:
`MAX_CACHE_ENTRIES * CHUNK_SIZE`, per module instance, and each worker gets its
own.

jbrowse measured panning twelve windows of a 105 MB BAM and panning back. The
second pass issues zero requests, and on that workload dropping the cache to
**four** entries cost one extra range request and 1.3 MB. Which sounds like an
argument for shrinking it, and is not: that run had `@gmod/bam`'s parsed cache
under its 1 GB budget, so it never evicted, and a region the parser has already
parsed never reaches this layer at all.

On real data the parsed cache does evict — a single 1000x track panned across a
250 kb contig already peaks past that budget — and a re-read then falls through
to here, where this cache is the only thing between it and the network. Do not
shrink it on the strength of a workload that stayed inside the parsed budget.

## `CACHE_IDLE_TIMEOUT_MS` is longer than the caches above it, deliberately

`@gmod/bam`, `@gmod/cram` and `@gmod/tabix` all take a `cacheIdleTimeoutMs` and
all default to three minutes
([bam-js/docs/caching.md](https://github.com/GMOD/bam-js/blob/main/docs/caching.md),
[cram-js/docs/memory.md](https://github.com/GMOD/cram-js/blob/main/docs/memory.md)).
This layer holds for fifteen.

Raw compressed bytes cost roughly an order of magnitude less per unit of genomic
coverage than the parsed features above them, and they are what stands between a
re-read and a re-download once those caches expire. Matching their three minutes
meant expiring at the exact moment this became the only thing helping: measured,
a reader who stepped away for four minutes re-downloaded all 73.5 MB of a pan.

Fifteen rather than forever because forever is what this used to be, and what
the sweep exists to end — 100 MB per worker, resident after the track closed,
after the tab hid, and after four minutes idle.

The sweep runs on an interval of a quarter of the timeout, so the lag between a
chunk going idle and being dropped is ~1.25x it rather than 2x. It starts with
the first cached chunk and stops when a sweep empties the cache, so it costs
nothing while nothing is cached. Chrome's intensive throttling of a hidden page
does not reach it where it matters: workers are not throttled, and the workers
are where the bytes are.

`sweepIdleCache()` is exported so a consumer can reclaim on its own schedule — a
tab going hidden, say. The interval is still what makes it work for the case it
exists for, since an idle consumer is calling nothing and a lazy check inside
the cache would never fire for exactly the reader who walked away.

`clearCache()` is the bigger hammer: every chunk, every known size, every queued
read. Mostly for tests, which need each case to start empty.

## `RESPONSE_TIMEOUT_MS` bounds the wait for a response, not for the bytes

`fetch` resolves when the response headers arrive, and the deadline is cleared
there, before a byte of the body is read.

That distinction is load-bearing rather than fussy, because this layer makes
range requests unusually large — 6.5 MiB for a single 4 kb viewport over a 2000x
BAM. A deadline over the whole transfer would cut that read off on any link
slower than about 2 Mbps, turning a slow session into a broken one.

What it catches is the one failure that produces no error at all: a connection
that is open and silent. Nothing looks wrong from the reader's point of view — a
fetch really is in flight — so the caller waits forever and never gets the error
it would retry on. Thirty seconds is generous on purpose; a server that has not
begun to answer by then is not about to.

Only the HTTP path carries a deadline. `CachedFilehandle` wraps a local file or
a Blob, which return or throw; there is no socket there to sit open on.

The deadline is composed with the caller's signal, never substituted for it —
replacing it would take cancellation back off the socket, which is the ~6.5 MiB
per cancelled navigation that reference counting exists to preserve
([sharing.md](sharing.md)).

## Where this runs

The cache is module state, so its scope is one module instance: **one per
realm**, not one per process and not one per filehandle. A page and each of its
workers get their own, and so does each worker thread in node. The 256 MB bound
is per instance, so a browser with six worker threads has a ceiling of 1.5 GB
and no single place that knows it.

That is the shape jbrowse has, and every number above was chosen for it: a
browser session panning a track, where the same person reads the same region
again a minute later and 256 MB of a device's memory is a reasonable ask.

Two other shapes are worth thinking about before taking the defaults.

**A long-lived server process** shares one cache across every request it serves,
keyed by URL. That is a real win when many requests hit the same few files, and
a pure cost when each request reads a file no other request will touch — the
chunks sit for fifteen minutes on the chance of a re-read that never comes. If
your traffic is the second kind, call `clearCache()` when a job finishes, or
`sweepIdleCache()` on a shorter interval of your own. Neither cancels work in
flight, so both are safe to call from a request handler.

There is no per-file bound and no per-tenant one. One large file can fill the
cache and evict every chunk of every other, which in a browser is the point (the
user is looking at one track) and on a shared server may not be.

**A short script** — read a file once, write something out, exit — wants none of
this and pays little for it: the chunks it caches are ones it will not read
again, and the ceiling caps the waste at 256 MB. Both timers are `unref`'d, so
neither the sweep interval nor a pending response deadline holds the process
open; a script that finishes exits without calling anything.

**A `LocalFile` under `CachedFilehandle`** is the case to think twice about. See
[api.md](api.md#new-cachedfilehandleinner-key) — there is no request to coalesce
there, so the only thing bought is reuse, at 256 KiB resident per touched
region.
