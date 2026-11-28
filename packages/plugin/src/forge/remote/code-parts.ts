/**
 * The parts of a plugin that would run code, as an install confirmation
 * lists them: hooks with their events, MCP servers with their command, shell
 * lines of commands and skills, status line and other scripts, code plugins,
 * environment a settings file sets, and agents that declare hooks or MCP
 * servers. Each says whether it runs in DSH once installed, or is a gap that
 * runs nothing (until an adapter is built), with the overview's reasons.
 * @module @kirkchinese/harness-forge
 */
import { relative } from 'node:path'
import { absolutePath, readText, type ForeignComponent, type ForeignPlugin, type Gap } from '@kirkchinese/harness-forge-core'
import { partOf, type OverviewPart } from '../../workbench/overview.js'

/** What runs: the Client words each in the person's language. */
export type CodeRunner = 'hooks' | 'mcp' | 'shell' | 'script' | 'code' | 'environment' | 'agent'

/** One part that would run code. */
export interface CodePart {
  readonly kind: string
  readonly name: string
  readonly what: CodeRunner
  /** The events, command, shell lines, script or runtime, as the plugin declares them. */
  readonly detail: string
  /** Whether it runs in DSH once installed; a gap runs nothing. */
  readonly runs: boolean
  /** Why it does not run, as the overview gives it. */
  readonly reasons?: OverviewPart['reasons']
}

/** Longest detail shown for one part: a command line or a list of shell lines, enough to tell what it starts. */
const DETAIL_LIMIT = 160
/** Overview states in which a part runs in DSH, wholly or in part. */
const RUNNING_STATES: ReadonlySet<OverviewPart['state']> = new Set(['works', 'partial'])
/** Surfaces that are text or colours DSH applies itself, not a program the plugin starts. */
const TEXT_SURFACES: ReadonlySet<string> = new Set(['output-style', 'theme'])
/** `other` parts that start nothing here: instructions, and connectors OpenAI hosts. */
const INERT_OTHER: ReadonlySet<string> = new Set(['codex-instructions', 'app-connector'])
/** An inline `` !`cmd` `` or a fenced ```` ```! ```` block (see core `hasShellDirective`). */
const SHELL_LINES = /^```!\s*\n([^]*?)^```|(?:^|\s)!`([^`\n]+)`/gmu

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= DETAIL_LIMIT ? flat : `${flat.slice(0, DETAIL_LIMIT - 1)}…`
}

/** The shell lines of a command or skill body, in order. */
function shellLines(body: string): string[] {
  return [...body.matchAll(SHELL_LINES)].map(match => (match[1] ?? match[2] ?? '').trim()).filter(line => line.length > 0)
}

/** A file of the plugin as the person would find it in its folder. */
function inPlugin(root: string, path: string): string {
  const relativePath = relative(root, absolutePath(root, path))
  return relativePath.startsWith('..') ? path : relativePath.split('\\').join('/')
}

/** What a part runs, or undefined for one that only adds text. */
function runnerOf(plugin: ForeignPlugin, component: ForeignComponent): { what: CodeRunner; detail: string } | undefined {
  switch (component.kind) {
    case 'hooks': return { what: 'hooks', detail: component.events.join(', ') }
    case 'mcp': return { what: 'mcp', detail: component.command !== undefined ? [component.command, ...(component.args ?? [])].join(' ') : component.url ?? component.transport }
    case 'command':
    case 'skill': {
      const lines = shellLines(component.kind === 'command' ? component.body : readText(component.bodyPath) ?? '')
      return lines.length > 0 ? { what: 'shell', detail: lines.join('; ') } : undefined
    }
    case 'code': return { what: 'code', detail: `${component.runtime}${component.entryPath !== undefined ? ` ${inPlugin(plugin.root, component.entryPath)}` : ''}` }
    case 'ui': {
      if (TEXT_SURFACES.has(component.surface)) return undefined
      const statusLine = component.metadata?.['statusLine'] as { command?: unknown } | undefined
      const script = typeof statusLine?.command === 'string' ? statusLine.command : component.specPath ?? component.path
      return { what: 'script', detail: script !== undefined ? inPlugin(plugin.root, script) : component.surface }
    }
    case 'settings': {
      const names = Object.keys(component.env)
      return names.length > 0 ? { what: 'environment', detail: names.join(', ') } : undefined
    }
    case 'agent': {
      const declared = ['hooks', 'mcpServers'].filter(key => component.frontmatter[key] !== undefined)
      return declared.length > 0 ? { what: 'agent', detail: declared.join(', ') } : undefined
    }
    case 'other': return INERT_OTHER.has(component.originalKind) ? undefined : { what: 'script', detail: component.originalKind }
    default: return undefined
  }
}

/** The parts of a plugin that would run code, and whether each runs in DSH once installed. */
export function codePartsOf(plugin: ForeignPlugin, gaps: readonly Gap[]): CodePart[] {
  return plugin.components.flatMap((component): CodePart[] => {
    const runner = runnerOf(plugin, component)
    if (runner === undefined) return []
    const part = partOf(component, gaps, undefined, undefined)
    const runs = RUNNING_STATES.has(part.state)
    return [{ kind: component.kind, name: component.name, what: runner.what, detail: clip(runner.detail), runs, ...(!runs && part.reasons.length > 0 ? { reasons: part.reasons } : {}) }]
  })
}
