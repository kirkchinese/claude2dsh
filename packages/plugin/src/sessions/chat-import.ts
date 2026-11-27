/**
 * dsh-chat-import, the dedicated session importer for DSH (Claude Code, Codex, OpenCode and 40+ other agents):
 * Harness Forge recommends it, installs it on request through DSH's plugin manager, and yields its own import
 * to it while it runs. Detected by the service it provides (`chatImport`); Harness Forge does not depend on it.
 * @module @kirkchinese/harness-forge
 */
import type { Context } from '@deepseek-ai/cordis'
import { dshService } from '../dsh/host.js'

/** Its npm package, which is also its bundle name. */
export const CHAT_IMPORT_PACKAGE = 'dsh-chat-import'

/** The command that installs it into the web profile when the plugin manager is not reachable. */
export const CHAT_IMPORT_COMMAND = `dsh plugin --profile web add ${CHAT_IMPORT_PACKAGE}`

/** What Harness Forge's import answers while dsh-chat-import runs. */
export const YIELD_MESSAGE = 'Session import is provided by dsh-chat-import: use its Import sessions button in the sidebar.'

/** Whether dsh-chat-import runs in this DSH. */
export function chatImportRunning(ctx: object): boolean {
  return dshService(ctx, 'chatImport') !== undefined
}

/** Where session import stands, for the workbench. */
export interface SessionImportStatus {
  /** Who imports sessions: Harness Forge, or dsh-chat-import while it runs. */
  readonly provider: 'harness-forge' | 'dsh-chat-import'
  /** Whether Harness Forge can install dsh-chat-import itself (DSH's plugin manager is there). */
  readonly canInstall: boolean
  readonly command: string
}

export function sessionImportStatus(ctx: object): SessionImportStatus {
  const manager = dshService(ctx, 'pluginManager') as Partial<PluginManager> | undefined
  return {
    provider: chatImportRunning(ctx) ? 'dsh-chat-import' : 'harness-forge',
    canInstall: typeof manager?.installBundle === 'function',
    command: CHAT_IMPORT_COMMAND,
  }
}

interface ChangeResult {
  readonly changed: boolean
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly error?: { readonly code: string; readonly diagnostic?: string }
  readonly pendingBuilds?: readonly string[]
  /** The bundle an installation added. */
  readonly bundle?: string
}

interface PluginManager {
  listBundles(): Promise<ReadonlyArray<{ readonly name: string; readonly enabled: boolean; readonly installed?: boolean }>>
  installBundle(spec: string, options?: { enabled?: boolean }): Promise<ChangeResult>
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>
}

/** How an installation ended. */
export interface ChatImportInstall {
  /** `applied`: it runs now; `restart-required`: it runs after DSH restarts. */
  readonly application: ChangeResult['application']
  readonly running: boolean
}

/**
 * Install dsh-chat-import from npm and enable it, through DSH's plugin manager, the way the Plugins page does; an
 * installed but disabled copy is enabled. The browser asks the person first. Throws with the reason, and the
 * command to run instead, when it cannot.
 */
export async function installChatImport(ctx: Context): Promise<ChatImportInstall> {
  const manager = dshService(ctx, 'pluginManager') as Partial<PluginManager> | undefined
  if (typeof manager?.installBundle !== 'function') throw new Error(`DSH's plugin manager is not available here; install dsh-chat-import from the Plugins page, or run: ${CHAT_IMPORT_COMMAND}`)
  if (chatImportRunning(ctx)) return { application: 'applied', running: true }
  const listed = typeof manager.listBundles === 'function' ? (await manager.listBundles()).find(bundle => bundle.name === CHAT_IMPORT_PACKAGE) : undefined
  const result = listed !== undefined && listed.installed !== false && typeof manager.setBundleEnabled === 'function'
    ? await manager.setBundleEnabled(CHAT_IMPORT_PACKAGE, true)
    : await manager.installBundle(CHAT_IMPORT_PACKAGE, { enabled: true })
  // A profile whose other entries fail to activate reports that as the change's error too; dsh-chat-import itself
  // was added when the manager names it as the bundle, or when its service runs.
  const added = result.bundle === CHAT_IMPORT_PACKAGE || chatImportRunning(ctx)
  if (result.application === 'failed' || result.application === 'cancelled' || (result.error !== undefined && !added)) {
    const builds = result.pendingBuilds !== undefined && result.pendingBuilds.length > 0 ? ` (its install scripts wait for approval: ${result.pendingBuilds.join(', ')})` : ''
    const reason = result.error?.diagnostic ?? result.error?.code ?? result.application
    throw new Error(`dsh-chat-import was not installed: ${reason}${builds}. Install it from the Plugins page, or run: ${CHAT_IMPORT_COMMAND}`)
  }
  return { application: result.application, running: chatImportRunning(ctx) }
}
