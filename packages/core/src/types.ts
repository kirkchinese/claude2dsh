/**
 * Dialect-neutral model shared by every Harness Forge connector, planner and
 * runtime bridge. The model is intentionally JSON-serializable and free of DSH
 * imports so it can be tested and reused outside a running harness.
 * @module @kirkchinese/harness-forge-core
 */
import type { SourceFingerprint } from './contracts.js'

/** A supported foreign harness ecosystem. */
export type SourceId = 'claude-code' | 'codex' | 'opencode' | (string & {})

/** The manifest convention a plugin was read through. */
export type ManifestKind =
  | 'agent-plugins'
  | 'agent-skills'
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'package'
  | 'unknown'

/** Compatibility levels, from read-only discovery to interaction parity. */
export type CompatibilityLevel = 'L0' | 'L1a' | 'L1b' | 'L2' | 'L3' | 'L4'

/** How faithfully a component maps to a DSH-native capability. */
export type Fidelity = 'exact' | 'equivalent' | 'partial' | 'unsupported'

/** Evidence quality behind a claim. */
export type EvidenceLevel = 'contract' | 'source' | 'runtime' | 'inferred'

/** Execution mode: migrated into DSH, hosted beside it, or both. */
export type CompatibilityMode = 'migrate' | 'host' | 'mixed'

/** A stable reference to the artifact a plugin was discovered from. */
export interface SourceRef {
  readonly kind: SourceId
  /** Absolute plugin root. */
  readonly root: string
  /** Absolute path of the manifest actually read. */
  readonly manifestPath: string
  readonly manifestKind: ManifestKind
  /** Marketplace identity when the plugin came from one. */
  readonly market?: {
    readonly name: string
    readonly url?: string
    readonly ref?: string
  }
  /** Source-side revision facts. */
  readonly revision?: {
    readonly commit?: string
    readonly version?: string
    readonly mtimeMs?: number
  }
}

/** One plugin discovered from a foreign ecosystem. */
export interface ForeignPlugin {
  /** Stable id: `<source>:<name>`. */
  readonly id: string
  readonly source: SourceId
  readonly name: string
  /** The plugin's own name, when `name` carries a suffix that tells it from another installed plugin of the same name. What people see. */
  readonly displayName?: string
  readonly version?: string
  readonly description?: string
  readonly license?: string
  readonly homepage?: string
  readonly repository?: string
  readonly root: string
  readonly ref: SourceRef
  readonly components: readonly ForeignComponent[]
  /** Fingerprint captured by the scan; plans bind to this snapshot. */
  readonly fingerprint?: SourceFingerprint
  /** Non-fatal parsing or capability problems. */
  readonly warnings: readonly PluginWarning[]
  /** Raw manifest value retained for diagnostics and future upgrades. */
  readonly manifest: Readonly<Record<string, unknown>>
}

/** A non-fatal problem found while reading a plugin. */
export interface PluginWarning {
  readonly code: string
  readonly message: string
  readonly componentId?: string
  readonly path?: string
}

/** Common fields of every component. */
export interface ComponentBase {
  /** Stable id: `<pluginId>:<kind>:<name>`. */
  readonly id: string
  readonly kind: ComponentKind
  readonly name: string
  readonly path?: string
  readonly description?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type ComponentKind =
  | 'skill'
  | 'mcp'
  | 'command'
  | 'agent'
  | 'hooks'
  | 'code'
  | 'ui'
  | 'settings'
  | 'session'
  | 'memory'
  | 'other'

/** Agent Skills / Claude skill frontmatter, normalized to string keys. */
export interface SkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly license?: string
  readonly compatibility?: string
  readonly allowedTools?: readonly string[]
  readonly disallowedTools?: readonly string[]
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly raw: Readonly<Record<string, unknown>>
}

/** A skill directory bundle (`<name>/SKILL.md`). */
export interface SkillComponent extends ComponentBase {
  readonly kind: 'skill'
  readonly bodyPath: string
  readonly resourceBase: string
  readonly frontmatter: SkillFrontmatter
}

/** One MCP server entry. */
export interface McpComponent extends ComponentBase {
  readonly kind: 'mcp'
  /**
   * The server's name as its plugin or configuration declares it (`cua_repl`), which `name` (the name Forge
   * registers it under, `cua-repl`) may differ from: what the plugin's own hooks call it by.
   */
  readonly declaredName?: string
  readonly transport: 'stdio' | 'streamable-http' | 'sse' | 'unknown'
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  /** Only these tools may run (Codex `enabled_tools`). */
  readonly enabledTools?: readonly string[]
  /** These tools never run, applied after {@link enabledTools} (Codex `disabled_tools`). */
  readonly disabledTools?: readonly string[]
  /**
   * Which tool calls ask the user first (Codex `default_tools_approval_mode`
   * and `tools.<tool>.approval_mode`): `askByDefault` for every tool, `tools`
   * overriding it per tool.
   */
  readonly toolApproval?: { readonly askByDefault: boolean; readonly tools: Readonly<Record<string, boolean>> }
  /** How long the server may take to start and list its tools (Codex `startup_timeout_sec`). */
  readonly startupTimeoutMs?: number
  /** How long one tool call may run (Codex `tool_timeout_sec`). */
  readonly toolTimeoutMs?: number
  /**
   * Why DSH does not start this server: the configuration switched it off
   * (`disabled`), or it needs something DSH cannot provide (`unsupported`,
   * reported as a gap). `code` is what screens translate; `detail` is the
   * same in English, for logs, plans and agents.
   */
  readonly notStarted?: { readonly reason: 'disabled' | 'unsupported'; readonly code: McpNotStartedCode; readonly detail: string }
}

/** Why an MCP server is not started, as a code a screen words in the person's language. */
export type McpNotStartedCode = 'disabled-in-plugin' | 'disabled-in-config' | 'needs-chatgpt-sign-in'

/** One Markdown slash command. */
export interface CommandComponent extends ComponentBase {
  readonly kind: 'command'
  /** Subdirectory of `commands/`, `/`-separated. */
  readonly namespace?: string
  /**
   * The name its own harness invokes it by, without a plugin prefix:
   * `.claude/commands/frontend/component.md` is `frontend:component`.
   */
  readonly invocationName?: string
  /**
   * The placeholder language of the body: Claude's (`$ARGUMENTS`, `$0`…,
   * named `arguments`, `!` commands, `@` files; the default) or Codex's
   * custom prompts (`$1`…`$9`, `$ARGUMENTS`, `$NAME` from `NAME=value`, `$$`).
   */
  readonly syntax?: 'claude' | 'codex'
  readonly bodyPath: string
  readonly body: string
  readonly frontmatter: Readonly<Record<string, unknown>>
}

/** One delegated agent definition. */
export interface AgentComponent extends ComponentBase {
  readonly kind: 'agent'
  readonly bodyPath: string
  readonly body: string
  readonly frontmatter: Readonly<Record<string, unknown>>
}

/** One hook configuration, kept in its native dialect shape. */
export interface HookComponent extends ComponentBase {
  readonly kind: 'hooks'
  /** The hooks file; empty for an inline `plugin.json#hooks` object. */
  readonly configPath: string
  /** The inline configuration when {@link configPath} is empty. */
  readonly inline?: Readonly<Record<string, unknown>>
  readonly events: readonly string[]
  readonly handlerTypes: readonly string[]
  /** ES module paths from Claude's `hooks.json#modules`, when present. */
  readonly modules: readonly string[]
}

/** One executable plugin component. */
export interface CodeComponent extends ComponentBase {
  readonly kind: 'code'
  readonly runtime: 'claude-mod' | 'opencode-plugin' | 'unknown'
  readonly entryPath?: string
  readonly apiVersion?: string
}

/** One UI-related component that has no portable core representation. */
export interface UiComponent extends ComponentBase {
  readonly kind: 'ui'
  readonly surface:
    | 'statusline'
    | 'output-style'
    | 'theme'
    | 'workflow'
    | 'monitor'
    | 'mcp-app'
    | 'tui'
    | 'gui'
    | 'unknown'
  readonly specPath?: string
}

/** A component Harness Forge understands well enough to report but not map. */
export interface OtherComponent extends ComponentBase {
  readonly kind: 'other'
  readonly originalKind: string
}

/** Permission rules as Claude Code settings write them. */
export interface PermissionRules {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly ask: readonly string[]
}

/**
 * Harness-wide settings a user or project declared: permission rules and the
 * environment applied to every session, hook and MCP server of the dialect.
 */
export interface SettingsComponent extends ComponentBase {
  readonly kind: 'settings'
  /** The settings files the values were read from, lowest precedence first. */
  readonly files: readonly string[]
  readonly permissions: PermissionRules
  /**
   * Where a `/path` file rule of these settings anchors, as in Claude Code:
   * `~/.claude` for user settings, the project root for project and local
   * settings. Absent: the session's working directory.
   */
  readonly ruleRoot?: string
  readonly env: Readonly<Record<string, string>>
  /** `disableAllHooks: true` turns off this scope's hooks. */
  readonly disableAllHooks?: boolean
  /** The output style the user selected (`outputStyle`). */
  readonly outputStyle?: string
}

/** The discriminated union every connector produces. */
export type ForeignComponent =
  | SkillComponent
  | McpComponent
  | CommandComponent
  | AgentComponent
  | HookComponent
  | CodeComponent
  | UiComponent
  | OtherComponent
  | SettingsComponent

/** Counts used by listing and planning. */
export interface ComponentCounts {
  readonly skill: number
  readonly mcp: number
  readonly command: number
  readonly agent: number
  readonly hooks: number
  readonly code: number
  readonly ui: number
  readonly settings: number
  readonly other: number
}

/** One actionable difference between a foreign component and DSH. */
export interface Gap {
  readonly id: string
  readonly componentId: string
  readonly kind:
    | 'missing-host-api'
    | 'semantic-difference'
    | 'ui-surface'
    | 'unsupported-transport'
    | 'unsupported-handler'
    | 'unsupported-event'
    | 'unsupported-component'
    /** The part needs something outside DSH (an account, a hosted service) that neither DSH nor an adapter can provide. */
    | 'external-requirement'
    | 'runtime-failure'
    | 'license'
    | 'version'
    | 'other'
  readonly summary: string
  readonly detail: string
  readonly suggestedAction:
    | 'bridge'
    | 'rewrite'
    | 'generate'
    | 'accept-difference'
    | 'skip'
}

/** Estimated context cost of importing a component or plugin. */
export interface ContextCost {
  readonly residentTokens: number
  readonly toolCount: number | null
  readonly skillCount: number
  /** Human-readable basis for the estimate. */
  readonly basis: string
}

/** One component's mapping outcome. */
export interface Mapping {
  readonly componentId: string
  readonly level: CompatibilityLevel
  readonly fidelity: Fidelity
  readonly mode: CompatibilityMode
  readonly gaps: readonly Gap[]
  readonly contextCost: ContextCost
  readonly evidence: readonly EvidenceRef[]
}

/** A source or runtime fact supporting a claim. */
export interface EvidenceRef {
  readonly level: EvidenceLevel
  readonly source: string
  readonly detail?: string
}

/** The per-plugin compatibility summary shown in the workbench. */
export interface CompatibilityLevels {
  readonly discovery: CompatibilityLevel
  readonly assets: CompatibilityLevel
  readonly declarativeRuntime: CompatibilityLevel
  readonly codeRuntime: CompatibilityLevel
  readonly interaction: CompatibilityLevel
}

/**
 * Runtime state of one component after a plan is applied. `inactive`: the
 * host part that mounts it is switched off; it mounts when that part is on.
 */
export type ComponentOutcomeStatus = 'declared' | 'mounted' | 'verified' | 'failed' | 'skipped' | 'inactive'

/**
 * One runtime fact about a component: a hook ran, a tool registered by the
 * component was called, a command was dispatched. `signal` names what was
 * observed (`hook:PreToolUse`, `tool:mcp__x__y`, `command`, `skill-load`).
 */
export interface Observation {
  readonly signal: string
  readonly ok: boolean
  readonly at: string
  readonly detail?: string
}

/** What the host actually did for one component. */
export interface ComponentOutcome {
  readonly componentId: string
  readonly status: ComponentOutcomeStatus
  readonly level: CompatibilityLevel
  readonly evidence: EvidenceLevel
  readonly message?: string
  /** Why a skipped part was left out, as a code a screen words in the person's language; `message` says it in English. */
  readonly skippedBy?: 'disabled-in-claude-code'
  /** The latest runtime observation per signal, newest last. */
  readonly observations?: readonly Observation[]
}

/**
 * The honest compatibility picture: `target` is what the plugin needs,
 * `achieved` is what this host has actually mounted or verified. A scan can
 * only fill `target`; an installation or runtime probe upgrades `achieved`.
 */
export interface CompatibilityVector {
  readonly target: CompatibilityLevels
  readonly achieved: CompatibilityLevels
  readonly mode: CompatibilityMode
  readonly evidence: EvidenceLevel
  readonly gaps: readonly Gap[]
  readonly license: string | 'unknown'
  readonly contextCost: ContextCost
}


/** Count components by kind. */
export function countComponents(components: readonly ForeignComponent[]): ComponentCounts {
  const counts = { skill: 0, mcp: 0, command: 0, agent: 0, hooks: 0, code: 0, ui: 0, settings: 0, other: 0 }
  for (const component of components) counts[component.kind] += 1
  return counts
}

/** Return a component's id prefix for stable child ids. */
export function componentId(pluginId: string, kind: ComponentKind, name: string): string {
  return `${pluginId}:${kind}:${name}`
}
