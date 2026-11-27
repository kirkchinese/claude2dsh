/**
 * Tool vocabulary of each foreign dialect. Hook matchers, hook payloads and
 * agent `tools:` lists name tools the way their own harness does (`Bash`,
 * `Write`, `apply_patch`, `mcp__plugin_x_y__z`) and expect that harness's
 * input and output shapes; DSH names the same capabilities `pwsh`/`bash`,
 * `write`, `edit` with its own shapes. This module translates both ways:
 * DSH call → foreign `tool_name`/`tool_input`/`tool_response`, and a hook's
 * `updatedInput`/`updatedToolOutput` → DSH arguments/value.
 * @module @kirkchinese/harness-forge
 */
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { CATALOG_CALL_TOOL, CATALOG_TOOLS, catalogToolName } from '../mcp/catalog.js'

/** Foreign dialects with their own tool vocabulary. */
export type HookDialect = 'claude-code' | 'codex'

/** How one DSH tool call is seen by a foreign hook. */
export interface ForeignTool {
  /** The DSH tool name. */
  readonly dshName: string
  /** The canonical foreign name placed in `tool_name`. */
  readonly name: string
  /** Every name a matcher or rule may use for this call (canonical first, DSH name last). */
  readonly aliases: readonly string[]
  /** The tool input in the foreign shape. */
  readonly input: Record<string, unknown>
}

/** What a translation needs beyond the call itself. */
export interface ToolContext {
  /** The session's working directory; relative file paths resolve against it. */
  readonly cwd?: string
  /** Maps a delegation preset id to the foreign agent name (`plugin:agent`). */
  readonly agentName?: (presetId: string) => string | undefined
  /** Maps a foreign agent name back to a DSH preset id. */
  readonly presetOf?: (foreignName: string) => string | undefined
}

interface Entry {
  readonly claude: readonly string[]
  readonly codex: readonly string[]
}

/** DSH tool name → foreign names, canonical first. */
const TABLE: Readonly<Record<string, Entry>> = {
  bash: { claude: ['Bash'], codex: ['Bash', 'shell', 'local_shell', 'exec_command'] },
  // On Windows the DSH shell tool is PowerShell. Claude hooks written for the
  // shell tool match `Bash`, the name Claude Code gives its shell tool on a
  // machine with Git Bash; a hook that names `PowerShell` sees that name.
  pwsh: { claude: ['Bash', 'PowerShell'], codex: ['Bash', 'shell', 'local_shell', 'exec_command'] },
  read: { claude: ['Read'], codex: ['Read'] },
  read_image: { claude: ['Read'], codex: ['view_image', 'Read'] },
  write: { claude: ['Write'], codex: ['apply_patch', 'Write', 'Edit'] },
  edit: { claude: ['Edit'], codex: ['apply_patch', 'Edit', 'Write'] },
  glob: { claude: ['Glob'], codex: ['Glob'] },
  grep: { claude: ['Grep'], codex: ['Grep'] },
  web_fetch: { claude: ['WebFetch'], codex: ['web_fetch', 'WebFetch'] },
  web_search: { claude: ['WebSearch'], codex: ['web_search', 'WebSearch'] },
  todo_write: { claude: ['TodoWrite'], codex: ['update_plan', 'TodoWrite'] },
  subagent: { claude: ['Agent', 'Task'], codex: ['spawn_agent', 'Agent'] },
  subagent_fork: { claude: ['Agent', 'Task'], codex: ['spawn_agent', 'Agent'] },
  agent: { claude: ['Agent', 'Task'], codex: ['spawn_agent', 'Agent'] },
  ask_user_question: { claude: ['AskUserQuestion'], codex: ['request_user_input', 'AskUserQuestion'] },
  exit_plan_mode: { claude: ['ExitPlanMode'], codex: ['ExitPlanMode'] },
  skill: { claude: ['Skill'], codex: ['Skill'] },
  job_output: { claude: ['TaskOutput', 'BashOutput'], codex: ['write_stdin'] },
  job_kill: { claude: ['TaskStop', 'KillShell'], codex: ['KillShell'] },
}

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const AGENT_TOOLS = new Set(['subagent', 'subagent_fork', 'agent'])
const FILE_TOOLS = new Set(['read', 'read_image', 'write', 'edit'])

/** The foreign view of one DSH tool call. MCP and unknown tools keep their names and input. */
export function foreignTool(dialect: HookDialect, dshName: string, args: unknown, context: ToolContext = {}): ForeignTool {
  const raw = isRecord(args) ? args : {}
  // A capability-catalog call is the MCP tool its id names, with that tool's arguments.
  const catalogName = dshName === CATALOG_CALL_TOOL ? catalogToolName(raw['id']) : undefined
  if (catalogName !== undefined) {
    return { dshName, name: catalogName, aliases: [catalogName, dshName], input: isRecord(raw['arguments']) ? { ...raw['arguments'] } : {} }
  }
  const entry = TABLE[dshName]
  if (entry === undefined) return { dshName, name: dshName, aliases: [dshName], input: { ...raw } }
  const names = dialect === 'codex' ? entry.codex : entry.claude
  return {
    dshName,
    name: names[0] ?? dshName,
    aliases: [...names, dshName],
    input: foreignInput(dialect, dshName, raw, context),
  }
}

/**
 * Map a foreign tool name from an agent/skill allow list or a rule to DSH
 * names. An MCP tool is reachable directly or through the capability catalog.
 */
export function dshToolsFor(foreignName: string, dialect?: 'claude-code' | 'codex'): string[] {
  if (foreignName.startsWith('mcp__')) return [foreignName, ...CATALOG_TOOLS]
  const bare = foreignName.replace(/\(.*\)$/u, '').trim()
  const names: string[] = []
  for (const [dsh, entry] of Object.entries(TABLE)) {
    // In one dialect a name means that dialect's tool only: Claude's `Write` is not Codex's patch-writer that also edits.
    const foreign = dialect === 'claude-code' ? entry.claude : dialect === 'codex' ? entry.codex : [...entry.claude, ...entry.codex]
    if (foreign.includes(bare) || dsh === bare) names.push(dsh)
  }
  return names
}

function foreignInput(dialect: HookDialect, dshName: string, input: Record<string, unknown>, context: ToolContext): Record<string, unknown> {
  if (SHELL_TOOLS.has(dshName)) {
    const command = typeof input['command'] === 'string' ? input['command'] : ''
    if (dialect === 'codex') return { command }
    return {
      command,
      ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
      ...(typeof input['timeoutMs'] === 'number' ? { timeout: input['timeoutMs'] } : {}),
      ...(typeof input['run_in_background'] === 'boolean' ? { run_in_background: input['run_in_background'] } : {}),
    }
  }
  if (FILE_TOOLS.has(dshName)) {
    const filePath = absolutePath(String(input['file_path'] ?? input['path'] ?? ''), context.cwd)
    if (dialect === 'codex' && (dshName === 'write' || dshName === 'edit')) {
      return { command: patchText(dshName, filePath, input) }
    }
    const { sandbox_permissions: _sandbox, justification: _justification, path: _path, ...rest } = input
    return { ...rest, file_path: filePath }
  }
  switch (dshName) {
    case 'glob':
      return { pattern: input['pattern'], ...(typeof input['path'] === 'string' ? { path: absolutePath(input['path'], context.cwd) } : {}) }
    case 'grep':
      return {
        pattern: input['pattern'],
        ...(typeof input['path'] === 'string' ? { path: absolutePath(input['path'], context.cwd) } : {}),
        ...(typeof input['include'] === 'string' ? { glob: input['include'] } : {}),
        output_mode: 'content',
      }
    case 'web_search': {
      const queries = Array.isArray(input['queries']) ? input['queries'].map(String) : []
      return { query: queries[0] ?? '', ...(queries.length > 1 ? { queries } : {}) }
    }
    case 'skill':
      return { skill: input['name'] }
    case 'ask_user_question':
      return { questions: Array.isArray(input['questions']) ? input['questions'].map(foreignQuestion) : [] }
    case 'job_output':
      return { task_id: input['job_id'], bash_id: input['job_id'], block: input['wait'] === true }
    case 'job_kill':
      return { task_id: input['job_id'], shell_id: input['job_id'] }
    default:
      break
  }
  if (AGENT_TOOLS.has(dshName)) {
    const preset = input['agent_preset']
    const subagentType = typeof preset === 'string' ? context.agentName?.(preset) ?? preset : 'general-purpose'
    return dialect === 'codex'
      ? { message: input['prompt'], agent_type: subagentType }
      : { prompt: input['prompt'], description: input['description'], subagent_type: subagentType }
  }
  return { ...input }
}

function foreignQuestion(value: unknown): unknown {
  if (!isRecord(value)) return value
  const { multi_select: multi, id: _id, ...rest } = value
  return { ...rest, multiSelect: multi === true }
}

/**
 * DSH arguments for a hook's `updatedInput`. The foreign input replaces the
 * whole input; DSH-only fields the hook cannot see (working directory,
 * sandbox escalation) keep their original values.
 * @throws when the replacement cannot be expressed as DSH arguments.
 */
export function dshInput(dialect: HookDialect, dshName: string, original: unknown, updated: Record<string, unknown>, context: ToolContext = {}): Record<string, unknown> {
  const base = isRecord(original) ? original : {}
  if (dshName === CATALOG_CALL_TOOL && catalogToolName(base['id']) !== undefined) return { id: base['id'], arguments: updated }
  const keep = (...keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter(key => key in base).map(key => [key, base[key]]))
  if (SHELL_TOOLS.has(dshName)) {
    if (typeof updated['command'] !== 'string') throw new Error('updatedInput for a shell call needs a string "command"')
    return {
      ...keep('workdir', 'sandbox_permissions', 'justification'),
      command: updated['command'],
      description: typeof updated['description'] === 'string' ? updated['description'] : String(base['description'] ?? ''),
      ...(typeof updated['timeout'] === 'number' ? { timeoutMs: updated['timeout'] } : {}),
      ...(typeof updated['run_in_background'] === 'boolean' ? { run_in_background: updated['run_in_background'] } : {}),
    }
  }
  if (dialect === 'codex' && (dshName === 'write' || dshName === 'edit')) {
    if (typeof updated['command'] !== 'string') throw new Error('updatedInput for apply_patch needs a string "command"')
    return { ...keep('sandbox_permissions', 'justification'), ...patchArguments(dshName, updated['command']) }
  }
  if (FILE_TOOLS.has(dshName)) {
    const { file_path: filePath, ...rest } = updated
    return { ...keep('sandbox_permissions', 'justification'), ...rest, file_path: typeof filePath === 'string' ? filePath : base['file_path'] }
  }
  switch (dshName) {
    case 'grep': {
      const { glob, output_mode: _mode, ...rest } = updated
      return { ...rest, ...(typeof glob === 'string' ? { include: glob } : {}) }
    }
    case 'web_search': {
      const queries = Array.isArray(updated['queries']) ? updated['queries'].map(String) : typeof updated['query'] === 'string' ? [updated['query']] : []
      return { queries }
    }
    case 'skill':
      return { name: updated['skill'] ?? base['name'] }
    case 'ask_user_question':
      return {
        questions: Array.isArray(updated['questions'])
          ? updated['questions'].map((question) => {
            if (!isRecord(question)) return question
            const { multiSelect, ...rest } = question
            return { ...rest, multi_select: multiSelect === true }
          })
          : base['questions'],
      }
    case 'job_output':
      return { job_id: updated['task_id'] ?? updated['bash_id'] ?? base['job_id'], ...(typeof updated['block'] === 'boolean' ? { wait: updated['block'] } : {}) }
    case 'job_kill':
      return { job_id: updated['task_id'] ?? updated['shell_id'] ?? base['job_id'] }
    default:
      break
  }
  if (AGENT_TOOLS.has(dshName)) {
    const type = updated['subagent_type'] ?? updated['agent_type']
    const preset = typeof type === 'string' ? context.presetOf?.(type) : undefined
    return {
      ...keep('cwd'),
      prompt: updated['prompt'] ?? updated['message'] ?? base['prompt'],
      description: updated['description'] ?? base['description'],
      ...(preset !== undefined ? { agent_preset: preset } : 'agent_preset' in base ? { agent_preset: base['agent_preset'] } : {}),
    }
  }
  return updated
}

/**
 * A shell call that ran but failed, as Claude Code reports it: a non-zero
 * exit, a timeout or an abort is a tool failure (`PostToolUseFailure`), with
 * `Exit code N` on the first line of the error. DSH returns such a call as a
 * value carrying the exit code.
 */
export function shellFailure(dshName: string, value: unknown): string | undefined {
  if (!SHELL_TOOLS.has(dshName) || !isRecord(value) || value['kind'] !== 'foreground') return undefined
  const exitCode = typeof value['exitCode'] === 'number' ? value['exitCode'] : undefined
  const stopped = value['timedOut'] === true || value['aborted'] === true
  if (!stopped && (exitCode === undefined || exitCode === 0)) return undefined
  const output = [textField(value['stderr']), textField(value['stdout'])].find(text => text.trim().length > 0) ?? ''
  const head = value['timedOut'] === true ? 'Command timed out' : value['aborted'] === true ? 'Command was aborted' : `Exit code ${String(exitCode)}`
  return output.length > 0 ? `${head}\n${output.trimEnd()}` : head
}

/** The structured result a foreign PostToolUse hook receives as `tool_response`. */
export function foreignResponse(dialect: HookDialect, dshName: string, args: unknown, value: unknown, text: string): unknown {
  const input = isRecord(args) ? args : {}
  const out = isRecord(value) ? value : undefined
  // A catalog call answers as the MCP tool would: its structured content, else its content blocks.
  if (dshName === CATALOG_CALL_TOOL && catalogToolName(input['id']) !== undefined) {
    return out?.['structuredContent'] ?? [{ type: 'text', text: typeof out?.['text'] === 'string' ? out['text'] : text }]
  }
  if (dialect === 'codex' && !dshName.startsWith('mcp__')) return text
  if (out === undefined) return value ?? text
  if (SHELL_TOOLS.has(dshName)) {
    if (out['kind'] === 'foreground') {
      return {
        stdout: textField(out['stdout']),
        stderr: textField(out['stderr']),
        interrupted: out['timedOut'] === true || out['aborted'] === true,
        isImage: false,
        ...(typeof out['exitCode'] === 'number' ? { exitCode: out['exitCode'] } : {}),
      }
    }
    return { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: out['jobId'] }
  }
  switch (dshName) {
    case 'read': {
      const lines = Array.isArray(out['lines']) ? out['lines'].filter(isRecord) : []
      const content = lines.map(line => String(line['text'] ?? '')).join('\n')
      return { type: 'text', file: { filePath: out['path'], content, numLines: lines.length, startLine: out['offset'], totalLines: out['totalLines'] ?? lines.length } }
    }
    case 'write':
      return { type: out['operation'], filePath: out['path'], content: out['after'], structuredPatch: [], originalFile: out['before'] ?? null }
    case 'edit':
      return {
        filePath: out['path'],
        oldString: input['old_string'],
        newString: input['new_string'],
        originalFile: out['before'],
        structuredPatch: [],
        userModified: false,
        replaceAll: input['replace_all'] === true,
      }
    case 'glob': {
      const paths = Array.isArray(out['paths']) ? out['paths'].map(String) : []
      return { filenames: paths, numFiles: paths.length, durationMs: 0, truncated: false }
    }
    case 'grep': {
      const matches = Array.isArray(out['matches']) ? out['matches'].filter(isRecord) : []
      const filenames = [...new Set(matches.map(match => String(match['path'])))]
      return {
        mode: 'content',
        numFiles: filenames.length,
        filenames,
        content: matches.map(match => `${String(match['path'])}:${String(match['lineNumber'])}:${String(match['line'])}`).join('\n'),
        numLines: matches.length,
      }
    }
    case 'web_fetch': {
      const body = isRecord(out['body']) ? out['body'] : {}
      const content = typeof body['content'] === 'string' ? body['content'] : text
      return { url: out['url'], code: out['statusCode'], codeText: '', result: content, bytes: Buffer.byteLength(content), durationMs: 0 }
    }
    default:
      break
  }
  if (AGENT_TOOLS.has(dshName)) return { status: 'completed', content: [{ type: 'text', text }], ...out }
  return value
}

/**
 * The DSH value for a hook's `updatedToolOutput`, when the replacement has the
 * foreign output shape of a tool whose DSH value can carry it.
 * @returns undefined when only the model-facing text can be replaced.
 */
export function dshValue(dshName: string, original: unknown, updated: unknown): unknown {
  const out = isRecord(original) ? original : undefined
  if (out === undefined || !isRecord(updated)) return undefined
  if (SHELL_TOOLS.has(dshName) && out['kind'] === 'foreground' && typeof updated['stdout'] === 'string') {
    return {
      ...out,
      stdout: { ...(isRecord(out['stdout']) ? out['stdout'] : {}), text: updated['stdout'], truncated: false },
      stderr: { ...(isRecord(out['stderr']) ? out['stderr'] : {}), text: typeof updated['stderr'] === 'string' ? updated['stderr'] : '', truncated: false },
    }
  }
  if (dshName === 'read' && isRecord(updated['file']) && typeof updated['file']['content'] === 'string') {
    const start = typeof out['offset'] === 'number' ? out['offset'] : 1
    return { ...out, lines: updated['file']['content'].split('\n').map((text, index) => ({ number: start + index, text })) }
  }
  return undefined
}

/** The value a rule such as `Edit(src

/** Whether a DSH tool runs shell commands. */
export function isShellTool(dshName: string): boolean {
  return SHELL_TOOLS.has(dshName)
}

/** An absolute path in the platform's native form; `~` expands to the home directory. */
export function absolutePath(path: string, cwd: string | undefined): string {
  if (path.length === 0) return path
  const expanded = path === '~' ? homedir() : path.startsWith('~/') || path.startsWith('~\\') ? resolve(homedir(), path.slice(2)) : path
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd ?? process.cwd(), expanded)
}

/** A Codex `apply_patch` rendering of a DSH write or edit. */
function patchText(dshName: string, filePath: string, input: Record<string, unknown>): string {
  if (dshName === 'write') {
    return `*** Begin Patch\n*** Add File: ${filePath}\n${String(input['content'] ?? '').split('\n').map(line => `+${line}`).join('\n')}\n*** End Patch`
  }
  const before = String(input['old_string'] ?? '').split('\n').map(line => `-${line}`).join('\n')
  const after = String(input['new_string'] ?? '').split('\n').map(line => `+${line}`).join('\n')
  return `*** Begin Patch\n*** Update File: ${filePath}\n@@\n${before}\n${after}\n*** End Patch`
}

/** DSH write/edit arguments from a single-file Codex patch. */
function patchArguments(dshName: string, patch: string): Record<string, unknown> {
  const lines = patch.replace(/\r\n/gu, '\n').split('\n')
  const header = lines.find(line => /^\*\*\* (Add|Update) File: /u.test(line))
  if (header === undefined) throw new Error('apply_patch updatedInput has no "*** Add File" or "*** Update File" header')
  const filePath = header.replace(/^\*\*\* (Add|Update) File: /u, '').trim()
  const body = lines.slice(lines.indexOf(header) + 1).filter(line => !line.startsWith('*** ') && !line.startsWith('@@'))
  if (header.startsWith('*** Add File: ')) {
    return { file_path: filePath, content: body.map(line => line.startsWith('+') ? line.slice(1) : line).join('\n') }
  }
  if (dshName === 'write') throw new Error('apply_patch updatedInput turned a file creation into an update')
  return {
    file_path: filePath,
    old_string: body.filter(line => line.startsWith('-') || line.startsWith(' ')).map(line => line.slice(1)).join('\n'),
    new_string: body.filter(line => line.startsWith('+') || line.startsWith(' ')).map(line => line.slice(1)).join('\n'),
  }
}

function textField(value: unknown): string {
  return isRecord(value) && typeof value['text'] === 'string' ? value['text'] : typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
