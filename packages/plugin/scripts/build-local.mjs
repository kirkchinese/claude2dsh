#!/usr/bin/env node
// Assemble local-package/ as a self-contained package that `dsh plugin add <path>` can
// install without resolving the monorepo's `workspace:` dependency protocol.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const local = join(packageRoot, 'local-package')
const source = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))

await mkdir(join(local, 'lib'), { recursive: true })
await copyFile(join(packageRoot, 'lib', 'client.js'), join(local, 'lib', 'client.js'))
await copyFile(join(packageRoot, 'cordis.patch.yml'), join(local, 'cordis.patch.yml'))
await copyFile(join(packageRoot, 'README.md'), join(local, 'README.md'))
await copyFile(join(packageRoot, 'LICENSE'), join(local, 'LICENSE'))

const manifest = {
  name: source.name,
  version: source.version,
  type: 'module',
  main: './lib/index.js',
  exports: {
    '.': { default: './lib/index.js' },
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json',
    './client': './lib/client.js',
  },
  dsh: source.dsh,
  dependencies: {
    '@deepseek-ai/dsh-tools': source.peerDependencies['@deepseek-ai/dsh-tools'],
    '@deepseek-ai/schemastery': source.dependencies['@deepseek-ai/schemastery'],
    yaml: source.dependencies.yaml,
  },
  peerDependencies: {
    '@deepseek-ai/cordis': source.peerDependencies['@deepseek-ai/cordis'],
    '@deepseek-ai/dsh-settings': source.peerDependencies['@deepseek-ai/dsh-settings'],
  },
  peerDependenciesMeta: {
    '@deepseek-ai/cordis': { optional: true },
    '@deepseek-ai/dsh-settings': { optional: true },
  },
  description: source.description,
  license: source.license,
  engines: source.engines,
}
await writeFile(join(local, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`local package ready: ${local}`)
