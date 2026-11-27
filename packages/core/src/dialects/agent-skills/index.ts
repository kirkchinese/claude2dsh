/**
 * Common formats for harnesses without a dialect of their own: a folder of
 * Agent Skills (`<name>/SKILL.md`, https://agentskills.io) with an optional
 * `.mcp.json` / `mcp.json` beside them, read as one plugin. Discovery reads
 * it only on a folder the user lists (or a default below), never while
 * walking, so a plugin's own `skills/` folder is not taken for one.
 *
 * `~/.agents/skills` and a project's `.agents/skills` are not listed: DSH
 * loads them itself.
 * @module @kirkchinese/harness-forge-core
 */
import { basename, dirname, join } from 'node:path'
import { scanPlugin } from '../../manifest.js'
import { childDirectories, isFile } from '../../paths.js'
import type { Dialect } from '../types.js'

export const agentSkillsDialect: Dialect = {
  id: 'agent-skills',
  label: 'Agent Skills',
  // Skill folders right below are as explicit as a manifest, so a `.mcp.json` beside them does not make it a bare Claude layout.
  markers: [{ tier: 'manifest', listedOnly: true, test: directory => skillFolders(directory).length > 0 }],
  scan: (root, options) => scanPlugin(root, {
    source: 'agent-skills',
    name: options?.name ?? folderName(root),
    manifest: { kind: 'agent-skills', data: { skills: skillFolders(root).map(child => `${child}/SKILL.md`) } },
  }).plugin,
  // Gemini CLI's user skills (https://geminicli.com/docs/cli/skills/), which DSH does not load.
  discoveryRoots: home => [join(home, '.gemini', 'skills')],
}

/** The child folders that hold a `SKILL.md`. */
export function skillFolders(directory: string): string[] {
  return childDirectories(directory).filter(child => isFile(join(directory, child, 'SKILL.md')))
}

/** `~/.gemini/skills` is named `gemini-skills`; any other folder by its own name. */
function folderName(root: string): string {
  const own = basename(root)
  return own === 'skills' ? `${basename(dirname(root)).replace(/^\.+/u, '')}-skills` : own
}
