/**
 * Compatibility assessment: separate what a plugin needs (`target`) from what
 * this host has actually mounted or verified (`achieved`). A scan cannot prove
 * runtime behavior, so its achieved vector stays at L0 until an apply/run probe
 * supplies outcomes.
 * @module @kirkchinese/harness-forge-core
 */
import { EXECUTED_HOOK_HANDLERS, OBSERVED_ONLY_HOOK_EVENTS, SERVED_HOOK_EVENTS } from './hook-events.js'
import { countComponents } from './types.js'
import type {
  CompatibilityLevel,
  CompatibilityLevels,
  CompatibilityMode,
  CompatibilityVector,
  ComponentOutcome,
  ContextCost,
  ForeignComponent,
  ForeignPlugin,
  Gap,
} from './types.js'

/**
 * Parts of a harness's own configuration DSH runs as they are: Codex's
 * global instructions (added to the main system prompt) and its `notify`
 * program (run after each completed turn).
 */
function mappedOther(component: Extract<ForeignComponent, { kind: 'other' }>): boolean {
  return component.originalKind === 'codex-notify' || (component.originalKind === 'codex-instructions' && component.path !== undefined)
}

/** Context cost heuristic used until a real schema/token probe runs. */
export function estimateContextCost(plugin: ForeignPlugin): ContextCost {
  let skillChars = 0
  let mcpServers = 0
  for (const component of plugin.components) {
    if (component.kind === 'skill') {
      skillChars += component.frontmatter.name.length + component.frontmatter.description.length + 8
    }
    if (component.kind === 'mcp' && component.notStarted === undefined) mcpServers += 1
  }
  const residentTokens = Math.ceil(skillChars / 4) + mcpServers * 40
  return {
    residentTokens,
    toolCount: null,
    skillCount: plugin.components.filter(component => component.kind === 'skill').length,
    basis: 'skill descriptions + per-server index estimate; MCP schemas are not loaded during scan',
  }
}

/** Collect source-level gaps without pretending to run anything. */
export function collectGaps(plugin: ForeignPlugin): Gap[] {
  const gaps: Gap[] = []
  for (const component of plugin.components) {
    if (component.kind === 'mcp' && component.notStarted?.reason === 'unsupported') {
      gaps.push({
        id: `${component.id}:unsupported`,
        componentId: component.id,
        // What it needs lies outside DSH (a ChatGPT sign-in): an adapter written for DSH cannot supply it.
        kind: 'external-requirement',
        summary: `MCP server is not supported in DSH: it ${component.notStarted.detail}`,
        detail: 'DSH does not start it; the plugin\'s other parts still work.',
        suggestedAction: 'skip',
      })
    }
    if (component.kind === 'mcp' && component.transport === 'unknown' && component.notStarted === undefined) {
      gaps.push({
        id: `${component.id}:transport`,
        componentId: component.id,
        kind: 'unsupported-transport',
        summary: 'MCP transport could not be determined',
        detail: 'The manifest declares neither a known type nor a command/url pair.',
        suggestedAction: 'skip',
      })
    }
    if (component.kind === 'hooks') {
      const handlers = component.handlerTypes.filter(type => !EXECUTED_HOOK_HANDLERS.has(type))
      if (handlers.length > 0) {
        gaps.push({
          id: `${component.id}:handlers`,
          componentId: component.id,
          kind: 'unsupported-handler',
          summary: `Hook handler type(s) not executed: ${handlers.join(', ')}`,
          detail: 'The broker runs command, http, mcp_tool, prompt and agent handlers; these handlers stay inert.',
          suggestedAction: 'bridge',
        })
      }
      const events = component.events.filter(event => !SERVED_HOOK_EVENTS.has(event))
      if (events.length > 0) {
        gaps.push({
          id: `${component.id}:events`,
          componentId: component.id,
          kind: 'unsupported-event',
          summary: `Hook event(s) DSH never raises: ${events.join(', ')}`,
          detail: 'Hooks on these events never run in DSH.',
          suggestedAction: 'accept-difference',
        })
      }
      const observed = component.events.filter(event => OBSERVED_ONLY_HOOK_EVENTS.has(event))
      if (observed.length > 0) {
        gaps.push({
          id: `${component.id}:observed`,
          componentId: component.id,
          kind: 'semantic-difference',
          summary: `Hook event(s) run after the fact and cannot block: ${observed.join(', ')}`,
          detail: 'DSH commits these events before hooks see them; a blocking decision is ignored.',
          suggestedAction: 'accept-difference',
        })
      }
    }
    if (component.kind === 'other' && !mappedOther(component)) {
      gaps.push({
        id: `${component.id}:unsupported`,
        componentId: component.id,
        kind: 'unsupported-component',
        summary: `${component.originalKind} is not mapped to DSH`,
        detail: component.description ?? 'Reported so it does not disappear silently.',
        suggestedAction: 'generate',
      })
    }
    if (component.kind === 'code') {
      gaps.push({
        id: `${component.id}:runtime`,
        componentId: component.id,
        kind: 'missing-host-api',
        summary: 'Executable plugin requires a host API shim',
        detail: `Runtime "${component.runtime}" is experimental; only the supported API subset is bridged.`,
        suggestedAction: 'accept-difference',
      })
    }
    if (component.kind === 'ui' && component.surface === 'output-style') {
      gaps.push({
        id: `${component.id}:output-style`,
        componentId: component.id,
        kind: 'semantic-difference',
        summary: 'Output style is added to the DSH system prompt',
        detail: 'DSH keeps its own coding instructions; a style with keep-coding-instructions: false cannot remove them. Select it with /output-style.',
        suggestedAction: 'accept-difference',
      })
    } else if (component.kind === 'ui') {
      gaps.push({
        id: `${component.id}:ui`,
        componentId: component.id,
        kind: 'ui-surface',
        summary: `UI surface "${component.surface}" has no direct DSH equivalent`,
        detail: 'It can be shown as a diagnostic or rewritten as a DSH slot adapter; not rendered as the original UI.',
        suggestedAction: 'rewrite',
      })
    }
  }
  // A user's or project's own assets need no license to use or move.
  if (plugin.license === undefined && plugin.manifest['scope'] !== 'user' && plugin.manifest['scope'] !== 'project') {
    gaps.push({
      id: `${plugin.id}:license`,
      componentId: plugin.id,
      kind: 'license',
      summary: 'No license declared',
      detail: 'Local use is allowed; publishing or redistributing derived assets requires an explicit license decision.',
      suggestedAction: 'accept-difference',
    })
  }
  return gaps
}

/** The capability ceiling the plugin declares. */
export function targetLevels(plugin: ForeignPlugin): CompatibilityLevels {
  // A server its own configuration switches off is not something the plugin asks for.
  const counts = countComponents(plugin.components.filter(component => component.kind !== 'mcp' || component.notStarted?.reason !== 'disabled'))
  const assets: CompatibilityLevel = counts.command + counts.agent > 0
    ? 'L1b'
    : counts.skill + counts.mcp > 0 ? 'L1a' : 'L0'
  const runtime: CompatibilityLevel = counts.hooks + counts.mcp + counts.command + counts.agent > 0 ? 'L2' : 'L0'
  return {
    discovery: 'L0',
    assets,
    declarativeRuntime: runtime,
    codeRuntime: counts.code > 0 ? 'L3' : 'L0',
    interaction: counts.ui > 0 ? 'L4' : 'L0',
  }
}

/**
 * Compute the honest vector.
 * @param plugin - scanned plugin.
 * @param outcomes - what apply/runtime probes actually did; omitted means scan-only.
 */
export function assess(plugin: ForeignPlugin, outcomes: readonly ComponentOutcome[] = []): CompatibilityVector {
  const target = targetLevels(plugin)
  const achieved = achievedLevels(plugin, outcomes)
  const verified = new Set(outcomes.filter(outcome => outcome.status === 'verified').map(outcome => outcome.componentId))
  const gaps = collectGaps(plugin).filter((gap) => {
    if (gap.componentId === undefined || !verified.has(gap.componentId)) return true
    // Verification resolves the reason a component could not run; structural
    // differences such as unsupported hook handlers still stand.
    return gap.kind !== 'missing-host-api' && gap.kind !== 'unsupported-transport'
  })
  for (const outcome of outcomes) {
    if (outcome.status !== 'failed') continue
    gaps.push({
      id: `${outcome.componentId}:runtime-failure`,
      componentId: outcome.componentId,
      kind: 'runtime-failure',
      summary: outcome.message ?? 'Component failed to mount or run',
      detail: 'The component is installed but not active; other components may still work.',
      suggestedAction: 'bridge',
    })
  }
  const counts = countComponents(plugin.components)
  const hasCode = counts.code > 0
  const hasUi = counts.ui > 0
  const hasDeclarative = counts.skill + counts.mcp + counts.command + counts.agent + counts.hooks > 0
  const mode: CompatibilityMode = hasCode || hasUi
    ? (hasDeclarative ? 'mixed' : 'host')
    : 'migrate'
  const evidence = outcomes.some(outcome => outcome.status === 'verified') ? 'runtime' : 'source'
  return {
    target,
    achieved,
    mode,
    evidence,
    gaps,
    license: plugin.license ?? 'unknown',
    contextCost: estimateContextCost(plugin),
  }
}

/** Observations of a plugin's code calling the host: OpenCode `client` routes, a mod's `$` calls. */
const HOST_API_SIGNAL = /^(opencode:client:|modcall:)/u

function achievedLevels(plugin: ForeignPlugin, outcomes: readonly ComponentOutcome[]): CompatibilityLevels {
  const kinds = new Map<string, ForeignComponent['kind']>()
  for (const component of plugin.components) kinds.set(component.id, component.kind)
  let assets: CompatibilityLevel = 'L0'
  let runtime: CompatibilityLevel = 'L0'
  let code: CompatibilityLevel = 'L0'
  let interaction: CompatibilityLevel = 'L0'
  for (const outcome of outcomes) {
    if (outcome.status === 'failed' || outcome.status === 'skipped' || outcome.status === 'inactive') continue
    const kind = kinds.get(outcome.componentId)
    if (kind === undefined) continue
    if (kind === 'skill' || kind === 'mcp') {
      if (assets !== 'L1b') assets = 'L1a'
    }
    if (kind === 'command' || kind === 'agent') assets = 'L1b'
    const verified = outcome.status === 'verified'
    if (kind === 'mcp' || kind === 'command' || kind === 'agent' || kind === 'hooks') {
      if (verified) runtime = 'L2'
      else if (runtime === 'L0') runtime = 'L1b'
    }
    // L3: the plugin's code called the host's API and the call succeeded (an OpenCode `client` route,
    // a mod's `$` call), not merely ran.
    if (kind === 'code' && verified && (outcome.observations ?? []).some(item => item.ok && HOST_API_SIGNAL.test(item.signal))) code = 'L3'
    if (kind === 'ui' && verified) interaction = 'L4'
  }
  return { discovery: 'L0', assets, declarativeRuntime: runtime, codeRuntime: code, interaction }
}
