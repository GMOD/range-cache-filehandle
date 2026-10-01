import { getEventListeners } from 'node:events'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { withResponseDeadline } from '../src/errors.ts'
import { RemoteFileWithRangeCache, clearCache } from '../src/index.ts'

const FILE_SIZE = 4096

let urlCounter = 0
function nextUrl() {
  urlCounter++
  return `https://listeners${urlCounter}.example.com/data.bin`
}

async function server(_url: string | URL | Request, init?: RequestInit) {
  const match = /bytes=(\d+)-(\d+)/.exec(
    new Headers(init?.headers).get('range') ?? '',
  )
  if (!match) {
    return new Response(new Uint8Array(FILE_SIZE), { status: 200 })
  }
  const start = Number(match[1])
  const end = Math.min(Number(match[2]), FILE_SIZE - 1)
  return new Response(new Uint8Array(end - start + 1), {
    status: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${FILE_SIZE}` },
  })
}

afterEach(() => {
  clearCache()
  vi.useRealTimers()
})

describe("the response deadline leaves no listener on the caller's signal", () => {
  test('after 25 reads', async () => {
    const { signal } = new AbortController()
    for (let i = 0; i < 25; i++) {
      const file = new RemoteFileWithRangeCache(nextUrl(), { fetch: server })
      await file.read(100, 0, { signal })
    }
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  test('after 25 whole-file reads', async () => {
    const { signal } = new AbortController()
    for (let i = 0; i < 25; i++) {
      const file = new RemoteFileWithRangeCache(nextUrl(), { fetch: server })
      expect((await file.readFile({ signal })).byteLength).toBe(FILE_SIZE)
    }
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  test('a caller who aborts before the deadline is never reported as a silent server', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const deadline = withResponseDeadline(controller.signal, () => 'timed out')
    controller.abort(new Error('reader gave up'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deadline.expired).toBeUndefined()
    expect(deadline.signal.reason).toEqual(new Error('reader gave up'))
  })
})
