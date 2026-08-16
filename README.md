# @gmod/range-cache-filehandle

A `GenericFilehandle` that caches byte ranges in chunks and coalesces adjacent
reads into one request.

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

Nothing is retried.

## Tuning

`CHUNK_SIZE`, `MAX_CACHE_ENTRIES`, `CACHE_IDLE_TIMEOUT_MS`, `MAX_CONCURRENT` and
`RESPONSE_TIMEOUT_MS` are exported for reading, not setting. `src/constants.ts`
records what each was measured against.

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
