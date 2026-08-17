import { RemoteFile } from 'generic-filehandle2'

import {
  getCachedRange,
  getSize,
  hasSize,
  limitConcurrency,
  oncePerKey,
  recordSize,
  recordSizeIfUnknown,
} from './chunkCache.ts'
import { RESPONSE_TIMEOUT_MS } from './constants.ts'
import {
  isNetworkRejection,
  networkFailureHint,
  statusHint,
  withResponseDeadline,
} from './errors.ts'
import { assertReadArgs, parseByteRange, parseContentRange } from './util.ts'

import type { FilehandleOptions } from 'generic-filehandle2'

/**
 * A `RemoteFile` whose reads go through a module-global chunk cache.
 *
 * Two things follow from that, and they are the whole point of the class:
 * contiguous chunks a read is missing become **one** range request rather than
 * one per read, and a chunk another read already has in flight is awaited rather
 * than requested again.
 */
export class RemoteFileWithRangeCache extends RemoteFile {
  /**
   * Publish a size this handle learned other than by a range request.
   *
   * A subclass that overrides `stat` answers from somewhere the chunk cache
   * never sees — a cloud provider's metadata endpoint, say — and so leaves the
   * size cache empty for its URL however many times it is called. That clamp is
   * not an optimization: @gmod/bam and @gmod/tabix compute their last read of a
   * file to include the whole final bgzf block, so it runs past EOF by
   * construction, and without a known size that tail asks for chunks starting
   * past the end and the server answers 416.
   */
  protected recordSize(size: number) {
    recordSize(this.url, size)
  }

  async stat() {
    if (!hasSize(this.url)) {
      // Bypass the chunk cache: a populated chunk would otherwise short-circuit
      // fetchRange, leaving the size cache empty. fetchRange always observes
      // Content-Range and updates it directly. Still goes through
      // limitConcurrency — a stat is a real request against the same server,
      // and N readers opening at once used to issue N stats outside the cap —
      // and through oncePerKey, so those N readers share one request rather
      // than making N of them for one number.
      await oncePerKey(this.url, () =>
        limitConcurrency(this.url, () => this.fetchRange(this.url, 0, 0)),
      )
    }
    const size = getSize(this.url)
    if (size === undefined) {
      // Content-Range header wasn't observable (commonly CORS hiding it).
      // Throw rather than silently returning size: 0 — that lie tends to cause
      // downstream callers to issue zero-byte reads or treat the file as empty.
      // Callers that can degrade gracefully should wrap stat() in try/catch.
      //
      // The request itself succeeded, so this is the one CORS misconfiguration
      // that is invisible from the network tab: the header is on the wire and
      // the browser will not let the page read it. Name the header to add.
      throw new Error(
        `Could not determine size of ${this.url} (the server answered but the Content-Range header was not readable; a cross-origin server has to send Access-Control-Expose-Headers: Content-Range before the browser will show it to the page)`,
      )
    } else {
      return { size }
    }
  }

  private async fetchRange(
    url: string,
    start: number,
    end: number,
    init?: RequestInit,
  ) {
    const { res, deadline } = await this.fetchWithDeadline(
      url,
      start,
      end,
      init,
    )
    try {
      return await this.readRange(res, url, start, end)
    } finally {
      // only now: until the body is read, this is what carries a caller's
      // cancellation down to the socket
      deadline.dispose()
    }
  }

  /** the bytes of a response, once its status and its claims check out */
  private async readRange(
    res: Response,
    url: string,
    start: number,
    end: number,
  ) {
    if (res.status === 416) {
      // Range Not Satisfiable: requested range starts past end of file. RFC 9110
      // §15.5.17 has the server report the real length here, as `bytes * /12345`
      // (the unsatisfied-range form of Content-Range, §14.4), and
      // that is the one thing this response carries worth keeping: learning the
      // size lets getCachedRange clamp every later over-read instead of asking
      // for past-EOF chunks and being refused again. It is also the only way
      // stat() can answer for an empty file, every range of which is
      // unsatisfiable.
      //
      // The empty result is only cached as an EOF marker if the size it carried
      // confirms the range really was past the end; see isKnownPastEof. A 416
      // that explains nothing is answered, but not remembered.
      recordSizeIfUnknown(
        url,
        parseContentRange(res.headers.get('content-range'))?.total,
      )
      return new Uint8Array(0)
    }
    assertServedTheRange(res, url, start, end)
    const buffer = new Uint8Array(await res.arrayBuffer())
    // The first successful range fetch populates the size cache, so a later
    // stat() needs no HEAD of its own.
    if (res.status === 200) {
      // no Content-Range on a 200, but the body is the entire file
      recordSizeIfUnknown(url, buffer.byteLength)
    } else {
      const range = parseContentRange(res.headers.get('content-range'))
      recordSizeIfUnknown(url, range?.total)
      assertBodyMatchesRange(res, url, start, buffer, range)
    }
    return buffer
  }

  /**
   * `super.fetch` for one byte range, under a deadline on the server beginning
   * to answer, with a network-level rejection turned into something readable.
   */
  private async fetchWithDeadline(
    url: string,
    start: number,
    end: number,
    init: RequestInit | undefined,
  ) {
    // Preserve everything the caller put on the request — auth headers,
    // credentials, the abort signal, RemoteFile.read's buildRequest overrides —
    // and replace only the range.
    const headers = new Headers(init?.headers)
    headers.set('range', `bytes=${start}-${end}`)
    // Deliberately here rather than a layer up: this call is the shared one.
    // fetchRun coalesces every reader of these chunks onto it, so the deadline
    // belongs to the request and fails all of them together — one stalled
    // reader with a deadline of its own would strand the rest on a fetch nobody
    // is watching any more.
    const deadline = withResponseDeadline(
      init?.signal,
      () =>
        `No response from ${url} for bytes ${start}-${end} after ${RESPONSE_TIMEOUT_MS / 1000}s (the connection was open and the server sent nothing; a transfer already under way is not subject to this limit, so this is a stalled request rather than a slow one)`,
    )
    try {
      const res = await super.fetch(url, {
        ...init,
        headers,
        signal: deadline.signal,
      })
      // the response is here; from here the body may take as long as it takes
      deadline.responded()
      // Deliberately not disposed here. The deadline stays linked to the
      // caller's signal until the body has been read, because that link is what
      // carries a cancellation down to the socket; `fetchRange` disposes it.
      return { res, deadline }
    } catch (e) {
      deadline.dispose()
      throw describeFetchFailure(e, deadline, url, start, end)
    }
  }

  // named apart from the module-level getCachedRange it calls, which is the one
  // doing the work; this only binds it to this instance's fetch
  private cachedRange(
    url: string,
    start: number,
    length: number,
    init?: RequestInit,
  ) {
    return getCachedRange(url, start, length, init, (s, e, runInit) =>
      this.fetchRange(url, s, e, runInit),
    )
  }

  /**
   * Bytes for a byte range, straight out of the chunk cache.
   *
   * `RemoteFile.read` would build the range header, call {@link fetch}, and
   * unwrap the `Response` it got back. Every one of those steps is a copy of
   * the whole range, and on a cache hit there is no network for them to hide
   * behind: measured warm, with the chunk cache fully populated, the
   * `Response` round trip was **69-77%** of the read (6.15ms vs 1.90ms at
   * 16MB, 0.36ms vs 0.08ms at 256KB).
   *
   * `fetch` below still caches, so anything that reaches this class by that
   * route — a caller setting its own range header — is unaffected. This is
   * the same cache, entered one layer lower.
   */
  override async read(
    length: number,
    position: number,
    opts: FilehandleOptions = {},
  ): Promise<Uint8Array<ArrayBuffer>> {
    // mirrors RemoteFile.read's guards, which we no longer go through
    if (length === 0) {
      return new Uint8Array(0)
    }
    assertReadArgs(this.url, length, position)
    return this.cachedRange(this.url, position, length, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      headers: opts.headers,
      ...opts.overrides,
    })
  }

  // NOTE: range reads return a fully-assembled in-memory Response, so
  // generic-filehandle2's streaming `onProgress` (toBytesWithProgress) sees the
  // whole buffer at once and reports 0→100 instantly — per-byte download
  // progress does not flow through this layer. That's intentional: the indexed
  // parsers (@gmod/bam, cram, tabix, bbi) self-report at block granularity from
  // their index metadata, which is the meaningful unit and also reflects cache
  // hits. Only whole-file readFile (no range header → super.fetch below) streams
  // for real. Don't try to "restore" streaming progress here expecting it to
  // surface in a loading UI.
  public async fetch(
    url: string | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> {
    // Only a string URL is cacheable: a Request object has no stable cache key
    // (String(request) is "[object Request]", which every Request shares) and
    // carries headers the range path would drop.
    if (typeof url === 'string') {
      const range = parseByteRange(new Headers(init?.headers).get('range'))
      if (range) {
        const buffer = await this.cachedRange(
          url,
          range.start,
          range.end - range.start + 1,
          init,
        )
        return new Response(buffer, { status: 206 })
      }
    }
    return super.fetch(url, init)
  }
}

/**
 * Turn a rejection with no response behind it into a message that says what to
 * check, keeping anything that already has a status.
 */
function describeFetchFailure(
  e: unknown,
  deadline: { expired?: Error; signal: AbortSignal },
  url: string,
  start: number,
  end: number,
) {
  if (deadline.expired) {
    return deadline.expired
  } else if (isNetworkRejection(e) && !deadline.signal.aborted) {
    // `!aborted` because an implementation that reports a cancellation as a
    // TypeError rather than as the signal's reason would otherwise have a
    // cancelled pan explained as a CORS misconfiguration, which is the worst
    // place to be confidently wrong.
    return new Error(
      `Network error fetching ${url} bytes ${start}-${end}${networkFailureHint(url)}`,
      { cause: e },
    )
  } else {
    return e
  }
}

/**
 * Reject a status that cannot be read as the range that was asked for.
 *
 * A 200 means the server ignored the Range header and sent the whole file (some
 * servers do this rather than clamping a range whose end is past EOF). The body
 * then starts at byte 0, but callers slice it at the offsets they asked for, so
 * every chunk past the first would be filled with data from the wrong position —
 * silently, and typically surfacing much later as a parse error like "invalid
 * bgzf header". Only tolerate it when the request started at 0, where the body
 * genuinely covers the requested bytes. This mirrors generic-filehandle2's
 * RemoteFile.read, whose equivalent check this class bypasses by synthesizing
 * its own 206 Response in fetch().
 */
function assertServedTheRange(
  res: Response,
  url: string,
  start: number,
  end: number,
) {
  if (!res.ok || (res.status !== 206 && start !== 0)) {
    const msg = `HTTP ${res.status} fetching ${url} bytes ${start}-${end}${statusHint(res.status)}`
    throw Object.assign(new Error(msg), { status: res.status })
  }
}

/**
 * Reject a 206 whose body is not the bytes it claims to be.
 *
 * Nothing downstream can tell a short response from the end of the file: a chunk
 * shorter than CHUNK_SIZE *is* how EOF is represented, so a proxy that truncates
 * a body, or a cache that answers with some other range it had lying around,
 * lands in the chunk cache as a file that ends early. Measured with a proxy
 * cutting each body to 1000 bytes, a read at offset 5000 of a 2 MB file returned
 * zero bytes and issued no request — and kept doing so for the whole idle
 * window, for every handle sharing the URL.
 *
 * So the two things the server told us are checked against what it sent: the
 * offset the body starts at, and how long it is. A single-part 206 carries
 * exactly one range and describes it in `Content-Range`, so those two agreeing
 * is the guarantee the format offers.
 * @see https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.7 (206)
 * @see https://www.rfc-editor.org/rfc/rfc9110.html#section-14.4 (Content-Range)
 *
 * Skipped when there is no `Content-Range` to check against, and when a
 * `Content-Encoding` means the body on the wire is not the bytes of the range.
 */
function assertBodyMatchesRange(
  res: Response,
  url: string,
  start: number,
  buffer: Uint8Array,
  range: ReturnType<typeof parseContentRange>,
) {
  if (
    range?.start === undefined ||
    range.end === undefined ||
    res.headers.get('content-encoding')
  ) {
    return
  }
  if (range.start !== start) {
    throw new Error(
      `${url} answered bytes ${range.start}-${range.end} for a request for bytes starting at ${start} (the response does not describe the range that was asked for, so its bytes would land at the wrong offsets; a caching proxy in front of the file is the usual cause)`,
    )
  }
  const expected = range.end - range.start + 1
  if (buffer.byteLength !== expected) {
    throw new Error(
      `${url} sent ${buffer.byteLength} bytes for bytes ${range.start}-${range.end}, which is ${expected} bytes (the body is truncated; left alone this is indistinguishable from the file ending here and would be cached as such)`,
    )
  }
}
