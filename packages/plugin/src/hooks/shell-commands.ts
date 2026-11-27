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
 * Split a shell input into the commands it runs.
 * @returns undefined when the input cannot be read reliably (unbalanced
 *   quotes or substitutions), in which case a caller treats every rule as a match.
 */
export function shellCommands(input: string): ShellCommands | undefined {
  const commands: string[] = []
  let dynamic = false
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
          if (inner === '$' && /[A-Za-z_{]/u.test(text[end + 1] ?? '')) dynamic = true
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
      if (char === '$' && /[A-Za-z_{]/u.test(next)) dynamic = true
      if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
        flush()
        index++
        continue
      }
      if (char === ';' || char === '|' || char === '\n' || (char === '&' && next !== '>' && text[index - 1] !== '>')) {
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

/** Remove leading `NAME=value` words. */
function stripAssignments(command: string): string {
  let rest = command
  for (;;) {
    const match = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"]*)+\s+/u.exec(rest)
    if (match === null) return rest
    rest = rest.slice(match[0].length)
  }
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
