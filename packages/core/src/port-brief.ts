/**
 * The porting brief: everything a DSH creation-mode agent needs to write a
 * local adapter plugin for one plugin part Harness Forge cannot run as it is.
 * Harness Forge describes the gap; DSH's own creation mode does the authoring.
 * Pure: the caller reads the files and passes their paths.
 * @module @kirkchinese/harness-forge-core
 */
import { isAbsolute, join } from 'node:path'
import { kebabCase } from './naming.js'
import type { ForeignComponent, ForeignPlugin, Gap } from './types.js'

/** What a brief is written from. */
export interface PortBriefInput {
  readonly plugin: ForeignPlugin
  readonly component: ForeignComponent
  /** The plugin's gaps; those of {@link component} are described. */
  readonly gaps: readonly Gap[]
  /** Absolute paths of the part's files on disk, as the caller listed them. */
  readonly files: readonly string[]
  /** The original's license when the manifest does not declare it (a detected LICENSE file). */
  readonly license?: string
}

/** Longest manifest excerpt quoted in a brief, in characters. */
const MANIFEST_LIMIT = 4_000

/** The npm name of the adapter for one part: unscoped, `dsh-adapter-<plugin>-<part>`. */
export function adapterPackageName(plugin: Pick<ForeignPlugin, 'name'>, component: Pick<ForeignComponent, 'name'>): string {
  const pluginName = kebabCase(plugin.name)
  const part = kebabCase(component.name)
  return `dsh-adapter-${part === pluginName || part.length === 0 ? pluginName : `${pluginName}-${part}`}`
}

/** Directory under the user's home where creation sessions author local adapters by default. */
export const ADAPTERS_DIR = 'dsh-adapters'

/** Where the creator suggests authoring the adapter, as the user would type it. */
export function defaultAdapterDir(packageName: string): string {
  return `~/${ADAPTERS_DIR}/${packageName}`
}

/** The gaps a brief is about: the component's own, without license and version notes. */
export function gapsOf(component: Pick<ForeignComponent, 'id'>, gaps: readonly Gap[]): Gap[] {
  return gaps.filter(gap => gap.componentId === component.id && gap.kind !== 'license' && gap.kind !== 'version')
}

/** A component path on disk: scans record some relative to the plugin root. */
export function absolutePath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path)
}

/** The files the original runs or reads for this part, with what each is, by absolute path. */
function entryPoints(root: string, component: ForeignComponent): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const add = (label: string, relativeOrAbsolute: string | undefined): void => {
    if (relativeOrAbsolute === undefined || relativeOrAbsolute.length === 0) return
    const path = absolutePath(root, relativeOrAbsolute)
    if (!out.some(([, existing]) => existing === path)) out.push([label, path])
  }
  switch (component.kind) {
    case 'skill':
      add('SKILL.md', component.bodyPath)
      add('resources', component.resourceBase)
      break
    case 'command':
    case 'agent':
      add('definition', component.bodyPath)
      break
    case 'hooks':
      add('hook configuration', component.configPath)
      for (const module of component.modules) add('hook module', module)
      break
    case 'code':
      add(`entry (${component.runtime})`, component.entryPath)
      break
    case 'ui':
      add(`${component.surface} specification`, component.specPath)
      break
    case 'settings':
      for (const file of component.files) add('settings', file)
      break
    default:
      break
  }
  add('declared at', component.path)
  return out
}

/** The part as the scan read it, without bodies the files already hold. */
function scanned(component: ForeignComponent): Record<string, unknown> {
  const { body: _body, frontmatter: _frontmatter, ...rest } = component as ForeignComponent & { body?: unknown; frontmatter?: unknown }
  return rest
}

function excerpt(value: unknown, limit: number): string {
  const text = JSON.stringify(value, null, 2) ?? 'null'
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated; read the manifest file for the rest)`
}

/** The DSH extension points nearest to what the part does, for the creator to confirm with dsh-doc. */
export function extensionPointsFor(component: ForeignComponent, gaps: readonly Gap[]): string[] {
  const points = new Set<string>()
  const kinds = new Set(gaps.map(gap => gap.kind))
  if (component.kind === 'ui' || kinds.has('ui-surface')) {
    points.add('Client UI plugin: a React component registered into a Web slot through `ctx.slots` (dsh-doc `references/ui-plugin.md`), styled with the `--dsw-alias-*` theme tokens')
    if (component.kind === 'ui' && component.surface === 'statusline') {
      points.add('For the default Web status-line placement, look for the session-scoped `conversation.composer.dock` slot below the composer; confirm it at runtime after the user replies')
    }
    points.add('Host session projection with `wire.view`, so the Client receives a value already derived from the session log')
    points.add('A Host Remote namespace (a `TypertRemoteService`) when the Client half needs Host data that is not a session projection')
  }
  if (component.kind === 'hooks' || kinds.has('unsupported-event') || kinds.has('unsupported-handler') || kinds.has('semantic-difference')) {
    points.add('Host listeners on the agent and tool lifecycle: `tools/pre-execute` (deny or ask), `ctx.tools.guard()`, `tools/result`, `agent/pre-step`, `turn/end` and other durable session events (confirm names with `cordis_inspect_query`)')
    points.add('`agent.inject()` for context the next step should see, `agent.followup()` to wake the agent')
  }
  if (component.kind === 'command') points.add('A slash command registered with the commands service of `@deepseek-ai/dsh-commands`')
  if (component.kind === 'agent') points.add('An agent preset declared by a bundle (dsh-doc `references/compositions.md`)')
  if (component.kind === 'mcp' || kinds.has('unsupported-transport')) points.add('A configuration-only MCP bundle (dsh-doc `references/mcp-bundle.md`), or a Host plugin that bridges the transport')
  if (component.kind === 'code' || kinds.has('missing-host-api') || kinds.has('unsupported-component')) {
    points.add('A Host plugin: tools registered with `ctx.tools.register()`, prompt text with `ctx.systemPrompt.section()`, per-agent behaviour on `agent.ctx` from an `agent/created` listener')
  }
  if (component.kind === 'skill') points.add('A skill shipped by the bundle and served through the `dsh-skill` providers')
  if (component.kind === 'settings') points.add('The plugin `Config` in `cordis.patch.yml`, which users edit and which survives upgrades')
  if (points.size === 0) points.add('A Host plugin (dsh-doc `references/host-plugin.md`); choose the weakest mechanism that suffices (dsh-doc `references/practices.md`)')
  return [...points]
}

/**
 * The choices this part leaves to the user, beyond where its source lives:
 * only what the original does not settle and no lookup can. Each names the
 * default the creator offers.
 */
export function openQuestionsFor(component: ForeignComponent, gaps: readonly Gap[]): string[] {
  const questions: string[] = []
  if (component.kind === 'ui' && component.surface === 'statusline') {
    questions.push('Where the status line shows in the DSH Web UI. Default: just below the message input.')
  } else if (component.kind === 'ui' && component.surface !== 'output-style') {
    questions.push(`Where the ${component.surface} surface appears in the DSH Web UI. Default: as close as possible to where the original shows it.`)
  }
  for (const gap of gaps) {
    if (gap.kind === 'unsupported-event') questions.push(`Which DSH event stands in for each event DSH never raises (${gap.summary}), or whether to leave one out. Default: the nearest lifecycle event you found, named in the question.`)
    if (gap.kind === 'semantic-difference' && !gap.id.endsWith(':output-style')) questions.push(`Whether the adapter blocks as the original does (${gap.summary}) or only reports. Default: block, as the original.`)
  }
  return [...new Set(questions)]
}

const bullet = (line: string): string => `- ${line}`
const code = (path: string): string => `\`${path}\``

/**
 * Write the brief for one part, as Markdown. It names the original's files
 * by absolute path so the adapter reuses them where it can.
 */
export function portBrief(input: PortBriefInput): string {
  const { plugin, component } = input
  const gaps = gapsOf(component, input.gaps)
  const packageName = adapterPackageName(plugin, component)
  const license = plugin.license ?? input.license
  const entries = entryPoints(plugin.root, component)
  const questions = openQuestionsFor(component, gaps)
  const lines: string[] = [
    `# Port "${component.name}" of ${plugin.name} to DSH`,
    '',
    `Harness Forge runs ${plugin.source} plugins inside DSH, but it cannot run the ${component.kind} part **${component.name}** of **${plugin.name}** as it is. Write a small DSH adapter plugin that makes this part work in DSH, and install it into the current profile. The original plugin stays where it is, untouched; the adapter runs beside it.`,
    '',
    '## The original',
    '',
    bullet(`Plugin: ${plugin.name}${plugin.version !== undefined ? ` ${plugin.version}` : ''} (${plugin.source}, id \`${plugin.id}\`)`),
    bullet(`Root on disk: ${code(plugin.root)}`),
    ...(plugin.description !== undefined ? [bullet(`Description: ${plugin.description}`)] : []),
    ...(plugin.repository !== undefined ? [bullet(`Repository: ${plugin.repository}`)] : []),
    ...(plugin.homepage !== undefined ? [bullet(`Homepage: ${plugin.homepage}`)] : []),
    bullet(`License: ${license ?? 'unknown (no declared license and no LICENSE file found)'}`),
    bullet(`Part: ${component.kind} \`${component.name}\` (component id \`${component.id}\`)${component.description !== undefined ? ` — ${component.description}` : ''}`),
    '',
    '### Entry points',
    '',
    ...(entries.length > 0 ? entries.map(([label, path]) => bullet(`${label}: ${code(path)}`)) : [bullet('none recorded; start from the manifest and the files below')]),
    '',
    '### Files of this part',
    '',
    ...(input.files.length > 0 ? input.files.map(file => bullet(code(file))) : [bullet('none listed')]),
    '',
    '### The part as Harness Forge read it',
    '',
    '```json',
    excerpt(scanned(component), MANIFEST_LIMIT),
    '```',
    '',
    `### Manifest excerpt (${plugin.ref.manifestKind}, ${code(plugin.ref.manifestPath)})`,
    '',
    '```json',
    excerpt(plugin.manifest, MANIFEST_LIMIT),
    '```',
    '',
    'Read these files, the plugin\'s README and the code that produces the behaviour until you can say in one sentence what the user sees in the original.',
    '',
    '## Why Harness Forge cannot run it',
    '',
    ...(gaps.length > 0
      ? gaps.flatMap(gap => [bullet(`**${gap.summary}** (${gap.kind}, suggested: ${gap.suggestedAction})`), ...(gap.detail.length > 0 ? [`  ${gap.detail}`] : [])])
      : [bullet('No gap is recorded for this part; check how it behaves in DSH before writing anything.')]),
    '',
    '## Nearest DSH extension points',
    '',
    'Confirm each with the dsh-doc skill and runtime inspection before relying on it:',
    '',
    ...extensionPointsFor(component, gaps).map(bullet),
    '',
    '## Questions for the user',
    '',
    bullet(`Where the adapter's source lives. Default: \`${defaultAdapterDir(packageName)}\`.`),
    ...questions.map(bullet),
    '',
    '## Acceptance criteria',
    '',
    bullet('In a DSH session of this profile, the behaviour from your one-sentence description happens: the tool answers, the command runs, the hook acts on the event, or the surface draws.'),
    bullet(`The adapter calls or loads the original's own code and data from ${code(plugin.root)} wherever it can, rather than copying or re-implementing them; anything it had to re-implement is listed in its README.`),
    bullet('The adapter loads without errors (check `plugin_manager` `list_bundles` and `cordis_inspect_query`) and disabling it in the Plugin Manager removes everything it registered.'),
    bullet(`Its \`package.json\` declares \`"harnessForge": { "ports": [{ "plugin": ${JSON.stringify(plugin.name)}, "component": ${JSON.stringify(component.name)} }] }\`, so Harness Forge shows this part as covered by the adapter.`),
    bullet('Its README says what it restores, how it finds the original plugin, and every remaining difference from the original.'),
    bullet(`\`harness_verify_port\` with \`${JSON.stringify({ pluginId: plugin.id, componentId: component.id })}\` answers \`"covered": true\`.`),
    '',
    '## Constraints',
    '',
    bullet(`Package name \`${packageName}\`, unscoped. Author it in the directory the user agreed to (default \`${defaultAdapterDir(packageName)}\`), never inside the original plugin's root.`),
    bullet('Install it as a LOCAL plugin into the current profile only (`plugin_manager` `install_bundle` with the absolute package directory). Do not install it anywhere else.'),
    bullet('Publishing is optional: publish nothing unless the user explicitly asks, and then only under the user\'s own npm scope.'),
    bullet(`Respect the original's license (${license ?? 'unknown: ask the user before reusing any of its code'}): keep its copyright and license notices for anything reused, and credit ${plugin.name} in the README.`),
    bullet('Verify what the page shows with `cordis_inspect_query` (Client `Slots.listSubTree`) or by asking the user. Never read DSH\'s access token or logs, `/proc` of another process, or another process\'s files, and never drive a browser with credentials taken from them.'),
    bullet('Put no token or session data into the adapter. If the user later wants to publish it, it must find the original at run time instead of by a path of this machine.'),
  ]
  return `${lines.join('\n')}\n`
}
