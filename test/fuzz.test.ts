import { afterEach, expect, test } from 'vitest'

import { inspectFile } from '../src/extentCache.ts'
import {
  CACHE_LIMIT,
  CachedFilehandle,
  MIN_REQUEST,
  cachedBytes,
  clearCache,
  setCacheLimit,
} from '../src/index.ts'

import type { GenericFilehandle } from 'generic-filehandle2'

// Random concurrent reads against a slow source: overlapping requests in
// flight, aborts that race new readers of the same bytes, readers that cannot
// abort, eviction under live reads, reads past EOF with the size known and
// unknown. Every read must return the file's bytes or its own abort reason.

const SIZE = 1_000_003
const data = new Uint8Array(SIZE)
for (let i = 0; i < SIZE; i++) {
  data[i] = (i * 7 + (i >> 8)) & 255
}

function lcg(seed: number) {
  let s = seed >>> 0
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
  return {
    rand,
    int: (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo)),
  }
}

function slowSource(int: (lo: number, hi: number) => number) {
  const fetched: { start: number; end: number }[] = []
  const inner: GenericFilehandle = {
    async read(length, position, opts = {}) {
      const { signal } = opts
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, int(0, 6))
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(signal.reason as Error)
          },
          { once: true },
        )
      })
      signal?.throwIfAborted()
      const end = Math.min(position + length, SIZE)
      fetched.push({ start: position, end: Math.max(position, end) })
      return data.slice(Math.min(position, SIZE), end)
    },
    readFile: (() => Promise.resolve(data)) as never,
    stat: () => Promise.resolve({ size: SIZE }),
    close: () => Promise.resolve(),
  }
  return { inner, fetched }
}

let keys = 0

async function trial({
  seed,
  limit,
  knownSize,
  rounds = 80,
}: {
  seed: number
  limit: number
  knownSize: boolean
  rounds?: number
}) {
  const { rand, int } = lcg(seed)
  const { inner } = slowSource(int)
  const key = `fuzz://${++keys}`
  const file = new CachedFilehandle(inner, key)
  setCacheLimit(limit)
  if (knownSize) {
    await file.stat()
  }
  const failures: string[] = []
  let completed = 0
  let aborted = 0
  for (let round = 0; round < rounds; round++) {
    const reads = Array.from({ length: int(1, 12) }, (_, i) => {
      const start = int(0, SIZE + 20_000)
      const length = rand() < 0.3 ? int(1, 2000) : int(1, 300_000)
      const controller = new AbortController()
      const willAbort = rand() < 0.25
      const reason = new Error(`abort ${round}:${i}`)
      if (willAbort) {
        setTimeout(
          () => {
            controller.abort(reason)
          },
          int(0, 4),
        )
      }
      const signal = rand() < 0.1 ? undefined : controller.signal
      return file.read(length, start, { signal }).then(
        bytes => {
          const want = data.subarray(
            Math.min(start, SIZE),
            Math.min(start + length, SIZE),
          )
          if (
            bytes.length !== want.length ||
            !bytes.every((b, k) => b === want[k])
          ) {
            failures.push(`read ${start}+${length} returned the wrong bytes`)
          }
          completed++
        },
        (e: unknown) => {
          if (e === reason && signal !== undefined) {
            aborted++
          } else {
            failures.push(`read ${start}+${length} rejected with ${e}`)
          }
        },
      )
    })
    await Promise.all(reads)
    await new Promise(resolve => setTimeout(resolve, 10))

    if (cachedBytes() > limit) {
      failures.push(`round ${round}: holds ${cachedBytes()} over ${limit}`)
    }
    const { extents, pending } = inspectFile(key)
    if (pending > 0) {
      failures.push(`round ${round}: ${pending} requests left pending`)
    }
    for (const [i, extent] of extents.entries()) {
      if (i > 0 && extent.start < extents[i - 1]!.end) {
        failures.push(`round ${round}: extents overlap at ${extent.start}`)
      }
      if (
        extent.bytes.length !== extent.end - extent.start ||
        (round === rounds - 1 &&
          !extent.bytes.every((b, k) => b === data[extent.start + k]))
      ) {
        failures.push(
          `round ${round}: extent ${extent.start} holds wrong bytes`,
        )
      }
      if (extent.end > SIZE) {
        failures.push(`round ${round}: extent ${extent.start} runs past EOF`)
      }
    }
  }
  return { failures, completed, aborted }
}

afterEach(() => {
  setCacheLimit(CACHE_LIMIT)
  clearCache()
})

test.for([
  { limit: Infinity, knownSize: false },
  { limit: Infinity, knownSize: true },
  { limit: 200_000, knownSize: false },
  { limit: 50_000, knownSize: true },
  { limit: 0, knownSize: false },
])(
  'random concurrent reads under a limit of $limit, size known: $knownSize',
  { timeout: 30_000 },
  async ({ limit, knownSize }) => {
    let aborted = 0
    for (const seed of [1, 2, 3]) {
      const result = await trial({ seed, limit, knownSize })
      expect(result.failures).toEqual([])
      expect(result.completed).toBeGreaterThan(300)
      aborted += result.aborted
    }
    expect(aborted).toBeGreaterThan(0)
  },
)

test('with no aborts and no limit, a byte is fetched twice only to merge gaps', async () => {
  const { int } = lcg(7)
  const { inner, fetched } = slowSource(int)
  const file = new CachedFilehandle(inner, 'fuzz://unlimited')
  setCacheLimit(Infinity)
  for (let round = 0; round < 60; round++) {
    await Promise.all(
      Array.from({ length: int(1, 12) }, () =>
        file.read(int(1, 300_000), int(0, SIZE)),
      ),
    )
  }
  const sorted = fetched.toSorted((a, b) => a.start - b.start)
  let twice = 0
  let cursor = 0
  for (const { start, end } of sorted) {
    twice += Math.max(0, Math.min(end, cursor) - start)
    cursor = Math.max(cursor, end)
  }
  // each request may span at most MIN_REQUEST of cover between two gaps it
  // merged, and only a request that merged gaps can
  expect(twice).toBeLessThanOrEqual(fetched.length * MIN_REQUEST)
  expect(cachedBytes()).toBe(
    sorted.reduce((sum, { start, end }) => sum + end - start, 0) - twice,
  )
})
