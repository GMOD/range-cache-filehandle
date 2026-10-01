import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  BROWSER_CONNECTIONS_PER_HOST,
  MAX_DEADLINE_REARMS,
  RESPONSE_TIMEOUT_MS,
} from '../src/constants.ts'
import { withResponseDeadline } from '../src/errors.ts'
import { RemoteFileWithRangeCache, clearCache } from '../src/index.ts'
import { holdBody, httpOrigin } from '../src/util.ts'

interface FakeLock {
  name: string
  mode: string
}

function fakeLocks() {
  const held: FakeLock[] = []
  return {
    held,
    request: async (
      name: string,
      options: { mode: string },
      callback: () => Promise<void>,
    ) => {
      const lock = { name, mode: options.mode }
      held.push(lock)
      try {
        await callback()
      } finally {
        held.splice(held.indexOf(lock), 1)
      }
    },
    query: async () => ({ held: [...held], pending: [] }),
  }
}

let hostCounter = 0
function nextUrl() {
  hostCounter++
  return `https://queue${hostCounter}.example.com/data.bin`
}

function holdBodies(url: string, n: number) {
  return Array.from({ length: n }, () => holdBody(url))
}

function releaseAll(releases: (() => void)[]) {
  for (const release of releases) {
    release()
  }
}

function deadlineFor(url: string, signal?: AbortSignal) {
  return withResponseDeadline(
    signal,
    seconds => `no response after ${seconds}s`,
    url,
  )
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearCache()
})

describe('a deadline re-arms while the origin has six bodies in progress', () => {
  test('re-arms at six bodies, and expires once they end', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const url = nextUrl()
    const bodies = holdBodies(url, BROWSER_CONNECTIONS_PER_HOST)
    const deadline = deadlineFor(url)

    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    expect(deadline.expired).toBeUndefined()
    expect(deadline.signal.aborted).toBe(false)

    releaseAll(bodies)
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    expect(deadline.expired?.message).toBe('no response after 60s')
    expect(deadline.signal.reason).toBe(deadline.expired)
  })

  test('counts bodies another context holds through the lock manager', async () => {
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    const url = nextUrl()
    const ours = holdBody(url)
    await vi.advanceTimersByTimeAsync(0)
    const { name } = locks.held[0]!
    for (let i = 1; i < BROWSER_CONNECTIONS_PER_HOST; i++) {
      locks.held.push({ name, mode: 'shared' })
    }
    const deadline = deadlineFor(url)

    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    expect(deadline.expired).toBeUndefined()
    deadline.stop()
    ours()
  })

  test('expires at five bodies', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const url = nextUrl()
    const bodies = holdBodies(url, BROWSER_CONNECTIONS_PER_HOST - 1)
    const deadline = deadlineFor(url)

    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    expect(deadline.expired?.message).toBe('no response after 30s')
    releaseAll(bodies)
  })

  test('bodies on another origin do not count', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const bodies = holdBodies(nextUrl(), BROWSER_CONNECTIONS_PER_HOST)
    const deadline = deadlineFor(nextUrl())

    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    expect(deadline.expired).toBeDefined()
    releaseAll(bodies)
  })

  test('expires after the cap, however many bodies are in progress', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const url = nextUrl()
    const bodies = holdBodies(url, BROWSER_CONNECTIONS_PER_HOST)
    const deadline = deadlineFor(url)

    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS * MAX_DEADLINE_REARMS)
    expect(deadline.expired).toBeUndefined()
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    expect(deadline.expired?.message).toBe(
      `no response after ${((MAX_DEADLINE_REARMS + 1) * RESPONSE_TIMEOUT_MS) / 1000}s`,
    )
    releaseAll(bodies)
  })
})

describe("without a working lock manager the context's own count decides", () => {
  test.for([
    ['absent', {}],
    [
      'rejecting',
      {
        locks: {
          request: () =>
            Promise.reject(new DOMException('sandboxed', 'SecurityError')),
          query: () =>
            Promise.reject(new DOMException('sandboxed', 'SecurityError')),
        },
      },
    ],
    [
      'throwing',
      {
        locks: {
          request: () => {
            throw new DOMException('sandboxed', 'SecurityError')
          },
          query: () => {
            throw new DOMException('sandboxed', 'SecurityError')
          },
        },
      },
    ],
  ] as const)('%s', async ([, navigator]) => {
    vi.stubGlobal('navigator', navigator)
    const url = nextUrl()
    const bodies = holdBodies(url, BROWSER_CONNECTIONS_PER_HOST)
    const rearmed = deadlineFor(url)
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    expect(rearmed.expired).toBeUndefined()
    rearmed.stop()

    bodies.pop()!()
    const expired = deadlineFor(url)
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    expect(expired.expired).toBeDefined()
    releaseAll(bodies)
  })
})

describe('a deadline stood down while its check is pending does nothing', () => {
  function pausedQuery() {
    let answer = (_held: FakeLock[]) => {}
    const locks = {
      request: async () => {},
      query: () =>
        new Promise<{ held: FakeLock[] }>(resolve => {
          answer = held => {
            resolve({ held })
          }
        }),
    }
    return {
      locks,
      answer: (held: FakeLock[]) => {
        answer(held)
      },
    }
  }

  test('headers arrived', async () => {
    const { locks, answer } = pausedQuery()
    vi.stubGlobal('navigator', { locks })
    const deadline = deadlineFor(nextUrl())
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    deadline.stop()
    answer([])
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS * 2)
    expect(deadline.expired).toBeUndefined()
    expect(deadline.signal.aborted).toBe(false)
  })

  test('caller aborted', async () => {
    const { locks, answer } = pausedQuery()
    vi.stubGlobal('navigator', { locks })
    const controller = new AbortController()
    const deadline = deadlineFor(nextUrl(), controller.signal)
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    controller.abort(new Error('reader gave up'))
    answer([])
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS * 2)
    expect(deadline.expired).toBeUndefined()
    expect(deadline.signal.reason).toEqual(new Error('reader gave up'))
  })
})

describe('only http(s) origins take part', () => {
  test.for([
    ['https://a.example.com:8443/x.bam', 'https://a.example.com:8443'],
    ['http://127.0.0.1:9000/x.bam', 'http://127.0.0.1:9000'],
    ['blob:https://a.example.com/0b7c', undefined],
    ['data:application/octet-stream;base64,AAAA', undefined],
    ['file:///data/x.bam', undefined],
    ['x.bam', undefined],
  ] as const)('%s', ([url, origin]) => {
    expect(httpOrigin(url)).toBe(origin)
  })

  test('a relative URL resolves against the page', () => {
    vi.stubGlobal('location', { href: 'http://localhost:3000/app/' })
    expect(httpOrigin('x.bam')).toBe('http://localhost:3000')
  })
})

describe('range and whole-file bodies count while they stream', () => {
  function controllableBody() {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let cancelled: unknown = 'not cancelled'
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel(reason) {
        cancelled = reason
      },
    })
    return {
      stream,
      controller,
      cancelled: () => cancelled,
    }
  }

  test('a range body counts from its headers until it ends', async () => {
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    const url = nextUrl()
    const body = controllableBody()
    let fetched = false
    const file = new RemoteFileWithRangeCache(url, {
      fetch: async () => {
        fetched = true
        return new Response(body.stream, {
          status: 206,
          headers: { 'content-range': 'bytes 0-3/4' },
        })
      },
    })
    const read = file.read(4, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetched).toBe(true)
    expect(locks.held).toHaveLength(1)

    body.controller.enqueue(new Uint8Array([1, 2, 3, 4]))
    body.controller.close()
    expect(await read).toEqual(new Uint8Array([1, 2, 3, 4]))
    await vi.advanceTimersByTimeAsync(0)
    expect(locks.held).toHaveLength(0)
  })

  test('a whole-file body counts until it is read to the end', async () => {
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    const url = nextUrl()
    const body = controllableBody()
    const file = new RemoteFileWithRangeCache(url, {
      fetch: async () => new Response(body.stream, { status: 200 }),
    })
    const text = file.readFile('utf8')
    await vi.advanceTimersByTimeAsync(0)
    expect(locks.held).toHaveLength(1)

    body.controller.enqueue(new TextEncoder().encode('chr1\t100\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(locks.held).toHaveLength(1)
    body.controller.close()
    expect(await text).toBe('chr1\t100\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(locks.held).toHaveLength(0)
  })

  test('a refused whole-file read counts nothing', async () => {
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    const file = new RemoteFileWithRangeCache(nextUrl(), {
      fetch: async () => new Response('no', { status: 404 }),
    })
    await expect(file.readFile()).rejects.toThrow(/404/)
    expect(locks.held).toHaveLength(0)
  })

  test('a whole-file body that fails stops counting and keeps its error', async () => {
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    const url = nextUrl()
    const body = controllableBody()
    const file = new RemoteFileWithRangeCache(url, {
      fetch: async () => new Response(body.stream, { status: 200 }),
    })
    const read = file.readFile()
    await vi.advanceTimersByTimeAsync(0)
    expect(locks.held).toHaveLength(1)

    const reason = new DOMException('gone', 'AbortError')
    body.controller.error(reason)
    await expect(read).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(locks.held).toHaveLength(0)
  })

  test('a whole-file read returns the same bytes it always did', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const url = nextUrl()
    const bytes = new Uint8Array([5, 6, 7, 8, 9])
    const file = new RemoteFileWithRangeCache(url, {
      fetch: async () => new Response(bytes, { status: 200 }),
    })
    expect(await file.readFile()).toEqual(bytes)
    expect(await file.stat()).toEqual({ size: bytes.length })
  })

  test('a request queued behind six streaming bodies is not failed at the deadline', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const host = nextUrl().replace('/data.bin', '')
    const bodies = Array.from({ length: BROWSER_CONNECTIONS_PER_HOST }, () =>
      controllableBody(),
    )
    let sent = 0
    const fetchImpl = async (_url: unknown, init?: RequestInit) => {
      const body = bodies[sent++]
      if (body) {
        return new Response(body.stream, {
          status: 206,
          headers: { 'content-range': 'bytes 0-3/4' },
        })
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal!.reason as Error)
        })
      })
    }
    const streaming = bodies.map((_, i) =>
      new RemoteFileWithRangeCache(`${host}/${i}.bin`, {
        fetch: fetchImpl,
      }).read(4, 0),
    )
    const queued = new RemoteFileWithRangeCache(`${host}/queued.bin`, {
      fetch: fetchImpl,
    }).read(4, 0)
    let outcome = 'pending'
    queued.then(
      () => {
        outcome = 'resolved'
      },
      (e: unknown) => {
        outcome = `${e}`
      },
    )

    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    expect(outcome).toBe('pending')

    for (const body of bodies) {
      body.controller.enqueue(new Uint8Array(4))
      body.controller.close()
    }
    await Promise.all(streaming)
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS)
    expect(outcome).toMatch(/No response from .*queued\.bin .* after 60s/)
  })
})
