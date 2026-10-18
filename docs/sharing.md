# Sharing a request between readers

Two reads that need the same bytes issue one request. Once a request is shared,
one reader's `AbortSignal` affects bytes that other readers are waiting for, and
most of this package's complexity follows from that.

**In the code, the unit of fetching and of joining is a request, and the unit of
cancelling is a reader.**

## Requests and readers

A **request** covers one merged cluster of gaps, `[start, end)`. While it is in
flight it sits in its file's `pending` list, and any read whose range overlaps
it joins it rather than asking for those bytes again, whether that read planned
in the same turn or arrives later. A **reader** is one call to `read()`, with at
most one signal.

The request holds the reference count. `Pending` holds the set of signals still
waiting, the `AbortController` the request runs under, and a second controller
used only to remove the listeners.

The request runs under its own signal, never the first reader's. A shared
request has to outlive any one reader giving up, and handing `fetch` the first
reader's signal would make the first reader's `abort()` cancel the request for
everyone.

## Giving up

When a reader's signal aborts, the request removes the signal from its set. When
the set empties, the request's controller aborts and `fetch` cancels the request
down to the socket, which saves ~6.5 MiB on a cancelled navigation.

A reader that aborts rejects at once with its own `signal.reason`, whether or
not the request goes on for somebody else. `getCachedRange` races the request
against the reader's signal and, on any rejection, prefers that reader's reason
to whatever the request reported, so two readers that abort with different
reasons each get back their own.

Three cases need care, and each one was a bug before the code handled it.

**A reader with no signal pins the request.** No combination of aborts should
stop a request when one of its readers never asked to be cancellable, so the
code marks it `pinned` and stops consulting the count. One read without a signal
therefore makes that request uncancellable for everyone sharing it, so pass a
signal even when you do not plan to abort.

**A reader that has already aborted is not a waiter.** An `abort` listener never
fires on a signal that aborted before the listener was added, so an
already-aborted signal added to the set would never come back out. The count
would never reach zero, and the request would become uncancellable for everyone
with no error. `getCachedRange` rejects such a reader at its first line, and
`join` checks again, because a broken invariant here raises no error and so
should not depend on a check several frames away.

**A request whose readers all gave up is not joinable.** It was cancelled, but
the rejection takes a tick to arrive, and the code removes the `pending` entry
only after that, so in between the entry still looks joinable. A new reader that
joined it would get somebody else's `AbortError`. On a pan this is the ordinary
sequence rather than a corner case, because the old blocks are aborted and the
new ones requested in the same tick, and adjacent blocks often overlap one
request. `coverage` treats such a request as a gap, and the reader plans a fresh
one, which survives when the cancelled request settles, since cleanup removes
only its own entry.

## Why joining rather than re-issuing

An earlier design let a reader's abort reject the request and re-issued the
fetch for whoever still wanted it. That design was correct, but it threw away a
request that was already in flight and that another reader still wanted. With
reference counting there is nothing to re-issue, because the request is not
cancelled while any reader is still waiting. `@gmod/bam` and `@gmod/cram` do the
same at their own cache layers.

## Settling

Once the request settles, it drops its signal set and aborts its `dispose`
controller, which removes every listener from the readers' signals. Keeping the
listeners would hold each reader's `AbortController` in memory after the request
is over.

The request stores its body before it leaves the `pending` list, so a byte is
never absent from both the cache and the list. A reader that joins in that
window awaits a promise that has already resolved, which costs nothing.

## Concurrency

`limitConcurrency` caps requests at 20 per **origin**, queueing the rest. When
the pool was global, one file could stall the whole process. A server that
answers the headers and then goes silent never settles, so its request never
releases its slot, and 20 of those blocked every read of every other file. With
a pool per origin, that server stalls only reads from its own host. The key is
the origin rather than the URL because a presigned URL rotates its signature on
every read, so a pool per URL would be a new pool each time and cap nothing.

`stat()` goes through the pool too, because it is a real request against the
same server, so N readers opening at once do not issue N stats outside the cap.
`stat()` also goes through `probeSize`, so those N readers share one request
rather than making N of them for one number.

`clearCache` leaves the pools alone. A read queued for a slot when the cache is
cleared is in-flight work like any other. The clear marks it stale, so its bytes
do not go back into the emptied cache, and it waits its turn and settles when a
slot frees. Dropping its resolver would strand its caller with no resolve and no
reject, and releasing every queued read at once would put more than 20 requests
on the wire.

The pool removes a request whose readers have all given up from the queue,
instead of letting it wait for a slot it no longer needs. Without that removal
the request would stay queued, because the response deadline starts only once it
claims a slot and sends its request, so behind a stalled origin a queued read
would wait forever, whatever its caller's abort. The pool splices the waiter out
rather than leaving a resolver that does nothing, because `runNext` claims a
slot _before_ it resumes the waiter it shifts off the queue, so a no-op waiter
would take a slot out of the pool for good.

## What the URL key does and does not separate

Two handles on one URL share bytes and requests, and **the key is the URL
alone**, so it does not separate handles that differ in how they fetch. If one
handle has a `fetch` that signs its requests and another has a plain one, the
handle whose read planned the request decides which `fetch` sends the request.
The other handle reads the bytes that request returned, and the cache serves
every later read without running either `fetch`. `stat()` shares the same way,
through `probeSize`.

The cache cannot separate such handles itself, because a `fetch` implementation
is a closure with no identity to key on. Where the separation matters, open the
file under one handle, or keep the URLs distinct, as a presigned URL already is.
`CachedFilehandle` takes its key as an argument for this reason, so a caller who
needs the separation can state it.

## A local file rewritten in place

A path identifies a location, and the bytes there can change. Rewrite a file in
place and a new `CachedFilehandle` on the same `file://` key reads the old
file's cached bytes, and the old file's size clamps every read. The cache does
not stat the file to notice, because that would cost every handle a round trip
before its first read. A caller that rewrites files either puts the modification
time in the key or calls `clearCacheFor(key)` before reopening.
