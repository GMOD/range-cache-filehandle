import { readFileSync } from 'node:fs'

import { afterEach, expect, test } from 'vitest'

import { buildArchitectureDot } from '../scripts/diagrams/architecture.ts'
import { buildChunksSvg } from '../scripts/diagrams/chunks.ts'
import { clearCache } from '../src/index.ts'

afterEach(() => {
  clearCache()
})

// The diagrams are drawn from the source rather than from memory of it — one by
// reading the call graph, one by running the cache and recording what it did —
// so a change to either that nobody redraws is a failure here rather than a
// picture that quietly stops being true.
const stale = (file: string) =>
  `docs/img/${file} no longer matches the code it is drawn from. Run \`pnpm diagrams\`.`

test('architecture.dot is what the source says', () => {
  expect(
    readFileSync('docs/img/architecture.dot', 'utf8'),
    stale('architecture.dot'),
  ).toBe(buildArchitectureDot())
})

test('chunks.svg is what a read actually does', async () => {
  expect(readFileSync('docs/img/chunks.svg', 'utf8'), stale('chunks.svg')).toBe(
    await buildChunksSvg(),
  )
})
