# @gmod/range-cache-filehandle

[![NPM version](https://img.shields.io/npm/v/@gmod/range-cache-filehandle.svg?style=flat-square)](https://npmjs.org/package/@gmod/range-cache-filehandle)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/range-cache-filehandle/publish.yml?branch=main)

A `GenericFilehandle` that caches byte ranges in chunks and coalesces adjacent
reads into one request.

An indexed genomics parser makes many small, adjacent, semi-random reads, most
near ones it just made. This package sits under the parser, merges those reads
into a few large requests, and serves the next query's overlapping reads from
memory.

```sh
npm install @gmod/range-cache-filehandle
```

## Usage

Drop-in for `RemoteFile` from
[generic-filehandle2](https://github.com/GMOD/generic-filehandle2):

```js
import { RemoteFileWithRangeCache } from '@gmod/range-cache-filehandle'
import { CramFile } from '@gmod/cram'

const cram = new CramFile({
  filehandle: new RemoteFileWithRangeCache('https://example.com/file.cram'),
})
```

`CachedFilehandle` wraps a local file or `Blob` instead. Its second argument is
the key for this file's chunks in the shared cache, so it must identify the
underlying bytes:

```js
import { CachedFilehandle } from '@gmod/range-cache-filehandle'
import { LocalFile } from 'generic-filehandle2'

const file = new CachedFilehandle(new LocalFile(path), `file://${path}`)
```

## Behavior

<img src="docs/img/chunks.svg" alt="A read spanning five 256 KiB chunks: one is cached, one is already being fetched by another read, and the three that are missing become two range requests" width="660">

The picture comes from running the cache, and its range headers are the ones
that read sent, as [CONTRIBUTING.md](CONTRIBUTING.md#docs) describes.

- Serves reads from a 256 KiB chunk grid. The chunks a read is missing are
  grouped into contiguous runs, one request each.
- Joins a chunk another read has in flight rather than requesting it again.
- Reference-counts each run's readers, so a shared request is cancelled only
  once all of them abort. A reader that passes no signal keeps the request
  running for everyone.
- Holds 1000 chunks (256 MB) per worker and sweeps chunks idle for 15 minutes.
  `clearCache()` drops everything, `clearCacheFor(key)` drops one file, and
  `sweepIdleCache()` sweeps early.
- Runs 20 requests at a time **per origin**.
- Clamps reads past EOF once a size is known, from `Content-Range`, a 416, or
  `stat()`.
- Checks a `206` against its `Content-Range` and the range requested, so a
  truncated body or a proxy answering with the wrong range throws an error
  instead of being cached as a file that ends early.
- Names a cause on failure: CORS, mixed content, a server ignoring the Range
  header, a connection that goes 30s without answering.

Timeouts and retries:

- This layer never retries a request.
- **It sets no time limit on a transfer.** A run of chunks becomes one large
  request, so a duration limit would cut off a slow download rather than a
  broken one. `fetch`
  [has no timeout of its own](https://github.com/whatwg/fetch/issues/951) for
  the same reason.
- To stop a read, abort the `AbortSignal` you passed it. The cache passes the
  signal through to the socket.

The concurrency cap is per origin:

- One unresponsive server cannot starve the others, as with any
  [per-endpoint semaphore](https://copdips.com/2023/01/python-aiohttp-rate-limit.html).
- It is per origin and not per URL, because a presigned URL rotates its
  signature on every read.

[docs/dataflow.md](docs/dataflow.md) has the diagram and follows one read
through each of these steps.

## Tuning

`CHUNK_SIZE`, `MAX_CACHE_ENTRIES`, `CACHE_IDLE_TIMEOUT_MS`, `MAX_CONCURRENT` and
`RESPONSE_TIMEOUT_MS` are exported for reading, not setting. The cache is
module-global, so a setting on one filehandle would change every other
filehandle in the process.

`src/constants.ts` and [docs/tuning.md](docs/tuning.md) give the measurements
behind each.

## Docs

- [docs/api.md](docs/api.md) — every export, and the `recordSize` hook a
  subclass with its own `stat()` needs
- [docs/optimizations.md](docs/optimizations.md) — what cuts the request count,
  and what each step was measured to be worth
- [docs/dataflow.md](docs/dataflow.md) — how a read flows, with the diagram
- [docs/sharing.md](docs/sharing.md) — one request, several readers, and whose
  abort cancels it
- [docs/tuning.md](docs/tuning.md) — the six constants, the measurements behind
  them, and what changes outside a browser
- [docs/errors.md](docs/errors.md) — what each failure reports and why

## References

- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) — HTTP semantics:
  [Range](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2) §14.2,
  [Content-Range](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.4)
  §14.4, [206](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.7)
  §15.3.7, [416](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.17)
  §15.5.17. Only single-part ranges are cached; a multi-range request is passed
  straight through rather than partly honored.
- [WHATWG DOM: dependent signals](https://dom.spec.whatwg.org/#abortsignal-dependent-signals)
  — why the deadline's `AbortSignal.any` leaves nothing behind on a long-lived
  caller signal.
- [whatwg/fetch#951](https://github.com/whatwg/fetch/issues/951) — why `fetch`
  has no timeout, and why this package adds none over a transfer.
- [Per-endpoint rate limiting](https://copdips.com/2023/01/python-aiohttp-rate-limit.html)
  — the semaphore-per-endpoint pattern `MAX_CONCURRENT` uses.

## The layer above

range-cache-filehandle caches bytes. Each parser that reads through it also
caches what it parsed, with a separate budget and idle timeout, and a hit in
that cache means the read never reaches this layer:

- [@gmod/bam](https://github.com/GMOD/bam-js) —
  [caching.md](https://github.com/GMOD/bam-js/blob/main/docs/caching.md)
- [@gmod/cram](https://github.com/GMOD/cram-js) —
  [memory.md](https://github.com/GMOD/cram-js/blob/main/docs/memory.md)
- [@gmod/tabix](https://github.com/GMOD/tabix-js) —
  [caching.md](https://github.com/GMOD/tabix-js/blob/main/docs/caching.md)
- [@gmod/bbi](https://github.com/GMOD/bbi-js) —
  [concurrency.md](https://github.com/GMOD/bbi-js/blob/main/docs/concurrency.md)

## Provenance

- Extracted from JBrowse 2, where it was
  `@jbrowse/core/util/io/RemoteFileWithRangeCache`, so parsers can use it
  without depending on `@jbrowse/core`.
- Replaces [http-range-fetcher](https://github.com/rbuels/http-range-fetcher),
  which merges the requests made in the last 100 ms. This package merges the
  chunks a read is missing, so it needs no window to wait out, and it passes an
  `AbortSignal` through to the socket.

## License

MIT
