# The constants, and what measured them

Six constants are exported for reading, not setting: `CHUNK_SIZE`,
`MAX_CACHE_ENTRIES`, `CACHE_IDLE_TIMEOUT_MS`, `MAX_CONCURRENT`,
`MAX_SIZE_ENTRIES` and `RESPONSE_TIMEOUT_MS`. There is no per-instance override,
because the cache is module-global, so a setting on one filehandle would apply
to every other one in the process. `src/constants.ts` gives the same reasoning
next to the values, and is the copy to update if a measurement changes.

| constant                | value         | bounds                                |
| ----------------------- | ------------- | ------------------------------------- |
| `CHUNK_SIZE`            | 256 KiB       | the grid a read snaps to              |
| `MAX_CACHE_ENTRIES`     | 1000 (256 MB) | retained bytes, per module instance   |
| `CACHE_IDLE_TIMEOUT_MS` | 15 min        | how long an unread chunk stays cached |
| `MAX_CONCURRENT`        | 20            | requests in flight, **per origin**    |
| `MAX_SIZE_ENTRIES`      | 5000          | file sizes remembered                 |
| `RESPONSE_TIMEOUT_MS`   | 30 s          | wait for a response to _begin_        |

We chose each value for one workload: a genome browser panning a track in a
browser tab. [Where this runs](#where-this-runs) covers what changes for other
workloads.

## `MAX_CACHE_ENTRIES` looks oversized and is not

`fetchRun` copies each chunk out of the run buffer rather than taking a view, so
no chunk keeps a run buffer alive. The entry count therefore bounds memory at
`MAX_CACHE_ENTRIES * CHUNK_SIZE` per module instance, and each worker has its
own instance.

jbrowse measured panning twelve windows of a 105 MB BAM and panning back. The
second pass issues zero requests, and on that workload a cache of **four**
entries cost one extra range request and 1.3 MB. That result does not justify
shrinking the cache, because in that run `@gmod/bam`'s parsed cache stayed under
its 1 GB budget and never evicted, and a region the parser has already parsed
never reaches this layer.

On real data the parsed cache does evict, because a single 1000x track panned
across a 250 kb contig already peaks past that budget. A re-read then falls
through to this layer, and this cache is the only thing that keeps it off the
network. Do not shrink it on the strength of a workload that stayed inside the
parsed budget.

## `CACHE_IDLE_TIMEOUT_MS` is longer than the caches above it, deliberately

This layer keeps chunks for fifteen minutes, while `@gmod/bam`, `@gmod/cram` and
`@gmod/tabix` all take a `cacheIdleTimeoutMs` that defaults to three minutes
([bam-js/docs/caching.md](https://github.com/GMOD/bam-js/blob/main/docs/caching.md),
[cram-js/docs/memory.md](https://github.com/GMOD/cram-js/blob/main/docs/memory.md)).

Raw compressed bytes take roughly an order of magnitude less memory per unit of
genomic coverage than the parsed features above them, and once those caches
expire, only this cache keeps a re-read from becoming a re-download. With a
three-minute timeout to match theirs, this cache expired at the moment it became
the only one helping. In our measurement, a reader who stepped away for four
minutes re-downloaded all 73.5 MB of a pan.

We added the sweep because holding every chunk forever left 100 MB per worker
resident after the track closed, after the tab hid, and after four minutes idle.
Fifteen minutes bounds that without the cost of holding chunks forever.

The sweep runs on an interval of a quarter of the timeout, so the lag between a
chunk going idle and being dropped is ~1.25x the timeout rather than 2x. The
interval starts with the first cached chunk and stops when a sweep empties the
cache, so it does no work while the cache is empty. Chrome's intensive
throttling of a hidden page does not affect the sweep where it matters, because
Chrome does not throttle workers, and the workers hold the bytes.

`sweepIdleCache()` is exported so a consumer can reclaim on its own schedule,
such as when a tab goes hidden. The interval is still needed for an idle
consumer, which calls nothing, so a check that ran only on the next cache access
would never run for the reader who walked away.

`clearCache()` drops every chunk and every known size. It leaves reads in flight
or queued to finish under the concurrency cap, and is mostly for tests, which
need each case to start empty.

## `RESPONSE_TIMEOUT_MS` bounds the wait for a response, not for the bytes

`fetch` resolves when the response headers arrive, and the code clears the
deadline there, before a byte of the body is read.

The distinction matters because this layer makes range requests unusually large,
such as 6.5 MiB for a single 4 kb viewport over a 2000x BAM. A deadline over the
whole transfer would cut that read off on any link slower than about 2 Mbps,
turning a slow session into a broken one.

The deadline catches a connection that is open and silent, the one failure that
produces no error at all. From the reader's side a fetch is in flight and
nothing looks wrong, so without the deadline the caller waits forever and never
gets the error it would retry on. Thirty seconds is generous on purpose, because
a server that has not begun to answer by then is unlikely to answer at all.

The deadline covers both HTTP paths: a range read, and a whole-file `readFile`,
which sends no range header and so goes through the plain fetch. The whole-file
path matters more than its share of the traffic suggests. An assembly's
chrom.sizes, chromAlias and cytoband files are all read that way, and a hub that
accepts the connection and goes silent leaves a spinner and no error at all.

`CachedFilehandle` has no deadline, because it wraps a local file or a Blob,
which returns or throws, and there is no socket to stay open.

The code combines the deadline with the caller's signal rather than replacing
the caller's signal. Replacing it would stop cancellation from reaching the
socket, which loses the ~6.5 MiB per cancelled navigation that reference
counting saves ([sharing.md](sharing.md)). `AbortSignal.any` combines the two,
and because a signal holds its dependents weakly, a session-long signal passed
to every read accumulates no listeners. `AbortSignal.any` needs Chrome 116,
Firefox 124, Safari 17.4 or Node 20.3.

### Requests the browser has queued

A browser opens six connections to one HTTP/1.1 origin, shared by every worker
and tab of the page, and holds a seventh `fetch` unsent in its own queue with
its promise pending. The page cannot see when a request leaves that queue, so
the deadline would count the wait, and on a slow link a request that was never
sent would fail as though the server had sent nothing.

The deadline therefore re-arms on evidence that the origin is answering. Each
request to an http(s) origin counts its body from the moment its headers arrive
until the body ends, is cancelled or fails, both in its own context and as a
shared Web Lock named for the origin, which `navigator.locks.query()` shows to
every worker and tab. When a deadline fires and `BROWSER_CONNECTIONS_PER_HOST`
(six) or more bodies are in progress on its origin, it re-arms for another 30
seconds instead of failing, at most `MAX_DEADLINE_REARMS` (ten) times, so six
bodies stalled forever still end in an error after five and a half minutes. A
whole-file `readFile` counts its body the same way.

Three limits remain:

- A page without `navigator.locks` counts only its own context's bodies. Any
  insecure context lacks it, which is every page served over plain http except
  from localhost or 127.0.0.1, so there a request queued behind another worker's
  six bodies still fails at 30 seconds. A sandboxed embed whose lock requests
  reject falls back the same way.
- On an HTTP/2 origin six streaming bodies do not mean a queue, so a request
  that really is silent is reported up to five minutes late while they stream.
- A whole-file response a caller takes from `fetch` directly, rather than
  through `readFile`, is not counted.

## Where this runs

The cache is module state, so its scope is one module instance: **one per
realm**, not one per process and not one per filehandle. A page and each of its
workers get their own, and so does each worker thread in node. The 256 MB bound
is per instance, so a browser with six worker threads has a ceiling of 1.5 GB
and no single place that tracks the total.

We chose every number above for this per-realm scoping, as jbrowse deploys it: a
browser session panning a track, where the same person reads the same region
again a minute later and 256 MB of a device's memory is a reasonable ask.

Consider two other deployment patterns before taking the defaults.

**A long-lived server process** shares one cache across every request it serves,
keyed by URL. Sharing helps when many requests hit the same few files, and only
costs memory when each request reads a file no other request will touch, because
the chunks stay for fifteen minutes waiting for a re-read that never comes. If
your traffic is the second kind, call `clearCache()` when a job finishes, or
`sweepIdleCache()` on a shorter interval of your own. Neither cancels work in
flight, so both are safe to call from a request handler.

The cache has no per-file or per-tenant bound. One large file can fill the cache
and evict every chunk of every other file, which in a browser is what you want
(the user is looking at one track) and on a shared server may not be.

**A short script** that reads a file once, writes something out and exits needs
none of this, and the cache costs it little. The script will not read its cached
chunks again, and the ceiling caps that waste at 256 MB. Both timers are
`unref`'d, so neither the sweep interval nor a pending response deadline holds
the process open, and a script that finishes exits without calling anything.

**A `LocalFile` under `CachedFilehandle`** may not be worth it. A local read
makes no request to coalesce, so the only benefit is reuse, at 256 KiB resident
per touched region; see [api.md](api.md#new-cachedfilehandleinner-key).
