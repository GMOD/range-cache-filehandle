import { afterEach, describe, expect, test } from 'vitest'

import { withResponseDeadline } from '../src/errors.ts'
import {
  CachedFilehandle,
  RemoteFileWithRangeCache,
  clearCache,
  clearCacheFor,
} from '../src/index.ts'
import { assertReadArgs, parseContentRange } from '../src/util.ts'

import type { GenericFilehandle } from 'generic-filehandle2'

const CHUNK = 256 * 1024
const FILE_SIZE = 2 * 1024 * 1024
// Each test gets its own URL. The cache is keyed by URL and is module-global,
// so a test that deliberately leaves a file stalled would otherwise hand the
// next test a pool with no free slots — which is the behaviour under test, not
// a flake.
let urlCounter = 0
function nextUrl() {
  urlCounter++
  return `https://example.com/f${urlCounter}.bin`
}

const fileData = new Uint8Array(FILE_SIZE)
for (let i = 0; i < FILE_SIZE; i++) {
  fileData[i] = i % 256
}

function requestedRange(init?: RequestInit) {
  const match = /bytes=(\d+)-(\d+)/.exec(
    new Headers(init?.headers).get('range') ?? '',
  )
  if (!match) {
    throw new Error('no range header')
  }
  return { start: Number(match[1]), end: Number(match[2]) }
}

/** a well-behaved server: 206 with an honest Content-Range, 416 past EOF */
function goodServer(log?: { start: number; end: number }[]) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const { start, end: asked } = requestedRange(init)
    const end = Math.min(asked, FILE_SIZE - 1)
    log?.push({ start, end })
    if (start >= FILE_SIZE) {
      return new Response('', {
        status: 416,
        headers: { 'content-range': `bytes */${FILE_SIZE}` },
      })
    }
    return new Response(fileData.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${FILE_SIZE}` },
    })
  }
}

function makeFile(url: string, fetchImpl: unknown) {
  return new RemoteFileWithRangeCache(url, {
    fetch: fetchImpl as typeof globalThis.fetch,
  })
}

afterEach(() => {
  clearCache()
})

describe('a response that is not the range it claims to be', () => {
  test('a truncated body is rejected rather than cached as an early EOF', async () => {
    // a proxy that cuts every body short while still declaring the full range
    const truncating = async (_url: unknown, init?: RequestInit) => {
      const { start, end: asked } = requestedRange(init)
      const end = Math.min(asked, FILE_SIZE - 1)
      return new Response(fileData.slice(start, start + 1000), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${FILE_SIZE}` },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, truncating)
    await expect(file.read(100, 0)).rejects.toThrow(/truncated/)
  })

  test('and leaves nothing behind, so a recovered server serves the read', async () => {
    let truncate = true
    const flaky = async (url: unknown, init?: RequestInit) => {
      if (!truncate) {
        return goodServer()(url as string, init)
      }
      const { start, end } = requestedRange(init)
      return new Response(fileData.slice(start, start + 1000), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${Math.min(end, FILE_SIZE - 1)}/${FILE_SIZE}`,
        },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, flaky)
    await expect(file.read(100, 5000)).rejects.toThrow(/truncated/)
    truncate = false
    const bytes = await file.read(100, 5000)
    expect(bytes.length).toBe(100)
    expect([...bytes.slice(0, 4)]).toEqual([...fileData.slice(5000, 5004)])
  })

  test('a body describing some other range is rejected', async () => {
    // a cache answering with whatever range it had lying around
    const wrongRange = async (_url: unknown, init?: RequestInit) => {
      const { start, end } = requestedRange(init)
      const length = Math.min(end, FILE_SIZE - 1) - start + 1
      return new Response(fileData.slice(0, length), {
        status: 206,
        headers: { 'content-range': `bytes 0-${length - 1}/${FILE_SIZE}` },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, wrongRange)
    await expect(file.read(100, CHUNK * 3)).rejects.toThrow(
      /does not describe the range that was asked for/,
    )
  })

  test('a short body is accepted where the file really does end there', async () => {
    const url = nextUrl()
    const file = makeFile(url, goodServer())
    const bytes = await file.read(CHUNK, FILE_SIZE - 10)
    expect(bytes.length).toBe(10)
  })

  test('an encoded body is not checked, since its length is not the range', async () => {
    const encoded = async (_url: unknown, init?: RequestInit) => {
      const { start, end } = requestedRange(init)
      return new Response(fileData.slice(start, start + 50), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${Math.min(end, FILE_SIZE - 1)}/${FILE_SIZE}`,
          'content-encoding': 'gzip',
        },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, encoded)
    await expect(file.read(100, 0)).resolves.toBeInstanceOf(Uint8Array)
  })

  test('no Content-Range means nothing to check against', async () => {
    const bare = async (_url: unknown, init?: RequestInit) => {
      const { start, end } = requestedRange(init)
      return new Response(
        fileData.slice(start, Math.min(end, FILE_SIZE - 1) + 1),
        { status: 206 },
      )
    }
    const url = nextUrl()
    const file = makeFile(url, bare)
    expect((await file.read(100, 0)).length).toBe(100)
  })
})

describe('416 that explains nothing is answered but not remembered', () => {
  test('a spurious 416 does not poison the chunk for later reads', async () => {
    let calls = 0
    const flaky416 = async (url: unknown, init?: RequestInit) => {
      calls++
      // no content-range, so nothing confirms this range was past the end
      return calls === 1
        ? new Response('', { status: 416 })
        : goodServer()(url as string, init)
    }
    const url = nextUrl()
    const file = makeFile(url, flaky416)
    expect((await file.read(100, 0)).length).toBe(0)
    // previously served 0 bytes from cache forever; now it asks again
    expect((await file.read(100, 0)).length).toBe(100)
  })

  test('a 416 that reports the size is trusted, and asked only once', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const file = makeFile(url, goodServer(log))
    expect((await file.read(100, FILE_SIZE + CHUNK)).length).toBe(0)
    const afterFirst = log.length
    expect((await file.read(100, FILE_SIZE + CHUNK)).length).toBe(0)
    expect(log.length).toBe(afterFirst)
  })

  test('and the size it reported is what stat answers with', async () => {
    const url = nextUrl()
    const file = makeFile(url, goodServer())
    await file.read(100, FILE_SIZE + CHUNK)
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
  })
})

describe('concurrency is scoped per file', () => {
  test('a file whose server never answers does not block another file', async () => {
    const urlA = nextUrl()
    const urlB = nextUrl()
    const stalled = async (url: string | URL | Request, init?: RequestInit) => {
      if (typeof url === 'string' && url === urlA) {
        // headers never arrive and the request never settles
        return new Promise<Response>(() => {})
      }
      return goodServer()(url, init)
    }
    const fileA = makeFile(urlA, stalled)
    const fileB = makeFile(urlB, stalled)
    // saturate A's pool several times over
    for (let i = 0; i < 40; i++) {
      void fileA.read(10, i * CHUNK).catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    const bytes = await Promise.race([
      fileB.read(10, 0),
      new Promise<'blocked'>(resolve => {
        setTimeout(() => {
          resolve('blocked')
        }, 1500)
      }),
    ])
    expect(bytes).not.toBe('blocked')
  })

  test('clearCache() does not let the next reads overshoot the cap', async () => {
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let concurrent = 0
    let peak = 0
    const gated = async (url: string | URL | Request, init?: RequestInit) => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await gate
      concurrent--
      return goodServer()(url, init)
    }
    const url = nextUrl()
    const file = makeFile(url, gated)
    for (let i = 0; i < 20; i++) {
      void file.read(10, i * CHUNK).catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    clearCache()
    for (let i = 0; i < 40; i++) {
      void file.read(10, (100 + i) * CHUNK).catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    expect(peak).toBeLessThanOrEqual(20)
  })
})

describe('stat is shared between callers that ask at once', () => {
  test('ten concurrent stats make one request', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const file = makeFile(url, goodServer(log))
    const sizes = await Promise.all(
      Array.from({ length: 10 }, () => file.stat()),
    )
    expect(sizes.every(s => s.size === FILE_SIZE)).toBe(true)
    expect(log.length).toBe(1)
  })

  test('a failed stat is not remembered as in flight', async () => {
    let fail = true
    const flaky = async (url: unknown, init?: RequestInit) => {
      if (fail) {
        return new Response('', { status: 500 })
      }
      return goodServer()(url as string, init)
    }
    const url = nextUrl()
    const file = makeFile(url, flaky)
    await expect(file.stat()).rejects.toThrow(/HTTP 500/)
    fail = false
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
  })
})

describe('the response deadline lets go of the caller signal', () => {
  test('dispose removes the listener it added', () => {
    const controller = new AbortController()
    let added = 0
    let removed = 0
    const { signal } = controller
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      added++
      add(...args)
    }
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      removed++
      remove(...args)
    }
    const deadline = withResponseDeadline(signal, () => 'timed out')
    expect(added).toBe(1)
    deadline.responded()
    expect(removed).toBe(0)
    deadline.dispose()
    expect(removed).toBe(1)
  })

  test('cancellation still reaches the socket after the headers arrive', () => {
    const controller = new AbortController()
    const deadline = withResponseDeadline(controller.signal, () => 'timed out')
    // headers are in, the body is still streaming
    deadline.responded()
    controller.abort(new Error('reader gave up'))
    expect(deadline.signal.aborted).toBe(true)
  })

  test('a caller who already gave up gets an aborted signal', () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    const deadline = withResponseDeadline(controller.signal, () => 'timed out')
    expect(deadline.signal.aborted).toBe(true)
    deadline.dispose()
  })
})

describe('read arguments that would become a wrong request', () => {
  test.for([
    ['negative position', 100, -1000],
    ['negative length', -100, 0],
    ['fractional position', 100, 10.5],
    ['fractional length', 10.5, 0],
    ['unsafe integer', 100, Number.MAX_SAFE_INTEGER + 2],
  ] as const)('%s is rejected', ([, length, position]) => {
    expect(() => {
      assertReadArgs('f.bin', length, position)
    }).toThrow(/non-negative safe-integer/)
  })

  test('NaN keeps its own message', () => {
    expect(() => {
      assertReadArgs('f.bin', Number.NaN, 0)
    }).toThrow(/NaN length or position/)
  })

  test('a negative position never reaches the network', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const file = makeFile(url, goodServer(log))
    await expect(file.read(100, -1000)).rejects.toThrow(TypeError)
    expect(log).toEqual([])
  })
})

describe('parseContentRange', () => {
  test.for([
    ['bytes 0-255/12345', { start: 0, end: 255, total: 12345 }],
    ['bytes */12345', { start: undefined, end: undefined, total: 12345 }],
    ['bytes 0-255/*', { start: 0, end: 255, total: undefined }],
    ['  bytes 0-255/12345  ', { start: 0, end: 255, total: 12345 }],
  ] as const)('parses %s', ([header, expected]) => {
    expect(parseContentRange(header)).toEqual(expected)
  })

  test.for([null, '', 'bytes 0-255', 'items 0-255/12345', 'bytes 0/12345'])(
    'rejects %s',
    header => {
      expect(parseContentRange(header)).toBeUndefined()
    },
  )
})

describe('clearCacheFor', () => {
  test('drops one file and leaves the others', async () => {
    const logA: { start: number; end: number }[] = []
    const logB: { start: number; end: number }[] = []
    const urlA = nextUrl()
    const urlB = nextUrl()
    const fileA = makeFile(urlA, goodServer(logA))
    const fileB = makeFile(urlB, goodServer(logB))
    await fileA.read(100, 0)
    await fileB.read(100, 0)
    clearCacheFor(urlA)
    await fileA.read(100, 0)
    await fileB.read(100, 0)
    expect({ a: logA.length, b: logB.length }).toEqual({ a: 2, b: 1 })
  })

  test('drops the size it learned, so stat asks again', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const file = makeFile(url, goodServer(log))
    await file.stat()
    clearCacheFor(url)
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
    expect(log.length).toBe(2)
  })
})

describe('a subclass that knows the size from somewhere else', () => {
  test('recordSize clamps reads without any range request finding out', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    // the shape a cloud provider's metadata endpoint takes: stat answers from
    // somewhere the chunk cache never sees
    class FromMetadata extends RemoteFileWithRangeCache {
      override async stat() {
        this.recordSize(FILE_SIZE)
        return { size: FILE_SIZE }
      }
    }
    const file = new FromMetadata(url, {
      fetch: goodServer(log),
    })
    await file.stat()
    expect(log).toEqual([])
    // the over-read every bgzf reader does on its last block, clamped by a
    // size no range request ever observed
    expect((await file.read(CHUNK, FILE_SIZE - 10)).length).toBe(10)
    expect(log.every(r => r.start < FILE_SIZE)).toBe(true)
  })
})

describe('the size cache is bounded', () => {
  test('a rotating key evicts rather than growing without limit', async () => {
    // CachedFilehandle.stat records a size per key without any network
    const inner = {
      read: async () => new Uint8Array(0),
      readFile: async () => new Uint8Array(0),
      stat: async () => ({ size: 1234 }),
      close: async () => {},
    } as unknown as GenericFilehandle
    for (let i = 0; i < 5100; i++) {
      await new CachedFilehandle(inner, `signed-url-${i}`).stat()
    }
    // the earliest keys are gone; the latest are not. Reading through a handle
    // whose size was evicted still works, it just no longer clamps
    const recent = new CachedFilehandle(inner, 'signed-url-5099')
    expect(await recent.stat()).toEqual({ size: 1234 })
  })
})
