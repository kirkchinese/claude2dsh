/**
 * Load a hooks module the way Claude Code does: its `.ts`/`.tsx`/`.js`
 * sources bundled (extensionless, directory and `.js`-for-`.ts` imports,
 * classic JSX on the global `h`/`Fragment`), then run in an environment of
 * its own with the globals claude-code.d.ts lists and no others: no Node, no
 * DOM, no timers, no code generation from strings.
 * @module @kirkchinese/harness-forge/mods
 */
import { createHash, getRandomValues, randomUUID, subtle } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute } from 'node:path'
import vm from 'node:vm'
import { CLAUDE_CODE_MODULE, Fragment, h } from './runtime.js'

/** One bundled module: CommonJS text over the virtual `claude-code` imports. */
export interface Bundle {
  readonly code: string
  readonly entry: string
  /** The plugin's own source files the bundle was built from. */
  readonly files: readonly string[]
  /** The bundle's identity, for caching. */
  readonly digest: string
}

/** What bundles and parses a module: rolldown's `build` and `parseAst` (see `bundler.ts`). */
export interface Bundler {
  readonly build: (options: never) => Promise<unknown>
  readonly parseAst: (code: string, options?: { lang?: string }) => unknown
}

/** Modules a hooks module imports from the engine rather than from its folder. */
const VIRTUAL = ['claude-code', 'claude-code/testing']

/** Bundle a module and everything it imports from its plugin. */
export async function bundleModule(entry: string, bundler: Bundler): Promise<Bundle> {
  const warnings: string[] = []
  const result = await bundler.build({
    input: entry,
    cwd: dirname(entry),
    write: false,
    platform: 'neutral',
    external: VIRTUAL,
    resolve: {
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      extensionAlias: { '.js': ['.ts', '.tsx', '.js'], '.jsx': ['.tsx', '.jsx'], '.mjs': ['.mts', '.mjs'], '.cjs': ['.cts', '.cjs'] },
      mainFields: ['module', 'main'],
    },
    transform: { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'Fragment' } },
    onLog: (level: string, log: { code?: string; message: string }) => { if (level === 'warn' && log.code !== 'CONFIGURATION_FIELD_CONFLICT') warnings.push(log.message) },
    output: { format: 'cjs', exports: 'named', codeSplitting: false },
  } as never) as { output: Array<{ type: string; code?: string; moduleIds?: string[] }> }
  const chunk = result.output.find(item => item.type === 'chunk')
  if (chunk?.code === undefined) throw new Error(`bundling ${entry} produced no module${warnings.length > 0 ? `: ${warnings.join('; ')}` : ''}`)
  const files = (chunk.moduleIds ?? []).filter(id => isAbsolute(id) && !/[\\/]node_modules[\\/]/u.test(id))
  return { code: chunk.code, entry, files, digest: createHash('sha256').update(chunk.code).digest('hex').slice(0, 16) }
}

/** The globals of a hooks module's environment. */
function environmentGlobals(extra: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    h,
    Fragment,
    AbortSignal,
    AbortController,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    structuredClone,
    crypto: Object.freeze({ subtle: Object.freeze({ digest: subtle.digest.bind(subtle) }), randomUUID, getRandomValues }),
    performance: Object.freeze({ now: () => performance.now() }),
    ...extra,
  }
}

/** A fresh environment for one load of a module. */
export function createEnvironment(extra: Readonly<Record<string, unknown>> = {}): vm.Context {
  return vm.createContext(environmentGlobals(extra), { codeGeneration: { strings: false, wasm: false }, name: 'claude-code hooks module' })
}

/**
 * Run a bundle in an environment and return its exports.
 * @param imports - the virtual modules it may import (`claude-code`, `claude-code/testing`).
 */
export function evaluateBundle(bundle: Bundle, context: vm.Context, imports: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const modules: Record<string, unknown> = { 'claude-code': CLAUDE_CODE_MODULE, ...imports }
  const wrapper = new vm.Script(`(function (exports, require, module) {\n${bundle.code}\n})`, { filename: bundle.entry })
  const run = wrapper.runInContext(context) as (exports: object, require: (name: string) => unknown, module: { exports: object }) => void
  const module = { exports: {} as Record<string, unknown> }
  run(module.exports, (name: string) => {
    if (name in modules) return modules[name]
    throw new Error(`a hooks module imports only from its plugin and from claude-code; "${name}" is neither`)
  }, module)
  return module.exports
}

/**
 * What a module hooks and calls, read off its source as `plugin.register`
 * reports it: its `on(...)` patterns in order, the `$` calls it spells
 * (sorted), and the variables its `$.env` calls name.
 */
export function scanUses(source: string): { events: string[]; calls: string[]; env?: { reads: string[]; writes: string[] } } {
  const events: string[] = []
  for (const match of source.matchAll(/\bon\(\s*(['"`])([^'"`]+)\1/gu)) if (!events.includes(match[2]!)) events.push(match[2]!)
  const calls = new Set<string>()
  for (const match of source.matchAll(/\$\.([a-z]+)\.([a-zA-Z]+)\s*\(/gu)) calls.add(`${match[1]!}.${match[2]!}`)
  const reads = new Set<string>()
  const writes = new Set<string>()
  for (const match of source.matchAll(/\$\.env\.(get|set)\(\s*(['"`])([^'"`]+)\2/gu)) (match[1] === 'get' ? reads : writes).add(match[3]!)
  return {
    events,
    calls: [...calls].sort(),
    ...(reads.size > 0 || writes.size > 0 ? { env: { reads: [...reads].sort(), writes: [...writes].sort() } } : {}),
  }
}

interface AstNode {
  readonly type: string
  readonly [key: string]: unknown
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (!isNode(node)) return
  visit(node)
  for (const [key, value] of Object.entries(node)) if (key !== 'type' && typeof value === 'object') walk(value, visit)
}

function rootName(node: unknown): string | undefined {
  if (!isNode(node)) return undefined
  if (node.type === 'Identifier') return node['name'] as string
  if (node.type === 'MemberExpression') return rootName(node['object'])
  return undefined
}

/**
 * Why the engine would refuse a module, read off its source as Claude Code's
 * scan does: an `engine.create` step that keeps the table it is handed, to
 * call later, outside the fold. Undefined when the module loads.
 */
export function scanRefusal(source: string, parseAst: Bundler['parseAst'], lang: 'js' | 'jsx' | 'ts' | 'tsx' = 'js'): string | undefined {
  let ast: unknown
  for (const attempt of [source, `(${source})`, `({${source}})`]) {
    try {
      ast = parseAst(attempt, { lang })
      break
    } catch {
      // Try the next reading: a function's text, or a method's.
    }
  }
  if (ast === undefined) return undefined
  let problem: string | undefined
  walk(ast, (node) => {
    if (problem !== undefined || node.type !== 'CallExpression') return
    const callee = node['callee']
    const args = node['arguments'] as unknown[]
    if (!isNode(callee) || callee.type !== 'Identifier' || callee['name'] !== 'on') return
    const first = args[0]
    if (!isNode(first) || first.type !== 'Literal' || first['value'] !== 'engine.create') return
    const hook = args.at(-1)
    if (!isNode(hook) || !/Function/u.test(hook.type)) return
    const params = (hook['params'] as unknown[]).map(rootName)
    const nextName = params[2]
    const local = new Set(params.filter((name): name is string => name !== undefined))
    const tables = new Set<string>()
    const isTable = (value: unknown): boolean => {
      if (!isNode(value)) return false
      if (value.type === 'AwaitExpression') return isTable(value['argument'])
      if (value.type === 'CallExpression') return isNode(value['callee']) && (value['callee'] as AstNode)['name'] === nextName
      return value.type === 'Identifier' && tables.has(value['name'] as string)
    }
    walk(hook['body'], (inner) => {
      if (inner.type === 'VariableDeclarator') {
        const name = rootName(inner['id'])
        if (name !== undefined) {
          local.add(name)
          if (isTable(inner['init'])) tables.add(name)
        }
      }
    })
    walk(hook['body'], (inner) => {
      if (problem !== undefined || inner.type !== 'AssignmentExpression') return
      const target = rootName(inner['left'])
      if (target !== undefined && !local.has(target) && isTable(inner['right'])) {
        problem = `its engine.create step keeps the table it is handed (in ${target}), to call outside the fold`
      }
    })
  })
  return problem
}

/** The scan over a bundle's own source files, as written (not as bundled). */
export function scanBundleRefusal(bundle: Bundle, parseAst: Bundler['parseAst']): string | undefined {
  for (const file of bundle.files) {
    const ext = extname(file).toLowerCase()
    const lang = ext === '.tsx' ? 'tsx' : ext === '.ts' || ext === '.mts' || ext === '.cts' ? 'ts' : ext === '.jsx' ? 'jsx' : 'js'
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const problem = scanRefusal(text, parseAst, lang)
    if (problem !== undefined) return problem
  }
  return undefined
}

/** The `uses` of a bundle, read off its own source files. */
export function scanBundleUses(bundle: Bundle): ReturnType<typeof scanUses> {
  const texts = bundle.files.map((file) => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  })
  return scanUses(texts.length > 0 ? texts.join('\n') : bundle.code)
}

/** The `Error` of an environment, for errors a module there receives. */
export function realmOf(context: vm.Context): { readonly Error: ErrorConstructor } {
  return { Error: vm.runInContext('Error', context) as ErrorConstructor }
}
