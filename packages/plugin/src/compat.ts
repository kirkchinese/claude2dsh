/**
 * Runtime compatibility gate for the installed DeepSeek Harness.
 *
 * The plugin writes Session logs through the host persistence service, so it is
 * bound to two host facts it cannot negotiate at runtime: the Session log format
 * version its synthesized events must satisfy, and the handle-based
 * `sessionPersistence` service they are written through. Both are checked here,
 * before any tool registers, so an unsupported harness fails with one actionable
 * message instead of a partial boot.
 * @module @claude2dsh/plugin
 */
import { createRequire } from 'node:module'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

const require = createRequire(import.meta.url)

/** Session log formats whose event vocabulary and envelopes this build writes. */
export const SUPPORTED_SESSION_FORMAT_VERSIONS: readonly number[] = [3]

/** Lowest DSH release whose Session persistence API this plugin targets. */
export const MINIMUM_DSH_VERSION = '0.1.5-rc.1'

/** DSH package range this plugin declares for its host peers. */
export const REQUIRED_DSH_PEER = `>=${MINIMUM_DSH_VERSION} <0.2.0`

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

/**
 * Parse a `major.minor.patch[-prerelease]` version.
 * @param value - version text, with or without a prerelease suffix.
 * @returns the parsed parts, or undefined when the text is not a version.
 */
export function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim())
  if (match === null) return undefined
  const [, major, minor, patch, prerelease] = match
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

/** Compare one prerelease identifier list, where a shorter list sorts first. */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? ''
    const b = right[index] ?? ''
    if (a === b) continue
    const numericA = /^\d+$/.test(a)
    const numericB = /^\d+$/.test(b)
    if (numericA && numericB) return Number(a) < Number(b) ? -1 : 1
    if (numericA !== numericB) return numericA ? -1 : 1
    return a < b ? -1 : 1
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
}

/**
 * Compare two parsed versions by SemVer precedence.
 * @param left - first version.
 * @param right - second version.
 * @returns a negative number, zero, or a positive number.
 */
export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * Whether a DSH release satisfies this plugin's declared peer range.
 * @param version - installed `@deepseek-ai/dsh-session` version.
 * @returns true when the release is within `>=MINIMUM_DSH_VERSION <0.2.0`.
 */
export function isSupportedDshVersion(version: string): boolean {
  const parsed = parseVersion(version)
  const minimum = parseVersion(MINIMUM_DSH_VERSION)
  if (parsed === undefined || minimum === undefined) return false
  return compareVersions(parsed, minimum) >= 0 && parsed.major === 0 && parsed.minor === 1
}

/** Read the installed host version from the package that owns the Session API. */
function peerVersion(): string {
  const pkg = require('@deepseek-ai/dsh-session/package.json') as { version?: unknown }
  return typeof pkg.version === 'string' ? pkg.version : ''
}

/**
 * Fail loud when the installed DSH is outside the declared peer range or writes
 * a Session log format this build does not produce.
 * @throws {Error} naming the installed version, the required range, and the fix.
 */
export function assertDshCompatibility(): void {
  const version = peerVersion()
  if (!isSupportedDshVersion(version)) {
    throw new Error(
      `claude2dsh requires @deepseek-ai/dsh-session ${REQUIRED_DSH_PEER}, found ${version || '<unknown>'}. `
      + `Upgrade DeepSeek Harness to a matching release (npm install -g @deepseek-ai/dsh@latest) or install an older claude2dsh.`,
    )
  }
  if (!SUPPORTED_SESSION_FORMAT_VERSIONS.includes(SESSION_FORMAT_VERSION)) {
    throw new Error(
      `claude2dsh writes DSH session log format ${SUPPORTED_SESSION_FORMAT_VERSIONS.join('/')}, `
      + `but this harness reads and writes format ${SESSION_FORMAT_VERSION}. `
      + `Upgrade claude2dsh to a release that supports format ${SESSION_FORMAT_VERSION}.`,
    )
  }
}
