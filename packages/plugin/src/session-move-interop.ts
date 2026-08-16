/** Optional interop with dsh-session-move: inspect only, never move. */
import type { Context } from '@deepseek-ai/cordis'

export interface SessionMoveInspectArgs {
  readonly sessionId: string
  readonly targetWorkspaceId: string
}

export type SessionMoveInspectResult =
  | { status: 'inspected'; result: unknown }
  | { status: 'unsupported'; reason: string }

export async function inspectSessionMove(ctx: Context, args: SessionMoveInspectArgs): Promise<SessionMoveInspectResult> {
  const service = ctx.get('sessionMove') as { inspect(input: unknown): Promise<unknown> } | undefined
  if (service === undefined) {
    return { status: 'unsupported', reason: 'dsh-session-move is not mounted in this profile; install it for cold-session workspace inspection' }
  }
  try {
    return { status: 'inspected', result: await service.inspect({ sessionId: args.sessionId, targetWorkspaceId: args.targetWorkspaceId }) }
  } catch (error) {
    return { status: 'unsupported', reason: error instanceof Error ? error.message : String(error) }
  }
}
