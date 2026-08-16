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
 * One signal that aborts when either of two do.
 *
 * `AbortSignal.any` where it exists — Chrome 116, Firefox 124, Safari 17.4. The
 * manual composition stays behind a feature test rather than being deleted
 * because this package is published for consumers who set their own targets,
 * where a missing static would be a TypeError on every range request.
 */
export function anySignal(a: AbortSignal, b: AbortSignal) {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b])
  }
  const composed = new AbortController()
  for (const source of [a, b]) {
    if (source.aborted) {
      composed.abort(source.reason)
    } else {
      source.addEventListener(
        'abort',
        () => {
          composed.abort(source.reason)
        },
        { once: true },
      )
    }
  }
  return composed.signal
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
 */
export function assertReadArgs(key: string, length: number, position: number) {
  if (Number.isNaN(length) || Number.isNaN(position)) {
    throw new TypeError(
      `read() of ${key} called with NaN length or position (length=${length}, position=${position}); the index the offset came from is probably corrupt or truncated`,
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
