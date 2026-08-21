# Failing legibly

Nothing here is retried. A failed range read surfaces as an error and the reader
decides. What the layer owes in exchange is an error that says what happened,
because the default answers — a bare `TypeError`, or a status number with no
context — are what turn "this BAM does not load" into a support thread.

Three kinds of failure reach a caller.

## A status came back

The message carries the status, the URL and the byte range, which is already
more than `fetch` gives, plus a hint for the statuses where there is something
to do about it.

- **200** — the server ignored the Range header and sent the whole file. Some
  servers do this rather than clamping a range whose end runs past EOF. The body
  then starts at byte 0, but callers slice it at the offsets they asked for, so
  every chunk past the first would be filled with data from the wrong position —
  silently, surfacing much later as something like `invalid bgzf header`. It is
  tolerated only when the request started at 0, where the body genuinely covers
  the requested bytes, **and only when it is no longer than the range that was
  asked for**. That second half is about memory rather than offsets: reading a
  body allocates all of it, so a `stat()` of a 100 GB BAM on a server with no
  range support used to allocate 100 GB to learn one number, and every 256 KiB
  read allocated it again. Now the declared length is checked before the body is
  touched, and a server sending more than was asked for gets this message
  instead of the process dying of memory. A file that really is shorter than the
  request still passes, since the whole of it _is_ the range.

  The check needs the response to declare a length of its own bytes. A chunked
  200 declares none, and a `Content-Encoding` makes `Content-Length` the
  compressed count — the same distinction the `Content-Range` checks below draw
  — so both fall through to reading the body as before.

- **401 / 403** — the file is there and the request was refused. A signed URL
  may have expired, or a bucket policy may not grant read to the page origin.
- **404** — check the URL, and that the index sits where the reader expects it
  alongside the data file.
- **429 or 5xx** — the server is failing or declining just now, and since
  nothing retries automatically, trying again is the caller's move.
- **416** — not an error at all here. Range Not Satisfiable means the range
  starts past the end, and RFC 9110 has the server report the real length as
  `bytes */12345`. That size is the one thing the response carries worth
  keeping: it lets every later over-read be clamped instead of refused again,
  and it is the only way `stat()` can answer for an empty file, every range of
  which is unsatisfiable. The read returns empty.

## No status came back

A CORS denial, a mixed-content block, a DNS failure, a refused connection and an
offline browser all arrive as the same bare `TypeError` — `Failed to fetch` in
Chrome, `Load failed` in Safari,
`NetworkError when attempting to fetch resource` in Firefox — with no status, no
headers and no URL. The browser withholds the difference deliberately: an error
that named the cause would itself be a cross-origin read.

So the hint names the two that are checkable from inside the page, and then the
one that is left:

1. `navigator.onLine === false` — the browser reports no network connection. The
   comparison is against `false` rather than a falsy test because node has had a
   global `navigator` since 21 and it has no `onLine` at all, which made every
   node-side network failure report as "no network connection" and swallowed the
   triage below it.
2. An `http:` URL on an `https:` page — the browser blocked it before it left,
   and the file has to be served over https too.
3. Otherwise, most often CORS. The server must send
   `Access-Control-Allow-Origin`, and
   `Access-Control-Expose-Headers: Content-Range` as well or the size of the
   file cannot be read either. A host that is down, a DNS failure and a blocked
   port look identical from here, and the message says so.

Detecting this at all takes walking the `cause` chain rather than checking the
rejection's class: `RemoteFile.fetch` catches the `TypeError` first and rethrows
a plain `Error` wrapping it (and, on Chrome's exact "Failed to fetch" wording,
retries once through the cache to work around a Chrome CORS-cache bug). By the
time it gets here the class is gone and the chain is the only thing that still
says what it was. The walk is depth-bounded, since a cause chain is not
guaranteed acyclic.

One guard on top: the hint is suppressed when the deadline signal aborted, so an
implementation that reports a cancellation as a `TypeError` cannot have a
cancelled pan explained as a CORS misconfiguration — the worst place to be
confidently wrong.

## No answer came back

A connection that is open and silent for 30 seconds fails with a message saying
so, and saying that a transfer already under way is not subject to the limit, so
this is a stalled request rather than a slow one. [tuning.md](tuning.md) has why
the deadline covers the response rather than the transfer.

The deadline lives on the shared request rather than on each reader, because
`fetchRun` coalesces every reader of those chunks onto one fetch — one stalled
reader with a deadline of its own would strand the rest on a fetch nobody is
watching any more.

## The one that succeeds and still fails

`stat()` throws rather than returning `size: 0` when the request came back fine
but `Content-Range` was not readable. Returning zero is a lie that tends to make
downstream callers issue zero-byte reads or treat the file as empty, and the
failure then surfaces nowhere near its cause.

This is the one CORS misconfiguration invisible from the network tab: the header
is on the wire and the browser will not let the page read it. The message names
the header to add. A caller that can degrade gracefully should wrap `stat()` in
a `try`/`catch`.

## The one nothing here can check

A range response is checked against its `Content-Range`: the header has to
describe a real range of a file that size, it has to be the range that was asked
for, and the body has to be as long as it says and reach either the end asked
for or the end of the file. A body shorter than the range it claims is what that
last pair is for — nothing downstream can tell a truncated response from the end
of the file, since a short chunk _is_ how this package represents EOF.

**A `Content-Encoding` puts the length half of that out of reach.** The bytes on
the wire are then not the bytes of the range, so their count says nothing, and
the two length checks are skipped. The header checks still run — a response that
contradicts itself, or that describes some other range, is rejected however it
is encoded — but a proxy that truncates an encoded body has nothing left to
catch it, and a truncated body lands in the cache as a file that ends early.

Worth knowing rather than worth fixing: a server that compresses a byte range is
already unusual, and the reader has no way to distinguish the honest form (the
range's own bytes, compressed) from the broken one. If a file reads short from
one host and not another, compare `Content-Encoding` on the range responses.

## Not an error, but worth knowing

A `read()` with a `NaN` length or position throws a `TypeError` naming the file,
rather than becoming a `bytes=NaN-NaN` request. It arrives from a corrupt or
truncated index, and the message says so. The same guard covers a negative or
fractional offset, a length past what a `Uint8Array` can hold, and a `Range`
header handed to `fetch()` asking for any of those.
