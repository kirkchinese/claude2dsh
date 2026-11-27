/**
 * Receipt persistence. A receipt is the durable record of what apply actually
 * did; it is small, JSON-serializable and safe to expose in diagnostics.
 * @module @kirkchinese/harness-forge
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Receipt } from '@kirkchinese/harness-forge-core'

/** Write one receipt atomically under `dir/<id>.json`. */
export function writeReceipt(receipt: Receipt, dir: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${receipt.id}.json`)
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return path
}

/** Read one receipt, or undefined when absent/malformed. */
export function readReceipt(id: string, dir: string): Receipt | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const receipt = value as Record<string, unknown>
    if (typeof receipt['id'] !== 'string' || typeof receipt['pluginId'] !== 'string') return undefined
    return value as Receipt
  } catch {
    return undefined
  }
}
