/**
 * The browser's view of the `harnessCompat` Remote namespace: the
 * contribution `ctx.remote.$mount` needs (one entry per Host method in
 * `workbench/remote.ts`, each taking at most one JSON `request`), and `call` / `stream`
 * helpers the workbench uses. Every workbench request travels through DSH's
 * own Remote carrier.
 * @module @kirkchinese/harness-forge/client
 */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'

/** [method, mode, takes a request]; mirrors REMOTE_METHODS of the Host. */
const METHODS: ReadonlyArray<readonly [string, 'unary' | 'stream', boolean]> = [
  ['overview', 'unary', false],
  ['workspaceTrust', 'unary', true],
  ['trustWorkspace', 'unary', true],
  ['trustDecisions', 'unary', false],
  ['dismissTrust', 'unary', true],
  ['discover', 'unary', false],
  ['contextStatus', 'unary', false],
  ['diagnostics', 'unary', false],
  ['settings', 'unary', false],
  ['saveSettings', 'unary', true],
  ['installPlugin', 'unary', true],
  ['migrate', 'unary', true],
  ['setPartEnabled', 'unary', true],
  ['removePlugin', 'unary', true],
  ['marketplaceScan', 'unary', true],
  ['marketplaceInstall', 'unary', true],
  ['signIns', 'unary', false],
  ['signIn', 'unary', true],
  ['sessions', 'unary', true],
  ['importSession', 'unary', true],
  ['sessionImport', 'unary', false],
  ['installChatImport', 'unary', false],
  ['modSurfaces', 'stream', true],
  ['modAct', 'unary', true],
  ['modClose', 'unary', true],
  ['modMove', 'unary', true],
  ['adapterSurface', 'stream', true],
  ['adapterRead', 'unary', true],
  ['portBrief', 'unary', true],
  ['portGap', 'unary', true],
  ['portSessions', 'unary', false],
  ['verifyPort', 'unary', true],
]

const json = (typeSymbol: string) => ({
  mode: 'strict' as const,
  typeSymbol,
  create: () => z.unknown(),
  jsonSchema: {},
})

const remote = createTypertRemoteInfo({
  package: '@kirkchinese/harness-forge',
  methods: Object.fromEntries(METHODS.map(([method, mode, takesRequest]) => [`harnessCompat/${method}`, {
    service: 'harnessCompat',
    invocation: { kind: 'direct' as const },
    ...(mode === 'stream' ? { mode: 'stream' as const } : {}),
    parameters: takesRequest
      ? [{ name: 'request', source: 'json' as const, codec: json('@kirkchinese/harness-forge#Request'), strictCodec: json('@kirkchinese/harness-forge#Request') }]
      : [],
    result: json(`@kirkchinese/harness-forge#${method}`),
  }])) as never,
}, z)

export const TYPERT_REMOTE = remote
export default remote

type Namespace = Record<string, (...args: unknown[]) => unknown>

let mounted: Namespace | undefined
let mountError: string | undefined
const waiting: Array<(namespace: Namespace | undefined) => void> = []

/** Set by the plugin body once `$mount` registered the namespace. */
export function setMountedRemote(value: unknown): void {
  mounted = typeof value === 'object' && value !== null ? value as Namespace : undefined
  mountError = undefined
  for (const resolve of waiting.splice(0)) resolve(mounted)
}

export function setMountedRemoteError(error: unknown): void {
  mounted = undefined
  mountError = error instanceof Error ? error.message : String(error)
  for (const resolve of waiting.splice(0)) resolve(undefined)
}

/** Why the namespace could not mount, when known. */
export function mountedRemoteError(): string | undefined {
  return mountError
}

async function namespace(): Promise<Namespace> {
  const ready = mounted ?? (mountError === undefined ? await new Promise<Namespace | undefined>((resolve) => { waiting.push(resolve) }) : undefined)
  if (ready === undefined) throw new Error(`Harness Forge is not reachable: ${mountError ?? 'the Remote namespace did not mount'}`)
  return ready
}

/** Call one workbench method; a failure throws an Error carrying the Host's reason. */
export async function call<T>(method: string, request?: Record<string, unknown>): Promise<T> {
  const target = (await namespace())[method]
  if (typeof target !== 'function') throw new Error(`Harness Forge has no method ${method}`)
  const result = await (request === undefined ? target() : target(request)) as unknown
  if (typeof result === 'object' && result !== null && 'ok' in result) {
    const outcome = result as { ok: boolean; value?: unknown; error?: { message?: string; code?: string } }
    if (!outcome.ok) throw new Error(outcome.error?.message ?? outcome.error?.code ?? `${method} failed`)
    return outcome.value as T
  }
  return result as T
}

/** Open one workbench stream; dispose the handle to stop it. */
export async function stream<T>(method: string, request: Record<string, unknown>): Promise<AsyncIterable<T> & { dispose(): void }> {
  const target = (await namespace())[method]
  if (typeof target !== 'function') throw new Error(`Harness Forge has no method ${method}`)
  return target(request) as AsyncIterable<T> & { dispose(): void }
}

