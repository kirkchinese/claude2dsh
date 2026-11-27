/**
 * Test-only DSH plugin for the Harness Forge end-to-end smoke test.
 *
 * Headless DSH differs from a Web session in two ways this plugin closes:
 * - the Web session controller binds every new top-level session to the default agent preset (which carries the
 *   agent plane: tools, delegation, plugin agents); headless does not, so this plugin does the same binding;
 * - headless sends the task straight to the model and never parses slash commands, and a scripted model has no
 *   other way to reach the host, so this plugin gives it two tools: `lab_command` runs one command line in the
 *   session, exactly as the Web composer would, and `lab_remote` calls one method of a Remote namespace (the
 *   calls the browser makes) with a request object.
 * @module @kirkchinese/dsh-harness-e2e-lab
 */
export const name = 'harness-e2e-lab'
export const inject = ['tools', 'commands']

const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    const presets = ctx.get('agentPresets')
    if (presets === undefined || (agent.session.header.delegationDepth ?? 0) > 0) return
    if (presets.composedPreset(agent.ctx) !== undefined) return
    // Only a new session is bound, as the Web binds it; a resumed one (turns already in its log) keeps its composition.
    const boundary = ctx.get('sessionProjections')?.stateOf(agent.session, 'turnBoundary')
    if (boundary !== undefined && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0)) return
    await presets.select(agent, presets.defaultId)
  })

  ctx.effect(() => ctx.tools.register({
    name: 'lab_command',
    description: 'Run one slash command line in this session. Test harness only.',
    parameters: {
      type: 'object',
      properties: { line: { type: 'string', description: 'A complete line such as "/name args"' } },
      required: ['line'],
      additionalProperties: false,
    },
    output: textOutput,
    execute: async (args, exec) => {
      const execution = await ctx.commands.execute(exec.agent, String(args.line), [], exec.signal)
      if (execution === undefined) return { status: 'unknown-command', line: args.line }
      return { status: execution.result.kind, text: execution.result.text ?? '' }
    },
  }), 'harness-e2e-lab.command')

  ctx.effect(() => ctx.tools.register({
    name: 'lab_remote',
    description: 'Call one method of a Remote namespace with a request object, as the browser would. Test harness only.',
    parameters: {
      type: 'object',
      properties: { namespace: { type: 'string' }, method: { type: 'string' }, request: { type: 'object', additionalProperties: true } },
      required: ['namespace', 'method'],
      additionalProperties: false,
    },
    output: textOutput,
    execute: async (args) => {
      const remote = ctx.get(String(args.namespace))
      if (remote === undefined || typeof remote[args.method] !== 'function') throw new Error(`no Remote method ${String(args.namespace)}.${String(args.method)}`)
      return await remote[args.method](args.request ?? {})
    },
  }), 'harness-e2e-lab.remote')
}
