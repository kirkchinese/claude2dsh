/**
 * Decode one hook run into what its harness would act on: the stdout
 * classification (JSON object, parse failure, plain text), the JSON output
 * schema check, and the exit-code table of the hook reference.
 *
 * | stdout \ exit         | 0                    | 2                          | other                         |
 * | valid JSON object     | success, fields apply | block; fields still read   | success; fields decide (failure for `onFailure`) |
 * | invalid / bad schema  | non-blocking error    | block; stderr is the reason | non-blocking error           |
 * | plain text or nothing | success               | block; stderr is the reason | non-blocking error            |
 * @module @kirkchinese/harness-forge
 */
import type { HookDialect } from './vocabulary.js'

/** The raw outcome of one handler, whatever its type. */
export interface RawRun {
  /** Exit status: a process exit code, 0 for a 2xx HTTP response or a successful tool/model call. */
  readonly exitCode?: number
  readonly stdout: string
  readonly stderr: string
  /** The handler could not produce a result. */
  readonly failure?: { readonly kind: 'start' | 'timeout' | 'transport' | 'cancelled'; readonly message: string }
  /** The process exited while a child still held its output (see {@link ../process}). */
  readonly suspectCapture?: boolean
}

/** What a harness acts on after one run. */
export interface Decoded {
  /** Validated JSON output fields. */
  readonly json?: Readonly<Record<string, unknown>>
  /** Plain stdout (only on success). */
  readonly plain?: string
  /** The run blocks the action (exit 2): its reason. */
  readonly block?: string
  /** The run is a hook error, with its notice text. */
  readonly error?: string
  /** The run counts as a failure for `onFailure: "block"`. */
  readonly failed: boolean
  /** The run was cancelled; it has no effect. */
  readonly cancelled?: boolean
}

type Classified =
  | { readonly kind: 'json'; readonly value: Record<string, unknown> }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'plain'; readonly text: string }

/** Universal JSON output fields and their types. */
const UNIVERSAL: Readonly<Record<string, 'boolean' | 'string'>> = {
  continue: 'boolean',
  stopReason: 'string',
  suppressOutput: 'boolean',
  systemMessage: 'string',
  terminalSequence: 'string',
  reason: 'string',
}

/** Events whose stdout Claude Code reads as plain text context. */
const PLAIN_CONTEXT = new Set(['UserPromptSubmit', 'UserPromptExpansion', 'SessionStart', 'PostModelSwitch', 'PreCompact'])

/** Decode a synchronous run. */
export function decodeRun(event: string, dialect: HookDialect, run: RawRun): Decoded {
  if (run.failure !== undefined) {
    if (run.failure.kind === 'cancelled') return { failed: false, cancelled: true }
    return { error: run.failure.message, failed: true }
  }
  const classified = classify(run.stdout, false)
  const checked = classified.kind === 'json' ? validate(event, dialect, classified.value) : classified
  const stderr = run.stderr.trim()
  if (run.exitCode === 2) {
    if (missingFileBlock(event, run)) return { error: `exit 2: ${firstLine(stderr)}`, failed: true }
    const json = checked.kind === 'json' ? checked.value : undefined
    const reason = jsonReason(json) ?? (stderr.length > 0 ? stderr : `${event} hook exited 2`)
    return { ...(json !== undefined ? { json } : {}), block: reason, failed: false }
  }
  if (checked.kind === 'invalid') return { error: checked.message, failed: true }
  if (run.exitCode === 0) {
    if (checked.kind === 'json') return { json: checked.value, failed: false }
    if (dialect === 'codex' && (event === 'Stop' || event === 'SubagentStop') && checked.text.length > 0) {
      return { error: `${event} hooks must print JSON; got plain text`, failed: true }
    }
    return { ...(checked.text.length > 0 ? { plain: checked.text } : {}), failed: false }
  }
  if (checked.kind === 'json') return { json: checked.value, failed: true }
  const detail = firstLine(stderr) || firstLine(run.stdout)
  return { error: `Failed with non-blocking status code ${String(run.exitCode ?? 'none')}${detail.length > 0 ? `: ${detail}` : ''}`, failed: true }
}

/**
 * Decode a background (`async`) run: the JSON response may span stdout alone
 * or sit on one line among other text; fields of the wrong type are dropped.
 */
export function decodeAsyncRun(event: string, dialect: HookDialect, run: RawRun): Decoded {
  if (run.failure !== undefined) return run.failure.kind === 'cancelled' ? { failed: false, cancelled: true } : { error: run.failure.message, failed: true }
  const classified = classify(run.stdout, true)
  const json = classified.kind === 'json' ? dropInvalid(event, classified.value) : undefined
  const failed = run.exitCode !== 0 && run.exitCode !== 2
  return {
    ...(json !== undefined ? { json } : {}),
    ...(run.exitCode === 2 ? { block: run.stderr.trim() || run.stdout.trim() } : {}),
    ...(failed ? { error: `Failed with status code ${String(run.exitCode ?? 'none')}: ${firstLine(run.stderr)}` } : {}),
    failed,
  }
}

/** Whether plain stdout of a successful run becomes context on this event. */
export function plainIsContext(event: string, dialect: HookDialect): boolean {
  if (dialect === 'codex') return event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'SubagentStart'
  return PLAIN_CONTEXT.has(event)
}

/** The `hookSpecificOutput` object of a decoded run. */
export function specific(decoded: Decoded): Readonly<Record<string, unknown>> | undefined {
  const value = decoded.json?.['hookSpecificOutput']
  return isRecord(value) ? value : undefined
}

/** The context strings a run adds: `additionalContext`, plus plain stdout where the event reads it. */
export function contextsOf(event: string, dialect: HookDialect, decoded: Decoded): string[] {
  const out: string[] = []
  const additional = specific(decoded)?.['additionalContext']
  if (typeof additional === 'string' && additional.length > 0) out.push(additional)
  if (decoded.plain !== undefined && plainIsContext(event, dialect) && event !== 'PreCompact') out.push(decoded.plain)
  return out
}

function classify(stdout: string, async: boolean): Classified {
  const text = stdout.trim()
  if (text.length === 0) return { kind: 'plain', text: '' }
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const value: unknown = JSON.parse(text)
      if (isRecord(value)) return { kind: 'json', value }
    } catch {
      // Several JSON lines, or a parse failure; see below.
    }
    const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(line => line.length > 0)
    const parsed = lines.map(tryParse)
    if (lines.length > 1 && parsed.every(item => item.ok)) {
      const objects = parsed.map(item => item.value).filter(isRecord)
      if (async && objects.length >= 1) return { kind: 'json', value: objects.at(-1) as Record<string, unknown> }
      return objects.some(object => Object.keys(object).length > 0)
        ? { kind: 'invalid', message: 'stdout holds several JSON values; print one JSON object only' }
        : { kind: 'plain', text }
    }
    if (!async) return { kind: 'invalid', message: `invalid JSON output: ${parseError(text)}` }
  }
  if (async) {
    const line = text.split(/\r?\n/u).map(item => item.trim()).filter(item => item.startsWith('{') && item.endsWith('}')).map(tryParse).find(item => item.ok && isRecord(item.value))
    if (line !== undefined) return { kind: 'json', value: line.value as Record<string, unknown> }
  }
  return { kind: 'plain', text }
}

function validate(event: string, dialect: HookDialect, value: Record<string, unknown>): Classified {
  for (const [field, type] of Object.entries(UNIVERSAL)) {
    if (field in value && typeof value[field] !== type) return { kind: 'invalid', message: `JSON output field "${field}" must be a ${type}` }
  }
  if ('decision' in value) {
    const decision = value['decision']
    const allowed = event === 'PreToolUse' ? ['block', 'approve'] : ['block']
    if (typeof decision !== 'string' || !allowed.includes(decision)) return { kind: 'invalid', message: `JSON output field "decision" must be ${allowed.map(item => `"${item}"`).join(' or ')}` }
  }
  const hso = value['hookSpecificOutput']
  if (hso !== undefined) {
    if (!isRecord(hso)) return { kind: 'invalid', message: 'hookSpecificOutput must be an object' }
    if (hso['hookEventName'] !== event) return { kind: 'invalid', message: `hookSpecificOutput.hookEventName must be "${event}"` }
    if ('additionalContext' in hso && typeof hso['additionalContext'] !== 'string') return { kind: 'invalid', message: 'additionalContext must be a string' }
    if (event === 'PreToolUse' && 'permissionDecision' in hso && !['allow', 'deny', 'ask', 'defer'].includes(String(hso['permissionDecision']))) {
      return { kind: 'invalid', message: 'permissionDecision must be "allow", "deny", "ask" or "defer"' }
    }
    if ('updatedInput' in hso && !isRecord(hso['updatedInput'])) return { kind: 'invalid', message: 'updatedInput must be an object' }
    if (event === 'PermissionRequest' && 'decision' in hso) {
      const decision = hso['decision']
      if (!isRecord(decision) || (decision['behavior'] !== 'allow' && decision['behavior'] !== 'deny')) {
        return { kind: 'invalid', message: 'decision.behavior must be "allow" or "deny"' }
      }
      if (dialect === 'codex' && ('updatedInput' in decision || 'updatedPermissions' in decision || 'interrupt' in decision)) {
        return { kind: 'invalid', message: 'Codex PermissionRequest hooks may not return updatedInput, updatedPermissions or interrupt' }
      }
    }
  }
  if (dialect === 'codex' && event === 'PreToolUse') {
    for (const field of ['continue', 'stopReason', 'suppressOutput']) {
      if (field in value) return { kind: 'invalid', message: `Codex PreToolUse hooks do not support "${field}"` }
    }
    if (isRecord(hso) && hso['permissionDecision'] === 'ask') return { kind: 'invalid', message: 'Codex PreToolUse hooks do not support permissionDecision "ask"' }
    if (value['decision'] === 'approve') return { kind: 'invalid', message: 'Codex PreToolUse hooks do not support decision "approve"' }
  }
  return { kind: 'json', value }
}

/** Async output: keep the fields whose types are right. */
function dropInvalid(event: string, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, type] of Object.entries(UNIVERSAL)) {
    if (typeof value[field] === type) out[field] = value[field]
  }
  const hso = value['hookSpecificOutput']
  if (isRecord(hso) && hso['hookEventName'] === event && typeof hso['additionalContext'] === 'string') {
    out['hookSpecificOutput'] = { hookEventName: event, additionalContext: hso['additionalContext'] }
  }
  return out
}

/** The block reason a JSON output names for itself. */
function jsonReason(json: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (json === undefined) return undefined
  const hso = isRecord(json['hookSpecificOutput']) ? json['hookSpecificOutput'] : {}
  for (const value of [hso['permissionDecisionReason'], isRecord(hso['decision']) ? hso['decision']['message'] : undefined, json['reason']]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Stop, SubagentStop and a plugin's UserPromptSubmit: exit 2 caused by a missing file is a non-blocking error. */
function missingFileBlock(event: string, run: RawRun): boolean {
  return (event === 'Stop' || event === 'SubagentStop' || event === 'TaskCompleted' || event === 'UserPromptSubmit')
    && run.stdout.trim().length === 0
    && /No such file or directory|cannot find the (path|file)/iu.test(run.stderr)
}

function tryParse(text: string): { ok: boolean; value?: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

function parseError(text: string): string {
  try {
    JSON.parse(text)
    return 'not an object'
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The first non-empty line, trimmed and bounded. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/u).find(line => line.trim().length > 0)?.trim().slice(0, 500) ?? ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
