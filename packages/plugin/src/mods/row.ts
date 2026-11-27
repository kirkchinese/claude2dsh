/**
 * The mods row: Claude Code mods, one engine per root session. Its hooks wrap
 * everything Claude Code itself does, so it hooks `tool.check` into the hooks
 * row's permission decision when that row runs; the hooks row knows nothing
 * of mods.
 * @module @kirkchinese/harness-forge/mods
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@kirkchinese/harness-forge-core'
import type { Disposer, ModsApi } from '../forge/contract.js'
import { FORGE_SERVICE, type HarnessForge } from '../forge/service.js'
import { loggerOf, messageOf } from '../shared/util.js'
import { bundlerInstalled, bundlerPrefix, ensureBundler, ROLLDOWN_VERSION } from './bundler.js'
import { mountClaudeMod } from './claude.js'
import type { Bundler } from './loader.js'
import { ModsService } from './service.js'
import { mounted, Parts, rowEffect } from '../forge/row.js'

export const name = 'harness-forge-mods'
export const inject = [FORGE_SERVICE]

/** The mods row. */
export function apply(ctx: Context): void {
  rowEffect(ctx, 'mods', forge => startMods(ctx, forge))
}

/** Start the mods row on the shared service. Returns its teardown. */
export function startMods(ctx: Context, forge: HarnessForge): Disposer {
  const mods = new ModsService(ctx, {
    shell: forge.shell,
    storeRoot: join(forge.dataRoot, 'mod-store'),
    disposedLog: join(forge.dataRoot, 'mods-disposed.jsonl'),
    directory: (agent, signal) => forge.directory(agent, signal),
    settings: (session, source) => forge.settings.claudeSettings(session, source),
    rewrite: (callId, args) => { forge.lookup('hooks')?.rewrite(callId, args) },
    agentName: presetId => forge.lookup('agents')?.foreignName(presetId),
    presetOf: foreignName => forge.lookup('agents')?.presetOf(foreignName),
    observe: (componentId, event) => {
      if (event.startsWith('call:')) forge.observe(componentId, `modcall:${event.slice('call:'.length)}`, true, `the mod called $.${event.slice('call:'.length)}`)
      else forge.observe(componentId, `mod:${event}`, true, `a hook ran for ${event}`)
    },
  })
  const api: ModsApi = {
    watch: (sessionId, listener) => mods.watch(sessionId, listener),
    act: (sessionId, generation, actionId, value) => mods.act(sessionId, generation, actionId, value),
    closePane: (sessionId, id) => mods.closePane(sessionId, id),
    move: (sessionId, kind, target) => mods.move(sessionId, kind, target),
  }

  // The first mod waits for the bundler's install; a failed install is the mods row's fault and that mod's
  // failure, and the row runs on (the next mod tries the install again).
  const bundler = async (): Promise<Bundler> => {
    if (!bundlerInstalled(forge.dataRoot)) loggerOf(ctx)?.info?.(`harness-forge: mods: waiting for the bundler (installing rolldown ${ROLLDOWN_VERSION} into ${bundlerPrefix(forge.dataRoot)})`)
    try {
      return await ensureBundler(forge.dataRoot)
    } catch (error: unknown) {
      forge.fault('mods', error)
      throw new HarnessError('component-failed', messageOf(error))
    }
  }

  const parts = new Parts(ctx, forge, 'mods')
  parts.add('engine', () => mods.install())
  // Torn down before the engine: every live session's mods hear `session.end` while the listeners are there.
  parts.add('session end', () => () => mods.shutdown())
  parts.add('tool.check', () => forge.watch('hooks', hooks => hooks.setChecker({
    checks: exec => mods.checks(exec as never),
    check: (exec, verdict) => mods.check(exec as never, verdict),
  })))
  parts.add('mod mounter', () => forge.registerMounter('claude-mod', {
    mount: async ({ component, plugin }) => {
      if (component.kind !== 'code') throw new HarnessError('component-failed', `action expects code: ${component.id}`)
      const mount = await mountClaudeMod(mods, component, plugin, bundler)
      return { outcome: mounted(component, 'L1b', `claude-mod ${mount.name} (${mount.tier})`), disposer: mount.dispose }
    },
  }))
  parts.add('api', () => forge.provide('mods', api))
  return () => parts.dispose()
}
