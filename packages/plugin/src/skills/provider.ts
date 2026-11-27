/**
 * Zero-copy skill provider for foreign skills. A mounted skill is served by
 * its exact body path, so a sibling skill in the same directory (switched off,
 * new or never reviewed) stays out of the catalog; only roots the person
 * configured (`skillRoots`) are scanned whole. Both are mutable so installing
 * or removing a plugin does not restart the host; each change invalidates the
 * DSH skill catalog. Loading a skill renders it as Claude Code
 * would (`${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `` !`cmd` ``).
 * @module @kirkchinese/harness-forge
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import {
  childDirectories,
  isFile,
  isInside,
  parseSkillFrontmatter,
  readMarkdownAsset,
  shortHash,
  stem,
  toolList,
} from '@kirkchinese/harness-forge-core'
import { pathPatternMatches } from '../hooks/condition.js'
import type { ForeignShell } from '../hooks/shell.js'
import { untrustedShell, type TrustCheck } from '../forge/trust.js'
import { renderBody, type RenderContext } from '../shared/render.js'

/** The provider label used by the registry and diagnostics. */
export const PROVIDER_NAME = 'harness-forge'

/** What a skill root belongs to. */
export interface SkillRootOrigin {
  readonly pluginRoot?: string
  /** The plugin's name; a skill a DSH-native skill would shadow is listed as `<plugin>-<skill>`. */
  readonly pluginName?: string
  readonly dataDir?: string
  /** A project's skills are listed only to sessions whose directory is inside the project. */
  readonly projectRoot?: string
  /** Whose skills these are, for what `@file` may attach; a configured root (no plugin) is the person's own. */
  readonly scope?: 'user' | 'project' | 'plugin'
}

interface SkillLocator {
  readonly bodyPath: string
  readonly fallbackName: string
  readonly origin: SkillRootOrigin
  /** `paths` frontmatter: the model sees the skill once a matching file is worked with. */
  readonly paths?: readonly string[]
}

/** Rank: after DSH custom roots, before user roots, so native skills win. */
const RANK = 350

/**
 * Which files a session has worked with, for skills whose `paths` limit when
 * the model may load them.
 */
export interface WorkedFiles {
  (sessionId: string): ReadonlySet<string>
}

/** Mutable-root foreign skill provider. */
export class ForeignSkillProvider implements SkillProvider {
  readonly name = PROVIDER_NAME
  /** Directories the person configured: every skill in them is served. */
  private readonly roots = new Map<string, SkillRootOrigin>()
  /** Skills mounted one by one, by body path, with the number of mounts using each. */
  private readonly skills = new Map<string, { readonly origin: SkillRootOrigin; users: number }>()
  private control: SkillProviderControl | undefined

  constructor(
    private readonly shell?: ForeignShell,
    private readonly onLoad?: (bodyPath: string) => void,
    private readonly worked?: WorkedFiles,
    /** A project's skill runs shell lines only while its workspace is trusted, checked each time it renders. */
    private readonly trust?: TrustCheck,
  ) {}

  /** Attach the registration-scoped invalidation capability. */
  attach(control: SkillProviderControl): void {
    this.control = control
  }

  /** Add roots and refresh the catalog. */
  addRoots(roots: Iterable<string>, origin: SkillRootOrigin = {}): void {
    let changed = false
    for (const root of roots) {
      if (!this.roots.has(root)) {
        this.roots.set(root, origin)
        changed = true
      }
    }
    if (changed) this.control?.invalidate()
  }

  /** Remove roots and refresh the catalog. */
  removeRoots(roots: Iterable<string>): void {
    let changed = false
    for (const root of roots) {
      if (this.roots.delete(root)) changed = true
    }
    if (changed) this.control?.invalidate()
  }

  /**
   * Serve one skill by its body path (`<dir>/SKILL.md` or a flat `<name>.md`).
   * Returns its withdrawal; a body mounted twice stays until both withdraw.
   */
  addSkill(bodyPath: string, origin: SkillRootOrigin = {}): () => void {
    const held = this.skills.get(bodyPath)
    if (held === undefined) this.skills.set(bodyPath, { origin, users: 1 })
    else held.users += 1
    if (held === undefined) this.control?.invalidate()
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.skills.get(bodyPath)
      if (current === undefined) return
      current.users -= 1
      if (current.users > 0) return
      this.skills.delete(bodyPath)
      this.control?.invalidate()
    }
  }

  /** The body paths of the skills mounted one by one, for diagnostics. */
  listSkills(): readonly string[] {
    return [...this.skills.keys()].sort((a, b) => a.localeCompare(b, 'en'))
  }

  /** Re-read every root (a hook installed new skills). */
  refresh(): void {
    this.control?.invalidate()
  }

  /** The configured roots, for diagnostics. */
  listRoots(): readonly string[] {
    return [...this.roots.keys()].sort((a, b) => a.localeCompare(b, 'en'))
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    const names = new Set<string>()
    // The person's own and the project's skills sit nearer than plugins in DSH's catalog and win a shared
    // name outright; Claude Code keeps both by naming plugin skills `plugin:skill`. A plugin skill such a
    // skill would hide is listed as `<plugin>-<skill>`, as `/plugin:command` is `/plugin-command`.
    const native = nativeSkillNames(options.cwd)
    const add = (candidate: SkillCandidate | undefined, bodyPath: string, origin: SkillRootOrigin): void => {
      if (candidate === undefined) return
      // The same skill installed in both places: DSH's own copy serves it.
      if (native.get(candidate.name)?.has(contentHash(bodyPath) ?? '') === true) return
      const prefixed = origin.pluginName !== undefined && native.has(candidate.name) ? `${kebab(origin.pluginName)}-${candidate.name}` : candidate.name
      // Two plugins may ship a skill with the same name; the later one stays
      // reachable under a stable suffix instead of breaking the catalog.
      const name = names.has(prefixed) || native.has(prefixed) ? `${prefixed}-${shortHash(bodyPath, 6)}` : prefixed
      names.add(name)
      candidates.push(name === candidate.name ? candidate : { ...candidate, name })
    }
    const sessionId = (options as { scope?: { session?: { header?: { id?: unknown } } } }).scope?.session?.header?.id
    const worked = typeof sessionId === 'string' ? this.worked?.(sessionId) : undefined
    const seen = new Set<string>()
    const visible = (origin: SkillRootOrigin): boolean => origin.projectRoot === undefined || (options.cwd !== undefined && isInside(origin.projectRoot, options.cwd))
    const gate = (candidate: SkillCandidate | undefined): SkillCandidate | undefined => {
      // A skill with `paths` is offered to the model once the session works with a matching file.
      const paths = (candidate?.locator as SkillLocator | undefined)?.paths
      if (candidate === undefined || paths === undefined || !candidate.invocation.modelInvocable) return candidate
      const cwd = options.cwd ?? process.cwd()
      const matched = [...worked ?? []].some(file => paths.some(pattern => pathPatternMatches(pattern, file, cwd)))
      return matched ? candidate : { ...candidate, invocation: { ...candidate.invocation, modelInvocable: false } }
    }
    const offer = (bodyPath: string, fallbackName: string, origin: SkillRootOrigin): void => {
      if (seen.has(bodyPath)) return
      seen.add(bodyPath)
      add(gate(this.candidate(bodyPath, fallbackName, origin)), bodyPath, origin)
    }
    for (const [root, origin] of this.roots) {
      if (!visible(origin)) continue
      for (const child of childDirectories(root)) {
        const bodyPath = join(root, child, 'SKILL.md')
        if (isFile(bodyPath)) offer(bodyPath, child, origin)
      }
      for (const entry of safeEntries(root)) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
        offer(join(root, entry.name), stem(entry.name), origin)
      }
    }
    for (const [bodyPath, { origin }] of this.skills) {
      if (visible(origin) && isFile(bodyPath)) offer(bodyPath, fallbackNameOf(bodyPath), origin)
    }
    return candidates
  }

  /**
   * Render a skill body for one invocation: `/name args` gives it the
   * arguments a model-loaded skill never has.
   */
  async renderFor(bodyPath: string, rawArguments: string, cwd: string, sessionId: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    const asset = readMarkdownAsset(bodyPath)
    if (asset === undefined) return undefined
    const origin = this.originOf(bodyPath)
    if (this.shell === undefined) return asset.body
    return (await renderBody(asset.body, {
      ...this.renderContext(bodyPath, origin ?? {}, asset.data, cwd, this.shell),
      rawArguments,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })).text
  }

  /**
   * What a body renders with. The body is the one just read, so whether its
   * shell lines may run is decided now, for this content: a project's skill
   * in a workspace that is not trusted (any more) runs none.
   */
  private renderContext(bodyPath: string, origin: SkillRootOrigin, data: Readonly<Record<string, unknown>>, cwd: string, shell: NonNullable<ForeignSkillProvider['shell']>): RenderContext {
    const scope = origin.scope ?? (origin.projectRoot !== undefined ? 'project' : origin.pluginRoot === undefined ? 'user' : 'plugin')
    const trust = origin.projectRoot !== undefined && this.trust !== undefined ? this.trust(origin.projectRoot) : undefined
    return {
      rawArguments: '',
      argumentNames: toolList(data['arguments']) ?? [],
      cwd,
      skillDir: dirname(bodyPath),
      shell,
      scope,
      ...(origin.pluginRoot !== undefined ? { pluginRoot: origin.pluginRoot } : {}),
      ...(origin.dataDir !== undefined ? { dataDir: origin.dataDir } : {}),
      ...(typeof data['shell'] === 'string' ? { shellKind: data['shell'] } : {}),
      ...(trust !== undefined && !trust.trusted ? { refuseShell: untrustedShell(trust.workspace) } : {}),
    }
  }

  private originOf(bodyPath: string): SkillRootOrigin | undefined {
    const mounted = this.skills.get(bodyPath)
    if (mounted !== undefined) return mounted.origin
    for (const [root, origin] of this.roots) if (isInside(root, bodyPath)) return origin
    return undefined
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as SkillLocator | undefined
    if (locator === undefined || !isFile(locator.bodyPath)) return undefined
    const asset = readMarkdownAsset(locator.bodyPath)
    if (asset === undefined) return undefined
    const frontmatter = parseSkillFrontmatter(asset.data, locator.fallbackName).frontmatter
    const description = frontmatter.description.length > 0 ? frontmatter.description : firstLine(asset.body)
    if (description === undefined) return undefined
    const sessionId = (options as { scope?: { session?: { header?: { id?: unknown } } } }).scope?.session?.header?.id
    const content = this.shell === undefined
      ? asset.body
      : (await renderBody(asset.body, {
          ...this.renderContext(locator.bodyPath, locator.origin, asset.data, options.cwd ?? process.cwd(), this.shell),
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })).text
    this.onLoad?.(locator.bodyPath)
    return {
      name: candidate.name,
      description,
      ...(frontmatter.whenToUse !== undefined ? { whenToUse: frontmatter.whenToUse } : {}),
      content,
      invocation: {
        modelInvocable: frontmatter.modelInvocable,
        userInvocable: frontmatter.userInvocable,
      },
      source: 'custom',
      provider: this.name,
      path: locator.bodyPath,
      resourceBase: { kind: 'directory', path: dirname(locator.bodyPath) },
      ...(frontmatter.metadata !== undefined ? { metadata: frontmatter.metadata } : {}),
    }
  }

  private candidate(bodyPath: string, fallbackName: string, origin: SkillRootOrigin): SkillCandidate | undefined {
    const asset = readMarkdownAsset(bodyPath)
    if (asset === undefined) return undefined
    const frontmatter = parseSkillFrontmatter(asset.data, fallbackName).frontmatter
    // Without a description, Claude Code uses the first non-empty line of the content.
    const description = frontmatter.description.length > 0 ? frontmatter.description : firstLine(asset.body)
    if (description === undefined) return undefined
    const paths = toolList(asset.data['paths'])
    return {
      name: frontmatter.name,
      description,
      ...(frontmatter.whenToUse !== undefined ? { whenToUse: frontmatter.whenToUse } : {}),
      invocation: {
        modelInvocable: frontmatter.modelInvocable,
        userInvocable: frontmatter.userInvocable,
      },
      source: 'custom',
      provider: this.name,
      rank: RANK,
      locator: { bodyPath, fallbackName, origin, ...(paths !== undefined ? { paths } : {}) } satisfies SkillLocator,
      path: bodyPath,
      resourceBase: { kind: 'directory', path: dirname(bodyPath) },
      ...(frontmatter.metadata !== undefined ? { metadata: frontmatter.metadata } : {}),
    }
  }
}

/** The name a skill body falls back to: its directory for `SKILL.md`, else the file's stem. */
function fallbackNameOf(bodyPath: string): string {
  return /^SKILL\.md$/iu.test(basename(bodyPath)) ? basename(dirname(bodyPath)) : stem(basename(bodyPath))
}

/**
 * Names of the skills DSH itself lists from the person's and the project's
 * roots: `~/.dsh/skills`, `$DSH_AGENTS_HOME` (else `~/.agents`) `/skills`,
 * and `.dsh/skills`, `.agents/skills` of the project: the session directory and
 * its parents up to the repository root, below the home directory.
 * @returns each name with the content hashes of its copies.
 */
function nativeSkillNames(cwd: string | undefined): Map<string, Set<string>> {
  const home = resolve(homedir())
  const roots = [
    join(process.env['DSH_HOME'] ?? join(home, '.dsh'), 'skills'),
    join(process.env['DSH_AGENTS_HOME'] ?? join(home, '.agents'), 'skills'),
  ]
  for (let dir = cwd === undefined ? undefined : resolve(cwd); dir !== undefined && dir.toLowerCase() !== home.toLowerCase();) {
    roots.push(join(dir, '.dsh', 'skills'), join(dir, '.agents', 'skills'))
    const parent = dirname(dir)
    dir = parent === dir || isFile(join(dir, '.git')) || existsSync(join(dir, '.git')) ? undefined : parent
  }
  const out = new Map<string, Set<string>>()
  for (const root of roots) {
    for (const child of childDirectories(root)) {
      const bodyPath = join(root, child, 'SKILL.md')
      if (!isFile(bodyPath)) continue
      const asset = readMarkdownAsset(bodyPath)
      const name = typeof asset?.data['name'] === 'string' ? asset.data['name'] : child
      const hashes = out.get(name) ?? new Set<string>()
      hashes.add(contentHash(bodyPath) ?? '')
      out.set(name, hashes)
    }
  }
  return out
}

/** sha256 of a file with line endings normalised, or undefined when unreadable. */
function contentHash(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/gu, '\n')).digest('hex')
  } catch {
    return undefined
  }
}

function kebab(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
}

/** The first non-empty line of Markdown content, without heading marks. */
function firstLine(body: string): string | undefined {
  const line = body.split(/\r?\n/u).map(text => text.replace(/^#+\s*/u, '').trim()).find(text => text.length > 0)
  return line === undefined ? undefined : line.slice(0, 1536)
}

function safeEntries(root: string): Array<{ name: string; isFile(): boolean }> {
  try {
    return readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
}
