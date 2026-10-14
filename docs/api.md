# API

The package has eleven exports: two filehandles, three cache controls, and six
constants.

## `new RemoteFileWithRangeCache(url, opts?)`

A `RemoteFile` from
[generic-filehandle2](https://github.com/GMOD/generic-filehandle2) whose reads
go through the chunk cache. It takes the same constructor arguments and options
as `RemoteFile`: `headers`, `overrides`, `signal`, and a custom `fetch`. Static
credentials go in `headers`; `fetch` is for the ones that have to be computed
per request, such as a signed URL that refreshes.

```js
const file = new RemoteFileWithRangeCache(url, {
  fetch: async (input, init) => globalThis.fetch(await sign(input), init),
})
```

The URL is the cache key, so two instances on the same URL share chunks. A
second handle on a file therefore reuses the chunks the first one fetched, for
example for two tracks on one BAM, or for a parser that you handed a URL rather
than a filehandle and that built its own.

Four methods behave differently from the base class.

### `read(length, position, opts?)`

Returns bytes from the chunk cache, which assembles and fetches them as
[dataflow.md](dataflow.md) describes. `RemoteFile.read` validates the arguments,
answers a zero length itself and hands the rest to `fetchBytes`, which this
class overrides to read from the cache instead of unwrapping a `Response`. A
`Response` round trip copies the range three times and takes 69-77% of a warm
read. The override also rejects a length larger than a `Uint8Array` can hold.

`RemoteFile.buildRequest` builds every request this class sends, the `stat()`
probe included, so `headers`, `overrides` and `signal` from the constructor and
from `opts` merge the way the base class merges them: `overrides` beats the
method/redirect/mode defaults, `opts` beats the constructor, `opts.signal` beats
a signal supplied through `overrides`, and a header name matches however it is
capitalized.

A subclass that overrides `fetchBytes` bypasses the cache. Override `fetch` to
change how requests are made.

### `fetch(url, init?)`

`fetch` also goes through the cache, one layer lower. The cache answers a
request that has a string URL and a single-range `bytes=start-end` header with a
synthetic 206. Any other request goes straight to `RemoteFile.fetch`: a
`Request` object, an open-ended `bytes=100-`, a multi-range header, or no range
at all.

The cache therefore covers a caller that builds its own range requests, and
leaves a caller that streams a whole file unaffected.

On the cached path, `fetch` differs from `RemoteFile.fetch` in two ways. First,
a status that the cache cannot read as the requested bytes **throws** rather
than coming back as a `Response` to inspect. The thrown error includes the
status hints listed in [errors.md](errors.md); the uncached path still returns
its `Response` for any status. Second, the synthetic 206 contains the bytes but
no `Content-Range` or `Content-Length` header, so read the size with `stat()`.

### `stat()`

Resolves to `{ size }`, taken from the size cache when an earlier range request
has already read `Content-Range`, and otherwise from one zero-length range
request made for the purpose.

A server with no range support answers that probe, the smallest range there is,
with the entire file. The probe reads up to one 256 KiB chunk of the body and
takes its length as the size. Any request returns a file that small whole, so
the package can still serve a small file from such a server, one chunk at a
time. Past that ceiling the probe fails with the 200 message from
[errors.md](errors.md#a-status-came-back), which names the missing range support
rather than the `Content-Range` header below. `stat()` ignores `Content-Length`,
because cross-origin it can be a compressed count, and CORS hides the
`Content-Encoding` header that would say so.

**`stat()` throws rather than reporting `size: 0`** when the server answered but
`Content-Range` was unreadable, a CORS misconfiguration that the network tab
does not show. [errors.md](errors.md#the-one-that-succeeds-and-still-fails) has
the reasoning and the header to add. Wrap the call in a `try`/`catch` if your
caller can work without a size.

### `protected recordSize(size)`

**A subclass that answers `stat()` from another source calls `recordSize`**, for
example after reading a cloud provider's metadata endpoint. Pass it the size:

```js
class GoogleDriveFile extends RemoteFileWithRangeCache {
  async stat() {
    const { size } = await fetchDriveMetadata(this.fileId)
    this.recordSize(size) // <- without this, every last read of the file 416s
    return { size }
  }
}
```

Without `recordSize`, the size cache stays empty for that URL however many times
`stat()` is called, so the clamp in [dataflow.md](dataflow.md#clamping) never
applies. `@gmod/bam` and `@gmod/tabix` size their last read to cover the whole
final BGZF block, so that read always runs past EOF. Without the clamp, the
server answers it with a 416 instead of the last block.

`recordSize` ignores a non-finite size. A metadata endpoint may set `size` only
for real files and leave it out for folders, shortcuts and native editor
documents, so `Number(undefined)` is a reachable input. A `NaN` in the size
cache would raise no error, and every later read of that file would return
empty.

## `new CachedFilehandle(inner, key)`

`CachedFilehandle` puts the chunk cache in front of any `GenericFilehandle`,
such as a `LocalFile`, a `BlobFile`, or your own implementation, since the cache
contains no HTTP-specific code.

```js
const file = new CachedFilehandle(new LocalFile(path), `file://${path}`)
```

`key` namespaces this file's chunks in the module-global cache, so **it has to
identify the underlying bytes**. Use a path or URL for anything with a stable
name, and something unique to the instance for a `Blob`, which has no name. Two
wrappers with the same key share chunks, which is right for two handles on one
path and wrong for two unrelated blobs.

`read` and `stat` go through the cache, while `readFile`, `close` and `source`
pass straight to the inner handle. `CachedFilehandle` records a size from `stat`
so past-EOF reads clamp, except a size of 0 from stats without `mtimeMs`. A
`RemoteFile` answers `{ size: 0 }` when it cannot see `Content-Range`, and
recording that would make every read empty. An empty Blob still reads as empty,
from its inner handle.

`source` comes from the inner handle rather than from `key` on purpose, because
of the `Blob` case. A caller invents a key where there is no name, while
`source` is an address someone can look up, so a wrapper around a `Blob` reports
`undefined`, and a slow-read log shows nothing rather than an invented id.

A local file may not need `CachedFilehandle` at all. The cache coalesces
requests, and a `LocalFile` read is a positional read on an already-open
descriptor, so there is no request to coalesce. The cache still helps with
reuse, because a re-read of a region already in the grid makes no syscall, at a
cost of 256 KiB resident per touched region.

## `sweepIdleCache()`

Drop every chunk no read has touched for `CACHE_IDLE_TIMEOUT_MS`. The call is
safe at any moment, including mid-fetch, because a read holds references to the
chunks it will assemble, and a later read that wants a dropped chunk re-fetches
it.

The library already calls `sweepIdleCache()` on an interval. Call it yourself to
free memory sooner after an event the library cannot see, such as a tab going
hidden, a track closing, or a request finishing on a server.

`sweepIdleCache()` is deliberately narrower than `clearCache`. It leaves
in-flight fetches and queued reads alone, since those are by definition active,
and keeps the size cache, which holds one number per file and costs a round trip
to re-derive.

## `clearCache()`

Drop every cached chunk and every known size. The call is mostly for tests,
which need each case to start empty, and for a consumer that has finished with
everything it opened.

`clearCache` does not cancel work in flight, reject queued reads, or touch the
concurrency pools. A read already running or queued for a slot gets its bytes,
settling in turn as slots free, but those bytes do not repopulate the emptied
cache. To stop the work, abort the signals you passed to it.

Because the pools keep their counts, a transfer stalled mid-body stays stalled
after a clear. That follows from setting no time limit on a transfer;
`RESPONSE_TIMEOUT_MS` still covers a server that never answers at all.

## `clearCacheFor(key)`

Drop one file's cached chunks and its known size, leaving every other file
alone. A consumer closing one track needs this, where `clearCache()` would drop
every file. The key is the one the file was opened with: the URL for a
`RemoteFileWithRangeCache`, and the second constructor argument for a
`CachedFilehandle`.

Like `clearCache`, it does not cancel work in flight, because a read still
waiting on a request should get the bytes it asked for, and that request cleans
up after itself. The request does not put its chunks back in the cache when it
completes, so a file cleared while a read was in flight stays cleared.

## Constants

`CHUNK_SIZE`, `MAX_CACHE_ENTRIES`, `CACHE_IDLE_TIMEOUT_MS`, `MAX_CONCURRENT`,
`MAX_SIZE_ENTRIES` and `RESPONSE_TIMEOUT_MS` are exported for reading, not
setting. The cache is module-global, so a setting on one filehandle would apply
to every other one in the process. [tuning.md](tuning.md) explains each constant
and the measurement behind it.

`CHUNK_SIZE` is the granularity your reads are rounded to, so compare an index's
chunk sizes against it to work out how much of a file a query costs.
