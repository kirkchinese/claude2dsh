/**
 * Read-only Claude Code plugin inventory plus optional declarative-asset
 * migration. Runtime hooks/app-server code is never executed or copied.
 * @module @claude2dsh/plugin
 */
import { mkdir, readFile, readdir, stat, copyFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { safeSkillName } from './name-utils.ts'

export interface PluginInventoryArgs {
  readonly path?: string
  readonly apply?: boolean
}

export interface PluginInventoryResult {
  readonly root: string
  readonly installedPlugins: number
  readonly marketplaces: number
  readonly skills: number
  readonly commands: number
  readonly agents: number
  readonly prompts: number
  readonly hookFiles: number
  readonly migratedSkills: number
  readonly dryRun: boolean
  readonly details: readonly {
    readonly plugin: string
    readonly version?: string
    readonly path: string
    readonly skills: number
    readonly commands: number
    readonly agents: number
    readonly prompts: number
    readonly hookFiles: number
  }[]
}

interface JsonMap {
  readonly [key: string]: unknown
}

function isObject(value: unknown): value is JsonMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveRoot(path: string | undefined, env: NodeJS.ProcessEnv): string {
  if (path !== undefined && path.length > 0) return path
  if (env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR.length > 0) return join(env.CLAUDE_CONFIG_DIR, 'plugins')
  return join(homedir(), '.claude', 'plugins')
}

async function readJson(path: string): Promise<JsonMap | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

async function countFiles(root: string, names: readonly string[]): Promise<number> {
  const counts = await Promise.all(names.map(async (name) => {
    const dir = join(root, name)
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) return 0
      let count = 0
      async function walk(current: string): Promise<void> {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const absolute = join(current, entry.name)
          if (entry.isDirectory()) await walk(absolute)
          else if (entry.isFile()) count += 1
        }
      }
      await walk(dir)
      return count
    } catch {
      return 0
    }
  }))
  return counts.reduce((sum, value) => sum + value, 0)
}

async function findFiles(root: string, suffix: string): Promise<string[]> {
  const out: string[] = []
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const absolute = join(root, entry.name)
      if (entry.isDirectory()) out.push(...await findFiles(absolute, suffix))
      else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(absolute)
    }
  } catch {
    return out
  }
  return out
}

async function migrateSkill(filePath: string, namespace: string, destination: string): Promise<boolean> {
  try {
    const body = await readFile(filePath, 'utf8')
    const match = /^---\n([\s\S]*?)\n---\n?/.exec(body)
    const meta = match?.[1] === undefined ? {} : (parseYaml(match[1]) as JsonMap | undefined) ?? {}
    const rawName = typeof meta.name === 'string' ? meta.name : basename(filePath).replace(/\.md$/i, '')
    const description = typeof meta.description === 'string' && meta.description.trim().length > 0 ? meta.description : `Migrated from Claude Code plugin ${namespace}: ${rawName}`
    const targetName = safeSkillName(namespace, rawName)
    if (targetName.length === 0) return false
    const target = join(destination, targetName, 'SKILL.md')
    await mkdir(dirname(target), { recursive: true })
    const frontmatter = `---\nname: ${targetName}\ndescription: ${JSON.stringify(description)}\n---\n\n`
    const bodyWithoutFrontmatter = match?.[1] === undefined ? body : body.slice(match[0].length)
    await writeFile(target, frontmatter + bodyWithoutFrontmatter, { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

/** Inventory installed plugins and optionally migrate their declarative skill assets. */
export async function inventoryClaudePlugins(args: PluginInventoryArgs, dshHome: string, env: NodeJS.ProcessEnv = process.env): Promise<PluginInventoryResult> {
  const root = resolveRoot(args.path, env)
  const installed = await readJson(join(root, 'installed_plugins.json'))
  const marketplaces = await readJson(join(root, 'known_marketplaces.json'))
  const plugins: { plugin: string; version?: string; path: string }[] = []
  const installedDoc = installed as { plugins?: JsonMap } | undefined
  const installedPlugins = isObject(installedDoc?.plugins) ? Object.keys(installedDoc.plugins) : []
  for (const key of installedPlugins) {
    const entries = installedDoc?.plugins?.[key]
    const entry = Array.isArray(entries) ? entries[0] : undefined
    if (isObject(entry) && typeof entry.installPath === 'string') {
      plugins.push({ plugin: key, ...(typeof entry.version === 'string' ? { version: entry.version } : {}), path: entry.installPath })
    }
  }

  const details = await Promise.all(plugins.map(async (plugin) => {
    const skills = (await findFiles(join(plugin.path, 'skills'), '.md')).filter((file) => basename(file) === 'SKILL.md').length
    const commands = await countFiles(plugin.path, ['commands'])
    const agents = await countFiles(plugin.path, ['agents'])
    const prompts = await countFiles(plugin.path, ['prompts'])
    const hookFiles = await countFiles(plugin.path, ['hooks'])
    return { plugin: plugin.plugin, ...(plugin.version !== undefined ? { version: plugin.version } : {}), path: plugin.path, skills, commands, agents, prompts, hookFiles }
  }))

  let migratedSkills = 0
  if (args.apply === true) {
    const destination = join(dshHome, 'skills')
    for (const plugin of plugins) {
      const skillsRoot = join(plugin.path, 'skills')
      const skillFiles = (await findFiles(skillsRoot, '.md')).filter((file) => basename(file) === 'SKILL.md')
      for (const file of skillFiles) {
        const namespace = plugin.plugin.split('@')[0] ?? 'plugin'
        if (await migrateSkill(file, namespace, destination)) migratedSkills += 1
      }
    }
  }

  void constants
  return {
    root,
    installedPlugins: plugins.length,
    marketplaces: isObject(marketplaces) ? Object.keys(marketplaces).length : 0,
    skills: details.reduce((sum, item) => sum + item.skills, 0),
    commands: details.reduce((sum, item) => sum + item.commands, 0),
    agents: details.reduce((sum, item) => sum + item.agents, 0),
    prompts: details.reduce((sum, item) => sum + item.prompts, 0),
    hookFiles: details.reduce((sum, item) => sum + item.hookFiles, 0),
    migratedSkills,
    dryRun: args.apply !== true,
    details,
  }
}
