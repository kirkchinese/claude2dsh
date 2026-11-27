import { describe, expect, it } from 'vitest'
import { renderCodexPrompt } from '../src/shared/render.js'

describe('Codex custom prompts', () => {
  it('expands $1..$9, $ARGUMENTS, NAME=value and $$ as Codex does', () => {
    const rendered = renderCodexPrompt('Review $FILE for $1 and $2; all: $ARGUMENTS; cost $$5; missing $3 $OTHER', 'FILE=src/app.ts bugs "style issues"')
    expect(rendered.text).toBe('Review src/app.ts for bugs and style issues; all: bugs style issues; cost $5; missing  $OTHER')
    expect(rendered.commands).toBe(0)
  })
})
