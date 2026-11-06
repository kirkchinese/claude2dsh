/** Browser half: DSH2Claude settings section inside the dsh Settings shell. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { Dsh2ClaudeSettings } from './Dsh2ClaudeSettings.tsx'

/** Stable browser-plugin name. */
export const name = 'dsh2claude-client'
/** Settings slot registration waits for the settings shell declaration. */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh2claude',
    order: 10,
    label: 'DSH2Claude',
    inject: () => ({}),
  }, Dsh2ClaudeSettings))
}
