/**
 * A handler's `if` field: one permission rule (`Bash(git *)`, `Edit(src/**)`,
 * `WebFetch(domain:example.com)`, `mcp__server__tool`, a bare tool name)
 * matched against the tool name and its input together.
 *
 * - Shell rules match each subcommand (after stripping `VAR=value`), commands
 *   inside `$(…)` and backticks; when the input cannot be read, or the rule
 *   names more than the command and the input expands something at run time,
 *   the hook runs.
 * - File rules follow gitignore semantics relative to the working directory:
 *   a pattern without `/` matches the file name at any depth, `src/**` only
 *   under `<cwd>/src`, `//abs` an absolute path, `~/x` the home directory.
 *   `Edit` rules cover every file-writing tool and `Read` rules every reader.
 * @module @kirkchinese/harness-forge
 */
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { shellCommands } from './shell-commands.js'
import { isShellTool, type ForeignTool } from './vocabulary.js'

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead'])

/**
 * Whether `rule` selects this tool call.
 * @param cwd - the session's working directory, for relative file rules.
 */
export function conditionMatches(rule: string, tool: ForeignTool, cwd: string): boolean {
  const match = /^\s*([A-Za-z0-9_\-:.*]+?)\s*(?:\((.*)\))?\s*$/su.exec(rule)
  if (match === null) return false
  const name = match[1] ?? ''
  const specifier = match[2]
  if (name.startsWith('mcp__')) return mcpRuleMatches(name, specifier, tool.name)
  if (!ruleNamesTool(name, tool)) return false
  if (specifier === undefined || specifier === '' || specifier === '*') return true
  if (isShellTool(tool.dshName) && name !== 'PowerShell') return shellRuleMatches(specifier, String(tool.input['command'] ?? ''))
  if (name === 'PowerShell') return globRegex(specifier, true).test(String(tool.input['command'] ?? ''))
  if (name === 'WebFetch' && specifier.startsWith('domain:')) return domainMatches(specifier.slice('domain:'.length), String(tool.input['url'] ?? ''))
  const path = tool.input['file_path'] ?? tool.input['path']
  if (typeof path === 'string' && (WRITE_TOOLS.has(name) || READ_TOOLS.has(name))) return pathRuleMatches(specifier, path, cwd)
  const subject = tool.input['subagent_type'] ?? tool.input['skill'] ?? tool.input['query'] ?? tool.input['url'] ?? tool.input['pattern'] ?? ''
  return globRegex(specifier, true).test(String(subject))
}

function ruleNamesTool(name: string, tool: ForeignTool): boolean {
  if (tool.aliases.includes(name)) return true
  if (name === 'Edit') return tool.aliases.some(alias => WRITE_TOOLS.has(alias))
  if (name === 'Read') return tool.aliases.some(alias => READ_TOOLS.has(alias))
  return false
}

function mcpRuleMatches(name: string, specifier: string | undefined, toolName: string): boolean {
  if (specifier !== undefined && specifier !== '' && specifier !== '*') return false
  if (name === toolName) return true
  const server = name.endsWith('__*') ? name.slice(0, -1) : `${name}__`
  return name.split('__').length === 2 || name.endsWith('__*') ? toolName.startsWith(server) : false
}

/** Shell rule: any subcommand matches; unreadable or run-time-expanding input runs the hook. */
function shellRuleMatches(specifier: string, command: string): boolean {
  const parsed = shellCommands(command)
  if (parsed === undefined) return true
  const words = specifier.trim().replace(/:\*$/u, '').split(/\s+/u).filter(word => word !== '*' && word.length > 0)
  if (parsed.dynamic && words.length > 1) return true
  const pattern = shellPattern(specifier)
  return parsed.commands.some(sub => pattern.test(sub))
}

/** `git *` matches `git` and `git <anything>`; `prefix:*` is the legacy prefix form. */
function shellPattern(specifier: string): RegExp {
  const trimmed = specifier.trim()
  if (trimmed.endsWith(':*')) return new RegExp(`^${escape(trimmed.slice(0, -2))}(\\s.*)?$`, 'su')
  if (trimmed.endsWith(' *')) return new RegExp(`^${globSource(trimmed.slice(0, -2), true)}(\\s.*)?$`, 'su')
  return new RegExp(`^${globSource(trimmed, true)}$`, 'su')
}

/**
 * `domain:example.com` is that host only, `*.example.com` any subdomain at
 * any depth but not the domain itself, `*` every host; any other `*` stays
 * between two dots. Case and a trailing dot are ignored.
 */
function domainMatches(domain: string, url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/u, '')
    const wanted = domain.trim().toLowerCase().replace(/\.$/u, '')
    if (wanted === '*') return true
    if (wanted.startsWith('*.')) return host.endsWith(wanted.slice(1))
    return new RegExp(`^${wanted.split('*').map(escape).join('[^.]*')}$`, 'u').test(host)
  } catch {
    return false
  }
}

/**
 * Whether a gitignore-style pattern, relative to the working directory,
 * matches a path (skill `paths`, `Read(...)`/`Edit(...)` rules).
 */
export function pathPatternMatches(pattern: string, path: string, cwd: string): boolean {
  return pathRuleMatches(pattern, path, cwd)
}

/** Gitignore-style path rule, relative to the working directory. */
function pathRuleMatches(specifier: string, path: string, cwd: string): boolean {
  const windows = process.platform === 'win32'
  const normalize = (value: string): string => {
    const posix = value.replace(/\\/gu, '/')
    return windows ? posix.toLowerCase() : posix
  }
  const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  let pattern = specifier.trim()
  let base = cwd
  if (pattern.startsWith('//')) {
    pattern = pattern.slice(1)
    base = ''
  } else if (pattern.startsWith('~/')) {
    base = homedir()
    pattern = pattern.slice(2)
  } else if (pattern.startsWith('./')) {
    pattern = pattern.slice(2)
  } else if (pattern.startsWith('/') && !windows) {
    pattern = pattern.slice(1)
  }
  const anchored = pattern.replace(/\/$/u, '').includes('/')
  if (base === '') return globRegex(normalize(pattern), false).test(normalize(target))
  const rel = normalize(relative(base, target))
  if (!anchored) {
    const name = rel.split('/').at(-1) ?? rel
    return globRegex(normalize(pattern), false).test(name) || globRegex(`**/${normalize(pattern)}`, false).test(rel)
  }
  return globRegex(normalize(pattern), false).test(rel)
}

function globRegex(pattern: string, shell: boolean): RegExp {
  return new RegExp(`^${globSource(pattern, shell)}$`, 'su')
}

/** Glob → regex source. In shell rules `*` spans anything; in path rules it stays within a segment. */
function globSource(pattern: string, shell: boolean): string {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? ''
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++
        if (pattern[index + 1] === '/') {
          index++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += shell ? '.*' : '[^/]*'
      }
    } else if (char === '?') {
      source += shell ? '.' : '[^/]'
    } else {
      source += escape(char)
    }
  }
  return source
}

function escape(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
}
