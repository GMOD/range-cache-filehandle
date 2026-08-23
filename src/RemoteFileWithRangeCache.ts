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
import { CHUNK_SIZE, RESPONSE_TIMEOUT_MS } from './constants.ts'
import {
  isNetworkRejection,
  networkFailureHint,
  statusHint,
  withResponseDeadline,
} from './errors.ts'
import {
  assertReadArgs,
  discardBody,
  parseByteRange,
  parseContentRange,
  readBodyAtMost,
} from './util.ts'

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
   * The options this handle was constructed with.
   *
   * Kept rather than reached for, because `RemoteFile` holds them privately and
   * exposes them only through its own private `buildRequest`. `read` below
   * deliberately does not go through that method, so without this copy the
   * constructor's `headers`, `overrides` and `signal` reach nothing at all — see
   * {@link buildReadRequest}.
   *
   * An explicit field rather than a constructor parameter property, which node's
   * type stripper cannot erase; `erasableSyntaxOnly` bans them.
   */
  private baseOpts: FilehandleOptions

  constructor(source: string, opts: FilehandleOptions = {}) {
    super(source, opts)
    this.baseOpts = opts
  }

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
      discardBody(res)
      return new Uint8Array(0)
    }
    assertServedTheRange(res, url, start, end)
    // The first successful range fetch populates the size cache, so a later
    // stat() needs no HEAD of its own.
    if (res.status === 200) {
      // no Content-Range on a 200, but the body is the entire file
      const buffer = await readWholeFile(res, url, start, end)
      recordSizeIfUnknown(url, buffer.byteLength)
      return buffer
    } else {
      const range = parseContentRange(res.headers.get('content-range'))
      const buffer = await readDeclaredRange(res, url, range)
      // Validate before recording. A response this rejects has still told us a
      // `total`, and recordSizeIfUnknown never overwrites, so recording first
      // lets a proxy with a wrong Content-Range fix the size of the file at
      // whatever it claimed — every later read clamped to it and stat()
      // answering with it, for the life of the process.
      assertBodyMatchesRange(res, url, start, end, buffer, range)
      recordSizeIfUnknown(url, range?.total)
      return buffer
    }
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
      throw describeFetchFailure(
        e,
        deadline,
        url,
        `${url} bytes ${start}-${end}`,
      )
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
    // mirrors RemoteFile.read's guards, which we no longer go through. Ahead of
    // the zero-length short-circuit, or `read(0, -1)` is accepted quietly while
    // `read(1, -1)` throws
    assertReadArgs(this.url, length, position)
    if (length === 0) {
      return new Uint8Array(0)
    }
    return this.cachedRange(
      this.url,
      position,
      length,
      this.buildReadRequest(opts),
    )
  }

  /**
   * The request `RemoteFile.buildRequest` would have built for this read.
   *
   * Repeated here rather than called, because that method is private to the base
   * class and the range path does not reach it: `fetchWithDeadline` ends at
   * `RemoteFile.fetch`, which hands an init straight to the fetch implementation
   * rather than building one. Left to the per-call options alone, a handle
   * constructed with an `authorization` header sent **every range request
   * unauthenticated** — measured — and a constructor `signal` cancelled nothing.
   *
   * Same merge order as the base class, and the order is the contract:
   * `overrides` beats the method/redirect/mode defaults so a caller can set
   * them, per-call options beat the constructor's, and the signal is applied
   * last so `opts.signal` beats one supplied through `overrides`.
   */
  private buildReadRequest(opts: FilehandleOptions): RequestInit {
    const signal = opts.signal ?? this.baseOpts.signal
    return {
      method: 'GET',
      redirect: 'follow',
      mode: 'cors',
      ...this.baseOpts.overrides,
      ...opts.overrides,
      headers: { ...this.baseOpts.headers, ...opts.headers },
      ...(signal ? { signal } : {}),
    }
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
        const length = range.end - range.start + 1
        // The same guard `read` applies, for the same reason one layer down.
        // `parseByteRange` accepts any pair of digits, and the chunk machinery
        // walks one iteration, promise and in-flight entry per CHUNK_SIZE of
        // the length before its first await: measured, `bytes=0-99999999999999`
        // spent 112 seconds in `planRead` and then took the process out with a
        // heap OOM rather than ever reaching the network.
        assertReadArgs(url, length, range.start)
        const buffer = await this.cachedRange(url, range.start, length, init)
        return new Response(buffer, { status: 206 })
      }
    }
    return typeof url === 'string'
      ? this.fetchWholeFile(url, init)
      : super.fetch(url, init)
  }

  /**
   * `super.fetch` for a whole-file read, under the same response deadline the
   * range path uses.
   *
   * It reaches here from `RemoteFile.readFile`, which sends no range header, so
   * before this it was the one HTTP path in the class with no clock on it at
   * all — and the one where waiting forever is most visible, because a
   * whole-file read is what an assembly's chrom.sizes, chromAlias and cytoband
   * files are. A hub that accepted the connection and went silent left the
   * caller with a spinner and no error, indefinitely.
   *
   * The deadline is safe here for exactly the reason it is safe there: it bounds
   * the wait for the response, and is stood down the moment the headers arrive.
   * A whole-file body is routinely large and may take as long as it takes.
   *
   * Not disposed on success, deliberately, and for the same reason
   * {@link fetchWithDeadline} does not: the link to the caller's signal is what
   * carries a cancellation to the socket while the body streams, and the body
   * belongs to whoever we hand the response to. `responded` has already stopped
   * the clock, so nothing is left to fire.
   */
  private async fetchWholeFile(url: string, init: RequestInit | undefined) {
    const deadline = withResponseDeadline(
      init?.signal,
      () =>
        `No response from ${url} after ${RESPONSE_TIMEOUT_MS / 1000}s (the connection was open and the server sent nothing; a transfer already under way is not subject to this limit, so this is a stalled request rather than a slow one)`,
    )
    try {
      const res = await super.fetch(url, { ...init, signal: deadline.signal })
      deadline.responded()
      return res
    } catch (e) {
      deadline.dispose()
      throw describeFetchFailure(e, deadline, url, url)
    }
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
    discardBody(res)
    throw Object.assign(new Error(msg), { status: res.status })
  }
}

/**
 * The whole file, from a server that ignored the Range header — but only as
 * much of it as the range asked for.
 *
 * A 200 to a range request means there is no range support here, and
 * {@link assertServedTheRange} already refuses that anywhere but at offset 0,
 * where the body does at least begin with the bytes that were wanted. What it
 * cannot refuse is the *size* of what is coming, and that is the half that
 * hurts: reading a body allocates all of it, so `stat()` of a 100 GB BAM on
 * such a server allocated 100 GB to learn one number, and every 256 KiB read of
 * it allocated 100 GB again. Both died of memory or hung, with nothing said —
 * on the one misconfiguration this package can name exactly, and already has a
 * hint written for.
 *
 * So the body is read under a ceiling and the request fails the moment it goes
 * past. Under the ceiling it is served: a file shorter than the range asked for
 * is the honest case the offset-0 tolerance exists for — the whole of it *is*
 * the range — and its length is the length of the file, which is how a `stat()`
 * of a small file on a range-ignoring server still answers.
 *
 * The ceiling is at least {@link CHUNK_SIZE} because the size probe asks for a
 * single byte. Left at the range asked for, the smallest request there is would
 * refuse every file bigger than one byte, and a small file on a server with no
 * range support — which this package can serve perfectly well, one chunk at a
 * time — would stop working.
 *
 * Nothing here reads `Content-Length`. It counts the bytes on the wire, so a
 * `Content-Encoding` makes it the compressed count, and `Content-Encoding` is
 * the header a browser withholds cross-origin while showing `Content-Length` —
 * so trusting it recorded a gzipped file's compressed size as the size of the
 * file, and reads past that point were then clamped to nothing and returned
 * empty rather than failing. Only the bytes know how many there are.
 */
async function readWholeFile(
  res: Response,
  url: string,
  start: number,
  end: number,
) {
  const buffer = await readBodyAtMost(
    res,
    Math.max(end - start + 1, CHUNK_SIZE),
  )
  if (buffer === undefined) {
    throw Object.assign(
      new Error(
        `HTTP 200 fetching ${url} bytes ${start}-${end}${statusHint(200)}`,
      ),
      { status: 200 },
    )
  }
  return buffer
}

/**
 * The bytes of a 206, holding no more of them than it said it was sending.
 *
 * `assertBodyMatchesRange` below has always compared the body against the range
 * the header declared, but it could only do that once the body was already in
 * memory — so a proxy answering a 256 KiB request with an honest
 * `bytes 0-262143/...` and then streaming the whole file allocated the whole
 * file and *then* reported the mismatch. Measured: 8 MB held for a 262144-byte
 * request. Same rule, applied a step earlier, where it costs the ceiling rather
 * than the file.
 *
 * Only where the header says how long the range is and the body is those bytes
 * — the same two conditions the length check downstream is already gated on. A
 * `Content-Range` hidden by CORS leaves nothing to bound against, and under a
 * `Content-Encoding` the bytes on the wire are not the bytes of the range, so
 * neither is checkable and both read as before.
 */
async function readDeclaredRange(
  res: Response,
  url: string,
  range: ReturnType<typeof parseContentRange>,
) {
  if (
    range?.start === undefined ||
    range.end === undefined ||
    range.end < range.start ||
    res.headers.get('content-encoding')
  ) {
    return new Uint8Array(await res.arrayBuffer())
  }
  const declared = range.end - range.start + 1
  const buffer = await readBodyAtMost(res, declared)
  if (buffer === undefined) {
    throw new Error(
      `${url} sent more than the ${declared} bytes of the range ${range.start}-${range.end} it declared (the body runs past its own Content-Range, so neither the header nor the bytes can be trusted; a caching proxy in front of the file is the usual cause)`,
    )
  }
  return buffer
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
 * Four things are checked, in two groups, and which group a check belongs to is
 * decided by whether it reads the body.
 *
 * The first two read only the header. The range has to describe itself
 * coherently — ending at or after where it starts, and before the end of the
 * file it reports — and it has to start where the request did.
 *
 * The second two compare the body against that header: it has to be as long as
 * the range says — a body *longer* than that never reaches here, having been
 * stopped at the ceiling by {@link readDeclaredRange} — and the range has to
 * reach either the end that was asked for or the end of the file. Without the last, a proxy that caps how much of a
 * range it will serve answers a 6 MB request with an accurate
 * `bytes 0-1048575/8388608` and a matching 1 MB body: honest about itself,
 * silently short against the request, and indistinguishable from EOF by the
 * time it reaches the chunk cache.
 * @see https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.7 (206)
 * @see https://www.rfc-editor.org/rfc/rfc9110.html#section-14.4 (Content-Range)
 *
 * A range *longer* than the one asked for passes: the extra bytes are sliced
 * off, and a server aligning to its own block size is doing nothing harmful.
 *
 * Skipped entirely when there is no `Content-Range` to check against. A
 * `Content-Encoding` skips only the second group, because the body on the wire
 * is then not the bytes of the range and its length says nothing — but the
 * header still has to be coherent and still has to be the range that was asked
 * for, and skipping those along with it let one added header take a truncated
 * body all the way into the cache as an early EOF.
 */
function assertBodyMatchesRange(
  res: Response,
  url: string,
  start: number,
  end: number,
  buffer: Uint8Array,
  range: ReturnType<typeof parseContentRange>,
) {
  if (range?.start === undefined || range.end === undefined) {
    return
  }
  // A range that ends before it begins, or at or past the length it reports,
  // is not a range. Left alone the arithmetic below launders it into a
  // nonsense message, and `recordSizeIfUnknown` takes the total it carried:
  // measured, a 206 answering `bytes 0-262143/100` fixed the file at 100 bytes
  // for every handle on the URL, so a read at offset 200 returned nothing and
  // stat() reported 100.
  if (
    range.end < range.start ||
    (range.total !== undefined && range.end >= range.total)
  ) {
    throw new Error(
      `${url} answered Content-Range "bytes ${range.start}-${range.end}/${range.total ?? '*'}", which does not describe a range of a file that size (the header contradicts itself, so neither the bytes it labels nor the length it reports can be trusted; a caching proxy in front of the file is the usual cause)`,
    )
  }
  if (range.start !== start) {
    throw new Error(
      `${url} answered bytes ${range.start}-${range.end} for a request for bytes starting at ${start} (the response does not describe the range that was asked for, so its bytes would land at the wrong offsets; a caching proxy in front of the file is the usual cause)`,
    )
  }
  if (res.headers.get('content-encoding')) {
    return
  }
  const expected = range.end - range.start + 1
  if (buffer.byteLength !== expected) {
    throw new Error(
      `${url} sent ${buffer.byteLength} bytes for bytes ${range.start}-${range.end}, which is ${expected} bytes (the body is truncated; left alone this is indistinguishable from the file ending here and would be cached as such)`,
    )
  }
  // only against a known total: with `bytes 0-255/*` there is no EOF to compare
  // a short range against, so there is nothing here to be sure about
  if (range.total !== undefined && range.end < Math.min(end, range.total - 1)) {
    throw new Error(
      `${url} served bytes ${range.start}-${range.end} of a request for bytes ${start}-${end} of a ${range.total}-byte file (the response stops short of both the end asked for and the end of the file, so the bytes past it would be cached as EOF; a proxy capping how much of a range it will serve is the usual cause)`,
    )
  }
}
