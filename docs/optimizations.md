# Optimizations

An indexed genomics parser reads a remote file as many small, adjacent,
semi-random ranges. A browser runs about six requests per origin over HTTP/1.1,
so the request count sets the wall-clock time long before the parser's CPU work
does. Every optimization here cuts that count or the bytes behind it.
[dataflow.md](dataflow.md) walks one read through the steps,
[sharing.md](sharing.md) covers shared requests, and [tuning.md](tuning.md)
covers the constants.

## Measured speedup

`@gmod/hic` measured whole chr1 at 5 kb from ENCODE's `ENCFF148QCR`, a 69 GB
hg38 `.hic`, over the public internet in headless Chrome
([hic docs/optimizations.md](https://github.com/GMOD/hic/blob/main/docs/optimizations.md#round-trips-not-cpu-are-the-budget)):

| filehandle                 | wall clock | HTTP requests |
| -------------------------- | ---------: | ------------: |
| `RemoteFile`               |     24.0 s |           225 |
| `RemoteFileWithRangeCache` |      1.8 s |            45 |

The parser returned the same 5,182,471 contacts both ways, and its own CPU work
stayed under 100 ms.

## The cache stores what it fetched, and fetches only gaps

Per file, the layer keeps the exact byte extents it fetched. A read takes what
they cover and requests only the gaps. A later read reuses bytes an earlier read
fetched even when the two ranges differ, and nothing is fetched just because it
shares a fixed-size cell with something wanted.

Against 1.6.0's 256 KiB grid, measured through the real parsers against a local
server that counted bytes, on a cold pass:

| workload                   | 256 KiB grid      | extents          |
| -------------------------- | ----------------- | ---------------- |
| 32 HPRC gene lanes (tabix) | 10.72 MB / 32 req | 3.38 MB / 32 req |
| RNA-seq BAM                | 8.39 MB / 11 req  | 6.12 MB / 11 req |
| 1000x BAM                  | 49.55 MB / 12 req | 48.71 MB / 6 req |
| 20x BAM                    | 2.10 MB / 5 req   | 1.38 MB / 6 req  |
| `.hic`                     | 4.72 MB / 18 req  | 4.24 MB / 8 req  |
| bigWig                     | 3.67 MB / 14 req  | 0.98 MB / 15 req |

A revisit of every region, with the parsers' own caches warm or cold, made no
request with either design.

## Reads of one turn plan together

A read with gaps waits one microtask, so every read issued in the same turn
plans at once. A gap under 64 KiB grows to 64 KiB, and gaps within 64 KiB of
each other share one request. 64 KiB is the knee: 32 KiB costs bigWig and `.hic`
requests, and 128 KiB adds bytes to the gene lanes for no request saved.
[tuning.md](tuning.md#min_request) has the sweep.

`@gmod/hic`'s whole-genome fetch at 2.5 Mb bins issues about 1,450 reads, and
the turn turns them into 3 requests.

## Concurrent readers share one request

Planning runs with no `await` in it, so two reads cannot open two requests for
the same bytes. A read that needs bytes already in flight joins the request
fetching them. The request stays alive until every reader waiting on it aborts,
so a pan that cancels one query keeps a request another query still needs.
[sharing.md](sharing.md) covers the reference counting and the cases around it.

## A cache hit skips the `Response` round trip

`RemoteFileWithRangeCache` overrides `fetchBytes` to read straight from the
cache. The default `RemoteFile.fetchBytes` builds a range header, calls `fetch`
and unwraps a `Response`, and on a warm read that round trip took 69-77% of the
time (6.15 ms against 1.90 ms at 16 MB).

## Cached bytes own their buffers

The layer stores each body in copies of at most 1 MiB rather than views. A view
would keep the whole body alive while any one piece stayed cached, so evicting a
piece would free nothing. The copy makes `CACHE_LIMIT` a real 256 MiB bound per
worker.

## The cache outlives the parsed caches above it

`@gmod/bam`, `@gmod/cram` and `@gmod/tabix` drop parsed records after three
minutes idle. This layer keeps compressed bytes for fifteen, because they cost
roughly an order of magnitude less memory per base of coverage, and once the
parsed cache expires, this cache is the only thing that keeps a re-read from
becoming a re-download. With a three-minute timeout, a reader who stepped away
for four minutes re-downloaded all 73.5 MB of a pan.
[tuning.md](tuning.md#cache_idle_timeout_ms-is-longer-than-the-caches-above-it-deliberately)
has the rest.

## Reads stop at the end of the file

BAM and tabix readers ask for 64 KiB past their last block so the final BGZF
block reads whole, which runs past EOF on every file. The layer clamps each read
to the file size once a `Content-Range`, a 416 or a `stat()` reports it, so that
tail makes no request and gets no 416.
