/** Browser half: Claude2DSH settings section inside the dsh Settings shell. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { Claude2DshSettings } from './Claude2DshSettings.tsx'

/** Stable browser-plugin name. */
export const name = 'claude2dsh-client'
/** Settings slot registration waits for the settings shell declaration. */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'claude2dsh',
    order: 10,
    label: 'Claude2DSH',
    inject: () => ({}),
  }, Claude2DshSettings))
}
