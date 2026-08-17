import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  isNetworkRejection,
  networkFailureHint,
  statusHint,
} from '../src/errors.ts'
import { CachedFilehandle, clearCache } from '../src/index.ts'
import { parseByteRange, unrefIfPossible } from '../src/util.ts'

import type { FilehandleOptions, GenericFilehandle } from 'generic-filehandle2'

afterEach(() => {
  clearCache()
  vi.unstubAllGlobals()
})

describe('statusHint', () => {
  test.for([
    [200, /ignored the Range header/],
    [401, /signed URL may have expired/],
    [403, /signed URL may have expired/],
    [404, /no such file/],
    [429, /failing or declining/],
    [500, /failing or declining/],
    [503, /failing or declining/],
  ] as const)('%i is explained', ([status, pattern]) => {
    expect(statusHint(status)).toMatch(pattern)
  })

  test.for([418, 302, 204])('%i gets no hint of its own', status => {
    expect(statusHint(status)).toBe('')
  })
})

describe('networkFailureHint', () => {
  test('names CORS when there is nothing else to go on', () => {
    expect(networkFailureHint('https://example.com/a.bin')).toMatch(
      /most often CORS/,
    )
  })

  test('reports an offline browser ahead of anything else', () => {
    vi.stubGlobal('navigator', { onLine: false })
    expect(networkFailureHint('https://example.com/a.bin')).toMatch(
      /no network connection/,
    )
  })

  test('a navigator without onLine is not read as offline', () => {
    // node has had a global navigator since 21 and it has no onLine
    vi.stubGlobal('navigator', {})
    expect(networkFailureHint('https://example.com/a.bin')).toMatch(
      /most often CORS/,
    )
  })

  test('names the mixed-content block on an https page loading http', () => {
    vi.stubGlobal('location', {
      protocol: 'https:',
      href: 'https://example.com/app/',
    })
    expect(networkFailureHint('http://example.com/a.bin')).toMatch(
      /may not load a file served over http/,
    )
  })

  test('an https file on an https page is not mixed content', () => {
    vi.stubGlobal('location', {
      protocol: 'https:',
      href: 'https://example.com/app/',
    })
    expect(networkFailureHint('https://example.com/a.bin')).toMatch(
      /most often CORS/,
    )
  })

  test('an unparseable url is not mixed content', () => {
    vi.stubGlobal('location', { protocol: 'https:', href: 'not a url' })
    expect(networkFailureHint('::::')).toMatch(/most often CORS/)
  })

  test('an http page is not checked for mixed content at all', () => {
    vi.stubGlobal('location', {
      protocol: 'http:',
      href: 'http://example.com/app/',
    })
    expect(networkFailureHint('http://example.com/a.bin')).toMatch(
      /most often CORS/,
    )
  })
})

describe('isNetworkRejection', () => {
  test('a bare TypeError is one', () => {
    expect(isNetworkRejection(new TypeError('Failed to fetch'))).toBe(true)
  })

  test('one wrapped as a cause is too', () => {
    const wrapped = new Error('fetching https://example.com/a.bin', {
      cause: new TypeError('Failed to fetch'),
    })
    expect(isNetworkRejection(wrapped)).toBe(true)
  })

  test('a plain error is not', () => {
    expect(isNetworkRejection(new Error('HTTP 404'))).toBe(false)
  })

  test('a non-error is not', () => {
    expect(isNetworkRejection('Failed to fetch')).toBe(false)
  })

  test('a cyclic cause chain terminates', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b
    expect(isNetworkRejection(a)).toBe(false)
  })

  test('a TypeError buried deeper than the bound is not found', () => {
    let error: Error = new TypeError('Failed to fetch')
    for (let i = 0; i < 6; i++) {
      error = new Error(`layer ${i}`, { cause: error })
    }
    expect(isNetworkRejection(error)).toBe(false)
  })
})

describe('parseByteRange', () => {
  test('parses a closed range', () => {
    expect(parseByteRange('bytes=0-255')).toEqual({ start: 0, end: 255 })
  })

  test.for([
    null,
    '',
    'bytes=100-',
    'bytes=-100',
    'bytes=0-9,20-29',
    'items=0-9',
    'bytes=255-0',
  ])('passes %s through uncached', header => {
    expect(parseByteRange(header)).toBeUndefined()
  })
})

describe('unrefIfPossible', () => {
  test('a browser timer id is left alone', () => {
    expect(() => {
      unrefIfPossible(7)
    }).not.toThrow()
  })

  test('a node timer is unrefed', () => {
    let called = false
    unrefIfPossible({
      unref: () => {
        called = true
      },
    })
    expect(called).toBe(true)
  })

  test('an object without unref is left alone', () => {
    expect(() => {
      unrefIfPossible({})
    }).not.toThrow()
  })
})

describe('CachedFilehandle over an arbitrary filehandle', () => {
  function fakeInner(size = 4096) {
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) {
      bytes[i] = i % 256
    }
    const reads: {
      length: number
      position: number
      signal: boolean
      sameAsCaller?: boolean
    }[] = []
    let closed = false
    let callerSignal: AbortSignal | undefined
    const inner: GenericFilehandle = {
      async read(length: number, position: number, opts?: FilehandleOptions) {
        reads.push({
          length,
          position,
          signal: Boolean(opts?.signal),
          sameAsCaller: opts?.signal === callerSignal,
        })
        return bytes.slice(position, position + length)
      },
      async readFile() {
        return bytes
      },
      async stat() {
        return { size }
      },
      async close() {
        closed = true
      },
    } as unknown as GenericFilehandle
    return {
      inner,
      reads,
      bytes,
      isClosed: () => closed,
      watchCaller: (signal: AbortSignal) => {
        callerSignal = signal
      },
    }
  }

  test('a zero-length read never reaches the inner handle', async () => {
    const { inner, reads } = fakeInner()
    const file = new CachedFilehandle(inner, 'zero')
    expect((await file.read(0, 0)).length).toBe(0)
    expect(reads).toEqual([])
  })

  test("the inner handle is given the run's signal, not the caller's", async () => {
    const { inner, reads, watchCaller } = fakeInner()
    const caller = new AbortController()
    watchCaller(caller.signal)
    await new CachedFilehandle(inner, 'signal').read(10, 0, {
      signal: caller.signal,
    })
    // the run's own signal, which outlives any one reader giving up
    expect(reads[0]?.signal).toBe(true)
    expect(reads[0]?.sameAsCaller).toBe(false)
  })

  test('a read with no signal of its own still runs under the run', async () => {
    const { inner, reads } = fakeInner()
    await new CachedFilehandle(inner, 'nosignal').read(10, 0)
    expect(reads[0]?.signal).toBe(true)
  })

  test('an already-aborted read never reaches the inner handle', async () => {
    const { inner, reads } = fakeInner()
    const file = new CachedFilehandle(inner, 'aborted')
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(
      file.read(10, 0, { signal: controller.signal }),
    ).rejects.toThrow(/gone/)
    expect(reads).toEqual([])
  })

  test('reads are chunked and served from cache the second time', async () => {
    const { inner, reads, bytes } = fakeInner()
    const file = new CachedFilehandle(inner, 'cached')
    const first = await file.read(100, 10)
    expect([...first]).toEqual([...bytes.slice(10, 110)])
    const afterFirst = reads.length
    const second = await file.read(50, 20)
    expect([...second]).toEqual([...bytes.slice(20, 70)])
    expect(reads.length).toBe(afterFirst)
  })

  test('stat records the size, which clamps a read past the end', async () => {
    const { inner, reads } = fakeInner(4096)
    const file = new CachedFilehandle(inner, 'clamped')
    expect(await file.stat()).toEqual({ size: 4096 })
    const bytes = await file.read(10_000, 4000)
    expect(bytes.length).toBe(96)
    // The clamp works in chunks, so the one request is the chunk-aligned run
    // covering the file rather than the 14,000 bytes the read implied.
    expect(reads).toHaveLength(1)
    expect(reads[0]!.position).toBe(0)
  })

  test('a read wholly past a known size never reaches the inner handle', async () => {
    const { inner, reads } = fakeInner(4096)
    const file = new CachedFilehandle(inner, 'past-eof')
    await file.stat()
    expect((await file.read(100, 999_999)).length).toBe(0)
    expect(reads).toEqual([])
  })

  test('readFile bypasses the chunk cache', async () => {
    const { inner, reads } = fakeInner()
    const file = new CachedFilehandle(inner, 'whole')
    expect((await file.readFile()).length).toBe(4096)
    expect(reads).toEqual([])
  })

  test('close delegates to the inner handle', async () => {
    const { inner, isClosed } = fakeInner()
    await new CachedFilehandle(inner, 'closing').close()
    expect(isClosed()).toBe(true)
  })

  test('two handles on one key share chunks', async () => {
    const { inner, reads } = fakeInner()
    await new CachedFilehandle(inner, 'shared').read(10, 0)
    const afterFirst = reads.length
    await new CachedFilehandle(inner, 'shared').read(10, 0)
    expect(reads.length).toBe(afterFirst)
  })
})
