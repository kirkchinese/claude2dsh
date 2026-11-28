/**
 * Porting a gap: Harness Forge writes the brief (see the core's
 * `portBrief`), puts the working protocol before it (`prompt.ts`) and hands
 * it to DSH's own creation mode, a new session on the
 * `cordis` preset that has the dsh-doc skill, runtime inspection and the
 * plugin manager. The authoring, testing and installing are that agent's.
 * @module @kirkchinese/harness-forge/porting
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ADAPTERS_DIR, absolutePath, detectLicense, portBrief, type ForeignComponent, type ForeignPlugin, type Gap, type PortRuntime } from '@kirkchinese/harness-forge-core'
import { dshService } from '../dsh/host.js'
import { resolveDshHome } from '../forge/state.js'
import { portPrompt } from './prompt.js'

/** The preset of DSH's creation mode ("Let the agent create a plugin" in the Plugin Manager). */
export const CREATOR_PRESET = 'cordis'

/** Most files a brief lists for one part. */
const FILE_LIMIT = 200
const SKIPPED_DIRS = new Set(['node_modules', '.git'])

/** Where a creation session runs: a DSH Workspace or an explicit directory, otherwise the adapters directory. */
export interface PortLocation {
  readonly workspaceId?: string
  readonly cwd?: string
}

/** The part of `sessionController` (`@deepseek-ai/dsh-api-session-controller`) a port uses. */
interface SessionControllerLike {
  create(request: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
  prompt(request: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: ReadonlyArray<{ type: 'text'; text: string }> }, signal: AbortSignal): Promise<unknown>
  rename?(request: { sessionId: string; title: string }): Promise<unknown>
}

/** The workspace of a directory (made when there is none), or undefined where the host has no workspace registry or refuses. */
async function workspaceOf(ctx: Context, cwd: string): Promise<string | undefined> {
  const registry = dshService(ctx, 'workspaceRegistry') as { create?(path: string): Promise<{ id?: unknown }> } | undefined
  if (typeof registry?.create !== 'function') return undefined
  try {
    const id = (await registry.create(cwd)).id
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/** The session title for a brief: its heading, without the Markdown marker DSH would otherwise show in the sidebar. */
export function briefTitle(brief: string): string {
  return (brief.split('\n', 1)[0] ?? '').replace(/^#+\s*/u, '').trim()
}

function filesUnder(path: string, out: string[]): void {
  if (out.length >= FILE_LIMIT || !existsSync(path)) return
  const stat = statSync(path)
  if (stat.isFile()) {
    if (!out.includes(path)) out.push(path)
    return
  }
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= FILE_LIMIT) return
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue
    filesUnder(join(path, entry.name), out)
  }
}

/**
 * The files of one part on disk: its own files, and the whole directory of a
 * skill or a code entry, whose neighbours it runs. A part declared in the
 * plugin's manifest itself lists the manifest.
 */
export function partFiles(plugin: ForeignPlugin, component: ForeignComponent): string[] {
  const out: string[] = []
  const paths: Array<string | undefined> = [component.path]
  switch (component.kind) {
    case 'skill': paths.push(component.resourceBase, component.bodyPath); break
    case 'command':
    case 'agent': paths.push(component.bodyPath); break
    case 'hooks': paths.push(component.configPath, ...component.modules); break
    case 'code': if (component.entryPath !== undefined) paths.push(component.entryPath, dirname(absolutePath(plugin.root, component.entryPath))); break
    case 'ui': paths.push(component.specPath); break
    case 'settings': paths.push(...component.files); break
    default: break
  }
  for (const path of paths) {
    if (path === undefined || path.length === 0) continue
    const absolute = absolutePath(plugin.root, path)
    // The plugin's root is not one part's files.
    if (resolve(absolute) !== resolve(plugin.root)) filesUnder(absolute, out)
  }
  if (!out.includes(plugin.ref.manifestPath) && existsSync(plugin.ref.manifestPath)) out.push(plugin.ref.manifestPath)
  return out
}

/**
 * The DSH home and profile this Harness Forge runs in, resolved as DSH does:
 * `$DSH_HOME` (a blank value is unset), else `~/.dsh`; the profile from the
 * `profileContext` service, which only a profile-launched DSH composes.
 */
export function portRuntime(ctx: Context, env: NodeJS.ProcessEnv = process.env): PortRuntime {
  const profile = dshService(ctx, 'profileContext') as { readonly name?: unknown; readonly dir?: unknown } | undefined
  const named = typeof profile?.name === 'string' && profile.name.length > 0 && typeof profile.dir === 'string' && profile.dir.length > 0
  return {
    dshHome: resolveDshHome(env),
    dshHomeFromEnv: (env.DSH_HOME?.trim() ?? '').length > 0,
    ...(named ? { profile: { name: profile.name as string, dir: profile.dir as string } } : {}),
  }
}

/** The brief for one part of a plugin, or a failure naming what is missing. */
export function briefFor(plugin: ForeignPlugin, gaps: readonly Gap[], componentId: string, runtime?: PortRuntime): string {
  const component = plugin.components.find(item => item.id === componentId)
  if (component === undefined) throw new Error(`${plugin.name} has no part ${componentId}`)
  const license = plugin.license ?? detectLicense(plugin.root)
  return portBrief({ plugin, component, gaps, files: partFiles(plugin, component), ...(license !== undefined ? { license } : {}), ...(runtime !== undefined ? { runtime } : {}) })
}

/** The first message of a part's port session: the protocol, then the brief (see `prompt.ts`). */
export function taskFor(plugin: ForeignPlugin, gaps: readonly Gap[], componentId: string, language?: string, runtime?: PortRuntime): string {
  const brief = briefFor(plugin, gaps, componentId, runtime)
  const component = plugin.components.find(item => item.id === componentId)!
  return portPrompt({ plugin, component, brief, ...(language !== undefined && language.length > 0 ? { language } : {}) })
}

/**
 * Start a creation-mode session and send it the task, as the Plugin
 * Manager's creation entry and a typed message would.
 * @param title - the session's name; the task's first line when absent.
 * @returns the new session's id.
 */
export async function startCreatorSession(ctx: Context, task: string, location: PortLocation = {}, title = briefTitle(task)): Promise<{ sessionId: string }> {
  const controller = dshService(ctx, 'sessionController') as SessionControllerLike | undefined
  if (controller === undefined) throw new Error('this DSH profile composes no session controller, so no creation session can be started; copy the brief into a session in creation mode instead')
  const presets = dshService(ctx, 'agentPresets') as { list?(): Promise<ReadonlyArray<{ id: string; broken?: unknown }>> } | undefined
  const creator = presets?.list === undefined ? undefined : (await presets.list()).find(preset => preset.id === CREATOR_PRESET)
  if (presets?.list !== undefined && (creator === undefined || creator.broken !== undefined)) {
    throw new Error(`creation mode (agent preset "${CREATOR_PRESET}") is ${creator === undefined ? 'not in this DSH profile' : 'unavailable in this DSH profile'}; copy the brief into a session instead`)
  }
  const cwd = location.cwd ?? join(homedir(), ADAPTERS_DIR)
  if (location.workspaceId === undefined && location.cwd === undefined) mkdirSync(cwd, { recursive: true })
  // DSH groups a session under the workspace whose path is its directory; without one the session lands in
  // "Ungrouped" among the person's own. The adapters directory gets a workspace named after the folder, reused by
  // every creation session.
  const workspaceId = location.workspaceId ?? await workspaceOf(ctx, cwd)
  const where = workspaceId !== undefined ? { workspaceId } : { cwd }
  const { sessionId } = await controller.create({ ...where, agentPreset: CREATOR_PRESET })
  // Named before the task is sent, so the sidebar shows the brief's heading rather than the protocol's first line. A title the host refuses only leaves DSH's own.
  if (title.length > 0) await controller.rename?.({ sessionId, title }).catch(() => undefined)
  await controller.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: task }] }, AbortSignal.timeout(60_000))
  return { sessionId }
}
