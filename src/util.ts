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
 * `bytes * /12345` form a 416 carries. Anything unparseable yields undefined,
 * and the caller treats the response as unvalidatable rather than as wrong.
 */
export function parseContentRange(header: string | null) {
  const match = header
    ? /^bytes (?:(\d+)-(\d+)|\*)\/(?:(\d+)|\*)$/.exec(header.trim())
    : null
  if (!match) {
    return undefined
  }
  const [, start, end, total] = match
  return {
    start: start === undefined ? undefined : Number.parseInt(start, 10),
    end: end === undefined ? undefined : Number.parseInt(end, 10),
    total: total === undefined ? undefined : Number.parseInt(total, 10),
  }
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
}

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
