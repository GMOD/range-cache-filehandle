import { CHUNK_SIZE } from './constants.ts'

/**
 * `unref` a timer where that exists.
 *
 * Duck-typed rather than cast because `setInterval` returns a number in the
 * browser and a `Timeout` under node, and this module runs in both. In a test
 * runner it is the difference between the suite exiting and a worker process
 * that never does.
 */
export function unrefIfPossible(timer: unknown) {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  ) {
    timer.unref()
  }
}

/**
 * Parse a `Content-Range: bytes 0-255/12345` response header.
 *
 * `total` is undefined for the `bytes 0-255/*` form, in which the server
 * declines to say how long the file is, and `start`/`end` are undefined for the
 * `bytes * /12345` form a 416 carries.
 *
 * Two passes, because validating the range and learning the size want opposite
 * things from a header that does not conform. The strict pass is what
 * `start`/`end` come from: a response is only checked against a `Content-Range`
 * we fully understand, and anything else is left unvalidated rather than called
 * wrong. The size, though, is worth recovering from a header that is merely
 * malformed — `bytes=0-255/12345` with an `=` for the space is a real server
 * bug, and `Headers.get` joins a duplicated header into
 * `bytes 0-255/12345, bytes 0-255/12345` — so the loose pass takes a trailing
 * `/<digits>` and reports only the total. Without it those responses lose the
 * size, and `stat()` reports the loss as a CORS misconfiguration, which sends
 * the reader to a header that arrived and was simply not parsed.
 */
export function parseContentRange(header: string | null) {
  if (!header) {
    return undefined
  }
  const trimmed = header.trim()
  const match = /^bytes (?:(\d+)-(\d+)|\*)\/(?:(\d+)|\*)$/.exec(trimmed)
  if (!match) {
    // still anchored on the range unit: `items 0-255/12345` counts something
    // that is not bytes, so its total is not a byte length
    const loose = /^bytes\b.*\/(\d+)\s*$/i.exec(trimmed)
    return loose
      ? {
          start: undefined,
          end: undefined,
          total: Number.parseInt(loose[1]!, 10),
        }
      : undefined
  }
  const [, start, end, total] = match
  return {
    start: start === undefined ? undefined : Number.parseInt(start, 10),
    end: end === undefined ? undefined : Number.parseInt(end, 10),
    total: total === undefined ? undefined : Number.parseInt(total, 10),
  }
}

/**
 * Let go of a body nobody is going to read.
 *
 * The 416 and the error statuses both leave `readRange` without reaching
 * `arrayBuffer()`. Under node a `Response` whose body is neither read nor
 * cancelled holds its connection out of undici's pool until GC, so a run of
 * 416s or 5xxs — exactly when a reader is retrying hard — exhausts the agent.
 */
export function discardBody(res: Response) {
  // the body is being dropped either way, so a failure to cancel says nothing
  res.body?.cancel().catch(() => undefined)
}

/**
 * How long a response says its body is, where that is a count of the bytes it
 * is about to hand back.
 *
 * `Content-Length` counts what is on the wire, so a `Content-Encoding` makes it
 * the compressed length and it says nothing about how much a caller is about to
 * hold — the same distinction `assertBodyMatchesRange` draws. Undefined for a
 * chunked response, which does not declare a length at all, so nothing may
 * depend on this being there.
 */
export function declaredLength(res: Response) {
  const header = res.headers.get('content-encoding')
    ? null
    : res.headers.get('content-length')
  // `Number`, not `parseInt`: `parseInt('12abc')` is 12, and a length that is
  // only partly a number is not one to allocate against. The empty string has
  // to be turned away first, though — `Number('')` is 0, so a malformed
  // `Content-Length:` with nothing after it would declare a body of no bytes.
  const length = header?.trim() ? Number(header) : Number.NaN
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined
}

/**
 * Parse a `bytes=start-end` header into inclusive absolute offsets. Anything
 * else — an open-ended `bytes=100-`, a multi-range `bytes=0-9,20-29`, a
 * backwards range — yields undefined, and the caller passes the request
 * straight through uncached rather than honoring part of it.
 */
export function parseByteRange(range: string | null) {
  const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null
  if (match) {
    const start = Number.parseInt(match[1]!, 10)
    const end = Number.parseInt(match[2]!, 10)
    return end < start ? undefined : { start, end }
  } else {
    return undefined
  }
}

/**
 * `RemoteFile.read`'s NaN guard, which neither reader in this package reaches
 * any more: both enter the chunk cache below that method. A NaN length arrives
 * from a corrupt index and would otherwise become a `bytes=NaN-NaN` request.
 *
 * Widened past NaN because the chunk arithmetic downstream launders a bad
 * offset into something that looks like a real request instead of failing.
 * A negative position produces the header `bytes=-262144--1`, which is not a
 * malformed request a server rejects but a *valid* one meaning something else
 * — the leading `-` is the suffix-range form, so a server may answer 200 or
 * serve the last 262144 bytes of the file, and this layer would cache those
 * bytes at the wrong offsets. A fractional position is quieter still: it is
 * floored during assembly, so the read silently returns the bytes next to the
 * ones asked for. Both come from the same place a NaN does, an index that is
 * corrupt or being parsed against the wrong file.
 *
 * The magnitude of `length` matters as well as its sign. `planRead` walks one
 * iteration, promise and in-flight entry per {@link CHUNK_SIZE} of it, all
 * before the first await, so a corrupt length hangs the thread long before
 * `new Uint8Array` would have refused it — hence the ceiling at what a
 * `Uint8Array` can hold rather than at `Number.MAX_SAFE_INTEGER`.
 */
export function assertReadArgs(key: string, length: number, position: number) {
  if (Number.isNaN(length) || Number.isNaN(position)) {
    throw new TypeError(
      `read() of ${key} called with NaN length or position (length=${length}, position=${position}); the index the offset came from is probably corrupt or truncated`,
    )
  }
  if (
    !Number.isSafeInteger(length) ||
    !Number.isSafeInteger(position) ||
    length < 0 ||
    position < 0
  ) {
    throw new TypeError(
      `read() of ${key} needs a non-negative safe-integer length and position (length=${length}, position=${position}); the index the offset came from is probably corrupt or being read against the wrong file`,
    )
  }
  if (length > MAX_READ_LENGTH) {
    throw new TypeError(
      `read() of ${key} asked for ${length} bytes, more than the ${MAX_READ_LENGTH} a Uint8Array can hold; the index the offset came from is probably corrupt or being read against the wrong file`,
    )
  }
}

/** what a `Uint8Array` can hold, and so the largest read worth attempting */
const MAX_READ_LENGTH = 2 ** 32 - 1

/**
 * Copy the part of `chunk` — the CHUNK_SIZE-aligned block at `chunkIndex` —
 * that overlaps the absolute byte range [start, end) into `result`, whose byte
 * 0 is absolute position `start`. Every offset is computed from absolute
 * positions, so a short chunk (one the file ended inside) cannot shift where
 * later chunks land, which an accumulate-as-you-go copy does silently.
 */
export function copyChunkInto({
  result,
  start,
  end,
  chunkIndex,
  chunk,
}: {
  result: Uint8Array
  start: number
  end: number
  chunkIndex: number
  chunk: Uint8Array
}) {
  const chunkStart = chunkIndex * CHUNK_SIZE
  const from = Math.max(start, chunkStart)
  const to = Math.min(end, chunkStart + chunk.length)
  if (to > from) {
    result.set(chunk.subarray(from - chunkStart, to - chunkStart), from - start)
  }
}
