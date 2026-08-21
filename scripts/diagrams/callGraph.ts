import { readFileSync } from 'node:fs'

import ts from 'typescript'

export interface CallGraph {
  /** `file.ts#name` or `Class#name` → the keys it calls */
  calls: Map<string, Set<string>>
  /** every function the source declares, for checking a diagram's node list */
  defined: Set<string>
}

interface Scope {
  key: string
  className: string | undefined
}

/**
 * The call graph of `files`, keyed by `owner#name`.
 *
 * Two rules make it describe this package rather than its syntax. Calls inside a
 * function passed to `f` are attributed to `f`, since that is where they run —
 * `limitConcurrency(key, () => doFetch(...))` is `limitConcurrency` calling
 * `doFetch`. And an argument in the position of a `FetchByteRange` parameter is
 * attributed to that parameter's name, which is how the entry points reach their
 * own source: everything they call from there lands under `doFetch`.
 */
export function buildCallGraph(files: string[]): CallGraph {
  const parsed = files.map(file => ({
    module: file.replace(/^.*\//, ''),
    source: ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ESNext,
      true,
    ),
  }))

  const functions = new Map<string, ts.SignatureDeclaration>()
  const byName = new Map<string, string[]>()
  for (const { module, source } of parsed) {
    collectDeclarations(source, module, functions, byName)
  }

  const calls = new Map<string, Set<string>>()
  for (const { module, source } of parsed) {
    walk(source, { key: `${module}#`, className: undefined })
  }
  return { calls, defined: new Set(functions.keys()) }

  function record(from: string, to: string) {
    let edges = calls.get(from)
    if (edges === undefined) {
      edges = new Set()
      calls.set(from, edges)
    }
    edges.add(to)
  }

  function resolve(callee: ts.Expression, scope: Scope) {
    if (ts.isIdentifier(callee)) {
      const [only, ...rest] = byName.get(callee.text) ?? []
      return rest.length === 0 ? only : undefined
    } else if (ts.isPropertyAccessExpression(callee)) {
      const target = callee.expression
      if (target.kind === ts.SyntaxKind.ThisKeyword && scope.className) {
        const key = `${scope.className}#${callee.name.text}`
        return functions.has(key) ? key : undefined
      }
    }
    return undefined
  }

  function fetchByteRangeIndex(key: string) {
    return functions
      .get(key)
      ?.parameters.findIndex(p => p.type?.getText() === 'FetchByteRange')
  }

  function walk(node: ts.Node, scope: Scope) {
    const owned = ownerOf(node, scope)
    if (owned !== undefined) {
      ts.forEachChild(node, child => {
        walk(child, owned)
      })
      return
    }
    if (ts.isCallExpression(node)) {
      const target = resolve(node.expression, scope)
      const name = calleeText(node.expression)
      if (target !== undefined) {
        record(scope.key, target)
      } else if (name !== undefined) {
        record(scope.key, name)
      }
      const rangeArg = target === undefined ? -1 : fetchByteRangeIndex(target)
      node.arguments.forEach((arg, index) => {
        const isFn = ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
        if (isFn && index === rangeArg) {
          const param = functions
            .get(target!)!
            .parameters[index]!.name.getText()
          walk(arg.body, { key: param, className: scope.className })
        } else if (isFn && target !== undefined) {
          walk(arg.body, { key: target, className: scope.className })
        } else {
          walk(arg, scope)
        }
      })
      walk(node.expression, scope)
      return
    }
    ts.forEachChild(node, child => {
      walk(child, scope)
    })
  }

  function ownerOf(node: ts.Node, scope: Scope): Scope | undefined {
    if (ts.isClassDeclaration(node) && node.name) {
      return { key: scope.key, className: node.name.text }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      return {
        key: `${scope.key.split('#')[0]}#${node.name.text}`,
        className: scope.className,
      }
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      return {
        key: `${scope.className}#${node.name.text}`,
        className: scope.className,
      }
    }
    return undefined
  }
}

function collectDeclarations(
  source: ts.SourceFile,
  module: string,
  functions: Map<string, ts.SignatureDeclaration>,
  byName: Map<string, string[]>,
) {
  const add = (key: string, name: string, decl: ts.SignatureDeclaration) => {
    functions.set(key, decl)
    byName.set(name, [...(byName.get(name) ?? []), key])
  }
  const visit = (node: ts.Node, className: string | undefined) => {
    if (ts.isClassDeclaration(node) && node.name) {
      const inner = node.name.text
      ts.forEachChild(node, child => {
        visit(child, inner)
      })
      return
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(`${module}#${node.name.text}`, node.name.text, node)
    } else if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      className
    ) {
      functions.set(`${className}#${node.name.text}`, node)
    }
    ts.forEachChild(node, child => {
      visit(child, className)
    })
  }
  visit(source, undefined)
}

function calleeText(callee: ts.Expression) {
  if (ts.isIdentifier(callee)) {
    return callee.text
  } else if (ts.isPropertyAccessExpression(callee)) {
    const text = callee.getText()
    return text.startsWith('this.') ? text.slice('this.'.length) : undefined
  }
  return undefined
}

/** every diagram node reachable from `from`, collapsing anything not in `keep` */
export function reachable(graph: CallGraph, from: string, keep: Set<string>) {
  const found = new Set<string>()
  const seen = new Set<string>([from])
  const queue = [...(graph.calls.get(from) ?? [])]
  while (queue.length > 0) {
    const next = queue.shift()!
    if (seen.has(next)) {
      continue
    }
    seen.add(next)
    if (keep.has(next)) {
      found.add(next)
    } else {
      queue.push(...(graph.calls.get(next) ?? []))
    }
  }
  return found
}
