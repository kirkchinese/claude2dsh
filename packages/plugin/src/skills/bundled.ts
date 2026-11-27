/**
 * Bundle the Harness Forge skills with the plugin so the workbench is
 * available in every installed profile.
 * @module @kirkchinese/harness-forge
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  parseSkillFrontmatter,
  readMarkdownAsset,
} from '@kirkchinese/harness-forge-core'

/** Register every `skills/<name>/SKILL.md` bundled with this package. */
export function registerBundledSkills(ctx: Context): void {
  const root = fileURLToPath(new URL('../../skills', import.meta.url))
  let names: string[]
  try {
    names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return
  }
  for (const directory of names) {
    const bodyPath = join(root, directory, 'SKILL.md')
    const asset = readMarkdownAsset(bodyPath)
    if (asset === undefined) continue
    const parsed = parseSkillFrontmatter(asset.data, directory)
    const frontmatter = parsed.frontmatter
    if (frontmatter.description.length === 0) continue
    ctx.effect(
      () => ctx.skills.register({
        name: frontmatter.name,
        description: frontmatter.description,
        ...(frontmatter.whenToUse !== undefined ? { whenToUse: frontmatter.whenToUse } : {}),
        content: asset.body,
        source: 'bundled',
        invocation: {
          modelInvocable: frontmatter.modelInvocable,
          userInvocable: frontmatter.userInvocable,
        },
        ...(frontmatter.metadata !== undefined ? { metadata: frontmatter.metadata } : {}),
      }),
      `harness-forge.bundled-skill:${directory}`,
    )
  }
}
