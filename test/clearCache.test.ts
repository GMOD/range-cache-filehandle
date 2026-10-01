import { afterEach, expect, test } from 'vitest'

import { CachedFilehandle, MAX_CONCURRENT, clearCache } from '../src/index.ts'

import type { GenericFilehandle } from 'generic-filehandle2'

const CHUNK = 256 * 1024
const READS = MAX_CONCURRENT + 12

afterEach(() => {
  clearCache()
})

test('clearCache keeps the concurrency cap on reads queued before it', async () => {
  const held: (() => void)[] = []
  let live = 0
  let peak = 0
  const inner: GenericFilehandle = {
    read(length: number) {
      live++
      peak = Math.max(peak, live)
      return new Promise(resolve => {
        held.push(() => {
          live--
          resolve(new Uint8Array(length))
        })
      })
    },
    readFile: (() => Promise.resolve(new Uint8Array(0))) as never,
    stat: () => Promise.resolve({ size: READS * CHUNK }),
    close: () => Promise.resolve(),
  }
  const file = new CachedFilehandle(inner, 'file:///tmp/capped.bin')
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))

  const reads = Array.from({ length: READS }, (_, i) =>
    file.read(10, i * CHUNK),
  )
  await tick()
  expect(live).toBe(MAX_CONCURRENT)

  clearCache()
  await tick()
  expect(live).toBe(MAX_CONCURRENT)

  while (held.length > 0) {
    held.shift()!()
    await tick()
  }
  const results = await Promise.all(reads)
  expect(results.map(r => r.length)).toEqual(new Array(READS).fill(10))
  expect(peak).toBe(MAX_CONCURRENT)
})
