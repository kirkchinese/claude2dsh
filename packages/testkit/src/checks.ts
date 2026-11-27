/**
 * The smoke checks. Each one boots a real DSH with the plugin installed, lets a scripted model act, and asserts
 * what was observed: what reached the model, what a tool returned, what a hook left on disk. Checks name no
 * internal module of the plugin, only what a person or the model can see.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FIXTURES, profileDir, runSession, type Sandbox, type Session } from './dsh.ts'
import { toolResults } from './helpers.ts'
import { isAuxiliary, requestText, systemText, toolNames, type MessagesRequest, type Policy, type Reply } from './mock-llm.ts'

export interface Check {
  readonly name: string
  /** Throws when the behaviour is missing; returns a short note on success. */
  run(sandbox: Sandbox): Promise<string>
}

const CLAUDE_PLUGIN = join(FIXTURES, 'claude-plugin')
const CODEX_PLUGIN = join(FIXTURES, 'codex-plugin')
/** How the plugin names a command: the plugin's name, then the command's. */
const GREET_COMMAND = '/e2e-claude-e2e-greet'
/** The tool that delegates to the plugin's agents. */
const AGENT_TOOL = 'agent'
/** How the plugin names an agent: a DSH agent preset named after the plugin and the agent. */
const AGENT_PRESET = 'e2e-claude-e2e-helper'
const MCP_TOOL = 'mcp__plugin_e2e-claude_e2e-echo__echo'
/** DSH's profile management tool, and the package name of the trivial bundle a session installs with it. */
const PLUGIN_MANAGER_TOOL = 'plugin_manager'
const NOOP_BUNDLE = 'e2e-noop-bundle'
/**
 * How long DSH lets a silent pnpm run before it terminates it (`plugin-manager` row, `idleTimeoutMs`, 10 minutes by
 * default): short here, so a stalled pnpm fails the check quickly (see the check).
 */
const PNPM_IDLE_MS = 20_000
/** The Remote namespace the plugin serves to the browser. */
const REMOTE_NAMESPACE = 'harnessCompat'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * The packages of `root`'s production dependency closure in a hoisted profile that declare `os` or `cpu`,
 * as `name@version`. Resolved as Node resolves them: nested `node_modules` first, then the profile's.
 */
function platformPackagesOf(profile: string, root: string): string[] {
  const top = join(profile, 'node_modules')
  const found: string[] = []
  const seen = new Set<string>()
  const visit = (dir: string): void => {
    if (seen.has(dir)) return
    seen.add(dir)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; os?: unknown; cpu?: unknown; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
    if (manifest.os !== undefined || manifest.cpu !== undefined) found.push(`${manifest.name}@${manifest.version}`)
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      let at = dir
      let resolved: string | undefined
      while (resolved === undefined && at.startsWith(top)) {
        const candidate = join(at, 'node_modules', ...name.split('/'))
        if (existsSync(join(candidate, 'package.json'))) resolved = candidate
        else at = dirname(at)
      }
      if (resolved === undefined && existsSync(join(top, ...name.split('/'), 'package.json'))) resolved = join(top, ...name.split('/'))
      if (resolved !== undefined) visit(resolved)
    }
  }
  visit(join(top, ...root.split('/')))
  return found
}

/** A script for the main agent: its n-th model request gets the n-th reply, then a closing text. */
function steps(...replies: Reply[]): Policy {
  return (_request, seen) => replies[seen.filter(request => !isAuxiliary(request)).length]
}

const call = (name: string, input: Record<string, unknown>): Reply => ({ tools: [{ name, input }] })

/** The text of a request's last message: the result of the tool call the model made last. */
function lastMessageText(request: MessagesRequest): string {
  const last = request.messages?.at(-1)
  return last === undefined ? '' : requestText({ messages: [last] })
}

/** The first request that offered tools: what the model sees at the start of a session. */
function firstAgentRequest(session: Session) {
  const request = session.requests.find(item => !isAuxiliary(item))
  assert(request !== undefined, `the session never reached the model (exit ${String(session.exitCode)}): ${session.stderr.slice(-400)}`)
  return request
}

/** A session several checks read; it runs once. */
const scenarios = new Map<string, Promise<Session>>()
function scenario(name: string, start: () => Promise<Session>): Promise<Session> {
  let session = scenarios.get(name)
  if (session === undefined) {
    session = start()
    scenarios.set(name, session)
  }
  return session
}

const hookScenario = (sandbox: Sandbox): Promise<Session> => scenario('hooks', () => runSession(sandbox, {
  name: 'hooks',
  task: 'Run the commands.',
  preload: [CLAUDE_PLUGIN],
  policy: steps(
    call('bash', { command: 'echo E2E-ALLOWED', description: 'Print a word' }),
    call('bash', { command: 'touch denied-ran.txt # E2E-DENY', description: 'Create a file' }),
  ),
}))

export const checks: readonly Check[] = [
  {
    name: 'skill',
    async run(sandbox) {
      const session = await runSession(sandbox, {
        name: 'skill',
        task: 'What is the e2e secret word?',
        preload: [CLAUDE_PLUGIN],
        policy: steps(call('skill', { name: 'e2e-skill' })),
      })
      assert(requestText(firstAgentRequest(session)).includes('`e2e-skill`: E2E smoke skill'), 'the skill is not in the model\'s skill catalog')
      const [loaded] = toolResults(session.events, 'skill')
      assert(loaded?.ok === true && loaded.text.includes('SKILL-BODY-7f3a'), `the skill did not load: ${loaded?.text ?? 'no skill call'}`)
      return 'listed in the catalog and loaded'
    },
  },
  {
    name: 'command',
    async run(sandbox) {
      const session = await runSession(sandbox, {
        name: 'command',
        task: 'Run the command.',
        preload: [CLAUDE_PLUGIN],
        policy: steps(call('lab_command', { line: `${GREET_COMMAND} World` })),
      })
      const [dispatch] = toolResults(session.events, 'lab_command')
      assert(dispatch !== undefined && !dispatch.text.includes('unknown-command'), `the command is not registered: ${dispatch?.text ?? 'no lab_command call'}`)
      // The expanded body, with the argument in place of $ARGUMENTS, reaches the model after the dispatch.
      const expanded = session.requests.find(request => requestText(request).includes('COMMAND-BODY-91c2: greet World in one short sentence'))
      assert(expanded !== undefined, `the expanded command never reached the model (dispatch: ${dispatch.text})`)
      return 'dispatched with its argument expanded'
    },
  },
  {
    name: 'agent',
    async run(sandbox) {
      // The parent delegates to the plugin's agent and waits for it; the child answers under the agent's own prompt.
      const policy: Policy = (request, seen) => {
        if (systemText(request).includes('AGENT-BODY-5d1e')) return { text: 'HELPER-DONE' }
        const turns = seen.filter(item => !isAuxiliary(item) && !systemText(item).includes('AGENT-BODY-5d1e')).length
        if (turns === 0) return call(AGENT_TOOL, { description: 'Ask the helper', prompt: 'Say your word.', agent_preset: AGENT_PRESET })
        if (turns === 1 && toolNames(request).includes('wait_agent')) return call('wait_agent', { timeout_ms: 60_000 })
        return undefined
      }
      const session = await runSession(sandbox, { name: 'agent', task: 'Delegate to the e2e helper.', preload: [CLAUDE_PLUGIN], policy })
      const offered = firstAgentRequest(session).tools?.find(tool => tool.name === AGENT_TOOL)
      assert(JSON.stringify(offered).includes(AGENT_PRESET), 'the agent is not offered for delegation')
      assert(session.requests.some(request => systemText(request).includes('AGENT-BODY-5d1e')), 'the delegated agent did not run under its own prompt')
      const last = session.requests.filter(request => !isAuxiliary(request) && !systemText(request).includes('AGENT-BODY-5d1e')).at(-1)!
      assert(requestText(last).includes('HELPER-DONE'), 'the agent\'s answer did not come back to the parent')
      return 'offered for delegation, ran under its prompt, answered the parent'
    },
  },
  {
    name: 'hook-runs',
    async run(sandbox) {
      const session = await hookScenario(sandbox)
      const log = join(session.cwd, 'e2e-plugin-hook.log')
      assert(existsSync(log), 'the PreToolUse hook left no log: it never ran')
      assert(readFileSync(log, 'utf8').includes('E2E-ALLOWED'), 'the hook ran without the tool call on its stdin')
      const [allowed] = toolResults(session.events, 'bash')
      assert(allowed?.ok === true && allowed.text.includes('E2E-ALLOWED'), `an allowed command did not run: ${allowed?.text ?? 'no bash call'}`)
      return 'ran before the tool call and let it through'
    },
  },
  {
    name: 'hook-deny',
    async run(sandbox) {
      const session = await hookScenario(sandbox)
      const denied = toolResults(session.events, 'bash')[1]
      assert(denied !== undefined && !denied.ok, `the denied command was not reported as failed: ${denied?.text ?? 'no second bash call'}`)
      assert(denied.text.includes('blocked by the e2e hook'), `the deny reason did not reach the model: ${denied.text}`)
      assert(!existsSync(join(session.cwd, 'denied-ran.txt')), 'the denied command ran anyway')
      return 'blocked the tool call with its reason'
    },
  },
  {
    name: 'mcp',
    async run(sandbox) {
      const session = await runSession(sandbox, {
        name: 'mcp',
        task: 'Echo ping.',
        preload: [CLAUDE_PLUGIN],
        policy: steps(call(MCP_TOOL, { text: 'ping' })),
      })
      assert(toolNames(firstAgentRequest(session)).includes(MCP_TOOL), 'the MCP tool is not offered to the model')
      const [echoed] = toolResults(session.events, MCP_TOOL)
      assert(echoed?.ok === true && echoed.text.includes('MCP-ECHO:ping'), `the MCP tool call failed: ${echoed?.text ?? 'no call'}`)
      return 'listed and callable'
    },
  },
  {
    name: 'user-setup',
    async run(sandbox) {
      cpSync(join(FIXTURES, 'claude-home/.claude'), join(sandbox.home, '.claude'), { recursive: true })
      const session = await runSession(sandbox, {
        name: 'user-setup',
        task: 'Run a command.',
        preload: [`claude-code:${join(sandbox.home, '.claude')}`],
        policy: steps(call('skill', { name: 'home-skill' }), call('bash', { command: 'echo E2E-USER', description: 'Print a word' })),
      })
      const [loaded] = toolResults(session.events, 'skill')
      assert(loaded?.ok === true && loaded.text.includes('HOME-BODY-c04d'), `the ~/.claude skill did not load: ${loaded?.text ?? 'no skill call'}`)
      const log = join(session.cwd, 'e2e-user-hook.log')
      assert(existsSync(log) && readFileSync(log, 'utf8').includes('E2E-USER'), 'the ~/.claude settings hook did not run')
      return '~/.claude skill loads and its settings hook runs'
    },
  },
  {
    name: 'codex-plugin',
    async run(sandbox) {
      const session = await runSession(sandbox, {
        name: 'codex',
        task: 'What is the codex secret word?',
        preload: [`codex:${CODEX_PLUGIN}`],
        policy: steps(call('skill', { name: 'codex-skill' })),
      })
      const [loaded] = toolResults(session.events, 'skill')
      assert(loaded?.ok === true && loaded.text.includes('CODEX-BODY-2b8c'), `the Codex skill did not load: ${loaded?.text ?? 'no skill call'}`)
      return 'Codex skill loads'
    },
  },
  {
    name: 'instructions',
    async run(sandbox) {
      // DSH reads CLAUDE.md itself; the plugin adds what DSH does not: the user's file, .claude/CLAUDE.md and @imports.
      const cwd = sandbox.directory('instructions')
      mkdirSync(join(cwd, '.claude'), { recursive: true })
      writeFileSync(join(cwd, 'CLAUDE.md'), 'ROOT-INSTRUCTION-52f0 @notes.md\n')
      writeFileSync(join(cwd, '.claude/CLAUDE.md'), 'DOT-INSTRUCTION-3c9e\n')
      writeFileSync(join(cwd, 'notes.md'), 'IMPORTED-NOTE-8b21\n')
      const userFile = join(sandbox.home, '.claude/CLAUDE.md')
      mkdirSync(join(sandbox.home, '.claude'), { recursive: true })
      writeFileSync(userFile, 'USER-INSTRUCTION-aa17\n')
      try {
        const session = await runSession(sandbox, { name: 'instructions', task: 'Hello.', cwd, policy: () => undefined })
        const request = firstAgentRequest(session)
        const system = systemText(request)
        for (const marker of ['USER-INSTRUCTION-aa17', 'DOT-INSTRUCTION-3c9e', 'IMPORTED-NOTE-8b21']) assert(system.includes(marker), `${marker} is not in the system prompt`)
        assert(requestText(request).includes('ROOT-INSTRUCTION-52f0'), 'DSH did not load the project CLAUDE.md')
        assert(!system.includes('ROOT-INSTRUCTION-52f0'), 'the project CLAUDE.md was added twice')
        return 'user, .claude and imported files in the system prompt; the project file left to DSH'
      } finally {
        rmSync(userFile, { force: true })
      }
    },
  },
  {
    name: 'session-import',
    async run(sandbox) {
      const cwd = sandbox.directory('import')
      const transcript = join(sandbox.root, '11111111-2222-4333-8444-555555555555.jsonl')
      writeFileSync(transcript, readFileSync(join(FIXTURES, 'sessions/claude-session.jsonl'), 'utf8').replaceAll('__CWD__', cwd))
      mkdirSync(cwd, { recursive: true })
      const imported = await runSession(sandbox, {
        name: 'import',
        task: 'Import the session.',
        cwd,
        policy: steps(call('lab_remote', { namespace: REMOTE_NAMESPACE, method: 'importSession', request: { path: transcript, source: 'claude-code' } })),
      })
      const [result] = toolResults(imported.events, 'lab_remote')
      assert(result?.ok === true, `importSession failed: ${result?.text ?? 'no call'}`)
      const sessionId = /"(?:sessionId|id|targetId)":"([^"]+)"/u.exec(result.text)?.[1]
      assert(sessionId !== undefined, `importSession returned no session id: ${result.text}`)
      // Registered with the running DSH, so it opens at once (no restart), grouped under its project.
      assert(result.text.includes('"live":true'), `the imported session is not live in DSH: ${result.text}`)
      assert(result.text.includes('"workspace":'), `the imported session is not in the workspace of its directory: ${result.text}`)
      // The imported history is what the model sees when the session continues in DSH.
      const resumed = await runSession(sandbox, { name: 'resume', task: 'Continue.', cwd, args: ['--session-id', sessionId], policy: () => undefined })
      const request = firstAgentRequest(resumed)
      assert(requestText(request).includes('IMPORT-MARK-a1b2'), 'the imported conversation did not reach the model')
      return `imported as ${sessionId}, live at once in its workspace, and continued with its history`
    },
  },
  {
    name: 'project-trust',
    async run(sandbox) {
      // A cloned project's own hook must not run until the person trusts the folder; then it runs in the open session.
      // Its deny rule is a restriction, so it blocks a call at once even though the same file also holds an allow rule and an env.
      const cwd = sandbox.directory('project-trust')
      mkdirSync(join(cwd, '.claude'), { recursive: true })
      writeFileSync(join(cwd, '.claude/settings.json'), JSON.stringify({
        permissions: { allow: ['Bash(echo E2E-GRANTED:*)'], deny: ['Bash(echo E2E-DENIED:*)'] },
        env: { E2E_PROJECT_ENV: 'set' },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'cat >> "$CLAUDE_PROJECT_DIR/project-hook.log"' }] }] },
      }))
      const remote = (method: string, request: Record<string, unknown>): Reply => call('lab_remote', { namespace: REMOTE_NAMESPACE, method, request })
      const session = await runSession(sandbox, {
        name: 'project-trust',
        task: 'Run the commands.',
        cwd,
        policy: steps(
          call('bash', { command: 'echo E2E-UNTRUSTED', description: 'Print a word' }),
          call('bash', { command: 'echo E2E-DENIED', description: 'Print a word the project denies' }),
          remote('workspaceTrust', { cwd }),
          remote('trustWorkspace', { cwd, trusted: true }),
          call('bash', { command: 'echo E2E-TRUSTED', description: 'Print a word' }),
        ),
      })
      const log = join(cwd, 'project-hook.log')
      const ran = existsSync(log) ? readFileSync(log, 'utf8') : ''
      const [before, denied, after] = toolResults(session.events, 'bash')
      assert(before?.ok === true && after?.ok === true, `the commands did not run: ${before?.text ?? 'none'} / ${after?.text ?? 'none'}`)
      assert(denied?.ok === false && denied.text.includes('denied by the rule Bash(echo E2E-DENIED:*)'), `the untrusted project's deny rule did not block the call: ${denied?.text ?? 'none'}`)
      assert(!ran.includes('E2E-DENIED'), 'the project hook saw a call its deny rule blocks')
      assert(!ran.includes('E2E-UNTRUSTED'), 'the project hook ran before the workspace was trusted')
      const [status] = toolResults(session.events, 'lab_remote')
      assert(status?.ok === true && status.text.includes('"trusted":false') && status.text.includes('waiting for you to trust this workspace'), `workspaceTrust did not report the waiting hook: ${status?.text ?? 'no call'}`)
      assert(ran.includes('E2E-TRUSTED'), 'the project hook did not run after the workspace was trusted')
      return 'hook held back while untrusted, deny rule applied at once, hook ran once trusted'
    },
  },
  {
    name: 'plugin-install',
    async run(sandbox) {
      // What Fill with AI's agent does: install a local bundle directory with plugin_manager from inside a session.
      const bundle = join(sandbox.root, 'noop-bundle')
      cpSync(join(FIXTURES, 'noop-bundle'), bundle, { recursive: true })
      // pnpm 11 with DSH's hoisted layout finishes the first install after a package with platform-specific optional
      // dependencies lands in the profile, then never exits. Harness Forge brings none, so the first call completes.
      const policy = steps(
        call(PLUGIN_MANAGER_TOOL, { action: 'install_bundle', target: bundle }),
        call(PLUGIN_MANAGER_TOOL, { action: 'list_bundles', limit: 100 }),
      )
      const session = await runSession(sandbox, {
        name: 'plugin-install',
        task: 'Install the bundle.',
        policy,
        // Live apply, as in the Web profile Fill with AI runs in: headless turns DSH's HMR off.
        rows: [{ id: 'hmr', disabled: false }, { id: 'plugin-manager', config: { idleTimeoutMs: PNPM_IDLE_MS } }],
        timeoutMs: 180_000,
      })
      const results = toolResults(session.events, PLUGIN_MANAGER_TOOL)
      assert(session.exitCode === 0, `the session did not finish (exit ${String(session.exitCode)}): ${results.at(-1)?.text.slice(0, 300) ?? session.stderr.slice(-400)}`)
      assert(results.length === 2, `a plugin_manager call never returned (${String(results.length)} results for 2 calls)`)
      const done = JSON.parse(results[0]!.text) as { application?: string; changed?: boolean }
      assert(done.changed === true && done.application === 'applied', `the first install_bundle did not install and apply the bundle live: ${results[0]!.text.slice(0, 400)}`)
      // The listing as the model received it: the JSON event clips long results.
      const listing = lastMessageText(session.requests.filter(item => !isAuxiliary(item)).at(-1)!)
      const listed = (JSON.parse(listing.slice(listing.indexOf('{'))) as { entries: Array<{ name: string; enabled?: boolean }> }).entries.find(entry => entry.name === NOOP_BUNDLE)
      assert(listed?.enabled === true, `list_bundles does not show the bundle enabled: ${listing.slice(0, 400)}`)
      const manifest = JSON.parse(readFileSync(join(profileDir(sandbox), 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
      assert(manifest.dependencies?.[NOOP_BUNDLE] !== undefined, 'the profile does not depend on the installed bundle')
      const platformBound = platformPackagesOf(profileDir(sandbox), '@kirkchinese/harness-forge')
      assert(platformBound.length === 0, `Harness Forge brings packages restricted to an OS or CPU into the profile: ${platformBound.join(', ')}`)
      return 'installed on the first call, applied live and listed; no platform-specific package from Harness Forge'
    },
  },
]
