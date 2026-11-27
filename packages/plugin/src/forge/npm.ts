/**
 * npm installs into a directory of Harness Forge's own, outside the profile's
 * `node_modules`: what Harness Forge fetches on first use (Bun, the mods
 * bundler) never goes through the profile's pnpm.
 * @module @kirkchinese/harness-forge
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'

/** What to spawn, without a shell: a program and its arguments. */
export interface Launch {
  readonly command: string
  readonly args: readonly string[]
}

/** What {@link npmLaunch} reads from the machine. */
export interface NpmEnvironment {
  readonly platform: NodeJS.Platform
  /** The running Node's executable. */
  readonly execPath: string
  /** `npm_execpath` when the process was started by npm. */
  readonly npmExecPath?: string
  readonly exists: (path: string) => boolean
}

/**
 * How to run `npm <args>` without a shell. Windows ships npm as `npm.cmd`, which Node refuses to spawn without
 * one (since the 2024 security fix), so npm's own JavaScript CLI runs under the running Node: from `npm_execpath`
 * when npm started this process, else from `node_modules/npm` beside `node.exe` (the Node installer's layout).
 * Elsewhere `npm` is an executable script and runs as it is.
 */
export function npmLaunch(args: readonly string[], env: NpmEnvironment = { platform: process.platform, execPath: process.execPath, ...(process.env['npm_execpath'] !== undefined ? { npmExecPath: process.env['npm_execpath'] } : {}), exists: existsSync }): Launch {
  if (env.platform !== 'win32') return { command: 'npm', args }
  const beside = win32.join(win32.dirname(env.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const cli = [...(env.npmExecPath !== undefined && /\.c?js$/iu.test(env.npmExecPath) && /npm-cli/iu.test(env.npmExecPath) ? [env.npmExecPath] : []), beside].find(candidate => env.exists(candidate))
  if (cli === undefined) throw new Error(`npm's command line (npm-cli.js) was not found beside ${env.execPath}`)
  return { command: env.execPath, args: [cli, ...args] }
}

/** The arguments of `npm install` for `specs`: no install scripts, no audit or funding chatter. */
export function npmInstallArgs(specs: readonly string[]): string[] {
  return ['install', ...specs, '--ignore-scripts', '--no-audit', '--no-fund']
}

/**
 * `npm install <specs>` into `prefix`. The prefix gets a `package.json` of its
 * own first: without one npm walks up to the nearest `package.json`, which
 * under a DSH profile is the profile's, and installs there.
 */
export async function npmInstall(specs: readonly string[], prefix: string, timeoutMs = 600_000): Promise<void> {
  // cwd must exist: a missing cwd makes spawn report ENOENT for npm.
  mkdirSync(prefix, { recursive: true })
  const manifest = join(prefix, 'package.json')
  if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ name: 'harness-forge-tools', private: true }, null, 2)}\n`)
  const npm = npmLaunch(npmInstallArgs(specs))
  await runProcess(npm.command, npm.args, prefix, timeoutMs)
}

/** Run a program to its end; rejects with the tail of its output when it fails. */
export function runProcess(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000) })
    child.stderr?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000) })
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${String(code)}: ${output.trim().split(/\r?\n/u).slice(-4).join(' | ')}`))
    })
  })
}
