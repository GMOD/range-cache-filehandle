# @gmod/range-cache-filehandle

[![NPM version](https://img.shields.io/npm/v/@gmod/range-cache-filehandle.svg?style=flat-square)](https://npmjs.org/package/@gmod/range-cache-filehandle)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/range-cache-filehandle/publish.yml?branch=main)

A `GenericFilehandle` that caches byte ranges in chunks and coalesces adjacent
reads into one request.

An indexed genomics parser reads in a pattern the network is bad at: many small,
adjacent, semi-random ranges, most of them near ones it just read. This layer
sits under the parser and turns that into a few large requests, then serves the
next query's overlapping reads from memory.

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

A local file or `Blob` can be wrapped instead. The second argument keys this
file's chunks in the shared cache, so it must identify the underlying bytes:

```js
import { CachedFilehandle } from '@gmod/range-cache-filehandle'
import { LocalFile } from 'generic-filehandle2'

const file = new CachedFilehandle(new LocalFile(path), `file://${path}`)
```

## What it does

- Serves reads from a 256 KiB chunk grid. The chunks a read is missing are
  grouped into contiguous runs, one request each.
- Joins a chunk another read has in flight rather than requesting it again.
- Reference-counts each run's readers, so a shared request is cancelled only
  once all of them abort. A reader passing no signal pins it for everyone.
- Holds 1000 chunks (256 MB) per worker, swept after 15 minutes idle, 20
  requests at a time. `clearCache()` drops everything, `sweepIdleCache()`
  reclaims early.
- Clamps reads past EOF once a size is known, from `Content-Range`, a 416, or
  `stat()`.
- Names a cause on failure: CORS, mixed content, a server ignoring the Range
  header, a connection that goes 30s without answering.

Nothing is retried. [docs/dataflow.md](docs/dataflow.md) has the diagram and
walks one read through all of it.

## Tuning

`CHUNK_SIZE`, `MAX_CACHE_ENTRIES`, `CACHE_IDLE_TIMEOUT_MS`, `MAX_CONCURRENT` and
`RESPONSE_TIMEOUT_MS` are exported for reading, not setting — the cache is
module-global, so a knob on one filehandle would set policy for every other one
in the process. What each was measured against is in `src/constants.ts` and in
[docs/tuning.md](docs/tuning.md).

## Docs

- [docs/api.md](docs/api.md) — every export, and the `recordSize` hook a
  subclass with its own `stat()` needs
- [docs/dataflow.md](docs/dataflow.md) — how a read flows, with the diagram
- [docs/sharing.md](docs/sharing.md) — one request, several readers, and whose
  abort cancels it
- [docs/tuning.md](docs/tuning.md) — the five constants, what measured them, and
  what changes outside a browser
- [docs/errors.md](docs/errors.md) — what each failure says and why

## The layer above

This caches bytes. Every parser that reads through it caches what it parsed out
of them, on its own budget and its own idle timeout, and that cache is the one
that decides whether a read reaches this layer at all:

- [@gmod/bam](https://github.com/GMOD/bam-js) —
  [caching.md](https://github.com/GMOD/bam-js/blob/main/docs/caching.md)
- [@gmod/cram](https://github.com/GMOD/cram-js) —
  [memory.md](https://github.com/GMOD/cram-js/blob/main/docs/memory.md)
- [@gmod/tabix](https://github.com/GMOD/tabix-js) —
  [caching.md](https://github.com/GMOD/tabix-js/blob/main/docs/caching.md)
- [@gmod/bbi](https://github.com/GMOD/bbi-js) —
  [concurrency.md](https://github.com/GMOD/bbi-js/blob/main/docs/concurrency.md)

## Provenance

Extracted from JBrowse 2, where it was
`@jbrowse/core/util/io/RemoteFileWithRangeCache`, so parsers can use it without
depending on `@jbrowse/core`.

Replaces [http-range-fetcher](https://github.com/rbuels/http-range-fetcher), the
earlier inspiration. That merges the requests made in the last 100 ms; this
merges the chunks a read is missing, so it needs no window to wait out and
carries an `AbortSignal` to the socket.

## License

MIT
