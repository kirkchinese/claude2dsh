/**
 * Small text scans used instead of patterns such as `/x+$/`, which an engine
 * tries from every position: quadratic on a long run of `x` that something follows.
 * @module @kirkchinese/harness-forge-core
 */

/** `text` without the run of `chars` characters at its end. */
export function stripTrailing(text: string, chars: string): string {
  let end = text.length
  while (end > 0 && chars.includes(text[end - 1] ?? '')) end--
  return text.slice(0, end)
}

/** `text` without the runs of `chars` characters at its start and end. */
export function stripAround(text: string, chars: string): string {
  let start = 0
  while (start < text.length && chars.includes(text[start] ?? '')) start++
  return stripTrailing(text.slice(start), chars)
}
