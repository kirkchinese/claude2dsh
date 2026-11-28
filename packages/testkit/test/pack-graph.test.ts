import { describe, expect, it } from 'vitest'
import { auditProductionGraph, staleImporters, type PnpmLock } from '../../../scripts/pack-graph.ts'

const PACKED = [{ dir: 'packages/core', name: 'core' }, { dir: 'packages/plugin', name: 'plugin' }]

/** A lockfile whose platform-specific packages sit below clean direct dependencies. */
const LOCK: PnpmLock = {
  lockfileVersion: '9.0',
  importers: {
    'packages/core': { dependencies: { tidy: { specifier: '1.0.0', version: '1.0.0' } } },
    'packages/plugin': {
      dependencies: {
        core: { specifier: 'workspace:*', version: 'link:../core' },
        wrapper: { specifier: '^2.0.0', version: '2.0.0(peer@1.0.0)' },
        renamed: { specifier: 'npm:bundler@3.0.0', version: 'bundler@3.0.0' },
      },
      optionalDependencies: { 'native-addon': { specifier: '1.0.0', version: '1.0.0' } },
    },
  },
  packages: {
    'tidy@1.0.0': {},
    'deep@1.0.0': { cpu: ['x64'], os: ['linux'] },
    'wrapper@2.0.0': {},
    'binary-host@1.0.0': {},
    '@vendor/binary-linux-x64@1.0.0': { os: ['linux'], cpu: ['x64'] },
    'bundler@3.0.0': {},
    'esbuild@0.25.0': {},
    'native-addon@1.0.0': { libc: ['glibc'] },
    'peer@1.0.0': {},
  },
  snapshots: {
    'tidy@1.0.0': { dependencies: { deep: '1.0.0' } },
    'deep@1.0.0': {},
    'wrapper@2.0.0(peer@1.0.0)': { dependencies: { 'binary-host': '1.0.0', peer: '1.0.0' } },
    'binary-host@1.0.0': { optionalDependencies: { '@vendor/binary-linux-x64': '1.0.0' } },
    '@vendor/binary-linux-x64@1.0.0': {},
    'bundler@3.0.0': { dependencies: { esbuild: '0.25.0' } },
    'esbuild@0.25.0': {},
    'native-addon@1.0.0': {},
    'peer@1.0.0': {},
  },
}

describe('the production dependency graph of the packed packages', () => {
  it('refuses platform-specific packages at any depth, through links, aliases and optional edges, naming the path', () => {
    expect(auditProductionGraph(LOCK, PACKED)).toEqual({
      problems: [
        'plugin > native-addon (optional): native-addon is platform-specific (libc: glibc)',
        'core > tidy > deep: deep is platform-specific (os: linux; cpu: x64)',
        'plugin > renamed > esbuild: esbuild brings platform-specific binaries in',
        'plugin > wrapper > binary-host: binary-host has platform-specific optional dependencies (@vendor/binary-linux-x64)',
        'plugin > wrapper > binary-host > @vendor/binary-linux-x64 (optional): @vendor/binary-linux-x64 is platform-specific (os: linux; cpu: x64)',
      ],
      packages: 9,
    })
  })

  it('passes a clean graph and refuses a lockfile it cannot read', () => {
    expect(auditProductionGraph({ ...LOCK, importers: { 'packages/core': {}, 'packages/plugin': {} } }, PACKED)).toEqual({ problems: [], packages: 0 })
    expect(auditProductionGraph({ ...LOCK, lockfileVersion: '6.0' }, PACKED).problems).toEqual([expect.stringMatching(/lockfileVersion "6\.0"/u)])
  })

  it('refuses a reachable package without a snapshot instead of taking it as an audited leaf, naming the path', () => {
    const { 'tidy@1.0.0': _tidy, ...snapshots } = LOCK.snapshots!
    expect(auditProductionGraph({ ...LOCK, snapshots }, PACKED).problems).toContain('core > tidy: tidy@1.0.0 has no snapshot in pnpm-lock.yaml, so what it brings in is not audited')
  })

  it('says when the lockfile no longer matches a package.json', () => {
    const manifest = { dependencies: { tidy: '1.0.0', added: '^1.0.0' } }
    expect(staleImporters(LOCK, [{ ...PACKED[0]!, manifest }])).toEqual(['core: pnpm-lock.yaml\'s dependencies differ from package.json; run pnpm install'])
    expect(staleImporters(LOCK, [{ ...PACKED[0]!, manifest: { dependencies: { tidy: '1.0.0' } } }])).toEqual([])
  })
})
