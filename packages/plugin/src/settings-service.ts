/**
 * Durable Claude2DSH settings + web transport facade.
 *
 * DSH 0.1.x exposed a namespaced settings registry (`settings.register`) that
 * persisted plugin documents and notified watchers. DSH 0.2.x replaced it with
 * Config-derived profile forms and no longer accepts foreign namespaces, so on
 * those hosts the same document is persisted in a plugin-owned file below
 * `$DSH_HOME/claude2dsh`. Both backends expose one {@link SettingsRuntime}.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PluginConfig } from './index.ts'
import { registryDir } from './registry.ts'

/** Settings namespace owned by this plugin; the host validates its format. */
export const CLAUDE2DSH_SETTINGS_NS = 'claude2dsh' as const

export interface Claude2DshSettings {
  readonly autoSync: {
    readonly enabled: boolean
    readonly claudeProjectsRoot: string
    readonly debounceMs: number
    readonly dshToClaude: boolean
  }
  readonly importDefaults: {
    readonly imageMode: 'auto' | 'placeholder' | 'native'
    readonly imageProvider: string
    readonly imageModel: string
    readonly includeSubagents: boolean
    readonly sidecarMaxBytes: number
    readonly recursive: boolean
  }
  readonly writeback: {
    readonly target: 'copy' | 'source'
    readonly allowOriginalClaudeDir: boolean
    readonly exportDir: string
  }
  readonly hooks: {
    readonly configPath: string
    readonly pluginRoot: string
    readonly projectDir: string
  }
  readonly ui: {
    readonly language: 'zh' | 'en'
  }
}

export function defaultClaude2dshSettings(): Claude2DshSettings {
  return {
    autoSync: { enabled: false, claudeProjectsRoot: '', debounceMs: 500, dshToClaude: true },
    importDefaults: { imageMode: 'auto', imageProvider: '', imageModel: '', includeSubagents: false, sidecarMaxBytes: 64 * 1024 * 1024, recursive: true },
    writeback: { target: 'copy', allowOriginalClaudeDir: false, exportDir: '' },
    hooks: { configPath: '', pluginRoot: '', projectDir: '' },
    ui: { language: 'zh' },
  }
}

export const claude2dshSettingsSchema: z<Claude2DshSettings> = z.object({
  autoSync: z.object({
    enabled: z.boolean().default(false),
    claudeProjectsRoot: z.string().default(''),
    debounceMs: z.number().step(1).min(50).default(500),
    dshToClaude: z.boolean().default(true),
  }),
  importDefaults: z.object({
    imageMode: z.union(['auto', 'placeholder', 'native'] as const).default('auto'),
    imageProvider: z.string().default(''),
    imageModel: z.string().default(''),
    includeSubagents: z.boolean().default(false),
    sidecarMaxBytes: z.number().step(1).min(1).default(64 * 1024 * 1024),
    recursive: z.boolean().default(true),
  }),
  writeback: z.object({
    target: z.union(['copy', 'source'] as const).default('copy'),
    allowOriginalClaudeDir: z.boolean().default(false),
    exportDir: z.string().default(''),
  }),
  hooks: z.object({
    configPath: z.string().default(''),
    pluginRoot: z.string().default(''),
    projectDir: z.string().default(''),
  }),
  ui: z.object({
    language: z.union(['zh', 'en'] as const).default('zh'),
  }),
})

function fromConfig(config: PluginConfig): Claude2DshSettings {
  const base = defaultClaude2dshSettings()
  const auto = config.autoSync
  return {
    ...base,
    autoSync: {
      ...base.autoSync,
      enabled: auto?.enabled ?? false,
      ...(auto?.claudeProjectsRoot !== undefined ? { claudeProjectsRoot: auto.claudeProjectsRoot } : {}),
      ...(auto?.debounceMs !== undefined ? { debounceMs: auto.debounceMs } : {}),
      ...(auto?.dshToClaude !== undefined ? { dshToClaude: auto.dshToClaude } : {}),
    },
  }
}

/** Live settings scope shared by the host-registry and file backends. */
export interface SettingsScopeLike<T> {
  get(): T
  update(patch: object): Promise<void>
  watch(listener: (next: T) => void): () => void
}

/** DSH 0.1.x settings registry; absent from DSH 0.2.x `SettingsForms`. */
interface LegacySettingsRegistry {
  register<T>(ns: string, schema: z<T>, options: { base: T; applies: 'live' }): SettingsScopeLike<T>
}

export interface SettingsRuntime {
  readonly initial: Claude2DshSettings
  scope: SettingsScopeLike<Claude2DshSettings> | undefined
  get(): Claude2DshSettings
  update(patch: object): Promise<void>
  /** Observe every committed change; returns a disposer. */
  watch(listener: (next: Claude2DshSettings) => void): () => void
}

/** File holding the user layer of the settings document on hosts without a settings registry. */
export function settingsFilePath(dshHome?: string): string {
  return join(registryDir(dshHome), 'settings.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Merge `patch` into `base` recursively; arrays and scalars replace. */
export function mergeSettingsPatch(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    out[key] = mergeSettingsPatch(base[key], value)
  }
  return out
}

function readUserDocument(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isPlainObject(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Settings scope persisted in a plugin-owned JSON file. Layers schema defaults,
 * the bundle entry config base and the stored user document; every update is
 * validated against the full schema before it is written atomically.
 * @param base - boot-time bundle config layer.
 * @param path - user document location.
 * @returns a live scope with change notifications.
 */
export function createFileSettingsScope(base: Claude2DshSettings, path: string): SettingsScopeLike<Claude2DshSettings> {
  const listeners = new Set<(next: Claude2DshSettings) => void>()
  let user = readUserDocument(path)
  const resolve = (layer: Record<string, unknown>): Claude2DshSettings => claude2dshSettingsSchema(mergeSettingsPatch(base, layer) as Claude2DshSettings)
  let current: Claude2DshSettings
  try {
    current = resolve(user)
  } catch {
    user = {}
    current = resolve(user)
  }
  return {
    get: () => current,
    update: async (patch) => {
      const nextUser = mergeSettingsPatch(user, patch) as Record<string, unknown>
      const next = resolve(nextUser)
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(nextUser, null, 2) + '\n', { mode: 0o600 })
      renameSync(temp, path)
      user = nextUser
      current = next
      for (const listener of listeners) listener(current)
    },
    watch: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * Create the settings runtime. With a DSH 0.1.x settings registry the scope is
 * registered as the `claude2dsh` namespace; otherwise (DSH 0.2.x, headless or
 * test compositions) the plugin-owned file scope is used. Watchers attached to
 * the runtime survive a backend switch.
 */
export function createSettingsRuntime(ctx: Context, config: PluginConfig, filePath: string = settingsFilePath()): SettingsRuntime {
  const initial = fromConfig(config)
  const listeners = new Set<(next: Claude2DshSettings) => void>()
  let detach: (() => void) | undefined
  const attach = (scope: SettingsScopeLike<Claude2DshSettings>): void => {
    detach?.()
    runtime.scope = scope
    detach = scope.watch((next) => { for (const listener of listeners) listener(next) })
  }
  const runtime: SettingsRuntime = {
    initial,
    scope: undefined,
    get: () => runtime.scope?.get() ?? runtime.initial,
    update: async (patch) => {
      if (runtime.scope === undefined) throw new Error('Claude2DSH settings are not available in this profile')
      await runtime.scope.update(patch)
    },
    watch: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const fileScope = createFileSettingsScope(initial, filePath)
  attach(fileScope)
  ctx.inject(['settings'], (ready) => {
    const registry = (ready as unknown as { settings: Partial<LegacySettingsRegistry> }).settings
    if (typeof registry.register !== 'function') return
    attach(registry.register(CLAUDE2DSH_SETTINGS_NS, claude2dshSettingsSchema, { base: runtime.initial, applies: 'live' }))
    for (const listener of listeners) listener(runtime.get())
    ready.effect(() => () => {
      attach(fileScope)
      for (const listener of listeners) listener(runtime.get())
    })
  })
  return runtime
}
