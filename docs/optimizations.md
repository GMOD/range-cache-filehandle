# Optimizations

An indexed genomics parser reads a remote file as many small, adjacent,
semi-random ranges. A browser runs about six requests per origin over HTTP/1.1,
so the request count sets the wall clock long before the parser's CPU work does.
Every optimization here cuts that count or the bytes behind it, and the other
docs hold the detail: [dataflow.md](dataflow.md) walks one read through the
steps, [sharing.md](sharing.md) covers shared requests, and
[tuning.md](tuning.md) covers the constants.

## What it is worth

`@gmod/hic` measured whole chr1 at 5 kb from ENCODE's `ENCFF148QCR`, a 69 GB
hg38 `.hic`, over the public internet in headless Chrome
([hic docs/optimizations.md](https://github.com/GMOD/hic/blob/main/docs/optimizations.md#round-trips-not-cpu-are-the-budget)):

| filehandle                 | wall clock | HTTP requests |
| -------------------------- | ---------: | ------------: |
| `RemoteFile`               |     24.0 s |           225 |
| `RemoteFileWithRangeCache` |      1.8 s |            45 |

The parser returned the same 5,182,471 contacts both ways, and its own CPU work
stayed under 100 ms.

## Reads snap to a chunk grid, and missing chunks coalesce

The layer rounds a read out to a 256 KiB grid and resolves each chunk on its
own. Chunks already cached cost nothing, and the missing ones group into
contiguous runs of one request each. A single 4 kb viewport over a 2000x BAM
measured 6.5 MiB in one request this way. The grid also lets a later read reuse
chunks an earlier read fetched, even when the two ranges differ.

`@gmod/hic`'s offline bench shows the coalescing without a network in the way.
At 2.5 Mb bins a whole-genome fetch issued 1,007 bare reads against 17 through
this layer. At 100 kb it issued 1,739 against 20, and transferred fewer bytes
(5.2 MB against 7.6 MB), because overlapping reads hit one cached chunk rather
than fetching the same bytes again.

## Concurrent readers share one request

Planning runs in one synchronous pass, so two reads in the same tick cannot open
two requests for one chunk. A read that needs a chunk already in flight joins
the request fetching it. The request stays alive until every reader waiting on
it aborts, so a pan that cancels one query keeps a request another query still
needs. [sharing.md](sharing.md) covers the reference counting and the three
cases around it.

## A cache hit skips the `Response` round trip

`RemoteFileWithRangeCache.read` goes straight to the chunk cache.
`RemoteFile.read` builds a range header, calls `fetch` and unwraps a `Response`,
and on a warm read that round trip was 69-77% of the time (6.15 ms against 1.90
ms at 16 MB).

## Chunks own their bytes

The layer copies each chunk out of a run's response with `slice` rather than
`subarray`. A view would keep the whole run buffer alive while any one chunk
stayed cached, so evicting a chunk would free nothing. The copy makes the
1000-entry cap a real 256 MB bound per worker.

## The cache outlives the parsed caches above it

`@gmod/bam`, `@gmod/cram` and `@gmod/tabix` drop parsed records after three
minutes idle. This layer keeps compressed chunks for fifteen, because they cost
roughly an order of magnitude less memory per base of coverage, and once the
parsed cache expires, nothing else separates a re-read from a re-download. With
a three-minute timeout, a reader who stepped away for four minutes re-downloaded
all 73.5 MB of a pan.
[tuning.md](tuning.md#cache_idle_timeout_ms-is-longer-than-the-caches-above-it-deliberately)
has the rest.

## Reads stop at the end of the file

BAM and tabix readers ask for 64 KiB past their last block so the final BGZF
block reads whole, which runs past EOF on every file. The layer clamps each read
to the file size once a `Content-Range`, a 416 or a `stat()` reports it, so that
tail costs no request and draws no 416.
