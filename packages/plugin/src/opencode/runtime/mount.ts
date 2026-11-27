/**
 * Mounting an OpenCode plugin: its Bun host, its tools as DSH tools, the
 * commands its `config` hook adds, and its unload.
 * @module @kirkchinese/harness-forge/opencode
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kebabCase, uniqueName, type CodeComponent, type ForeignPlugin } from '@kirkchinese/harness-forge-core'
import { ensureBun, ensureDependencies } from '../bun.js'
import { isRecord } from '../convert.js'
import { dshService } from '../../dsh/host.js'
import type { OpenCodeCore } from './core.js'
import { messageOf } from '../../shared/util.js'
import type { OpenCodeServer } from './server.js'
import type { OpenCodeCommand, OpenCodeMount, PluginHost, ToolExec, ToolRegistry } from './types.js'

/** `@opencode-ai/sdk/client` (an ESM-only export), found from this module up. */
function sdkClient(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', '@opencode-ai', 'sdk', 'dist', 'client.js')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) throw new Error('@opencode-ai/sdk is not installed beside Harness Forge')
  }
}
const HOST_SCRIPT = fileURLToPath(new URL('../../../runtime/opencode-host.mjs', import.meta.url))

/** Starts plugins' Bun hosts and registers their tools and commands. */
export class PluginMounter {
  constructor(private readonly core: OpenCodeCore, private readonly http: OpenCodeServer, private readonly loadTimeoutMs: number = 180_000) {}

  // ---------------------------------------------------------------------------
  // Mounting
  // ---------------------------------------------------------------------------

  /** Start a plugin's Bun host and register its tools and commands. */
  async mount(component: CodeComponent, plugin: ForeignPlugin, options: Record<string, unknown> = {}): Promise<OpenCodeMount> {
    if (component.entryPath === undefined) throw new Error(`code component "${component.name}" has no entry path`)
    await this.http.listen()
    const bun = await ensureBun(this.core.host.dataRoot)
    await ensureDependencies(bun, plugin.root)
    const directory = process.cwd()
    const project = this.core.projectOf(directory)
    const key = `${kebabCase(plugin.name)}-${randomUUID().slice(0, 8)}`
    const config = this.core.configFor(directory)
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => { this.core.waiting.set(key, { resolve, reject }) })
    // No auto-install: a plugin uses the dependencies installed beside it, as in OpenCode's plugin cache.
    // A plugin resolves its modules from its own install, as in OpenCode: the DSH process's NODE_PATH does not reach it.
    const { NODE_PATH: _nodePath, ...inherited } = process.env
    let child: ChildProcess
    try {
      child = spawn(bun, ['--no-install', HOST_SCRIPT], {
        cwd: plugin.root,
        windowsHide: true,
        env: {
          ...inherited,
          HF_OC_ENTRY: component.entryPath,
          HF_OC_SERVER: this.http.base,
          HF_OC_KEY: key,
          HF_OC_SDK: sdkClient(),
          HF_OC_INPUT: JSON.stringify({ directory, worktree: project.worktree, project: { id: project.id, worktree: project.worktree, vcs: 'git', time: { created: project.created } }, options, config, auth: this.core.storedAuth() }),
        },
      })
    } catch (error: unknown) {
      this.core.waiting.delete(key)
      throw error
    }
    // The Bun host ends with this process, however it ends.
    const stop = (): void => { if (child.exitCode === null) child.kill() }
    process.once('exit', stop)
    const record: PluginHost = { key, componentId: component.id, pluginName: plugin.name, root: plugin.root, url: '', child, hooks: new Set(), tools: [], config: {}, events: Promise.resolve(), log: '' }
    const keep = (chunk: Buffer): void => { record.log = (record.log + chunk.toString()).slice(-8000) }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    // An asynchronous spawn failure (a missing or non-executable Bun) arrives as `error`; unhandled it would take DSH down.
    child.on('error', (error) => {
      process.removeListener('exit', stop)
      record.log = `${record.log}${error.message}\n`.slice(-8000)
      this.core.waiting.get(key)?.reject(new Error(`the plugin's Bun host could not run: ${error.message}`))
      this.core.waiting.delete(key)
      if (this.core.hosts.get(key) === record) this.core.hosts.delete(key)
    })
    child.once('exit', () => { process.removeListener('exit', stop) })
    child.on('exit', (code) => {
      this.core.waiting.get(key)?.reject(new Error(`the plugin's Bun host exited with ${String(code)} before it was ready: ${record.log.trim().split(/\r?\n/u).slice(-6).join(' | ')}`))
      this.core.waiting.delete(key)
      if (this.core.hosts.get(key) === record) this.core.hosts.delete(key)
    })
    const timer = setTimeout(() => {
      this.core.waiting.get(key)?.reject(new Error(`the plugin did not finish loading in ${String(Math.round(this.loadTimeoutMs / 1000))}s: ${record.log.trim().split(/\r?\n/u).slice(-6).join(' | ')}`))
    }, this.loadTimeoutMs)
    const disposers: Array<() => void> = []
    // Whatever fails from here on leaves nothing behind: no process, no tool, no host record.
    const rollback = (): void => {
      clearTimeout(timer)
      this.core.waiting.delete(key)
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose() } catch { /* already gone */ }
      }
      if (this.core.hosts.get(key) === record) this.core.hosts.delete(key)
      process.removeListener('exit', stop)
      if (child.exitCode === null && !child.killed) child.kill()
    }
    try {
      const body = await ready
      clearTimeout(timer)
      this.core.waiting.delete(key)
      if (typeof body['error'] === 'string') throw new Error(`OpenCode plugin ${plugin.name} failed to load: ${body['error'].split('\n')[0] ?? ''}`)
      record.url = `http://127.0.0.1:${String(body['port'])}`
      const loaded = Array.isArray(body['plugins']) ? body['plugins'].filter(isRecord) : []
      record.hooks = new Set(loaded.flatMap(item => (Array.isArray(item['hooks']) ? item['hooks'].map(String) : [])))
      record.tools = (Array.isArray(body['tools']) ? body['tools'].filter(isRecord) : []).map(tool => ({
        name: String(tool['name']),
        description: String(tool['description'] ?? ''),
        parameters: isRecord(tool['parameters']) ? tool['parameters'] : { type: 'object', additionalProperties: true },
      }))
      record.config = isRecord(body['config']) ? body['config'] : {}
      this.core.hosts.set(key, record)

      const registered: string[] = []
      const registry = dshService(this.core.ctx, 'tools') as ToolRegistry | undefined
      for (const tool of record.tools) {
        if (registry === undefined) break
        let name = tool.name
        try {
          disposers.push(registry.register(this.toolDefinition(record, tool, name)))
        } catch {
          name = uniqueName(kebabCase(`${plugin.name}-${tool.name}`).replace(/-/gu, '_'), new Set(registered), `${plugin.id}:${tool.name}`)
          disposers.push(registry.register(this.toolDefinition(record, tool, name)))
        }
        registered.push(name)
      }
      const commands = this.addedCommands(component, config, record.config)
      const configChanged = [...new Set([...Object.keys(config), ...Object.keys(record.config)])]
        .filter(key => JSON.stringify(config[key]) !== JSON.stringify(record.config[key])).sort()
      return {
        tools: registered,
        hooks: [...record.hooks],
        commands,
        configChanged,
        dispose: async () => {
          for (const dispose of disposers.splice(0)) dispose()
          this.core.hosts.delete(key)
          // Events already queued for the plugin (a turn's last session.idle / session.updated) are delivered first:
          // its `dispose` ends the Bun host, and a queued event would then fail. At most two seconds.
          await Promise.race([record.events, new Promise<void>(resolve => setTimeout(resolve, 2000).unref())])
          record.stopping = true
          // The plugin's `dispose` hooks get five seconds; then the process is stopped.
          const disposed = await Promise.race([
            this.core.post(record, '/dispose', {}, { timeoutMs: 5000 }).catch((error: unknown) => ({ ok: false, error: messageOf(error) })),
            new Promise<Record<string, unknown>>(resolve => setTimeout(() => { resolve({ ok: false, error: 'dispose did not answer in 5s' }) }, 5000).unref()),
          ])
          this.recordDisposal(record, disposed)
          await new Promise<void>((resolve) => {
            if (child.exitCode !== null) return resolve()
            const timer = setTimeout(() => { child.kill(); resolve() }, 3000)
            child.once('exit', () => { clearTimeout(timer); resolve() })
          })
        },
      }
    } catch (error: unknown) {
      rollback()
      throw error
    }
  }

  /**
   * How a plugin's unload went (its `dispose` hooks, the process ending), appended to
   * `<dataRoot>/disposed.jsonl`: the record of an uninstalled plugin is gone from the ledger.
   */
  private recordDisposal(record: PluginHost, answer: Record<string, unknown>): void {
    const line = { componentId: record.componentId, plugin: record.pluginName, ok: answer['ok'] === true, ran: Number(answer['ran'] ?? 0), ...(typeof answer['error'] === 'string' ? { error: answer['error'] } : {}), at: new Date().toISOString() }
    try {
      mkdirSync(this.core.host.dataRoot, { recursive: true })
      appendFileSync(join(this.core.host.dataRoot, 'disposed.jsonl'), `${JSON.stringify(line)}\n`)
    } catch {
      // Evidence only.
    }
  }

  /** Evidence: the commands a plugin's `config` hook added, under their DSH names, with the templates the hook gave them. */
  recordAddedCommands(componentId: string, commands: ReadonlyArray<{ readonly name: string; readonly foreignName: string; readonly template: string }>): void {
    const file = join(this.core.host.dataRoot, 'added-commands.json')
    try {
      mkdirSync(this.core.host.dataRoot, { recursive: true })
      const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {}
      all[componentId] = commands
      writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`)
    } catch {
      // Evidence only.
    }
  }

  /** Commands a plugin's `config` hook added, as command components. */
  private addedCommands(component: CodeComponent, before: Record<string, unknown>, after: Record<string, unknown>): OpenCodeCommand[] {
    const was = isRecord(before['command']) ? before['command'] : {}
    const now = isRecord(after['command']) ? after['command'] : {}
    const out: OpenCodeCommand[] = []
    for (const [name, spec] of Object.entries(now)) {
      if (name in was || !isRecord(spec) || typeof spec['template'] !== 'string') continue
      out.push({
        name,
        component: {
          id: `${component.id}:command:${name}`,
          kind: 'command',
          name,
          path: name,
          description: typeof spec['description'] === 'string' ? spec['description'] : '',
          bodyPath: component.entryPath ?? '',
          body: spec['template'],
          frontmatter: {
            ...(typeof spec['agent'] === 'string' ? { agent: spec['agent'] } : {}),
            ...(typeof spec['model'] === 'string' ? { model: spec['model'] } : {}),
            ...(spec['subtask'] === true ? { context: 'fork' } : {}),
          },
        },
      })
    }
    return out
  }

  private toolDefinition(record: PluginHost, tool: PluginHost['tools'][number], name: string): Record<string, unknown> {
    return {
      name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: {},
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      },
      execute: async (args: unknown, exec: ToolExec) => {
        const agent = exec.agent
        const sessionId = agent?.session.header.id ?? ''
        const cwd = agent !== undefined ? await this.core.host.directory(agent, exec.signal).catch(() => agent.session.header.cwd ?? process.cwd()) : process.cwd()
        const callId = exec.callId ?? `call_${randomUUID()}`
        const onAbort = (): void => { void this.core.post(record, '/abort', { callID: callId }).catch(() => undefined) }
        exec.signal.addEventListener('abort', onAbort, { once: true })
        try {
          const answer = await this.core.post(record, '/tool', {
            name: tool.name,
            args,
            context: { sessionID: sessionId, messageID: `msg_${callId}`, agent: agent === undefined ? 'build' : this.core.agentOf(agent), directory: cwd, worktree: this.core.projectOf(cwd).worktree, callID: callId },
          }, { timeoutMs: null })
          if (typeof answer['error'] === 'string') {
            this.core.host.observe(record.componentId, `opencode:tool:${tool.name}`, false, answer['error'].split('\n')[0] ?? '')
            throw new Error(answer['error'])
          }
          this.core.host.observe(record.componentId, `opencode:tool:${tool.name}`, true, `${tool.name} returned`)
          const value = answer['result']
          if (typeof value === 'string') return value
          if (isRecord(value)) {
            const attachments = Array.isArray(value['attachments']) ? value['attachments'].filter(isRecord) : []
            const files = attachments.map(file => `\n[attachment ${String(file['filename'] ?? file['mime'] ?? 'file')}: ${String(file['url'] ?? '').slice(0, 120)}]`).join('')
            return `${String(value['output'] ?? '')}${files}`
          }
          return JSON.stringify(value ?? '')
        } finally {
          exec.signal.removeEventListener('abort', onAbort)
        }
      },
    }
  }
}
