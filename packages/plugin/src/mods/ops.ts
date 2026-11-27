/**
 * The mods API (`$`) as calls on the chain, read off claude-code.d.ts
 * `CoreEngineInterface`, `OpEventOf` and `EventCalls`: each method raises the
 * event of its own name with the call's arguments as its input.
 *
 * - `value` ops: hooks see `{ value } | { deny }`; the caller gets the value
 *   or a rejection `<plugin>: $.<op>: <reason>`;
 * - `fire` ops return nothing at once and raise in the background;
 * - `event` calls raise one of the engine's own events and resolve to its
 *   result as the event defines it.
 * @module @kirkchinese/harness-forge/mods
 */
import { isRecord } from './values.js'

export type OpKind = 'value' | 'fire' | 'event'

export interface OpSpec {
  readonly event: string
  readonly kind: OpKind
  /** The event input built from the call's arguments. */
  readonly input: (args: readonly unknown[]) => Record<string, unknown>
}

const none = (): Record<string, unknown> => ({})
const first = (args: readonly unknown[]): Record<string, unknown> => (isRecord(args[0]) ? { ...args[0] } : {})
const named = (...names: string[]) => (args: readonly unknown[]): Record<string, unknown> => {
  const input: Record<string, unknown> = {}
  names.forEach((name, index) => { if (args[index] !== undefined) input[name] = args[index] })
  return input
}

/** Every method of `$` that crosses to the host, by `<noun>.<method>`. */
export const OPS: Readonly<Record<string, OpSpec>> = Object.freeze({
  'ui.notice': { event: 'ui.notice', kind: 'fire', input: args => ({ tool_use_id: args[0], text: args[1] }) },
  'ui.invalidate': { event: 'ui.invalidate', kind: 'fire', input: named('event') },
  'ui.blit': { event: 'ui.blit', kind: 'value', input: first },
  'ui.log': { event: 'ui.log', kind: 'fire', input: args => ({ text: args[0], to: (isRecord(args[1]) && typeof args[1]['to'] === 'string' ? args[1]['to'] : 'transcript') }) },
  'ui.toast': { event: 'ui.toast', kind: 'fire', input: args => ({ text: args[0], ...(isRecord(args[1]) && typeof args[1]['timeoutMs'] === 'number' ? { timeoutMs: args[1]['timeoutMs'] } : {}) }) },
  'ui.status': { event: 'ui.status', kind: 'fire', input: args => ({ text: args[0] }) },
  'ui.notify': { event: 'ui.notify', kind: 'value', input: args => (isRecord(args[0]) ? { ...args[0] } : { text: args[0], ...(isRecord(args[1]) ? args[1] : {}) }) },
  'ui.copy': { event: 'ui.copy', kind: 'value', input: args => (isRecord(args[0]) ? { ...args[0] } : { text: args[0] }) },
  'ui.selection': { event: 'ui.selection', kind: 'value', input: first },
  'ui.open': { event: 'ui.open', kind: 'value', input: first },
  'ui.close': { event: 'ui.close', kind: 'value', input: args => ({ ...first(args), origin: { kind: 'plugin' } }) },
  'ui.panes': { event: 'ui.panes', kind: 'value', input: none },
  'ui.scroll': { event: 'ui.scroll', kind: 'event', input: first },
  'ui.focus': { event: 'ui.focus', kind: 'event', input: first },
  'model.complete': { event: 'model.complete', kind: 'value', input: first },
  'model.fork': { event: 'model.fork', kind: 'value', input: first },
  'model.classify': { event: 'model.classify', kind: 'value', input: named('text', 'labels', 'options') },
  'audio.play': { event: 'audio.play', kind: 'value', input: args => ({ clip: args[0], shouldLoop: isRecord(args[1]) && args[1]['loop'] === true, ...(isRecord(args[1]) && typeof args[1]['gain'] === 'number' ? { gain: args[1]['gain'] } : {}) }) },
  'audio.speak': { event: 'audio.speak', kind: 'value', input: args => ({ text: args[0], ...(isRecord(args[1]) && typeof args[1]['voice'] === 'string' ? { voice: args[1]['voice'] } : {}) }) },
  'mcp.call': { event: 'mcp.call', kind: 'value', input: args => ({ server: args[0], tool: args[1], args: isRecord(args[2]) ? args[2] : {} }) },
  'mcp.connect': { event: 'mcp.connect', kind: 'value', input: named('server') },
  'session.messages': { event: 'session.messages', kind: 'value', input: none },
  'session.cwd': { event: 'session.cwd', kind: 'value', input: none },
  'session.root': { event: 'session.root', kind: 'value', input: none },
  'session.model': { event: 'session.model', kind: 'value', input: none },
  'session.turns': { event: 'session.turns', kind: 'value', input: none },
  'session.id': { event: 'session.id', kind: 'value', input: none },
  'session.repo': { event: 'session.repo', kind: 'value', input: none },
  'session.surfaces': { event: 'session.surfaces', kind: 'value', input: none },
  'session.surface': { event: 'session.surface', kind: 'value', input: none },
  'session.usage': { event: 'session.usage', kind: 'value', input: first },
  'session.version': { event: 'session.version', kind: 'value', input: none },
  'session.compact': { event: 'session.compact', kind: 'event', input: first },
  'session.append': { event: 'session.append', kind: 'event', input: first },
  'session.send': { event: 'session.send', kind: 'event', input: first },
  'session.authorize': { event: 'session.authorize', kind: 'value', input: none },
  'session.identity': { event: 'session.identity', kind: 'value', input: none },
  'turn.abort': { event: 'turn.abort', kind: 'value', input: first },
  'prompt.submit': { event: 'prompt.submit', kind: 'event', input: first },
  'prompt.read': { event: 'prompt.read', kind: 'value', input: none },
  'prompt.fill': { event: 'prompt.fill', kind: 'event', input: first },
  'prompt.suggest': { event: 'prompt.suggest', kind: 'event', input: first },
  'prompt.compose': { event: 'prompt.compose', kind: 'event', input: first },
  'tool.list': { event: 'tool.list', kind: 'value', input: none },
  'tool.call': { event: 'tool.call', kind: 'event', input: first },
  'tool.check': { event: 'tool.check', kind: 'event', input: first },
  'tool.register': { event: 'tool.register', kind: 'value', input: first },
  'command.list': { event: 'command.list', kind: 'value', input: none },
  'command.run': { event: 'command.run', kind: 'event', input: first },
  'command.register': { event: 'command.register', kind: 'value', input: first },
  'config.list': { event: 'config.list', kind: 'value', input: none },
  'config.set': { event: 'config.set', kind: 'event', input: first },
  'agent.spawn': { event: 'agent.spawn', kind: 'event', input: first },
  'agent.list': { event: 'agent.list', kind: 'value', input: none },
  'agent.register': { event: 'agent.register', kind: 'value', input: first },
  'fs.read': { event: 'fs.read', kind: 'value', input: args => ({ path: args[0], as: isRecord(args[1]) && args[1]['as'] === 'bytes' ? 'bytes' : 'text' }) },
  'fs.write': { event: 'fs.write', kind: 'value', input: named('path', 'text') },
  'fs.list': { event: 'fs.list', kind: 'value', input: args => ({ path: args[0] ?? '.' }) },
  'fs.exists': { event: 'fs.exists', kind: 'value', input: named('path') },
  'fs.stat': { event: 'fs.stat', kind: 'value', input: args => ({ path: args[0], resolve: isRecord(args[1]) && args[1]['resolve'] === true }) },
  'fs.ancestors': { event: 'fs.ancestors', kind: 'value', input: first },
  'store.get': { event: 'store.get', kind: 'value', input: named('key') },
  'store.set': { event: 'store.set', kind: 'value', input: args => ({ key: args[0], value: args[1] }) },
  'store.delete': { event: 'store.delete', kind: 'value', input: named('key') },
  'store.keys': { event: 'store.keys', kind: 'value', input: none },
  'clock.now': { event: 'clock.now', kind: 'value', input: none },
  'clock.sleep': { event: 'clock.sleep', kind: 'value', input: named('ms') },
  'http.fetch': { event: 'http.fetch', kind: 'value', input: args => ({ url: args[0], ...(isRecord(args[1]) ? { init: args[1] } : {}) }) },
  'process.run': { event: 'process.run', kind: 'value', input: args => ({ argv: args[0], ...(isRecord(args[1]) ? { init: args[1] } : {}) }) },
  'settings.read': { event: 'settings.read', kind: 'value', input: first },
  'env.get': { event: 'env.get', kind: 'value', input: named('name') },
  'env.set': { event: 'env.set', kind: 'value', input: args => ({ name: args[0], ...(args[1] !== undefined ? { value: args[1] } : {}) }) },
  // $.telemetry (mods reference): a record is sent only when Claude Code or a built-in makes the call.
  'telemetry.log': { event: 'telemetry.log', kind: 'value', input: first },
  'telemetry.mark': { event: 'telemetry.mark', kind: 'value', input: first },
})

/** The engine's own events a test's `$` (and a plugin) may raise by name. */
export const ENGINE_EVENTS: readonly string[] = [
  'tool.call', 'tool.check', 'tool.describe', 'command.run', 'command.describe', 'config.set', 'config.describe',
  'prompt.submit', 'prompt.fill', 'prompt.suggest', 'prompt.edit', 'prompt.section', 'prompt.context', 'prompt.attachment',
  'prompt.compose', 'prompt.mention', 'prompt.autocomplete', 'skill.prompt', 'attribution.text', 'agent.offer', 'agent.spawn',
  'session.start', 'session.receive', 'session.send', 'session.append', 'session.compact', 'session.attach', 'session.detach',
  'session.measure', 'session.end', 'plugin.register', 'turn.start', 'turn.step', 'turn.complete', 'engine.create',
  'ui.render', 'ui.resolve', 'ui.press', 'ui.input', 'ui.select', 'ui.message', 'ui.scroll', 'ui.focus', 'ui.fault', 'ui.close',
  'settings.read',
]

/** Settings hook events, raised as `classic.<Event>`. */
export const CLASSIC_EVENTS: readonly string[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'PermissionDenied', 'PermissionRequest', 'Notification',
  'UserPromptSubmit', 'UserPromptExpansion', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'Elicitation', 'ElicitationResult', 'ConfigChange', 'InstructionsLoaded', 'WorktreeCreate', 'WorktreeRemove', 'CwdChanged',
  'FileChanged', 'DirectoryAdded', 'MessageDisplay',
]
