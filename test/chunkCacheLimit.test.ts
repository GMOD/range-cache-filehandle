import { afterEach, expect, test, vi } from 'vitest'

import {
  CACHE_IDLE_TIMEOUT_MS,
  CHUNK_SIZE,
  CachedFilehandle,
  MAX_CACHE_ENTRIES,
  cachedBytes,
  clearCache,
  clearCacheFor,
  setChunkCacheLimit,
  sweepIdleCache,
} from '../src/index.ts'

import type { GenericFilehandle } from 'generic-filehandle2'

afterEach(() => {
  setChunkCacheLimit(MAX_CACHE_ENTRIES * CHUNK_SIZE)
  clearCache()
  vi.useRealTimers()
})

function open(key: string, size = 8 * CHUNK_SIZE) {
  const fetched: number[] = []
  const inner: GenericFilehandle = {
    read(length: number, position: number) {
      fetched.push(position / CHUNK_SIZE)
      return Promise.resolve(
        new Uint8Array(Math.max(0, Math.min(length, size - position))),
      )
    },
    readFile: (() => Promise.resolve(new Uint8Array(0))) as never,
    stat: () => Promise.resolve({ size }),
    close: () => Promise.resolve(),
  }
  const file = new CachedFilehandle(inner, key)
  const read = (...chunks: number[]) =>
    Promise.all(chunks.map(i => file.read(10, i * CHUNK_SIZE)))
  return { fetched, read }
}

test('lowering the limit evicts the least recently used chunks', async () => {
  const { fetched, read } = open('file:///lower.bin')
  for (const i of [0, 1, 2, 3, 0]) {
    await read(i)
  }
  expect(cachedBytes()).toBe(4 * CHUNK_SIZE)

  setChunkCacheLimit(2 * CHUNK_SIZE)
  expect(cachedBytes()).toBe(2 * CHUNK_SIZE)
  fetched.length = 0
  await read(0)
  await read(3)
  expect(fetched).toEqual([])

  await read(1)
  expect(fetched).toEqual([1])
  expect(cachedBytes()).toBe(2 * CHUNK_SIZE)
  await read(0)
  expect(fetched).toEqual([1, 0])
})

test.each([0, CHUNK_SIZE - 1])(
  'a limit of %d caches nothing, and concurrent reads still share a request',
  async limit => {
    const { fetched, read } = open('file:///off.bin')
    await read(0, 1)
    setChunkCacheLimit(limit)
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
  setChunkCacheLimit(CHUNK_SIZE)
  await read(0, 1)
  expect(cachedBytes()).toBe(CHUNK_SIZE)

  setChunkCacheLimit(3 * CHUNK_SIZE)
  await read(0, 1, 2, 3)
  expect(cachedBytes()).toBe(3 * CHUNK_SIZE)

  setChunkCacheLimit(Infinity)
  await read(4, 5, 6, 7)
  expect(cachedBytes()).toBe(7 * CHUNK_SIZE)
})

test('cachedBytes follows clearCacheFor, sweepIdleCache and clearCache', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const a = open('file:///a.bin')
  const b = open('file:///b.bin', CHUNK_SIZE + 100)
  const c = open('file:///c.bin')
  await a.read(0, 1)
  await b.read(0, 1)
  expect(cachedBytes()).toBe(3 * CHUNK_SIZE + 100)

  clearCacheFor('file:///a.bin')
  expect(cachedBytes()).toBe(CHUNK_SIZE + 100)

  vi.advanceTimersByTime(CACHE_IDLE_TIMEOUT_MS)
  await c.read(0)
  sweepIdleCache()
  expect(cachedBytes()).toBe(CHUNK_SIZE)

  clearCache()
  expect(cachedBytes()).toBe(0)
})

test('a fresh module holds MAX_CACHE_ENTRIES chunks', async () => {
  vi.resetModules()
  const fresh = await import('../src/index.ts')
  const { cachedBytes } = fresh
  const tiny = (i: number) => {
    const fetched: number[] = []
    const file = new fresh.CachedFilehandle(
      {
        read(length: number) {
          fetched.push(0)
          return Promise.resolve(new Uint8Array(Math.min(length, 10)))
        },
        readFile: (() => Promise.resolve(new Uint8Array(0))) as never,
        stat: () => Promise.resolve({ size: 10 }),
        close: () => Promise.resolve(),
      },
      `file:///tiny${i}.bin`,
    )
    return { fetched, read: () => file.read(10, 0) }
  }
  const files = Array.from({ length: MAX_CACHE_ENTRIES + 1 }, (_, i) => tiny(i))
  for (const { read } of files) {
    await read()
  }
  expect(cachedBytes()).toBe(MAX_CACHE_ENTRIES * 10)

  await files[1]!.read()
  expect(files[1]!.fetched).toEqual([0])
  await files[0]!.read()
  expect(files[0]!.fetched).toEqual([0, 0])
  fresh.clearCache()
})

test.each([-1, NaN, '1024' as unknown as number])(
  'rejects a limit of %s',
  limit => {
    expect(() => {
      setChunkCacheLimit(limit)
    }).toThrow(RangeError)
  },
)
