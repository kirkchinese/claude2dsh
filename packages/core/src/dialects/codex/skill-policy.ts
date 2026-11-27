/**
 * Codex skill metadata (`agents/openai.yaml` beside `SKILL.md`): the
 * interface's short description, and `policy.allow_implicit_invocation`,
 * which keeps Codex from choosing the skill on its own when false.
 * @module @kirkchinese/harness-forge-core
 */
import { join } from 'node:path'
import { parse } from 'yaml'
import { isPlainObject, readText } from '../../paths.js'

/** What `agents/openai.yaml` says about how a skill is offered. */
export interface CodexSkillPolicy {
  /** Whether the model may invoke the skill by itself; undefined when the file does not say. */
  readonly implicit?: boolean
  readonly description?: string
  readonly displayName?: string
}

/** Read a skill directory's `agents/openai.yaml`; empty when absent or unreadable. */
export function codexSkillPolicy(skillDir: string): CodexSkillPolicy {
  const text = readText(join(skillDir, 'agents', 'openai.yaml'))
  if (text === undefined) return {}
  let data: unknown
  try {
    data = parse(text)
  } catch {
    return {}
  }
  if (!isPlainObject(data)) return {}
  const ui = isPlainObject(data['interface']) ? data['interface'] : {}
  const policy = isPlainObject(data['policy']) ? data['policy'] : {}
  return {
    ...(typeof policy['allow_implicit_invocation'] === 'boolean' ? { implicit: policy['allow_implicit_invocation'] } : {}),
    ...(typeof ui['short_description'] === 'string' ? { description: ui['short_description'] } : {}),
    ...(typeof ui['display_name'] === 'string' ? { displayName: ui['display_name'] } : {}),
  }
}
