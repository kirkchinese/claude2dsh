/**
 * Small SPDX-oriented license reader. It recognizes common license files so a
 * plugin without a manifest license is not silently treated as unknown; full
 * SPDX expression parsing is intentionally out of scope.
 * @module @kirkchinese/harness-forge-core
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { leadsToShare, readJsonObject, readText } from './paths.js'

const SIGNATURES: ReadonlyArray<[RegExp, string]> = [
  [/MIT License|Permission is hereby granted, free of charge/iu, 'MIT'],
  [/Apache License,?\s+Version 2\.0/iu, 'Apache-2.0'],
  [/Mozilla Public License,?\s+Version 2\.0/iu, 'MPL-2.0'],
  [/BSD 2-Clause/iu, 'BSD-2-Clause'],
  [/BSD 3-Clause|Redistribution and use in source and binary forms/iu, 'BSD-3-Clause'],
  [/GNU GENERAL PUBLIC LICENSE,?\s+Version 3/iu, 'GPL-3.0-only'],
  [/GNU GENERAL PUBLIC LICENSE,?\s+Version 2/iu, 'GPL-2.0-only'],
  [/ISC License/iu, 'ISC'],
  [/The Unlicense/iu, 'Unlicense'],
]

/** Read the first license-looking file under the plugin root. */
export function detectLicense(root: string, declared?: string): string | undefined {
  if (declared !== undefined && declared.trim().length > 0) return declared.trim()
  const packageJson = readJsonObject(join(root, 'package.json'))
  if (typeof packageJson?.['license'] === 'string' && packageJson['license'].trim().length > 0) {
    return packageJson['license'].trim()
  }
  let names: string[]
  // On a link to a network share the path is not on: as unreadable (see `leadsToShare`).
  if (leadsToShare(root)) return undefined
  try {
    names = readdirSync(root)
  } catch {
    return undefined
  }
  const candidates = names
    .filter(name => /^(?:licen[cs]e|copying)(?:\..*)?$/iu.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'))
  for (const name of candidates) {
    // A license file we cannot read (or one on a link to a network share, see `leadsToShare`) is simply not recognized.
    const text = readText(join(root, name))?.slice(0, 16_384)
    if (text === undefined) continue
    for (const [pattern, id] of SIGNATURES) if (pattern.test(text)) return id
  }
  return undefined
}
