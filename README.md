# @gmod/range-cache-filehandle

A `GenericFilehandle` that caches byte ranges in fixed-size chunks and coalesces
adjacent reads into one request.

Indexed genomics parsers — `@gmod/bam`, `@gmod/cram`, `@gmod/tabix`, `@gmod/bbi`
— read a file as many small byte ranges. A whole-reference CRAM query issues
hundreds of reads for a file of a few hundred kilobytes; over HTTP that is
hundreds of range requests. This sits underneath them and turns that into a
handful.

```sh
npm install @gmod/range-cache-filehandle
```

## Usage

```js
import { RemoteFileWithRangeCache } from '@gmod/range-cache-filehandle'
import { CramFile } from '@gmod/cram'

const cram = new CramFile({
  filehandle: new RemoteFileWithRangeCache('https://example.com/file.cram'),
})
```

It is a drop-in `RemoteFile` from
[generic-filehandle2](https://github.com/GMOD/generic-filehandle2), so anywhere
a parser takes a `filehandle` this goes instead.

For a local file or a `Blob`, wrap it — nothing in the cache is about HTTP:

```js
import { CachedFilehandle } from '@gmod/range-cache-filehandle'
import { LocalFile } from 'generic-filehandle2'

const file = new CachedFilehandle(new LocalFile(path), `file://${path}`)
```

The second argument namespaces this file's chunks in the shared cache, so it has
to identify the underlying bytes. Two wrappers sharing a key share chunks, which
is right for two handles on one path and wrong for two unrelated blobs.

## What it does

**One request per contiguous run.** A read is served from a 256 KiB chunk grid.
The chunks it is missing are grouped into contiguous runs, and each run becomes
a single range request — so a read spanning five uncached chunks makes one
request, not five.

**A chunk in flight is joined, not re-requested.** Concurrent reads over
adjacent genomic blocks routinely land in the same chunk. The second one awaits
the first one's fetch.

**A shared request survives one reader giving up.** Each run keeps a reference
count of the readers waiting on it and is cancelled only once every one of them
has aborted. Cancelling your read never costs a concurrent reader its bytes —
but a reader that passes **no** signal cannot give up, so it pins the request
for everyone sharing it.

**The cache is module-global**, holding up to 1000 chunks — 256 MB — with a
15-minute idle sweep, and at most 20 concurrent requests. Each worker gets its
own. `clearCache()` drops everything; `sweepIdleCache()` reclaims on your own
schedule, for a tab going hidden.

**Reads past EOF are clamped.** Every bgzf reader over-reads its last block by
construction. Once a size is known — from a `Content-Range` header, a 416, or a
`stat()` — the tail is clamped instead of asking for chunks past the end and
being refused.

**Failures say what to do.** A bare `TypeError` from `fetch` carries no status,
no headers and no URL, so a CORS denial, a mixed-content block and a dead host
are indistinguishable; the error names the two that are checkable and then the
CORS case, which is nearly always the right one for a genome file on someone
else's server. A 200 to a range request means the server ignored the header, and
says so. A stalled connection fails after 30 seconds rather than hanging — that
deadline is on the server _beginning_ to answer, never on the transfer, which is
routinely multi-megabyte here.

Nothing is retried. A failed read surfaces as an error and the caller decides.

## Tuning

The constants are exported (`CHUNK_SIZE`, `MAX_CACHE_ENTRIES`,
`CACHE_IDLE_TIMEOUT_MS`, `MAX_CONCURRENT`, `RESPONSE_TIMEOUT_MS`) for reading,
not for setting — `src/constants.ts` records what each was measured against.
`MAX_CACHE_ENTRIES` in particular looks oversized and is not.

## Provenance

Extracted from JBrowse 2, where it lived as
`@jbrowse/core/util/io/RemoteFileWithRangeCache` and served every remote track.
It is pulled out here so parsers can point at it without a dependency on
`@jbrowse/core`, react and mobx-state-tree.

## License

MIT
