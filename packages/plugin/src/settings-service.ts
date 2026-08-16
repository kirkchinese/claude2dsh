/** Durable Claude2DSH settings namespace + web transport facade. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { PluginConfig } from './index.ts'

export const CLAUDE2DSH_SETTINGS_NS = settingsNamespace('claude2dsh')

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
}

export function defaultClaude2dshSettings(): Claude2DshSettings {
  return {
    autoSync: { enabled: false, claudeProjectsRoot: '', debounceMs: 500, dshToClaude: true },
    importDefaults: { imageMode: 'auto', imageProvider: 'deepseek-official', imageModel: 'deepseek-v4-flash', includeSubagents: false, sidecarMaxBytes: 64 * 1024 * 1024 },
    writeback: { target: 'copy', allowOriginalClaudeDir: false, exportDir: '' },
    hooks: { configPath: '', pluginRoot: '', projectDir: '' },
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
    imageProvider: z.string().default('deepseek-official'),
    imageModel: z.string().default('deepseek-v4-flash'),
    includeSubagents: z.boolean().default(false),
    sidecarMaxBytes: z.number().step(1).min(1).default(64 * 1024 * 1024),
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

export interface SettingsRuntime {
  readonly initial: Claude2DshSettings
  scope: SettingsScope<Claude2DshSettings> | undefined
  get(): Claude2DshSettings
  update(patch: object): Promise<void>
}

/**
 * Register the settings namespace when the host settings provider exists.
 * The scope layers schema defaults, the bundle entry config base, and the
 * user settings document. Without a provider the runtime stays on the
 * boot-time bundle config, so headless/test compositions keep working.
 */
export function createSettingsRuntime(ctx: Context, config: PluginConfig): SettingsRuntime {
  const initial = fromConfig(config)
  const runtime: SettingsRuntime = {
    initial,
    scope: undefined,
    get: () => runtime.scope?.get() ?? runtime.initial,
    update: async (patch) => {
      if (runtime.scope === undefined) throw new Error('Claude2DSH settings provider is not mounted in this profile')
      await runtime.scope.update(patch)
    },
  }
  ctx.inject(['settings'], (ready) => {
    runtime.scope = ready.settings.register(CLAUDE2DSH_SETTINGS_NS, claude2dshSettingsSchema, { base: runtime.initial, applies: 'live' })
  })
  return runtime
}
