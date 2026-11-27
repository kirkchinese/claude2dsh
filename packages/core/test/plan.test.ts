import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assess } from '../src/assess.js'
import { fingerprintPlugin } from '../src/fingerprint.js'
import { planPlugin } from '../src/plan.js'
import { scanPlugin } from '../src/manifest.js'

const temporary: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-plan-'))
  temporary.push(root)
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'plan-demo',
    version: '1.0.0',
  }), 'utf8')
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true })
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\n\nPINEAPPLE\n', 'utf8')
  mkdirSync(join(root, 'hooks'), { recursive: true })
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
    modules: ['./mod.js'],
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }] },
  }), 'utf8')
  writeFileSync(join(root, 'hooks', 'mod.js'), 'export function register() {}\n', 'utf8')
  mkdirSync(join(root, 'output-styles'), { recursive: true })
  writeFileSync(join(root, 'output-styles', 'compact.md'), 'Compact style\n', 'utf8')
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({
    mcpServers: {
      remote: { type: 'sse', url: 'https://example.invalid/sse' },
      mystery: { description: 'no transport fields' },
    },
  }), 'utf8')
  return root
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('target/achieved compatibility', () => {
  it('a scan reports target but no achieved runtime', () => {
    const { plugin } = scanPlugin(fixture(), { source: 'agent-plugins' })
    const compat = assess(plugin)
    expect(compat.target.assets).toBe('L1a')
    expect(compat.target.declarativeRuntime).toBe('L2')
    expect(compat.target.codeRuntime).toBe('L3')
    expect(compat.target.interaction).toBe('L4')
    expect(compat.achieved).toMatchObject({
      discovery: 'L0', assets: 'L0', declarativeRuntime: 'L0', codeRuntime: 'L0', interaction: 'L0',
    })
    expect(compat.evidence).toBe('source')
    expect(compat.gaps.some(gap => gap.kind === 'unsupported-transport' && gap.componentId?.endsWith(':mcp:mystery'))).toBe(true)
    expect(compat.gaps.some(gap => gap.componentId?.endsWith(':mcp:remote'))).toBe(false)
  })

  it('verified outcomes upgrade achieved, failures become gaps', () => {
    const { plugin } = scanPlugin(fixture(), { source: 'agent-plugins' })
    const compat = assess(plugin, [
      { componentId: `${plugin.id}:skill:demo`, status: 'mounted', level: 'L1a', evidence: 'source' },
      { componentId: `${plugin.id}:mcp:remote`, status: 'verified', level: 'L2', evidence: 'runtime' },
      { componentId: `${plugin.id}:hooks:hooks`, status: 'failed', level: 'L0', evidence: 'runtime', message: 'sandbox unavailable' },
      { componentId: `${plugin.id}:code:mod`, status: 'skipped', level: 'L1b', evidence: 'source' },
      { componentId: `${plugin.id}:ui:output-style-compact`, status: 'skipped', level: 'L1b', evidence: 'source' },
    ])
    expect(compat.achieved.assets).toBe('L1a')
    expect(compat.achieved.declarativeRuntime).toBe('L2')
    expect(compat.achieved.codeRuntime).toBe('L0')
    expect(compat.achieved.interaction).toBe('L0')
    expect(compat.gaps.some(gap => gap.kind === 'runtime-failure')).toBe(true)
    expect(compat.evidence).toBe('runtime')
  })
})

describe('planner', () => {
  it('binds the plan fingerprint to the scan snapshot', () => {
    const root = fixture()
    const { plugin } = scanPlugin(root, { source: 'agent-plugins' })
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Changed after scan\n---\n\nChanged.\n', 'utf8')
    const plan = planPlugin(plugin)
    expect(plan.fingerprint.digest).toBe(plugin.fingerprint?.digest)
    expect(fingerprintPlugin(scanPlugin(root, { source: 'agent-plugins' }).plugin).digest).not.toBe(plan.fingerprint.digest)
  })

  it('plans every component and stays pure', () => {
    const { plugin } = scanPlugin(fixture(), { source: 'agent-plugins' })
    const plan = planPlugin(plugin)
    expect(plan.target.declarativeRuntime).toBe('L2')
    expect(plan.actions.some(action => action.kind === 'link-skill-root')).toBe(true)
    expect(plan.actions.some(action => action.kind === 'mount-mcp')).toBe(true)
    expect(plan.actions.some(action => action.kind === 'mount-hooks')).toBe(true)
    expect(plan.actions.some(action => action.kind === 'report-code')).toBe(true)
    expect(plan.warnings.some(warning => warning.includes('unsupported-transport'))).toBe(true)
  })

  it('changes the fingerprint and plan id when a skill changes', () => {
    const root = fixture()
    const first = scanPlugin(root, { source: 'agent-plugins' }).plugin
    const firstFingerprint = fingerprintPlugin(first)
    const firstPlan = planPlugin(first)
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\n\nMANGO\n', 'utf8')
    const second = scanPlugin(root, { source: 'agent-plugins' }).plugin
    const secondPlan = planPlugin(second)
    expect(fingerprintPlugin(second).digest).not.toBe(firstFingerprint.digest)
    expect(secondPlan.id).not.toBe(firstPlan.id)
  })

  it('fingerprints the MCP map, not only the manifest', () => {
    const root = fixture()
    const first = scanPlugin(root, { source: 'agent-plugins' }).plugin
    const firstFingerprint = fingerprintPlugin(first)
    writeFileSync(join(root, 'mcp.json'), JSON.stringify({
      mcpServers: { remote: { type: 'sse', url: 'https://example.invalid/other' } },
    }), 'utf8')
    const second = scanPlugin(root, { source: 'agent-plugins' }).plugin
    expect(fingerprintPlugin(second).digest).not.toBe(firstFingerprint.digest)
  })
})
