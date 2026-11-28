/**
 * The commands one shell input runs, as Claude Code's `if` matching sees
 * them: every subcommand of `&&`, `||`, `;`, `|`, `&` and newlines, every
 * command inside `$(…)` and backticks, with leading `VAR=value` assignments
 * stripped.
 * @module @kirkchinese/harness-forge
 */

/** The commands found in one input. */
export interface ShellCommands {
  readonly commands: readonly string[]
  /** The input expands something at run time: `$(…)`, backticks or `$VAR`. */
  readonly dynamic: boolean
}

/**
 * PowerShell's constant automatic variables, which expand to nothing a caller
 * chooses (https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_automatic_variables).
 */
const POWERSHELL_CONSTANT = /^\$(?:null|true|false)(?![\w:])/iu

/**
 * What a lone PowerShell `&` (not part of `&&`) is: the call operator before a
 * command (`& ./x.ps1`), PowerShell 7's background operator after one
 * (https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_operators#background-operator-),
 * or, right after `>` or `<`, part of a merge such as `2>&1` (undefined).
 * @param started - whether a command has begun before it.
 */
export function powershellAmpersand(previous: string, next: string, started: boolean): 'call' | 'background' | undefined {
  if (next === '&' || previous === '&' || previous === '>' || previous === '<') return undefined
  return started ? 'background' : 'call'
}

/**
 * Split a shell input into the commands it runs.
 * @param shell - the shell that reads it: in PowerShell `$null`, `$true` and `$false` are constants, no expansion.
 * @returns undefined when the input cannot be read reliably (unbalanced
 *   quotes or substitutions), in which case a caller treats every rule as a match.
 */
export function shellCommands(input: string, shell: 'bash' | 'powershell' = 'bash'): ShellCommands | undefined {
  const commands: string[] = []
  let dynamic = false
  const expands = (text: string, at: number): boolean => /[A-Za-z_{]/u.test(text[at + 1] ?? '') && !(shell === 'powershell' && POWERSHELL_CONSTANT.test(text.slice(at)))
  const visit = (text: string, depth: number): boolean => {
    if (depth > 8) return false
    let current = ''
    const flush = (): void => {
      const command = stripAssignments(current.trim())
      if (command.length > 0) commands.push(command)
      current = ''
    }
    for (let index = 0; index < text.length; index++) {
      const char = text[index] ?? ''
      const next = text[index + 1] ?? ''
      if (char === '\\') {
        current += char + next
        index++
        continue
      }
      if (char === "'") {
        const end = text.indexOf("'", index + 1)
        if (end === -1) return false
        current += text.slice(index, end + 1)
        index = end
        continue
      }
      if (char === '"') {
        let end = index + 1
        let quoted = ''
        for (; end < text.length; end++) {
          const inner = text[end] ?? ''
          if (inner === '\\') {
            quoted += inner + (text[end + 1] ?? '')
            end++
            continue
          }
          if (inner === '"') break
          if (inner === '$' && text[end + 1] === '(') {
            const close = matchParen(text, end + 1)
            if (close === -1) return false
            dynamic = true
            if (!visit(text.slice(end + 2, close), depth + 1)) return false
            quoted += text.slice(end, close + 1)
            end = close
            continue
          }
          if (inner === '`') {
            const close = text.indexOf('`', end + 1)
            if (close === -1) return false
            dynamic = true
            if (!visit(text.slice(end + 1, close), depth + 1)) return false
            quoted += text.slice(end, close + 1)
            end = close
            continue
          }
          if (inner === '$' && expands(text, end)) dynamic = true
          quoted += inner
        }
        if (end >= text.length) return false
        current += `"${quoted}"`
        index = end
        continue
      }
      if (char === '$' && next === '(') {
        const close = matchParen(text, index + 1)
        if (close === -1) return false
        dynamic = true
        if (!visit(text.slice(index + 2, close), depth + 1)) return false
        current += text.slice(index, close + 1)
        index = close
        continue
      }
      if (char === '`') {
        const close = text.indexOf('`', index + 1)
        if (close === -1) return false
        dynamic = true
        if (!visit(text.slice(index + 1, close), depth + 1)) return false
        current += text.slice(index, close + 1)
        index = close
        continue
      }
      if (char === '$' && expands(text, index)) dynamic = true
      if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
        flush()
        index++
        continue
      }
      // A lone `&`: bash's background operator (not `&>` or `>&`); in PowerShell the call operator or the background
      // operator (see `powershellAmpersand`), either way where a command starts or ends.
      const ampersand = char === '&' && (shell === 'powershell'
        ? powershellAmpersand(text[index - 1] ?? '', next, current.trim().length > 0) !== undefined
        : next !== '>' && text[index - 1] !== '>')
      if (char === ';' || char === '|' || char === '\n' || ampersand) {
        flush()
        continue
      }
      // Grouping: `( cmd )` and `{ cmd; }` run the commands inside them.
      if ((char === '(' || char === '{') && current.trim().length === 0) continue
      if ((char === ')' || char === '}') && !/[({]/u.test(current)) {
        flush()
        continue
      }
      current += char
    }
    flush()
    return true
  }
  return visit(input, 0) ? { commands, dynamic } : undefined
}

/**
 * Remove leading `NAME=value` words that whitespace follows. A scan, not a
 * pattern: a pattern for this backtracks exponentially on an assignment that
 * nothing follows, and froze DSH.
 */
function stripAssignments(command: string): string {
  let start = 0
  for (;;) {
    const end = assignmentEnd(command, start)
    if (end === undefined || end >= command.length || !/\s/u.test(command[end] ?? '')) return command.slice(start)
    start = end
    while (start < command.length && /\s/u.test(command[start] ?? '')) start++
  }
}

/** Where the `NAME=value` word at `start` ends, or undefined when none starts there (or a quote never closes). */
function assignmentEnd(text: string, start: number): number | undefined {
  let index = start
  if (!/[A-Za-z_]/u.test(text[index] ?? '')) return undefined
  while (/[A-Za-z0-9_]/u.test(text[index] ?? '')) index++
  if (text[index] !== '=') return undefined
  index++
  while (index < text.length) {
    const char = text[index] ?? ''
    if (/\s/u.test(char)) break
    if (char === "'") {
      const close = text.indexOf("'", index + 1)
      if (close === -1) return undefined
      index = close + 1
    } else if (char === '"') {
      index++
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
      if (index >= text.length) return undefined
      index++
    } else {
      index += char === '\\' ? 2 : 1
    }
  }
  return Math.min(index, text.length)
}

/** Index of the `)` closing the `(` at `open`, honoring nesting and quotes. */
function matchParen(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') {
      index++
      continue
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1)
      if (end === -1) return -1
      index = end
      continue
    }
    if (char === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      if (end >= text.length) return -1
      index = end
      continue
    }
    if (char === '(') depth++
    if (char === ')') {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}
