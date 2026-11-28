/**
 * Source fingerprints bind a plan to the exact files it was reviewed against.
 * They are content hashes, not a security signature; a mismatch means the
 * source changed and the plan must be regenerated.
 * @module @kirkchinese/harness-forge-core
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { ForeignComponent, ForeignPlugin } from './types.js'
import type { SourceFingerprint } from './contracts.js'
import { LEADS_TO_SHARE, leadsToShare } from './paths.js'

const MAX_HASH_BYTES = 8 * 1024 * 1024

/** Compute a deterministic fingerprint for the plugin's manifest and files. */
export function fingerprintPlugin(plugin: ForeignPlugin): SourceFingerprint {
  const manifestDigest = sha256(JSON.stringify(plugin.manifest))
  const files = componentFiles(plugin.components, plugin.root)
  const hash = createHash('sha256')
  for (const path of files) {
    const relativePath = relative(plugin.root, path).replace(/\\/gu, '/')
    hash.update(relativePath)
    hash.update('\0')
    try {
      // A file on a link to a network share the path is not on is hashed as unreadable (see `leadsToShare`).
      if (leadsToShare(path)) throw new Error(LEADS_TO_SHARE)
      const stat = statSync(path)
      if (stat.size <= MAX_HASH_BYTES) hash.update(readFileSync(path))
      else hash.update(`${String(stat.size)}:${String(stat.mtimeMs)}`)
    } catch {
      hash.update('missing')
    }
    hash.update('\0')
  }
  const contentDigest = hash.digest('hex')
  const digest = sha256(`${manifestDigest}:${contentDigest}:${plugin.version ?? ''}`)
  const manifestStat = safeStat(plugin.ref.manifestPath)
  return {
    root: plugin.root,
    manifestPath: plugin.ref.manifestPath,
    manifestDigest,
    contentDigest,
    digest,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    ...(manifestStat !== undefined ? { mtimeMs: Number(manifestStat.mtimeMs) } : {}),
  }
}

/** Return the files that define a plugin's behavior, deduplicated and sorted. */
export function componentFiles(components: readonly ForeignComponent[], root: string): string[] {
  const paths = new Set<string>()
  for (const component of components) {
    if (component.path !== undefined && component.path.length > 0) paths.add(resolve(root, component.path))
    switch (component.kind) {
      case 'skill':
      case 'command':
      case 'agent':
        if (component.bodyPath.length > 0) paths.add(component.bodyPath)
        break
      case 'hooks':
        if (component.configPath.length > 0) paths.add(component.configPath)
        for (const modulePath of component.modules) paths.add(modulePath)
        break
      case 'code':
        if (component.entryPath !== undefined) paths.add(component.entryPath)
        break
      case 'ui':
        if (component.specPath !== undefined) paths.add(component.specPath)
        break
      case 'settings':
        for (const file of component.files) paths.add(file)
        break
      default:
        break
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b, 'en'))
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeStat(path: string): ReturnType<typeof statSync> | undefined {
  // On a link to a network share the path is not on: as unreadable (see `leadsToShare`).
  if (leadsToShare(path)) return undefined
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}
