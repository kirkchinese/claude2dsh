/**
 * Pure planner: turn a scanned plugin into reviewable actions. It never writes
 * or mounts anything; the apply engine is the only executor.
 * @module @kirkchinese/harness-forge-core
 */
import { createHash } from 'node:crypto'
import { assess } from './assess.js'
import { fingerprintPlugin } from './fingerprint.js'
import type { Gap, ForeignComponent, ForeignPlugin } from './types.js'
import type { Plan, PlanAction, PlanActionKind, PlanSummary, RiskLevel } from './contracts.js'

/** Planner inputs. Selection is reserved for a later component picker. */
export interface PlanOptions {
  /** Optional component ids to include; omitted means every component. */
  readonly include?: readonly string[]
}

/** The action and side effects per component kind. */
const POLICY: Record<ForeignComponent['kind'], {
  readonly kind: PlanActionKind
  readonly risk: RiskLevel
  readonly reversible: boolean
  readonly order: number
}> = {
  skill: { kind: 'link-skill-root', risk: 'read', reversible: true, order: 10 },
  command: { kind: 'register-command', risk: 'write', reversible: true, order: 20 },
  agent: { kind: 'register-agent', risk: 'write', reversible: true, order: 30 },
  mcp: { kind: 'mount-mcp', risk: 'network', reversible: true, order: 40 },
  hooks: { kind: 'mount-hooks', risk: 'execute', reversible: true, order: 50 },
  code: { kind: 'report-code', risk: 'code', reversible: true, order: 60 },
  ui: { kind: 'report-ui', risk: 'read', reversible: true, order: 70 },
  // Settings first: their environment and permission rules apply to everything mounted after them.
  settings: { kind: 'apply-settings', risk: 'execute', reversible: true, order: 5 },
  other: { kind: 'report-code', risk: 'read', reversible: true, order: 90 },
}

/** Build a plan for one plugin. */
export function planPlugin(plugin: ForeignPlugin, options: PlanOptions = {}): Plan {
  const compat = assess(plugin)
  const include = options.include === undefined ? undefined : new Set(options.include)
  const actions: PlanAction[] = []
  for (const component of plugin.components) {
    if (include !== undefined && !include.has(component.id)) continue
    const policy = POLICY[component.kind]
    actions.push({
      id: `${plugin.id}:${policy.kind}:${component.id}`,
      kind: policy.kind,
      componentId: component.id,
      name: component.name,
      description: describe(component),
      risk: policy.risk,
      reversible: policy.reversible,
    })
  }
  actions.sort((a, b) => {
    const left = POLICY[componentKind(a)]?.order ?? 99
    const right = POLICY[componentKind(b)]?.order ?? 99
    return left - right || a.name.localeCompare(b.name, 'en')
  })
  const fingerprint = plugin.fingerprint ?? fingerprintPlugin(plugin)
  const gaps = compat.gaps
  const summary: PlanSummary = {
    components: plugin.components.length,
    actions: actions.length,
    residentTokens: compat.contextCost.residentTokens,
    toolCount: compat.contextCost.toolCount,
    skillCount: compat.contextCost.skillCount,
  }
  const id = createHash('sha256')
    .update(plugin.id)
    .update('\0')
    .update(fingerprint.digest)
    .update('\0')
    .update(actions.map(action => action.id).join('\n'))
    .digest('hex')
  return {
    id,
    pluginId: plugin.id,
    source: plugin.source,
    root: plugin.root,
    fingerprint,
    target: compat.target,
    actions,
    summary,
    warnings: [...plugin.warnings.map(warning => `${warning.code}: ${warning.message}`), ...gaps.map((gap: Gap) => `${gap.kind}: ${gap.summary}`)],
  }
}

function componentKind(action: PlanAction): ForeignComponent['kind'] {
  const prefix = action.componentId?.split(':')[2]
  return (prefix ?? 'other') as ForeignComponent['kind']
}

function describe(component: ForeignComponent): string {
  switch (component.kind) {
    case 'skill': return `Link skill root for ${component.name}`
    case 'command': return `Register slash command ${component.name}`
    case 'agent': return `Register agent preset ${component.name}`
    case 'mcp': return component.notStarted !== undefined
      ? `Leave MCP server ${component.name} unstarted: ${component.notStarted.detail}`
      : `Mount MCP server ${component.name} (${component.transport})`
    case 'hooks': return `Mount hook bridge ${component.name} (${component.events.join(', ') || 'no events'})`
    case 'code': return `Load ${component.runtime} ${component.name} through its runtime shim`
    case 'ui': return `Report UI surface ${component.name} (${component.surface}); not rendered`
    case 'settings': return `Apply ${component.name}: ${component.permissions.allow.length + component.permissions.deny.length + component.permissions.ask.length} permission rule(s), ${Object.keys(component.env).length} environment variable(s)`
    default: return `Report ${component.kind} component ${component.name}`
  }
}
