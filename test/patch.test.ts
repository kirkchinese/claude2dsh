import {
  applyEntryPatches,
  entryListSchema,
  type PatchOptions,
} from '@deepseek-ai/cordis-plugin-include'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

describe('DSH bundle patch', () => {
  it('parses and applies with the production include patch engine', async () => {
    // Include exports the parser schema and exact patch applicator used by DSH.
    // Calling those pure entry points validates the bundle without mounting a
    // file-backed Include tree or creating any DSH-home state.
    const parsed: unknown = load(await readFile(patchPath, 'utf8'), {
      schema: entryListSchema,
    })
    expect(Array.isArray(parsed)).toBe(true)

    const warnings: string[] = []
    const entries = applyEntryPatches([], parsed as PatchOptions[], (message) =>
      warnings.push(message),
    )

    expect(warnings).toEqual([])
    expect(entries).toEqual([
      {
        id: 'claude2dsh',
        name: 'claude2dsh',
        config: { mode: 'read-only' },
      },
    ])
    expect(JSON.stringify(entries)).not.toContain('.claude')
    expect(JSON.stringify(entries)).not.toContain('read-write')
  })
})
