# API

Eleven exports: two filehandles, three cache controls, and the six constants.

## `new RemoteFileWithRangeCache(url, opts?)`

A `RemoteFile` from
[generic-filehandle2](https://github.com/GMOD/generic-filehandle2) whose reads
go through the chunk cache. Same constructor, same options: `headers`,
`overrides`, `signal`, and a custom `fetch`. Static credentials go in `headers`;
`fetch` is for the ones that have to be computed per request, such as a signed
URL that refreshes.

```js
const file = new RemoteFileWithRangeCache(url, {
  fetch: async (input, init) => globalThis.fetch(await sign(input), init),
})
```

The URL is the cache key, so two instances on the same URL share chunks. That
makes a second handle on a file cheap rather than a duplicate — two tracks on
one BAM, or a parser you handed a URL rather than a filehandle and which built
its own.

Four methods behave differently from the base class.

### `read(length, position, opts?)`

Bytes from the chunk cache, assembling and fetching as
[dataflow.md](dataflow.md) describes. `headers`, `overrides` and `signal` all
reach the underlying request, from the constructor and from `opts` both, merged
the way `RemoteFile` merges them: `overrides` beats the method/redirect/mode
defaults, `opts` beats the constructor, and `opts.signal` beats a signal
supplied through `overrides`.

It does not call `RemoteFile.read`, which would build a range header, call
`fetch` and unwrap a `Response` — three copies of the range, 69-77% of a warm
read. A subclass overriding `RemoteFile.read` will find it is no longer on the
path, and so will one overriding `RemoteFile.fetchBytes`, which the base library
documents as the seam for serving bytes another way — this class is already that
override. Override this or `fetch` instead.

### `fetch(url, init?)`

Still cached, one layer lower: a string URL plus a single-range
`bytes=start-end` header is served from the cache and returned as a
synthetic 206. Anything else — a `Request` object, an open-ended `bytes=100-`, a
multi-range header, no range at all — goes straight to `RemoteFile.fetch`.

So a caller that builds its own range requests gets the cache for free, and a
caller that streams a whole file is unaffected.

Two differences from `RemoteFile.fetch` on the cached path. A status the range
machinery cannot read as the bytes that were asked for **throws** rather than
coming back as a `Response` to inspect — the status hints in
[errors.md](errors.md) are what that buys, and the uncached path still returns
its `Response` for any status. And the synthetic 206 carries the bytes, not the
headers: no `Content-Range`, no `Content-Length`. Read the size with `stat()`.

### `stat()`

`{ size }`, from the size cache when a range request has already observed
`Content-Range`, and otherwise from one zero-length range request issued for the
purpose.

That probe is the smallest range there is, so a server with no range support
answers it with the entire file. Up to one 256 KiB chunk of that is read and its
length taken as the size — a file that small is served whole by any request, so
such a server works here one chunk at a time. Past the ceiling the probe fails
with the 200 message from [errors.md](errors.md#a-status-came-back), which names
the missing range support rather than the `Content-Range` header below.
`Content-Length` is not consulted: cross-origin it can be a compressed count
with the `Content-Encoding` that would have said so hidden by CORS.

**It throws rather than reporting `size: 0`** when the server answered but the
header was not readable — the CORS misconfiguration that is invisible in the
network tab. [errors.md](errors.md#the-one-that-succeeds-and-still-fails) has
the reasoning and the header to add. Wrap it in a `try`/`catch` if your caller
can degrade.

### `protected recordSize(size)`

**The extension point for a subclass that answers `stat()` from somewhere
else.** A cloud provider's metadata endpoint, say. Call it with the size you
learned:

```js
class GoogleDriveFile extends RemoteFileWithRangeCache {
  async stat() {
    const { size } = await fetchDriveMetadata(this.fileId)
    this.recordSize(size) // <- without this, every last read of the file 416s
    return { size }
  }
}
```

Without it the size cache stays empty for that URL however many times `stat()`
is called, and the clamp in [dataflow.md](dataflow.md#clamping) never engages.
`@gmod/bam` and `@gmod/tabix` compute their last read to cover the whole final
BGZF block, so it runs past EOF by construction — the clamp is not an
optimization there, it is the difference between the last block reading and the
server answering 416.

A non-finite size is ignored rather than stored. A metadata endpoint that
populates `size` only for real files — not folders, shortcuts or native editor
documents — makes `Number(undefined)` a reachable input, and a `NaN` in the size
cache poisons rather than fails: every later read of that file would return
empty with nothing said.

## `new CachedFilehandle(inner, key)`

The same cache in front of any `GenericFilehandle` — a `LocalFile`, a
`BlobFile`, or your own implementation. Nothing in the cache is about HTTP.

```js
const file = new CachedFilehandle(new LocalFile(path), `file://${path}`)
```

`key` namespaces this file's chunks in the module-global cache, so **it has to
identify the underlying bytes**. A path or URL for anything with a stable name;
something instance-unique for a `Blob`, which has none. Two wrappers sharing a
key share chunks — right for two handles on one path, wrong for two unrelated
blobs.

`read` and `stat` go through the cache (`stat` recording the size it gets, so
past-EOF reads clamp); `readFile` and `close` pass through untouched.

Worth knowing that a local file may not want this at all. The cache buys request
coalescing, and a `LocalFile` read is a positional read on an already-open
descriptor — there is no request to coalesce. What it still buys is the reuse: a
re-read of a region already in the grid does no syscall, at a cost of 256 KiB
resident per touched region.

## `sweepIdleCache()`

Drop every chunk no read has touched for `CACHE_IDLE_TIMEOUT_MS`. Safe at any
moment, including mid-fetch: a read holds its own references to the chunks it
will assemble, and a chunk dropped from under it is simply re-fetched.

An interval already calls this. Call it yourself to reclaim earlier on an event
the library cannot see — a tab going hidden, a track closing, a request
finishing on a server.

Deliberately narrower than `clearCache`: it leaves in-flight fetches and queued
reads alone, since those are by definition active, and keeps the size cache,
which is one number per file and costs a round trip to re-derive.

## `clearCache()`

Drop every cached chunk, every known size, and hand every queued read its slot
so it runs. Mostly for tests, which need each case to start empty, and for a
consumer that knows it is finished with everything it has opened.

Note what it does **not** do: it does not cancel work in flight, and it does not
reject queued reads. A queued read is resumed rather than dropped, because a
dropped resolver strands its caller with neither a resolve nor a reject — a hang
rather than a cancellation. To actually stop work, abort the signals you passed
to it.

It also leaves each origin's in-flight request count alone. Resetting a count of
work that is genuinely still running is what let the reads after a `clearCache`
reach 40 concurrent against a cap of 20, so a transfer that has wedged mid-body
stays wedged across a clear. That is the cost of putting no clock on a transfer;
a server that never answers at all is still covered by `RESPONSE_TIMEOUT_MS`.

## `clearCacheFor(key)`

Drop one file's cached chunks and its known size, leaving every other file
alone. What a consumer closing one track wants, where `clearCache()` is too
blunt. The key is the same one the file was opened with — the URL for a
`RemoteFileWithRangeCache`, the second constructor argument for a
`CachedFilehandle`.

Like `clearCache`, it does not cancel work in flight: a read still waiting on a
request is entitled to the bytes it asked for, and that request cleans up after
itself. What such a request no longer does is repopulate the cache when it lands
— otherwise clearing a file that had a read in flight put it straight back.

## Constants

`CHUNK_SIZE`, `MAX_CACHE_ENTRIES`, `CACHE_IDLE_TIMEOUT_MS`, `MAX_CONCURRENT`,
`MAX_SIZE_ENTRIES` and `RESPONSE_TIMEOUT_MS` are exported for reading, not
setting — the cache is module-global, so a knob on one filehandle would be
policy for every other one in the process. [tuning.md](tuning.md) is what each
is and what measured it.

Reading them is genuinely useful, though. `CHUNK_SIZE` is the granularity your
reads are rounded to, so it is the number to compare an index's chunk sizes
against when deciding how much of a file a query really costs.
