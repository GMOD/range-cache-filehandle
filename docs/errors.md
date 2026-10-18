# Errors

The cache retries nothing and hands a failed range read to the reader as an
error, so the error has to report what happened for the reader to decide what to
do. The default errors, a bare `TypeError` or a status number with no context,
turn "this BAM does not load" into a support thread.

## A status came back

The message contains the status, the URL and the byte range, which is already
more than `fetch` gives, plus a hint for the statuses where there is something
to do about it.

- **200** — the server ignored the Range header and sent the whole file. The
  body then starts at byte 0, while callers slice it at the offsets they asked
  for, so every byte would come from the wrong position, with no error until
  something like `invalid bgzf header` shows up much later. The cache needs a
  server that supports ranges, so it refuses any 200 to a range request,
  including the `stat()` probe, before reading a byte of the body.

- **401 / 403** — the file is there and the request was refused. A signed URL
  may have expired, or a bucket policy may not grant read to the page origin.
- **404** — check the URL, and that the index sits where the reader expects it
  alongside the data file.
- **429 or 5xx** — the server is failing or declining just now, and since
  nothing retries automatically, the caller decides whether to try again.
- **416** — usually not an error here. Range Not Satisfiable means the range
  starts past the end, and RFC 9110 has the server report the real length as
  `bytes */12345`. The read returns empty, and the cache keeps that size, the
  only useful content of the response. The size lets the cache clamp every later
  over-read instead of having it refused again, and it is the only way `stat()`
  can answer for an empty file, every range of which is unsatisfiable. A 416
  with no readable length still bounds the file at the start of the range. A 416
  whose reported length puts the range _inside_ the file contradicts itself, so
  the read fails: an empty read would pass for the end of the file.

## No status came back

A CORS denial, a mixed-content block, a DNS failure, a refused connection and an
offline browser all reject with the same bare `TypeError` — `Failed to fetch` in
Chrome, `Load failed` in Safari,
`NetworkError when attempting to fetch resource` in Firefox — with no status, no
headers and no URL. The browser hides the cause deliberately, because an error
that named the cause would itself be a cross-origin read.

The hint names the two that are checkable from inside the page, and then the one
that is left:

1. `navigator.onLine === false` — the browser reports no network connection. The
   comparison is against `false` rather than a falsy test because node has had a
   global `navigator` since version 21 with no `onLine` property, so a falsy
   test reported every node-side network failure as "no network connection" and
   skipped the checks below it.
2. An `http:` URL on an `https:` page — the browser blocked the request before
   sending it, and the file has to be served over https too.
3. Anything else — most often CORS, where the server must send
   `Access-Control-Allow-Origin`, and
   `Access-Control-Expose-Headers: Content-Range` as well or the size of the
   file cannot be read either. A host that is down, a DNS failure and a blocked
   port look identical from inside the page, so the message does not pick one.

The code detects a network failure by walking the `cause` chain rather than by
checking the rejection's class, because `RemoteFile.fetch` catches the
`TypeError` first and rethrows a plain `Error` wrapping it (and, on Chrome's
exact "Failed to fetch" wording, retries once through the cache to work around a
Chrome CORS-cache bug). By the time the error reaches this code its class is
`Error`, and only the chain still holds the original `TypeError`. The walk is
depth-bounded, since a cause chain is not guaranteed acyclic.

The code also suppresses the hint when the deadline signal aborted. An
implementation may report a cancellation as a `TypeError`, and without that
check the message would explain a cancelled pan as a CORS misconfiguration.

## No answer came back

A connection that is open and silent for 30 seconds fails with a message saying
so, and saying that a transfer already under way is not subject to the limit, so
this is a stalled request rather than a slow one. [tuning.md](tuning.md)
explains why the deadline covers the response rather than the transfer.

On the range path the deadline belongs to the shared request rather than to each
reader, because `dispatch` coalesces every reader of those bytes onto one fetch.
If one reader with its own deadline gave up on a stalled fetch, the other
readers would be left waiting on it with no deadline at all. A whole-file read
has one reader, so it has its own deadline.

The message names the range on the range path and the file on the whole-file
one, which is also how you can tell which of the two you are looking at.

The seconds in the message are the whole wait. A request the browser held in its
per-host queue behind six streaming bodies waits longer than 30 seconds before
it is reported; [tuning.md](tuning.md#requests-the-browser-has-queued) has the
rule.

## The one that succeeds and still fails

`stat()` throws rather than returning `size: 0` when the request succeeded but
its response had no `Content-Range` with a length. A size of zero would
misrepresent the failure, because downstream callers tend to issue zero-byte
reads or treat the file as empty, and the failure then appears nowhere near its
cause.

The usual cause is a CORS misconfiguration that the network tab does not show,
because the header is on the wire but the browser will not let the page read it.
The message names the header to add, and also names the other cause, a server
answering `bytes 0-0/*` that has exposed the header and declined to give a
total. A caller that can degrade gracefully should wrap `stat()` in a
`try`/`catch`.

## Checking a range response

A file's size only ever shrinks, so a wrong bound would hold for the URL until
`clearCacheFor`. The cache checks every 206 before it learns anything from it:

- The `Content-Range` describes a real range of a file that size, starting where
  the request did.
- The range reaches either the end asked for or the end of the file. A proxy
  capping how much of a range it serves would otherwise pass for an early EOF.
- The body is as long as the header declares, or, with no readable header, no
  longer than the request. A body shorter than its request is the end of the
  file, so a truncated one would otherwise be cached as one.

The length check also caps memory, because the cache reads a body only as far as
the header declared, or as far as the request with no header. If a proxy answers
with an honest `Content-Range` and then streams the whole file, the cache stops
at that ceiling rather than allocating the whole body and rejecting it
afterwards.

A `Content-Encoding` gets no exemption. The bytes of a range of an encoded
representation are not bytes of the file, so such a response usually fails the
length check, and would be wrong if it passed.

## Invalid offsets and lengths

A `read()` with a `NaN` length or position throws a `TypeError` naming the file,
rather than becoming a `bytes=NaN-NaN` request. A `NaN` comes from a corrupt or
truncated index, and the message names the cause. The same guard covers a
negative or fractional offset, and a `Range` header handed to `fetch()` asking
for either.
