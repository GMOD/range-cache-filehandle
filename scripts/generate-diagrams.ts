import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { buildArchitectureDot } from './diagrams/architecture.ts'
import { buildChunksSvg } from './diagrams/chunks.ts'

const dot = buildArchitectureDot()
writeFileSync('docs/img/architecture.dot', dot)
writeFileSync('docs/img/chunks.svg', await buildChunksSvg())

try {
  execFileSync('dot', [
    '-Tsvg',
    'docs/img/architecture.dot',
    '-o',
    'docs/img/architecture.svg',
  ])
} catch {
  console.warn(
    'graphviz is not installed, so docs/img/architecture.svg was left as it was.\n' +
      'The .dot beside it is current; re-render it with `dot -Tsvg` where graphviz exists.',
  )
}
