#!/usr/bin/env node
// Builds a tsconfig that resolves every @deepseek-ai/* specifier to the DSH
// source checkout, so the plugin can be typechecked against a DSH version that
// is not installed. Prints the generated config path.
//
// Usage: node scripts/make-compat-tsconfig.mjs <dsh-checkout> <out-tsconfig>

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

const [checkoutArg, outArg] = process.argv.slice(2)
if (checkoutArg === undefined || outArg === undefined) {
  console.error('usage: make-compat-tsconfig.mjs <dsh-checkout> <out-tsconfig>')
  process.exit(2)
}
const checkout = resolve(checkoutArg)
const out = resolve(outArg)
const pluginRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')

/** Collect every package.json below a root, skipping dependency trees. */
function findPackageJsons(root, acc = []) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const absolute = join(root, entry.name)
    if (entry.name === 'package.json') continue
    const manifest = join(absolute, 'package.json')
    try {
      if (statSync(manifest).isFile()) acc.push(manifest)
    } catch {
      // No manifest at this level; keep descending.
    }
    findPackageJsons(absolute, acc)
  }
  return acc
}

const roots = ['packages', 'vendor', 'apps'].map((name) => join(checkout, name))
const manifests = roots.flatMap((root) => findPackageJsons(root))

/** Pick the closest source entry for a package directory. */
function sourceEntry(dir, manifest) {
  const candidates = [
    manifest.exports?.['.']?.types,
    manifest.exports?.['.']?.default,
    manifest.types,
    manifest.main,
    './src/index.ts',
    './index.ts',
  ].filter((value) => typeof value === 'string')
  const mapped = []
  for (const candidate of candidates) {
    // The shipped exports point at lib/; prefer the same-named source file.
    const source = candidate
      .replace(/^\.\//, '')
      .replace(/^lib\/types\//, 'src/')
      .replace(/^lib\//, 'src/')
      .replace(/\.d\.ts$/, '.ts')
      .replace(/\.js$/, '.ts')
    mapped.push(join(dir, source))
  }
  for (const candidate of mapped) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

const paths = {}
const skipped = []
let mapped = 0
for (const manifestPath of manifests) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    continue
  }
  if (typeof manifest.name !== 'string') continue
  const dir = dirname(manifestPath)
  const entry = sourceEntry(dir, manifest)
  if (entry === undefined) {
    skipped.push(manifest.name)
    continue
  }
  mapped += 1
  paths[manifest.name] = [entry]
  paths[`${manifest.name}/*`] = [`${dir}/src/*`, `${dir}/*`]
  // Mirror every published subpath so `pkg/sub` imports resolve to source too.
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (subpath === '.' || subpath.includes('*')) continue
    const candidates = [target?.types, target?.default, target]
      .filter((value) => typeof value === 'string')
      .map((value) =>
        join(dir, value.replace(/^\.\//, '').replace(/^lib\/types\//, 'src/').replace(/^lib\//, 'src/').replace(/\.d\.ts$/, '.ts').replace(/\.js$/, '.ts')),
      )
    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isFile()) {
          paths[`${manifest.name}${subpath.slice(1)}`] = [candidate]
          break
        }
      } catch {
        // Try the next candidate.
      }
    }
  }
}

const withClient = process.argv.includes('--client')

// The plugin's own workspaces resolve through its committed build outputs, so a
// source-plane check maps them like the DSH packages above.
for (const [name, dir] of [
  ['@claude2dsh/core', 'packages/core'],
  ['@claude2dsh/adapter-claude-code', 'packages/adapters/claude-code'],
  ['@claude2dsh/plugin', 'packages/plugin'],
]) {
  paths[name] = [`${pluginRoot}/${dir}/src/index.ts`]
}

const config = {
  compilerOptions: {
    target: 'ES2023',
    lib: withClient ? ['ES2023', 'DOM', 'DOM.Iterable'] : ['ES2023'],
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    jsx: 'react-jsx',
    types: ['node'],
    baseUrl: pluginRoot,
    paths,
  },
  include: [
    `${pluginRoot}/packages/plugin/src/**/*.ts`,
    ...(withClient ? [`${pluginRoot}/packages/plugin/src/**/*.tsx`] : [`${pluginRoot}/packages/plugin/src/*.ts`]),
    `${pluginRoot}/packages/core/src/**/*.ts`,
    `${pluginRoot}/packages/adapters/claude-code/src/**/*.ts`,
  ],
}

writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`)
console.log(`wrote ${out}: ${mapped} packages mapped, ${skipped.length} without a source entry`)
if (skipped.length > 0) console.log(`no source entry: ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ', ...' : ''}`)
void createRequire
void relative
