/**
 * The id an OpenCode plugin declares, read from its source without running it. OpenCode takes a plugin's id from
 * its server part's `Plugin.define({ id })` (https://opencode.ai/docs/build/plugins: "The plugin's `id` comes from
 * its server part's `Plugin.define`"; every server and Effect example declares it so). The source is cut into
 * tokens by a small linear scanner that steps over comments, strings, template literals and regular expressions,
 * so text that only looks like a declaration is not one.
 * @module @kirkchinese/harness-forge-core
 */

/**
 * Why a plugin's id cannot be told: no declaration, more than one, one whose id is not a plain string literal, or
 * one whose literal has an escape JavaScript refuses in a module (a legacy octal, a malformed `\x` or `\u`).
 */
export type PluginIdProblem = 'missing' | 'ambiguous' | 'dynamic' | 'escape'

/** The id a plugin declares, or why it cannot be told. */
export type PluginIdRead = { readonly id: string } | { readonly problem: PluginIdProblem }

/** What a name or a literal reads as: its value, or `escape` when an escape in it cannot be decoded. */
type Decoded = string | typeof BAD_ESCAPE

type Token =
  | { readonly type: 'name'; readonly value: Decoded }
  /** A string literal, or a template literal without substitutions (`value` undefined when it has some). */
  | { readonly type: 'string'; readonly value: Decoded | undefined }
  | { readonly type: 'punct'; readonly value: string }

/** The value of a name or literal whose escape JavaScript would refuse: the id it is part of cannot be told. */
const BAD_ESCAPE = Symbol('bad escape')

/** The single-character escapes of a string literal (ECMA-262 `SingleEscapeCharacter`), and what they stand for. */
const SINGLE_ESCAPES: Readonly<Record<string, string>> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', "'": "'", '"': '"', '\\': '\\', '`': '`' }

/** The line terminators a backslash continues a literal over (ECMA-262 `LineContinuation`); CRLF is one. */
const LINE_TERMINATORS: ReadonlySet<string> = new Set(['\n', '\r', '\u2028', '\u2029'])

/** The largest code point `\u{…}` may name. */
const MAX_CODE_POINT = 0x10ffff

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER_KEYWORDS: ReadonlySet<string> = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'of'])

const NAME_START = /[A-Za-z_$\u0080-\uffff]/u
const NAME_PART = /[\w$\u0080-\uffff]/u

/** The declared id of a plugin's source: one `Plugin.define({ id: "<literal>" })`, else the problem. */
export function declaredPluginId(source: string): PluginIdRead {
  const tokens = tokenize(source)
  const reads: PluginIdRead[] = []
  for (let at = 0; at + 3 < tokens.length; at++) {
    if (!isName(tokens[at], 'Plugin') || !isPunct(tokens[at + 1], '.') || !isName(tokens[at + 2], 'define') || !isPunct(tokens[at + 3], '(')) continue
    reads.push(isPunct(tokens[at + 4], '{') ? idOfObject(tokens, at + 5) : { problem: 'dynamic' })
  }
  if (reads.length === 0) return { problem: 'missing' }
  if (reads.length > 1) return { problem: 'ambiguous' }
  return reads[0]!
}

/** The `id` of an object literal whose properties start at `start`, only its own top-level properties read. */
function idOfObject(tokens: readonly Token[], start: number): PluginIdRead {
  const ids: PluginIdRead[] = []
  let depth = 0
  let propertyStart = true
  for (let at = start; at < tokens.length; at++) {
    const token = tokens[at]!
    if (depth === 0 && propertyStart) {
      propertyStart = false
      // A spread or a computed key may bring an id that cannot be read here.
      if (isPunct(token, '...') || isPunct(token, '[')) ids.push({ problem: 'dynamic' })
      // A key whose escape cannot be decoded may be `id`.
      else if ((token.type === 'name' || token.type === 'string') && token.value === BAD_ESCAPE) ids.push({ problem: 'escape' })
      else if ((token.type === 'name' || token.type === 'string') && token.value === 'id') {
        const next = tokens[at + 1]
        const value = tokens[at + 2]
        const after = tokens[at + 3]
        if (!isPunct(next, ':') || value?.type !== 'string' || value.value === undefined || !(isPunct(after, ',') || isPunct(after, '}'))) ids.push({ problem: 'dynamic' })
        else ids.push(value.value === BAD_ESCAPE ? { problem: 'escape' } : { id: value.value })
      }
    }
    if (token.type !== 'punct') continue
    if (token.value === '{' || token.value === '(' || token.value === '[') depth++
    else if (token.value === '}' || token.value === ')' || token.value === ']') {
      if (depth === 0) break
      depth--
    } else if (token.value === ',' && depth === 0) propertyStart = true
  }
  if (ids.length === 0) return { problem: 'missing' }
  if (ids.length > 1) return { problem: 'ambiguous' }
  return ids[0]!
}

function isName(token: Token | undefined, value: string): boolean {
  return token?.type === 'name' && token.value === value
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token?.type === 'punct' && token.value === value
}

/**
 * The tokens of JavaScript or TypeScript source, in one pass: names, punctuation, and string and template literals
 * with their values; comments and regular expressions dropped. The code inside a template's `${…}` is tokenized
 * like the rest.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  /** For each template whose `${…}` is open, the brace depth within it. */
  const templates: number[] = []
  let at = 0
  const regexAllowed = (): boolean => {
    const last = tokens[tokens.length - 1]
    if (last === undefined) return true
    if (last.type === 'name') return typeof last.value === 'string' && REGEX_AFTER_KEYWORDS.has(last.value)
    if (last.type === 'string') return false
    return last.value !== ')' && last.value !== ']' && last.value !== '}'
  }
  /** The source text of an escape starting at `at` (the backslash): two characters, three for a backslash before CRLF. */
  const escapeAt = (): string => {
    const length = source[at + 1] === '\r' && source[at + 2] === '\n' ? 3 : 2
    const raw = source.slice(at, at + length)
    at += length
    return raw
  }
  /** Read a template's text from `at` (after the backtick or a closing `}`) to its end or its next `${`, decoded. */
  const templateText = (): { readonly text: Decoded; readonly substitution: boolean } => {
    let raw = ''
    while (at < source.length) {
      const char = source[at]!
      if (char === '\\') raw += escapeAt()
      else if (char === '`') {
        at++
        return { text: decodeLiteral(raw, true), substitution: false }
      } else if (char === '$' && source[at + 1] === '{') {
        at += 2
        templates.push(0)
        return { text: decodeLiteral(raw, true), substitution: true }
      } else {
        raw += char
        at++
      }
    }
    return { text: decodeLiteral(raw, true), substitution: false }
  }
  while (at < source.length) {
    const char = source[at]!
    const next = source[at + 1]
    if (/\s/u.test(char)) {
      at++
    } else if (char === '/' && next === '/') {
      while (at < source.length && source[at] !== '\n') at++
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', at + 2)
      at = end === -1 ? source.length : end + 2
    } else if (char === '"' || char === "'") {
      let raw = ''
      at++
      while (at < source.length && source[at] !== char && source[at] !== '\n') {
        if (source[at] === '\\') raw += escapeAt()
        else raw += source[at++]
      }
      at++
      tokens.push({ type: 'string', value: decodeLiteral(raw, false) })
    } else if (char === '`') {
      at++
      const part = templateText()
      tokens.push({ type: 'string', value: part.substitution ? undefined : part.text })
    } else if (char === '}' && templates.length > 0 && templates[templates.length - 1] === 0) {
      // The end of a template's `${…}`: its text goes on.
      templates.pop()
      at++
      templateText()
    } else if (char === '/' && regexAllowed()) {
      at++
      let inClass = false
      while (at < source.length && source[at] !== '\n') {
        const current = source[at]!
        if (current === '\\') at += 2
        else {
          at++
          if (current === '[') inClass = true
          else if (current === ']') inClass = false
          else if (current === '/' && !inClass) break
        }
      }
      while (at < source.length && NAME_PART.test(source[at]!)) at++
    } else if (NAME_START.test(char) || (char === '\\' && next === 'u')) {
      // A name may spell a character as `\uXXXX` or `\u{…}`: `i\u0064` is `id`.
      let raw = ''
      while (at < source.length && (NAME_PART.test(source[at]!) || (source[at] === '\\' && source[at + 1] === 'u'))) {
        if (source[at] === '\\') {
          const end = source[at + 2] === '{' ? source.indexOf('}', at) + 1 : at + 6
          raw += source.slice(at, end > at ? end : source.length)
          at = end > at ? end : source.length
        } else raw += source[at++]
      }
      tokens.push({ type: 'name', value: decodeLiteral(raw, false) })
    } else if (/\d/u.test(char)) {
      while (at < source.length && /[\w.]/u.test(source[at]!)) at++
      // A number: like a name, no regular expression follows it.
      tokens.push({ type: 'name', value: '0' })
    } else if (source.startsWith('...', at)) {
      at += 3
      tokens.push({ type: 'punct', value: '...' })
    } else {
      if (templates.length > 0) {
        if (char === '{') templates[templates.length - 1]!++
        else if (char === '}') templates[templates.length - 1]!--
      }
      at++
      tokens.push({ type: 'punct', value: char })
    }
  }
  return tokens
}

/**
 * The value of a string or template literal's text between its quotes, as JavaScript reads it in a module (strict
 * code, ECMA-262 "String Literals" and "Template Literal Lexical Components"): `\xHH`, `\uXXXX`, `\u{…}`, the
 * single-character escapes, `\0` not before a digit, line continuations, and any other character standing for
 * itself. A legacy octal (`\1`, `\01`), `\8`, `\9`, or a malformed `\x` or `\u` is refused: {@link BAD_ESCAPE}.
 * In a template, a raw CR or CRLF reads as LF.
 */
function decodeLiteral(raw: string, template: boolean): Decoded {
  let out = ''
  for (let at = 0; at < raw.length;) {
    const char = raw[at]!
    if (char !== '\\') {
      if (template && char === '\r') {
        out += '\n'
        at += raw[at + 1] === '\n' ? 2 : 1
      } else {
        out += char
        at++
      }
      continue
    }
    const next = raw[at + 1]
    if (next === undefined) return BAD_ESCAPE
    if (LINE_TERMINATORS.has(next)) {
      at += next === '\r' && raw[at + 2] === '\n' ? 3 : 2
    } else if (next in SINGLE_ESCAPES) {
      out += SINGLE_ESCAPES[next]
      at += 2
    } else if (next === '0' && !/\d/u.test(raw[at + 2] ?? '')) {
      out += '\0'
      at += 2
    } else if (/\d/u.test(next)) {
      return BAD_ESCAPE
    } else if (next === 'x') {
      const hex = raw.slice(at + 2, at + 4)
      if (!/^[\da-f]{2}$/iu.test(hex)) return BAD_ESCAPE
      out += String.fromCharCode(Number.parseInt(hex, 16))
      at += 4
    } else if (next === 'u' && raw[at + 2] === '{') {
      const end = raw.indexOf('}', at + 3)
      const hex = end === -1 ? '' : raw.slice(at + 3, end)
      if (!/^[\da-f]+$/iu.test(hex) || Number.parseInt(hex, 16) > MAX_CODE_POINT) return BAD_ESCAPE
      out += String.fromCodePoint(Number.parseInt(hex, 16))
      at = end + 1
    } else if (next === 'u') {
      const hex = raw.slice(at + 2, at + 6)
      if (!/^[\da-f]{4}$/iu.test(hex)) return BAD_ESCAPE
      out += String.fromCharCode(Number.parseInt(hex, 16))
      at += 6
    } else {
      out += next
      at += 2
    }
  }
  return out
}
