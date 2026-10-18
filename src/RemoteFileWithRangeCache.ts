import { RemoteFile } from 'generic-filehandle2'

import {
  isNetworkRejection,
  networkFailureHint,
  statusHint,
  withResponseDeadline,
} from './errors.ts'
import { getCachedRange, probeSize, recordSize } from './extentCache.ts'
import {
  assertReadArgs,
  discardBody,
  holdBody,
  parseByteRange,
  parseContentRange,
  readBodyAtMost,
} from './util.ts'

import type { FetchedRange } from './extentCache.ts'
import type { FilehandleOptions } from 'generic-filehandle2'

/**
 * A `RemoteFile` whose reads go through a module-global cache of the byte
 * extents fetched so far.
 *
 * Two things follow from that, and they are the whole point of the class: a
 * read fetches only the bytes no earlier read has fetched or is fetching, as
 * one request per cluster of gaps, and a read that overlaps a request another
 * read has in flight awaits it rather than asking for the same bytes again.
 */
export class RemoteFileWithRangeCache extends RemoteFile {
  /**
   * Publish a size this handle learned other than by a range request.
   *
   * A subclass that overrides `stat` answers from somewhere the cache never
   * sees — a cloud provider's metadata endpoint, say — and so leaves the size
   * cache empty for its URL however many times it is called. That clamp is not
   * an optimization: @gmod/bam and @gmod/tabix compute their last read of a
   * file to include the whole final bgzf block, so it runs past EOF by
   * construction, and without a known size that tail asks for bytes past the
   * end and the server answers 416.
   */
  protected recordSize(size: number) {
    recordSize(this.url, size)
  }

  async stat() {
    // Bypasses the cache, where a cached extent would answer without the
    // Content-Range that carries the size
    const size = await probeSize(
      this.url,
      async () =>
        (await this.fetchRange(this.url, 0, 0, this.buildRequest({}))).total,
    )
    if (size === undefined) {
      // No Content-Range carrying a length came back. Throw rather than
      // silently returning size: 0 — that lie tends to cause downstream callers
      // to issue zero-byte reads or treat the file as empty. Callers that can
      // degrade gracefully should wrap stat() in try/catch.
      //
      // The request itself succeeded, so the usual cause is the CORS
      // misconfiguration that is invisible from the network tab: the header is
      // on the wire and the browser will not let the page read it. Name the
      // header to add — but name the other cause too, because a server sending
      // `bytes 0-0/*` has exposed the header correctly and simply declined to
      // give a total, and being told to expose a header it already exposes is
      // an afternoon lost.
      throw new Error(
        `Could not determine size of ${this.url} (the server answered, but no Content-Range carrying the length of the file came back with it: either the header was not readable, which cross-origin needs Access-Control-Expose-Headers: Content-Range to fix, or the server sent the "bytes 0-0/*" form and declined to say how long the file is)`,
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
    const res = await this.fetchWithDeadline(url, init, { start, end })
    const release = holdBody(url)
    try {
      return await this.readRange(res, url, start, end)
    } finally {
      release()
    }
  }

  /**
   * The bytes of a response, once its status and its claims check out, and the
   * file's total length if the response gave it.
   *
   * Three checks, for a server that supports ranges: the status is a 206, the
   * `Content-Range` is the range asked for (see {@link rangeProblem}), and the
   * body is the length the header declares — or, with no readable header, no
   * longer than the request. A body shorter than the request is the end of the
   * file. A 200
   * means the server ignored the Range header, and its body starts at byte 0
   * whatever offset was asked for, so it is refused with a hint rather than
   * sliced into bytes from the wrong position.
   */
  private async readRange(
    res: Response,
    url: string,
    start: number,
    end: number,
  ): Promise<FetchedRange> {
    if (res.status === 416) {
      // Range Not Satisfiable: requested range starts past end of file. RFC 9110
      // §15.5.17 has the server report the real length here, as `bytes * /12345`
      // (the unsatisfied-range form of Content-Range, §14.4), and that is the
      // one thing this response carries worth keeping. It is also the only way
      // stat() can answer for an empty file, every range of which is
      // unsatisfiable. Without it, the request's own start bounds the size.
      const total = parseContentRange(res.headers.get('content-range'))?.total
      discardBody(res)
      if (total !== undefined && start < total) {
        throw Object.assign(
          new Error(
            `HTTP 416 fetching ${url} bytes ${start}-${end}, which starts inside the ${total}-byte file the same response reports (the server refused a range it says exists, so an empty read here would pass for the end of the file; a caching proxy in front of the file is the usual cause)`,
          ),
          { status: 416 },
        )
      }
      return { bytes: new Uint8Array(0), total }
    }
    if (res.status !== 206) {
      const msg = `HTTP ${res.status} fetching ${url} bytes ${start}-${end}${statusHint(res.status)}`
      discardBody(res)
      throw Object.assign(new Error(msg), { status: res.status })
    }
    const range = parseContentRange(res.headers.get('content-range'))
    const problem = rangeProblem(url, start, end, range)
    if (problem !== undefined) {
      discardBody(res)
      throw new Error(problem)
    }
    // Read no more than the header declares, so a proxy streaming the whole
    // file behind an honest header costs the request rather than the file.
    const declared =
      range?.start === undefined || range.end === undefined
        ? undefined
        : range.end - range.start + 1
    const bytes = await readBodyAtMost(res, declared ?? end - start + 1)
    if (bytes === undefined) {
      throw new Error(
        declared === undefined
          ? `${url} sent more than the ${end - start + 1} bytes requested for bytes ${start}-${end} with no Content-Range to say what they are (the body cannot be placed, so it is not trusted; a server ignoring the Range header or a caching proxy in front of the file is the usual cause)`
          : `${url} sent more than the ${declared} bytes of the range ${range!.start}-${range!.end} it declared (the body runs past its own Content-Range, so neither the header nor the bytes can be trusted; a caching proxy in front of the file is the usual cause)`,
      )
    }
    if (declared !== undefined && bytes.byteLength !== declared) {
      throw new Error(
        `${url} sent ${bytes.byteLength} bytes for bytes ${range!.start}-${range!.end}, which is ${declared} bytes (the body is truncated; left alone this is indistinguishable from the file ending here and would be cached as such)`,
      )
    }
    return { bytes, total: range?.total, owned: true }
  }

  /**
   * `super.fetch` under a deadline on the server beginning to answer, with a
   * network-level rejection turned into something readable.
   *
   * Both HTTP paths come through here: a range read, and a whole-file
   * `readFile`, which sends no range header. The whole-file path matters more
   * than its share of the traffic suggests: an assembly's chrom.sizes,
   * chromAlias and cytoband files are read that way, and a hub that accepted
   * the connection and went silent left the caller with a spinner and no error.
   * The deadline is stood down once the headers arrive, so a large body may
   * take as long as it takes.
   *
   * Deliberately here rather than a layer up: this call is the shared one. The
   * cache coalesces every reader of these bytes onto it, so the deadline
   * belongs to the request and fails all of them together — one stalled reader
   * with a deadline of its own would strand the rest on a fetch nobody is
   * watching any more.
   */
  private async fetchWithDeadline(
    url: string,
    init: RequestInit | undefined,
    range?: { start: number; end: number },
  ) {
    const span = range && `bytes ${range.start}-${range.end}`
    const deadline = withResponseDeadline(
      init?.signal,
      seconds =>
        `No response from ${url}${span ? ` for ${span}` : ''} after ${seconds}s (the connection was open and the server sent nothing; a transfer already under way is not subject to this limit, so this is a stalled request rather than a slow one)`,
      url,
    )
    const request: RequestInit = { ...init, signal: deadline.signal }
    if (range) {
      // keep everything buildRequest put on the request and replace only the
      // range
      const headers = new Headers(init?.headers)
      headers.set('range', `bytes=${range.start}-${range.end}`)
      request.headers = headers
    }
    try {
      return await super.fetch(url, request)
    } catch (e) {
      throw describeFetchFailure(
        e,
        deadline,
        url,
        span ? `${url} ${span}` : url,
      )
    } finally {
      deadline.stop()
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
    return getCachedRange(
      url,
      start,
      length,
      init?.signal ?? undefined,
      (s, e, signal) => this.fetchRange(url, s, e, { ...init, signal }),
    )
  }

  /**
   * Bytes straight out of the cache, skipping the `Response` that
   * `RemoteFile.fetchBytes` would build and unwrap.
   */
  protected override async fetchBytes(
    length: number,
    position: number,
    opts: FilehandleOptions,
  ): Promise<Uint8Array<ArrayBuffer>> {
    assertReadArgs(this.url, length, position)
    return this.cachedRange(this.url, position, length, this.buildRequest(opts))
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
    if (typeof url !== 'string') {
      return super.fetch(url, init)
    }
    const range = parseByteRange(new Headers(init?.headers).get('range'))
    if (!range) {
      return this.fetchWithDeadline(url, init)
    }
    const length = range.end - range.start + 1
    assertReadArgs(url, length, range.start)
    const buffer = await this.cachedRange(url, range.start, length, init)
    return new Response(buffer, { status: 206 })
  }

  // counted like a range body, so a deadline elsewhere on this origin can tell
  // the browser's connections are busy
  protected override async readFileBody(
    ...args: Parameters<RemoteFile['readFileBody']>
  ) {
    const release = holdBody(this.url)
    try {
      return await super.readFileBody(...args)
    } finally {
      release()
    }
  }
}

/**
 * Why a 206's `Content-Range` cannot be the answer to a request for
 * `[start, end]`, or undefined when it can.
 *
 * A size a response states clamps every later read of the URL, so a wrong one
 * returns short reads with no error. Two headers would record one: a range that contradicts its own
 * total, and a range that stops short of the request while its total says the
 * file goes on, which a short body would otherwise turn into an early EOF.
 */
function rangeProblem(
  url: string,
  start: number,
  end: number,
  range: ReturnType<typeof parseContentRange>,
) {
  if (range?.start === undefined || range.end === undefined) {
    return undefined
  }
  const { total } = range
  if (range.end < range.start || (total !== undefined && range.end >= total)) {
    return `${url} answered Content-Range "bytes ${range.start}-${range.end}/${total ?? '*'}", which does not describe a range of a file that size (the header contradicts itself, so neither the bytes it labels nor the length it reports can be trusted; a caching proxy in front of the file is the usual cause)`
  }
  if (range.start !== start) {
    return `${url} answered bytes ${range.start}-${range.end} for a request for bytes starting at ${start} (the response does not describe the range that was asked for, so its bytes would land at the wrong offsets; a caching proxy in front of the file is the usual cause)`
  }
  if (total !== undefined && range.end < Math.min(end, total - 1)) {
    return `${url} served bytes ${range.start}-${range.end} of a request for bytes ${start}-${end} of a ${total}-byte file (the response stops short of both the end asked for and the end of the file, so the bytes past it would be taken for EOF; a proxy capping how much of a range it will serve is the usual cause)`
  }
  return undefined
}

/**
 * Turn a rejection with no response behind it into a message that says what to
 * check, keeping anything that already has a status.
 */
function describeFetchFailure(
  e: unknown,
  deadline: { expired?: Error; signal: AbortSignal },
  url: string,
  // what was being fetched, for the message: a byte range on the range path,
  // the file itself on the whole-file one
  what: string,
) {
  if (deadline.expired) {
    return deadline.expired
  } else if (isNetworkRejection(e) && !deadline.signal.aborted) {
    // `!aborted` because an implementation that reports a cancellation as a
    // TypeError rather than as the signal's reason would otherwise have a
    // cancelled pan explained as a CORS misconfiguration, which is the worst
    // place to be confidently wrong.
    return new Error(
      `Network error fetching ${what}${networkFailureHint(url)}`,
      { cause: e },
    )
  } else {
    return e
  }
}
