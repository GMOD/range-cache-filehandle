import { afterEach, expect, test, vi } from 'vitest'

import {
  CACHE_IDLE_TIMEOUT_MS,
  CACHE_LIMIT,
  CachedFilehandle,
  MIN_REQUEST,
  PIECE_SIZE,
  cachedBytes,
  clearCache,
  clearCacheFor,
  setCacheLimit,
  sweepIdleCache,
} from '../src/index.ts'

import type { GenericFilehandle } from 'generic-filehandle2'

// far enough apart that reads of two blocks in one turn are two requests
const BLOCK = 4 * MIN_REQUEST

afterEach(() => {
  setCacheLimit(CACHE_LIMIT)
  clearCache()
  vi.useRealTimers()
})

function open(key: string, size = 8 * BLOCK) {
  const fetched: number[] = []
  const inner: GenericFilehandle = {
    read(length: number, position: number) {
      fetched.push(position / BLOCK)
      return Promise.resolve(
        new Uint8Array(Math.max(0, Math.min(length, size - position))),
      )
    },
    readFile: (() => Promise.resolve(new Uint8Array(0))) as never,
    stat: () => Promise.resolve({ size }),
    close: () => Promise.resolve(),
  }
  const file = new CachedFilehandle(inner, key)
  const read = (...blocks: number[]) =>
    Promise.all(blocks.map(i => file.read(10, i * BLOCK)))
  return { fetched, read, file }
}

test('lowering the limit evicts the least recently used extents', async () => {
  const { fetched, read } = open('file:///lower.bin')
  for (const i of [0, 1, 2, 3, 0]) {
    await read(i)
  }
  expect(cachedBytes()).toBe(4 * MIN_REQUEST)

  setCacheLimit(2 * MIN_REQUEST)
  expect(cachedBytes()).toBe(2 * MIN_REQUEST)
  fetched.length = 0
  await read(0)
  await read(3)
  expect(fetched).toEqual([])

  await read(1)
  expect(fetched).toEqual([1])
  expect(cachedBytes()).toBe(2 * MIN_REQUEST)
  await read(0)
  expect(fetched).toEqual([1, 0])
})

test('eviction drops one piece of a long body, not the whole body', async () => {
  const { fetched, file } = open('file:///long.bin', 4 * PIECE_SIZE)
  await file.read(3 * PIECE_SIZE, 0)
  expect(cachedBytes()).toBe(3 * PIECE_SIZE)

  setCacheLimit(2.5 * PIECE_SIZE)
  expect(cachedBytes()).toBe(2 * PIECE_SIZE)
  fetched.length = 0
  await file.read(10, 2.5 * PIECE_SIZE)
  expect(fetched).toEqual([])
  await file.read(10, 0)
  expect(fetched).toEqual([0])
})

test.each([0, MIN_REQUEST - 1])(
  'a limit of %d caches nothing, and concurrent reads still share a request',
  async limit => {
    const { fetched, read } = open('file:///off.bin')
    await read(0, 1)
    setCacheLimit(limit)
    expect(cachedBytes()).toBe(0)

    fetched.length = 0
    await read(2, 2, 2)
    expect(fetched).toEqual([2])
    expect(cachedBytes()).toBe(0)
    await read(2)
    expect(fetched).toEqual([2, 2])
  },
)

test('raising the limit again caches up to the new limit', async () => {
  const { read } = open('file:///raise.bin')
  setCacheLimit(MIN_REQUEST)
  await read(0, 1)
  expect(cachedBytes()).toBe(MIN_REQUEST)

  setCacheLimit(3 * MIN_REQUEST)
  await read(0, 1, 2, 3)
  expect(cachedBytes()).toBe(3 * MIN_REQUEST)

  setCacheLimit(Infinity)
  await read(4, 5, 6, 7)
  expect(cachedBytes()).toBe(7 * MIN_REQUEST)
})

test('cachedBytes follows clearCacheFor, sweepIdleCache and clearCache', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const a = open('file:///a.bin')
  const b = open('file:///b.bin', 100)
  const c = open('file:///c.bin')
  await a.read(0, 1)
  await b.read(0)
  expect(cachedBytes()).toBe(2 * MIN_REQUEST + 100)

  clearCacheFor('file:///a.bin')
  expect(cachedBytes()).toBe(100)

  vi.advanceTimersByTime(CACHE_IDLE_TIMEOUT_MS)
  await c.read(0)
  sweepIdleCache()
  expect(cachedBytes()).toBe(MIN_REQUEST)

  clearCache()
  expect(cachedBytes()).toBe(0)
})

test('a fresh module holds CACHE_LIMIT bytes', async () => {
  vi.resetModules()
  const fresh = await import('../src/index.ts')
  const { fetched, file } = (() => {
    const fetched: number[] = []
    const file = new fresh.CachedFilehandle(
      {
        read(length: number, position: number) {
          fetched.push(position)
          return Promise.resolve(new Uint8Array(length))
        },
        readFile: (() => Promise.resolve(new Uint8Array(0))) as never,
        stat: () => Promise.resolve({ size: 2 * CACHE_LIMIT }),
        close: () => Promise.resolve(),
      },
      'file:///big.bin',
    )
    return { fetched, file }
  })()
  await file.read(CACHE_LIMIT, 0)
  expect(fresh.cachedBytes()).toBe(CACHE_LIMIT)

  await file.read(10, CACHE_LIMIT)
  expect(fresh.cachedBytes()).toBe(CACHE_LIMIT - PIECE_SIZE + MIN_REQUEST)
  await file.read(10, PIECE_SIZE)
  await file.read(10, 0)
  expect(fetched).toEqual([0, CACHE_LIMIT, 0])
  fresh.clearCache()
})

test.each([-1, NaN, '1024' as unknown as number])(
  'rejects a limit of %s',
  limit => {
    expect(() => {
      setCacheLimit(limit)
    }).toThrow(RangeError)
  },
)
