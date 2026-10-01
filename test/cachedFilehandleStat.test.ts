import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BlobFile, LocalFile, RemoteFile } from 'generic-filehandle2'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { hasSize } from '../src/chunkCache.ts'
import { CachedFilehandle, clearCache, clearCacheFor } from '../src/index.ts'

import type { GenericFilehandle } from 'generic-filehandle2'

const dec = new TextDecoder()

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcf-stat-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  clearCache()
})

describe('a local file rewritten in place', () => {
  test('read does not stat the inner handle', async () => {
    let stats = 0
    const data = new Uint8Array(100)
    const inner: GenericFilehandle = {
      read: (length: number, position: number) =>
        Promise.resolve(data.slice(position, position + length)),
      readFile: (() => Promise.resolve(data)) as never,
      stat: () => {
        stats++
        return Promise.resolve({ size: data.length })
      },
      close: () => Promise.resolve(),
    }
    await new CachedFilehandle(inner, 'file:///data/nostat.bin').read(10, 0)
    expect(stats).toBe(0)
  })

  test('clearCacheFor lets a new handle read the new bytes', async () => {
    const file = path.join(dir, 'rewritten.bin')
    fs.writeFileSync(file, 'AAAAAAAAAA')
    const h1 = new CachedFilehandle(new LocalFile(file), `file://${file}`)
    await h1.stat()
    expect(dec.decode(await h1.read(10, 0))).toBe('AAAAAAAAAA')

    fs.writeFileSync(file, 'BBBBBBBBBBBBBBBBBBBB')
    clearCacheFor(`file://${file}`)
    const h2 = new CachedFilehandle(new LocalFile(file), `file://${file}`)
    expect(dec.decode(await h2.read(20, 0))).toBe('BBBBBBBBBBBBBBBBBBBB')
  })
})

describe('a size the stats cannot vouch for', () => {
  test('a remote size of 0 from hidden Content-Range does not empty the file', async () => {
    const body = new Uint8Array(1000).map((_, i) => i % 251)
    const fetch = (_url: string | URL | Request, init?: RequestInit) => {
      const m = /bytes=(\d+)-(\d+)/.exec(
        new Headers(init?.headers).get('range') ?? '',
      )!
      const start = Number(m[1])
      const end = Math.min(Number(m[2]), body.length - 1)
      return Promise.resolve(
        new Response(body.slice(start, end + 1), { status: 206 }),
      )
    }
    const file = new CachedFilehandle(
      new RemoteFile('https://example.com/m2', { fetch }),
      'https://example.com/m2',
    )
    expect((await file.stat()).size).toBe(0)
    expect(hasSize('https://example.com/m2')).toBe(false)
    expect((await file.read(100, 0)).length).toBe(100)
  })

  test('a non-empty Blob’s size is recorded', async () => {
    const file = new CachedFilehandle(
      new BlobFile(new Blob(['abc'])),
      'blob://sized',
    )
    await file.stat()
    expect(hasSize('blob://sized')).toBe(true)
    expect(dec.decode(await file.read(100, 0))).toBe('abc')
  })

  test('an empty Blob reads as empty', async () => {
    const file = new CachedFilehandle(
      new BlobFile(new Blob([])),
      'blob://empty',
    )
    expect((await file.stat()).size).toBe(0)
    expect((await file.read(100, 0)).length).toBe(0)
  })

  test('an empty local file records its size and reads as empty', async () => {
    const file = path.join(dir, 'empty.bin')
    fs.writeFileSync(file, '')
    const handle = new CachedFilehandle(new LocalFile(file), `file://${file}`)
    await handle.stat()
    expect(hasSize(`file://${file}`)).toBe(true)
    expect((await handle.read(100, 0)).length).toBe(0)
  })
})
