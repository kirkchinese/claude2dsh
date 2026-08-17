/** Read-only Claude Code hook discovery for the opt-in bridge. */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { resolveDshHome } from './registry.ts'

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const

export interface DiscoveredHook {
  readonly sourcePath: string
  readonly event: (typeof CLAUDE_HOOK_EVENTS)[number]
  readonly type: 'command' | string
  readonly command?: string
  readonly matcher?: string
  readonly timeout?: number
  readonly supported: boolean
  readonly reason?: string
}

export interface HookScanReport {
  readonly scannedFiles: number
  readonly supportedCommands: number
  readonly skipped: number
  readonly entries: DiscoveredHook[]
  readonly config: Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout?: number }> }>>
}

export function discoveredHooksPath(dshHome = resolveDshHome()): string {
  return join(dshHome, 'claude2dsh', 'discovered-hooks.json')
}

function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function walkFiles(root: string, maxDepth = 8): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) await walk(absolute, depth + 1)
      else if (entry.isFile() && (basename(absolute) === 'hooks.json' || /\.plugin\.json$/i.test(entry.name) || entry.name === 'plugin.json')) out.push(absolute)
    }
  }
  await walk(root, 0)
  return out.sort()
}

function hooksMapFrom(value: unknown): Record<string, unknown> | undefined {
  const root = asObject(value)
  if (root === undefined) return undefined
  const hooks = asObject(root.hooks)
  if (hooks !== undefined) return hooks
  // A bare Claude hooks.json is an event map.
  return root
}

function collectHook(root: unknown, sourcePath: string, out: DiscoveredHook[]): void {
  const map = hooksMapFrom(root)
  if (map === undefined) return
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = map[event]
    if (!Array.isArray(groups)) continue
    for (const rawGroup of groups) {
      const group = asObject(rawGroup)
      if (group === undefined) continue
      const matcher = typeof group.matcher === 'string' ? group.matcher : undefined
      const rawHooks = group.hooks
      if (!Array.isArray(rawHooks)) continue
      for (const rawHook of rawHooks) {
        const hook = asObject(rawHook)
        if (hook === undefined) continue
        const type = typeof hook.type === 'string' ? hook.type : 'command'
        const command = typeof hook.command === 'string' ? hook.command : undefined
        const timeout = typeof hook.timeout === 'number' ? hook.timeout : undefined
        if (type !== 'command') {
          out.push({ sourcePath, event, type, supported: false, reason: `only command hooks are supported by the upstream bridge; got type "${type}"` })
          continue
        }
        if (command === undefined) {
          out.push({ sourcePath, event, type, supported: false, reason: 'command hook is missing a command string' })
          continue
        }
        out.push({ sourcePath, event, type, command, ...(matcher !== undefined ? { matcher } : {}), ...(timeout !== undefined ? { timeout } : {}), supported: true })
      }
    }
  }
}

/**
 * Scan Claude settings.json/settings.local.json plus plugin manifests and
 * hooks.json files under the Claude plugins directory. Reads only; never
 * enables or writes anything.
 */
export async function discoverClaudeHooks(options: { configDir?: string; pluginRoot?: string; env?: NodeJS.ProcessEnv } = {}): Promise<HookScanReport> {
  const env = options.env ?? process.env
  const configDir = resolve(options.configDir ?? resolveConfigDir(env))
  const pluginRoot = resolve(options.pluginRoot ?? join(configDir, 'plugins'))
  const candidates = new Set<string>([join(configDir, 'settings.json'), join(configDir, 'settings.local.json')])
  for (const file of await walkFiles(pluginRoot)) candidates.add(file)

  const entries: DiscoveredHook[] = []
  let scannedFiles = 0
  for (const file of candidates) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    scannedFiles += 1
    try {
      collectHook(JSON.parse(text) as unknown, file, entries)
    } catch {
      entries.push({ sourcePath: file, event: 'SessionStart', type: 'command', supported: false, reason: 'invalid JSON in candidate file' })
    }
  }

  const config: HookScanReport['config'] = {}
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.supported || entry.command === undefined) continue
    const key = JSON.stringify([entry.event, entry.matcher ?? '', entry.command, entry.timeout ?? null])
    if (seen.has(key)) continue
    seen.add(key)
    const list = config[entry.event] ?? []
    const existing = list.find((group) => (group.matcher ?? '') === (entry.matcher ?? ''))
    const hook = { type: 'command' as const, command: entry.command, ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}) }
    if (existing !== undefined) existing.hooks.push(hook)
    else list.push({ ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}), hooks: [hook] })
    config[entry.event] = list
  }

  return {
    scannedFiles,
    supportedCommands: entries.filter((entry) => entry.supported).length,
    skipped: entries.filter((entry) => !entry.supported).length,
    entries,
    config,
  }
}

/** Persist a merged candidate (preview result only; activation stays opt-in). */
export async function saveDiscoveredHooks(config: HookScanReport['config'], dshHome = resolveDshHome()): Promise<string> {
  const path = discoveredHooksPath(dshHome)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ hooks: config }, null, 2) + '\n')
  return path
}
