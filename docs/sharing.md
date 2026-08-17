# Sharing a request between readers

Two reads that need the same 256 KiB chunk issue one request. That is easy to
say and most of the subtlety in this package, because the moment a request is
shared, one reader's `AbortSignal` is a decision about somebody else's bytes.

The rule the code implements: **the unit of fetching is a run, the unit of
joining is a chunk, and the unit of cancelling is a reader.**

## The three units

A **run** is a contiguous stretch of missing chunks covered by one range
request. A **chunk** is one 256 KiB cell of the grid; a second read joins at
chunk granularity, since it may want three chunks of a ten-chunk run and nothing
else. A **reader** is one call to `read()`, with at most one signal.

So the reference count lives on the run — that is what a request maps to — and
every chunk the run produces points back at it. `RunState` holds the set of
signals still waiting, an `AbortController` the request actually runs under, and
a second controller used only to take the listeners back off.

The request runs under the run's own signal, never the opening reader's. A
shared request has to outlive any one reader giving up, and handing `fetch` the
first reader's signal would make the first reader's `abort()` everyone's.

## Giving up

When a reader's signal aborts, it comes out of the set. When the set empties,
the run's controller aborts and the request is cancelled for real — down to the
socket, which is worth ~6.5 MiB on a cancelled navigation.

Three cases around that are worth naming, because each was a bug before it was a
rule.

**A reader with no signal pins the run.** There is no set of aborts that should
stop a request one of whose readers never asked to be cancellable, so the run is
marked pinned and the count stops mattering. One signal-free read makes that
request uncancellable for everyone sharing it — the honest reading of the API,
and the reason to pass a signal even when you do not plan to abort.

**A reader that has already aborted is not a waiter.** An `abort` listener never
fires on a signal that aborted before the listener was added, so an
already-aborted signal added to the set would never come back out, the count
would never reach zero, and the request would be uncancellable for everyone —
silently. `getCachedRange` rejects such a reader at its first line, and
`joinRun` checks again, because an invariant this quiet should not rest on a
check several frames away.

**A run whose readers all gave up is not joinable.** Its request was cancelled,
but the rejection takes a tick to arrive and the `inFlight` entry is not removed
until after that, so in between it sits there looking joinable. Joining it hands
the new reader somebody else's `AbortError`. On a pan that window is the
ordinary sequence rather than a corner case: the old blocks are aborted and the
new ones requested in the same tick, and adjacent blocks routinely want the same
chunk. `joinChunk` refuses, and the reader opens a fresh run — which survives
the doomed one settling, since cleanup removes only its own entry.

## Why joining rather than re-issuing

An earlier design let a reader's abort reject the chunk and re-issued the fetch
for whoever still wanted it. Correct, and it threw away a 256 KiB request that
was already in flight and that somebody still wanted. Reference counting means
there is nothing to re-issue: the request is simply not cancelled while anyone
is still waiting. `@gmod/bam` and `@gmod/cram` do the same at their own cache
layers.

## Settling

Once the request settles, the run drops its signal set and aborts its `dispose`
controller, which takes every listener back off the readers' signals — holding
them would pin each reader's `AbortController` behind a request that is over.

A settled run is still joinable for its bytes but not for its count: `putCached`
runs after `settle`, so there is a window where the bytes have arrived and the
chunk is in neither the cache nor the in-flight map, and the promise is still
the right thing to await. Adding a signal to a settled run's set is what must
not happen — nothing would ever take it out.

## Concurrency

`limitConcurrency` caps requests at 20 per **origin**, queueing the rest. Held
globally, the pool was a place one file could take the whole process down: a
server that answers the headers and then goes silent never settles, so its
request never gives the slot back, and 20 of those blocked every read of every
other file. Keyed per origin instead, that dead server stalls only the host it
lives on — and per origin rather than per URL because a presigned URL rotates
its signature on every read, which would mint a fresh pool each time and cap
nothing.

`stat()` goes through it too: it is a real request against the same server, and
N readers opening at once used to issue N stats outside the cap. `stat()` also
goes through `oncePerKey`, so those N readers share one request rather than
making N of them for one number.

`clearCache` resumes queued waiters rather than dropping them. A dropped
resolver strands its caller with no resolve and no reject — a hang rather than a
cancellation. Each resumed waiter is _added_ to the active count, never assigned
over it: assigning discards the count of work still running, which let the next
reads reach 40 concurrent against a cap of 20.

A run whose readers have all given up comes out of the queue rather than waiting
for a slot it no longer wants. Nothing else would take it out: the response
deadline starts once the slot is claimed and a request goes out, so behind a
wedged origin a queued read waited forever and ignored its caller's abort. The
waiter is spliced out rather than left behind as a resolver that does nothing —
`runNext` claims a slot _before_ it resumes whatever it shifts, so a no-op
waiter would take a slot out of the pool for good.

## What the URL key does and does not separate

Two handles on one URL share chunks, and that is the point — a second handle on
a file is cheap rather than a duplicate. They share requests too, and **the key
is the URL alone**, so it does not separate handles that differ in how they
fetch. Give one handle a `fetch` that signs its requests and another a plain
one, and whichever opens the run decides which of the two goes out; the other
reads the bytes it brought back, and every later read is served from the cache
without either fetcher running. `stat()` shares the same way, through
`oncePerKey`.

Where that is wrong, it cannot be fixed from inside: a `fetch` implementation is
a closure with no identity to key on. Open the file under one handle, or keep
the URLs distinct — a presigned URL already is. `CachedFilehandle` takes its key
as an argument for this reason, so a caller who needs the separation can state
it.
