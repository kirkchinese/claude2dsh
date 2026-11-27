/**
 * Everything that touches a real DSH: the isolated sandbox (temp DSH_HOME and HOME), the packed plugin
 * installed into a fresh profile, and headless sessions against a scripted model.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentPlanePatch, parseEvents, type HeadlessEvent } from './helpers.ts'
import { startScriptedLlm, type MessagesRequest, type Policy } from './mock-llm.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')

/** The loader row of the plugin under test; sessions configure `preload` on it. */
const PLUGIN_ROW = 'harness-forge'
const PROFILE = 'e2e'

/** Web rows that serve the browser transport or the signed-in account, not the agent runtime. */
const WEB_ONLY_ROWS = new Set([
  'web-startup', 'webserver', 'web-runtime', 'desktop-product-telemetry', 'open-in-app', 'directory-picker',
  'harness-dev-context', 'session-log-download', 'session-controller', 'schedule', 'account-controller',
])

const children = new Set<ChildProcess>()

/** Kill every process this run started and still has running. */
export function killAll(): void {
  for (const child of children) killTree(child)
}

function killTree(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

interface Finished {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Run a command to completion in its own process group, killing the group when it outlives `timeoutMs`. */
function run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Finished> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? REPO, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    children.add(child)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, options.timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      children.delete(child)
      resolvePromise({ code: timedOut ? null : code, stdout, stderr: timedOut ? `${stderr}\n[timed out after ${String(options.timeoutMs)} ms]` : stderr })
    })
  })
}

async function must(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<Finished> {
  const result = await run(command, args, { timeoutMs: 600_000, ...options })
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${String(result.code)})\n${result.stdout}\n${result.stderr}`)
  return result
}

/** The throwaway world of one run: its own DSH_HOME and HOME, and room for workspaces. */
export interface Sandbox {
  readonly root: string
  readonly dshHome: string
  readonly home: string
  readonly dshVersion: string
  /** A fresh empty directory under the sandbox. */
  directory(name: string): string
  dispose(): void
}

export async function createSandbox(): Promise<Sandbox> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hf-e2e-')))
  const dshHome = join(root, 'dsh-home')
  const home = join(root, 'home')
  mkdirSync(dshHome)
  mkdirSync(home)
  const version = (await must('dsh', ['--version'], { timeoutMs: 60_000 })).stdout.trim()
  return {
    root,
    dshHome,
    home,
    dshVersion: version,
    directory(name) {
      const path = join(root, 'work', name)
      rmSync(path, { recursive: true, force: true })
      mkdirSync(path, { recursive: true })
      return path
    },
    dispose() {
      killAll()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The directory of the profile under test. */
export function profileDir(sandbox: Sandbox): string {
  return join(sandbox.dshHome, 'profiles', PROFILE)
}

/** The environment of every `dsh` child: the parent's, minus anything that could point at a real DSH. */
function dshEnv(sandbox: Sandbox, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(DSH_|DEEPSEEK_|CLAUDE_|CODEX_|OPENCODE_|XDG_)/u.test(key)) env[key] = value
  }
  return {
    ...env,
    DSH_HOME: sandbox.dshHome,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    // The person's shared skills (~/.agents) would stand in for the fixtures'.
    DSH_AGENTS_HOME: join(sandbox.root, 'agents-home'),
    // The Web default preset: no sandbox, no approvals.
    DSH_PERMISSION_MODE: 'danger-full-access',
    ...extra,
  }
}

/** Build core and plugin, pack both and the lab plugin into `<sandbox>/tarballs`. */
export async function packAll(sandbox: Sandbox): Promise<{ core: string; plugin: string; lab: string }> {
  const filters = ['@kirkchinese/harness-forge-core', '@kirkchinese/harness-forge']
  await must('pnpm', ['--filter', filters[0]!, 'build'])
  await must('pnpm', ['--filter', filters[1]!, 'build'])
  await must('pnpm', ['--filter', filters[1]!, 'build:client'])
  const out = join(sandbox.root, 'tarballs')
  mkdirSync(out)
  await must('pnpm', ['--filter', filters[0]!, 'pack', '--pack-destination', out])
  await must('pnpm', ['--filter', filters[1]!, 'pack', '--pack-destination', out])
  await must('pnpm', ['pack', '--pack-destination', out], { cwd: join(REPO, 'packages/testkit/lab-plugin') })
  const find = (prefix: string): string => {
    const name = readdirSync(out).find(file => file.startsWith(prefix) && /^-\d+\.\d+\.\d+.*\.tgz$/u.test(file.slice(prefix.length)))
    if (name === undefined) throw new Error(`no tarball ${prefix}*.tgz in ${out}`)
    return join(out, name)
  }
  return { core: find('kirkchinese-harness-forge-core'), plugin: find('kirkchinese-harness-forge'), lab: find('kirkchinese-dsh-harness-e2e-lab') }
}

/** The installed `@deepseek-ai/dsh-web-app` bundle next to the `dsh` on PATH. */
function webBundle(): string {
  const bin = (process.env['PATH'] ?? '').split(delimiter).map(dir => join(dir, 'dsh')).find(candidate => existsSync(candidate))
  if (bin === undefined) throw new Error('`dsh` is not on PATH')
  for (let dir = dirname(realpathSync(bin)); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === '@deepseek-ai/dsh') {
      for (const candidate of [join(dir, 'node_modules/@deepseek-ai/dsh-web-app'), join(dirname(dir), 'dsh-web-app')]) if (existsSync(join(candidate, 'cordis.patch.yml'))) return candidate
    }
  }
  throw new Error('the DSH Web bundle (@deepseek-ai/dsh-web-app) was not found next to `dsh`')
}

/**
 * Create the profile: the shipped headless template, the packed plugin installed as a person installs it (so its
 * own cordis.patch.yml inserts every row), and the Web agent plane over it.
 */
export async function createProfile(sandbox: Sandbox, tarballs: { core: string; plugin: string; lab: string }): Promise<void> {
  const env = dshEnv(sandbox)
  await must('dsh', ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], { env, timeoutMs: 120_000 })
  const dir = join(sandbox.dshHome, 'profiles', PROFILE)
  // The plugin depends on its core by version; the packed core stands in for the unpublished release.
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n\noverrides:\n  '@kirkchinese/harness-forge-core': 'file:${tarballs.core}'\n`)
  await must('dsh', ['plugin', '--profile', PROFILE, 'add', tarballs.core, tarballs.plugin, tarballs.lab], { env })

  const bundle = webBundle()
  writeFileSync(join(sandbox.root, 'agent-plane.patch.yml'), agentPlanePatch(readFileSync(join(bundle, 'cordis.patch.yml'), 'utf8'), WEB_ONLY_ROWS))
  const manifest = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string | string[] } } }
  const presets = [manifest.dsh?.bundle?.patch ?? []].flat().filter(path => path.includes('presets/')).map(path => join(bundle, path))
  writeFileSync(join(sandbox.root, 'agent-plane.json'), JSON.stringify([join(sandbox.root, 'agent-plane.patch.yml'), ...presets]))
}

/** What one headless session produced. */
export interface Session {
  readonly exitCode: number | null
  readonly events: readonly HeadlessEvent[]
  readonly stderr: string
  readonly requests: readonly MessagesRequest[]
  /** The workspace the session ran in. */
  readonly cwd: string
}

export interface SessionSpec {
  readonly name: string
  readonly task: string
  readonly policy: Policy
  /** Plugin roots the plugin under test installs at boot (`claude-code:<path>` names the dialect). */
  readonly preload?: readonly string[]
  /** Extra headless arguments before the task, such as `--session-id`. */
  readonly args?: readonly string[]
  /** Use this workspace instead of a fresh one. */
  readonly cwd?: string
  /** More loader patch entries for this session, such as `{ id, config }` or `{ id, disabled }`. */
  readonly rows?: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly timeoutMs?: number
}

/** Boot the profile once against a scripted model and run one task. */
export async function runSession(sandbox: Sandbox, spec: SessionSpec): Promise<Session> {
  const cwd = spec.cwd ?? sandbox.directory(spec.name)
  const overlay = join(sandbox.root, `${spec.name}.overlay.json`)
  writeFileSync(overlay, JSON.stringify([
    { id: PLUGIN_ROW, config: { preload: spec.preload ?? [] } },
    ...spec.rows ?? [],
  ]))
  const planes = JSON.parse(readFileSync(join(sandbox.root, 'agent-plane.json'), 'utf8')) as string[]
  const llm = await startScriptedLlm(spec.policy)
  try {
    const result = await run('dsh', [
      '--profile', PROFILE,
      ...[...planes, overlay].flatMap(patch => ['--patch', patch]),
      '--json',
      ...spec.args ?? [],
      spec.task,
    ], {
      cwd,
      timeoutMs: spec.timeoutMs ?? 180_000,
      env: dshEnv(sandbox, { DEEPSEEK_BASE_URL: llm.baseURL, DEEPSEEK_API_KEY: 'e2e', GIT_CEILING_DIRECTORIES: dirname(cwd) }),
    })
    const session = { exitCode: result.code, events: parseEvents(result.stdout), stderr: result.stderr, requests: [...llm.requests], cwd }
    // Kept with the sandbox (E2E_KEEP=1) for inspecting a failure.
    mkdirSync(join(sandbox.root, 'logs'), { recursive: true })
    writeFileSync(join(sandbox.root, 'logs', `${spec.name}.json`), JSON.stringify(session, null, 1))
    return session
  } finally {
    await llm.close()
  }
}
