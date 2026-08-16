import { RemoteFile } from 'generic-filehandle2'

import {
  getCachedRange,
  getSize,
  hasSize,
  limitConcurrency,
  recordSize,
  recordSizeFromContentRange,
  recordSizeFromWholeBody,
} from './chunkCache.ts'
import { RESPONSE_TIMEOUT_MS } from './constants.ts'
import {
  isNetworkRejection,
  networkFailureHint,
  statusHint,
  withResponseDeadline,
} from './errors.ts'
import { assertReadArgs, parseByteRange } from './util.ts'

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
      // and N readers opening at once used to issue N stats outside the cap.
      await limitConcurrency(() => this.fetchRange(this.url, 0, 0))
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
    let res: Response
    try {
      res = await super.fetch(url, {
        ...init,
        headers,
        signal: deadline.signal,
      })
    } catch (e) {
      if (deadline.expired) {
        throw deadline.expired
      } else if (isNetworkRejection(e) && !deadline.signal.aborted) {
        // `!aborted` because an implementation that reports a cancellation as a
        // TypeError rather than as the signal's reason would otherwise have a
        // cancelled pan explained as a CORS misconfiguration, which is the worst
        // place to be confidently wrong.
        throw new Error(
          `Network error fetching ${url} bytes ${start}-${end}${networkFailureHint(url)}`,
          { cause: e },
        )
      } else {
        throw e
      }
    } finally {
      // either the response is here or the request is over; from here the body
      // may take as long as it takes
      deadline.dispose()
    }
    if (res.status === 416) {
      // Range Not Satisfiable: requested range starts past end of file. RFC 9110
      // has the server report the real length here, as `bytes * /12345`, and
      // that is the one thing this response carries worth keeping: learning the
      // size lets getCachedRange clamp every later over-read instead of asking
      // for past-EOF chunks and being refused again. It is also the only way
      // stat() can answer for an empty file, every range of which is
      // unsatisfiable.
      recordSizeFromContentRange(url, res)
      return new Uint8Array(0)
    }
    // A 200 means the server ignored the Range header and sent the whole file
    // (some servers do this rather than clamping a range whose end is past EOF).
    // The body then starts at byte 0, but callers slice it at the offsets they
    // asked for, so every chunk past the first would be filled with data from the
    // wrong position — silently, and typically surfacing much later as a parse
    // error like "invalid bgzf header". Only tolerate it when the request started
    // at 0, where the body genuinely covers the requested bytes. This mirrors
    // generic-filehandle2's RemoteFile.read, whose equivalent check this class
    // bypasses by synthesizing its own 206 Response in fetch() below.
    if (!res.ok || (res.status !== 206 && start !== 0)) {
      const msg = `HTTP ${res.status} fetching ${url} bytes ${start}-${end}${statusHint(res.status)}`
      throw Object.assign(new Error(msg), { status: res.status })
    }
    const buffer = new Uint8Array(await res.arrayBuffer())
    // The first successful range fetch populates the size cache, so a later
    // stat() needs no HEAD of its own.
    if (res.status === 200) {
      // no Content-Range on a 200, but the body is the entire file
      recordSizeFromWholeBody(url, buffer.byteLength)
    } else {
      recordSizeFromContentRange(url, res)
    }
    return buffer
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
