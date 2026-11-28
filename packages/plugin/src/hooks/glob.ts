/**
 * Wildcard patterns matched in O(text × pattern) time, within a work budget.
 * A wildcard rule turned into a regular expression (`*` → `.*`) backtracks
 * polynomially in the number of wildcards, and rules and the text they match
 * both come from outside; this matcher walks every reachable pattern position
 * at once instead. That still runs on the synchronous permission path, so a
 * pattern, text or text × pattern product beyond the budget below is not
 * matched at all and answers undefined: the caller decides which way an
 * unknown answer falls (deny, ask and hook conditions match: they fail closed).
 * @module @kirkchinese/harness-forge
 */

type Test = (char: string) => boolean
type Node =
  | { readonly kind: 'one'; readonly test: Test }
  | { readonly kind: 'many'; readonly test: Test }
  | { readonly kind: 'skip'; to: number }

const ANY: Test = () => true

/** At most this many pattern positions… */
export const GLOB_PATTERN_LIMIT = 1_000
/** …this many characters of text… */
export const GLOB_TEXT_LIMIT = 100_000
/** …and this much work (text × pattern) for one match. */
export const GLOB_WORK_LIMIT = 4_000_000

/** A pattern built piece by piece; `test` matches a whole text. */
export class Glob {
  private readonly nodes: Node[] = []
  /** Set for a pattern refused before it was built: it matches nothing and answers undefined. */
  private oversized = false

  /** A pattern too long to build: every match is undefined. Check {@link tooLong} before building one. */
  static refused(): Glob {
    const glob = new Glob()
    glob.oversized = true
    return glob
  }

  /** Whether a pattern of this text is beyond the budget, known before anything is built (no pattern character makes more than one position). */
  static tooLong(pattern: string): boolean {
    return pattern.length > GLOB_PATTERN_LIMIT
  }

  /** These characters, exactly. */
  literal(text: string): this {
    for (const char of text) this.nodes.push({ kind: 'one', test: other => other === char })
    return this
  }

  /** One character that passes `test`. */
  one(test: Test = ANY): this {
    this.nodes.push({ kind: 'one', test })
    return this
  }

  /** Any number of characters that pass `test`. */
  many(test: Test = ANY): this {
    this.nodes.push({ kind: 'many', test })
    return this
  }

  /** What `build` adds, or nothing. */
  optional(build: (glob: this) => void): this {
    const skip: Node = { kind: 'skip', to: 0 }
    this.nodes.push(skip)
    build(this)
    skip.to = this.nodes.length
    return this
  }

  /** Whether the whole text matches; undefined when the pattern or the text is beyond the budget. */
  match(text: string): boolean | undefined {
    const end = this.nodes.length
    if (this.oversized || end > GLOB_PATTERN_LIMIT || text.length > GLOB_TEXT_LIMIT || (end + 1) * text.length > GLOB_WORK_LIMIT) return undefined
    let current = new Uint8Array(end + 1)
    let next = new Uint8Array(end + 1)
    const add = (set: Uint8Array, start: number): void => {
      const stack = [start]
      while (stack.length > 0) {
        const at = stack.pop() ?? end
        if (set[at] === 1) continue
        set[at] = 1
        const node = this.nodes[at]
        if (node === undefined) continue
        if (node.kind === 'skip') stack.push(at + 1, node.to)
        else if (node.kind === 'many') stack.push(at + 1)
      }
    }
    add(current, 0)
    for (const char of text) {
      next.fill(0)
      let alive = false
      for (let at = 0; at < end; at++) {
        if (current[at] !== 1) continue
        const node = this.nodes[at]
        if (node === undefined || node.kind === 'skip' || !node.test(char)) continue
        add(next, node.kind === 'one' ? at + 1 : at)
        alive = true
      }
      if (!alive) return false
      const swap = current
      current = next
      next = swap
    }
    return current[end] === 1
  }
}

/** `*` any run of characters, everything else literal. */
export function wildcard(pattern: string, star: Test = ANY): Glob {
  if (Glob.tooLong(pattern)) return Glob.refused()
  const glob = new Glob()
  pattern.split('*').forEach((part, index) => {
    if (index > 0) glob.many(star)
    glob.literal(part)
  })
  return glob
}
