/** Runtime compatibility gate for the installed DeepSeek Harness. */
import { createRequire } from 'node:module'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

const require = createRequire(import.meta.url)

/** Session log format version this plugin was built against. */
export const REQUIRED_SESSION_FORMAT_VERSION = SESSION_FORMAT_VERSION

/** Peer version range this plugin declares for DSH packages. */
export const REQUIRED_DSH_PEER = '0.1.x (rc >= 6)' as const

function peerVersion(): string {
  const pkg = require('@deepseek-ai/dsh-session/package.json') as { version?: unknown }
  return typeof pkg.version === 'string' ? pkg.version : ''
}

function parseRc(value: string): number {
  const match = /-rc\.(\d+)/.exec(value)
  return match?.[1] === undefined ? Number.POSITIVE_INFINITY : Number(match[1])
}

function isSupportedPeerVersion(version: string): boolean {
  const match = /^0\.1\.0(?:-rc\.(\d+))?/.exec(version)
  return match !== null && parseRc(version) >= 6
}

/** Fail loud when the installed DSH session package is outside the declared peer range. */
export function assertDshCompatibility(): void {
  const version = peerVersion()
  if (!isSupportedPeerVersion(version)) {
    throw new Error(`claude2dsh requires @deepseek-ai/dsh-session ${REQUIRED_DSH_PEER}, found ${version || '<unknown>'}`)
  }
  if (SESSION_FORMAT_VERSION !== 0) {
    throw new Error(`claude2dsh supports DSH session format version 0, found ${SESSION_FORMAT_VERSION}`)
  }
}
