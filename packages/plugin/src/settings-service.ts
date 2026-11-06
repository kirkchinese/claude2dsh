/** Durable DSH2Claude settings namespace plus the web transport facade. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { PluginConfig } from './index.ts'

export const DSH2CLAUDE_SETTINGS_NS = 'dsh2claude' as const

export interface Dsh2ClaudeSettings {
  readonly sessions: {
    /** Empty means `$DSH_HOME`. */
    readonly dshHome: string
    /** Empty means `<dshHome>/sessions`. */
    readonly root: string
    readonly recursive: boolean
    readonly includeSubagents: boolean
  }
  readonly assets: {
    readonly skills: boolean
    readonly instructions: boolean
    readonly mcp: boolean
  }
  readonly install: {
    /** Empty means `CLAUDE_CONFIG_DIR` or `~/.claude`. */
    readonly claudeHome: string
    readonly overwrite: boolean
  }
  readonly ui: {
    readonly language: 'zh' | 'en'
  }
}

export function defaultDsh2ClaudeSettings(): Dsh2ClaudeSettings {
  return {
    sessions: { dshHome: '', root: '', recursive: true, includeSubagents: false },
    assets: { skills: true, instructions: true, mcp: true },
    install: { claudeHome: '', overwrite: false },
    ui: { language: 'zh' },
  }
}

export const dsh2ClaudeSettingsSchema: z<Dsh2ClaudeSettings> = z.object({
  sessions: z.object({
    dshHome: z.string().default(''),
    root: z.string().default(''),
    recursive: z.boolean().default(true),
    includeSubagents: z.boolean().default(false),
  }),
  assets: z.object({
    skills: z.boolean().default(true),
    instructions: z.boolean().default(true),
    mcp: z.boolean().default(true),
  }),
  install: z.object({
    claudeHome: z.string().default(''),
    overwrite: z.boolean().default(false),
  }),
  ui: z.object({
    language: z.union(['zh', 'en'] as const).default('zh'),
  }),
})

function fromConfig(config: PluginConfig): Dsh2ClaudeSettings {
  const base = defaultDsh2ClaudeSettings()
  return {
    ...base,
    sessions: {
      ...base.sessions,
      ...(config.dshHome !== undefined ? { dshHome: config.dshHome } : {}),
      ...(config.includeSubagents !== undefined ? { includeSubagents: config.includeSubagents } : {}),
    },
    install: {
      ...base.install,
      ...(config.claudeHome !== undefined ? { claudeHome: config.claudeHome } : {}),
    },
  }
}

export interface SettingsRuntime {
  readonly initial: Dsh2ClaudeSettings
  scope: SettingsScope<Dsh2ClaudeSettings> | undefined
  get(): Dsh2ClaudeSettings
  update(patch: object): Promise<void>
}

/**
 * Register the settings namespace when the host settings provider exists.
 * Without one the runtime stays on the bundle config, so headless profiles
 * keep working with defaults.
 */
export function createSettingsRuntime(ctx: Context, config: PluginConfig = {}): SettingsRuntime {
  const initial = fromConfig(config)
  const runtime: SettingsRuntime = {
    initial,
    scope: undefined,
    get: () => runtime.scope?.get() ?? runtime.initial,
    update: async (patch) => {
      if (runtime.scope === undefined) throw new Error('Dsh2Claude settings provider is not mounted in this profile')
      await runtime.scope.update(patch)
    },
  }
  ctx.inject(['settings'], (ready) => {
    runtime.scope = ready.settings.register(DSH2CLAUDE_SETTINGS_NS, dsh2ClaudeSettingsSchema, { base: runtime.initial, applies: 'live' })
  })
  return runtime
}
