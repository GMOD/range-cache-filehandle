import { afterEach, expect, test } from 'vitest'

import {
  CachedFilehandle,
  RemoteFileWithRangeCache,
  clearCache,
} from '../src/index.ts'

import type { GenericFilehandle } from 'generic-filehandle2'

afterEach(() => {
  clearCache()
})

function slow(fill = 1) {
  return {
    async read(
      length: number,
      _p: number,
      opts: { signal?: AbortSignal } = {},
    ) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5)
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(opts.signal!.reason as Error)
        })
      })
      return new Uint8Array(length).fill(fill)
    },
    readFile: async () => new Uint8Array(),
    stat: async () => ({ size: 1e9 }),
    close: async () => {},
  } as unknown as GenericFilehandle
}

test('a read aborted in its own turn does not cancel the others of that turn', async () => {
  // a pan: the old block is aborted and the new ones requested in one tick
  const file = new CachedFilehandle(slow(), 'regress://abort')
  const a = new AbortController()
  const pa = file.read(100, 0, { signal: a.signal })
  a.abort(new Error('A'))
  const pb = file.read(100, 0, { signal: new AbortController().signal })
  const pc = file.read(100, 0)
  await expect(pa).rejects.toThrow('A')
  await expect(pb).resolves.toHaveLength(100)
  await expect(pc).resolves.toHaveLength(100)
})

test('a caller mutating its result does not change the cache', async () => {
  // a node Buffer's `slice` is a view, so a piece cut with it aliases the body
  const inner = {
    read: async (length: number) => Buffer.alloc(length, 7),
    readFile: async () => new Uint8Array(),
    stat: async () => ({ size: 1e6 }),
    close: async () => {},
  } as unknown as GenericFilehandle
  const file = new CachedFilehandle(inner, 'regress://buffer')
  ;(await file.read(65_536, 0)).fill(0)
  expect([...(await file.read(4, 0))]).toEqual([7, 7, 7, 7])
})

test('a cached handle cannot wrap one caching under the same key', () => {
  const inner = new CachedFilehandle(slow(), 'regress://nested')
  expect(() => new CachedFilehandle(inner, 'regress://nested')).toThrow(
    /same key/,
  )
  const remote = new RemoteFileWithRangeCache('https://example.com/a.bin')
  expect(
    () => new CachedFilehandle(remote, 'https://example.com/a.bin'),
  ).toThrow(/same key/)
  expect(() => new CachedFilehandle(inner, 'regress://other')).not.toThrow()
})
