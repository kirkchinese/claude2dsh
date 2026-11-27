/**
 * The hook broker's observational events: committed session events and file
 * watching.
 * @module @kirkchinese/harness-forge
 */
import { existsSync, watch } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { specific } from '../output.js'
import { foreignTool } from '../vocabulary.js'
import type { HookEngine } from './engine.js'
import { isRecord, lastAssistantText, textOf } from './helpers.js'
import type { AgentLike, Occurrence, SessionLike } from './types.js'

/**
 * Committed session events (compaction, turn ends, working-directory
 * changes, approvals, model responses), the idle notification and the
 * FileChanged watchers, each raised in the background.
 */
export class SessionEvents {
  constructor(private readonly engine: HookEngine) {}

  // -------------------------------------------------------------------------
  // Committed session events
  // -------------------------------------------------------------------------

  sessionEvent(session: SessionLike, event: { type: string; data?: Record<string, unknown> }): void {
    const agent = this.engine.agentOf(session.header.id)
    const data = event.data ?? {}
    switch (event.type) {
      case 'compaction/start': {
        if (!this.engine.has('PreCompact')) return
        const trigger = data['sourceCommandId'] !== undefined ? 'manual' : 'auto'
        this.detachedEvent(agent, { event: 'PreCompact', subject: trigger, fields: { trigger, custom_instructions: null } })
        return
      }
      case 'compaction/summary':
        this.engine.state(session).lastSummary = textOf(Array.isArray(data['summary']) ? data['summary'] as ContentBlock[] : [])
        return
      case 'compaction/end': {
        if (!this.engine.has('PostCompact') || data['error'] !== undefined) return
        const trigger = data['sourceCommandId'] !== undefined ? 'manual' : 'auto'
        this.detachedEvent(agent, { event: 'PostCompact', subject: trigger, fields: { trigger, compact_summary: this.engine.state(session).lastSummary ?? '' } }, true)
        return
      }
      case 'turn/end': {
        const reason = isRecord(data['reason']) ? data['reason'] : {}
        if (reason['kind'] === 'error' && this.engine.has('StopFailure')) {
          const failure = isRecord(reason['error']) ? reason['error'] : {}
          const error = stopFailureType(String(failure['code'] ?? ''), String(failure['message'] ?? ''))
          this.detachedEvent(agent, {
            event: 'StopFailure',
            subject: error,
            fields: { error, error_details: String(failure['message'] ?? ''), last_assistant_message: `API Error: ${String(failure['message'] ?? 'unknown error')}` },
          })
        }
        if (reason['kind'] === 'max-tokens' && this.engine.has('StopFailure')) {
          this.detachedEvent(agent, { event: 'StopFailure', subject: 'max_output_tokens', fields: { error: 'max_output_tokens', last_assistant_message: lastAssistantText(session) } })
        }
        if (reason['kind'] === 'aborted' && isRecord(reason['reason']) && reason['reason']['kind'] === 'user' && this.engine.has('Interrupt')) {
          this.detachedEvent(agent, { event: 'Interrupt', fields: { turn_id: String(data['turn'] ?? '') } })
        }
        return
      }
      case 'working-directory/change': {
        if (agent === undefined) return
        const state = this.engine.state(session)
        const oldCwd = state.cwd ?? session.header.cwd ?? ''
        state.cwd = String(data['cwd'] ?? '')
        this.engine.clearEnv(session, 'cwd')
        if (this.engine.has('CwdChanged')) {
          this.detachedEvent(agent, { event: 'CwdChanged', fields: { old_cwd: oldCwd, new_cwd: state.cwd }, cwd: state.cwd }, true, this.engine.envFile(session, 'cwd'))
        }
        this.startWatching(agent)
        return
      }
      case 'approval/asked': {
        if (!this.engine.has('Notification') || agent === undefined) return
        const id = String(data['id'] ?? '')
        const tool = foreignTool('claude-code', String(data['toolName'] ?? ''), {}, this.engine.toolContext(agent)).name
        this.engine.notifyTimers.set(id, setTimeout(() => {
          this.engine.notifyTimers.delete(id)
          this.detachedEvent(agent, { event: 'Notification', subject: 'permission_prompt', fields: { notification_type: 'permission_prompt', title: 'Permission needed', message: `Claude needs your permission to use ${tool}` } })
        }, 6_000))
        return
      }
      case 'approval/decided': {
        const id = String(data['id'] ?? '')
        clearTimeout(this.engine.notifyTimers.get(id))
        this.engine.notifyTimers.delete(id)
        return
      }
      case 'assistant/message': {
        if (!this.engine.has('PostModelRequest') || agent === undefined) return
        const message = isRecord(data['message']) ? data['message'] : {}
        this.detachedEvent(agent, { event: 'PostModelRequest', fields: { model: agent.options?.model, turn_id: String(data['turn'] ?? ''), status: 'completed', error: null, token_usage: message['usage'] ?? null } })
        return
      }
      default:
    }
  }

  /** Arm the `idle_prompt` notification: 60 s after a root turn ends without new input. */
  armIdle(agent: AgentLike): void {
    if (!this.engine.has('Notification')) return
    const id = agent.session.header.id
    clearTimeout(this.engine.idleTimers.get(id))
    this.engine.idleTimers.set(id, setTimeout(() => {
      this.engine.idleTimers.delete(id)
      this.detachedEvent(agent, { event: 'Notification', subject: 'idle_prompt', fields: { notification_type: 'idle_prompt', title: 'Waiting for input', message: 'Claude is waiting for your input' } })
    }, 60_000))
  }

  // -------------------------------------------------------------------------
  // FileChanged
  // -------------------------------------------------------------------------

  setWatchPaths(agent: AgentLike, paths: readonly string[]): void {
    this.engine.state(agent.session).watchPaths = [...paths]
    this.startWatching(agent)
  }

  /** Watch the FileChanged matcher filenames in the working directory plus the dynamic watch list. */
  startWatching(agent: AgentLike): void {
    if (!this.engine.has('FileChanged')) return
    const state = this.engine.state(agent.session)
    for (const watcher of state.watchers) watcher.close()
    state.watchers = []
    const cwd = state.cwd ?? this.engine.committedDirectory(agent) ?? agent.session.header.cwd ?? process.cwd()
    const files = new Set(state.watchPaths)
    for (const source of this.engine.sources.values()) {
      for (const group of source.table.get('FileChanged') ?? []) {
        for (const name of (group.matcher ?? '').split('|').map(item => item.trim()).filter(item => item.length > 0)) files.add(resolve(cwd, name))
      }
    }
    const byDir = new Map<string, Set<string>>()
    for (const file of files) {
      const dir = dirname(file)
      if (!existsSync(dir)) continue
      byDir.set(dir, (byDir.get(dir) ?? new Set()).add(basename(file)))
    }
    for (const [dir, names] of byDir) {
      try {
        const watcher = watch(dir, (_type, filename) => {
          if (filename === null || !names.has(filename.toString())) return
          const path = join(dir, filename.toString())
          const kind = existsSync(path) ? 'change' : 'unlink'
          this.detachedEvent(agent, { event: 'FileChanged', subject: basename(path), fields: { file_path: path, event: kind } }, true, this.engine.envFile(agent.session, 'cwd'))
        })
        watcher.unref()
        state.watchers.push(watcher)
      } catch {
        // A directory that cannot be watched is skipped.
      }
    }
  }

  /** Fire an observational event in the background. */
  private detachedEvent(
    agent: AgentLike | undefined,
    occurrence: Omit<Occurrence, 'signal' | 'agent'>,
    userErrors = false,
    envFile?: string,
  ): void {
    this.engine.track(this.engine.run({ ...occurrence, ...(agent !== undefined ? { agent } : {}), signal: this.engine.lifetime.signal }, envFile !== undefined ? { envFile } : {}).then((results) => {
      if (agent === undefined) return
      this.engine.noticeAll(agent, occurrence.event, occurrence.subject, results)
      for (const ran of results) {
        if (userErrors && ran.decoded.block !== undefined) this.engine.notice(agent, { kind: 'hook-error', event: occurrence.event, ...(occurrence.subject !== undefined ? { subject: occurrence.subject } : {}), plugin: ran.source.pluginId, text: ran.decoded.block })
        const watchPaths = specific(ran.decoded)?.['watchPaths']
        if ((occurrence.event === 'CwdChanged' || occurrence.event === 'FileChanged') && Array.isArray(watchPaths)) this.setWatchPaths(agent, watchPaths.map(String))
      }
    }))
  }
}

/** Claude's StopFailure error type for a DSH LLM failure. */
function stopFailureType(code: string, message: string): string {
  const text = `${code} ${message}`.toLowerCase()
  if (/rate.?limit|429/u.test(text)) return 'rate_limit'
  if (/overload|529/u.test(text)) return 'overloaded'
  if (/auth|401|403|api key/u.test(text)) return 'authentication_failed'
  if (/billing|quota|payment|402/u.test(text)) return 'billing_error'
  if (/model.*(not.?found|does not exist)/u.test(text)) return 'model_not_found'
  if (/invalid|400/u.test(text)) return 'invalid_request'
  if (/5\d\d|server/u.test(text)) return 'server_error'
  return 'unknown'
}
