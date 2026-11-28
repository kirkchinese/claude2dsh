/**
 * The first message of a creation-mode port session: the working protocol
 * (ask once, build, verify, report), then the part's brief. The protocol is
 * the same for every part and lives only here; what is specific to the part
 * (its files, gaps, the questions it leaves open, its acceptance criteria) is
 * the brief's. Written for the model, in English; it tells the agent to talk
 * to the user in their own language.
 * @module @kirkchinese/harness-forge/porting
 */
import { adapterPackageName, defaultAdapterDir, type ForeignComponent, type ForeignPlugin } from '@kirkchinese/harness-forge-core'

/** The model tool that confirms an adapter covers the part (see `verify-port.ts`). */
export const VERIFY_TOOL = 'harness_verify_port'

/** Language names for the user's interface language, as the prompt names it. */
const LANGUAGES: Readonly<Record<string, string>> = { en: 'English', zh: 'Chinese (简体中文)' }

/** What the prompt is written for. */
export interface PortPromptInput {
  readonly plugin: Pick<ForeignPlugin, 'id' | 'name'>
  readonly component: Pick<ForeignComponent, 'id' | 'name'>
  /** The part's brief (`portBrief`), appended after the protocol. */
  readonly brief: string
  /** The user's interface language (`en`, `zh`, …), when the browser said. */
  readonly language?: string
}

/** The language line: the interface language when known, else whatever the user writes in. */
function languageLine(language: string | undefined): string {
  const named = language === undefined ? undefined : LANGUAGES[language.split('-')[0]!.toLowerCase()] ?? language
  return named === undefined
    ? 'Talk to the user in the language they write in.'
    : `Talk to the user in ${named}, the language of their DSH interface, unless they write in another language.`
}

/** The protocol and the brief, as the session's first message. */
export function portPrompt(input: PortPromptInput): string {
  const { plugin, component } = input
  const packageName = adapterPackageName(plugin, component)
  const verifyArgs = JSON.stringify({ pluginId: plugin.id, componentId: component.id })
  const protocol = [
    `You are in DSH's creation mode. Harness Forge asks you to port the part "${component.name}" of ${plugin.name} to DSH as a local adapter plugin \`${packageName}\`. The brief below has the facts; this is how to work. ${languageLine(input.language)}`,
    '',
    '## Protocol',
    '',
    '1. **Ask once, first.** Your first reply is ONE concise message with numbered questions, each with a default so the user can just reply "ok". Use only the brief: do not call tools, inspect files or the runtime, or plan the implementation before the answer. Ask:',
    `   - where to put the adapter's source; default \`${defaultAdapterDir(packageName)}\`, under the creation session's default working directory and separate from the original plugin;`,
    '   - each user choice under "Questions for the user" in the brief; describe placement and other choices in user-facing terms, not API names.',
    '   Never ask what you can look up (DSH APIs, slot names, file contents). Write no file before the answer.',
    '2. **Build without further questions.** Now read the original files and load the `dsh-doc` skill. If the skill tool is unavailable, find and read the installed dsh-doc references directly. Confirm the DSH APIs and slot names with runtime inspection. Scaffold the package in the agreed directory, implement it reusing the original\'s code and data where possible, install it into the current profile with `plugin_manager` `install_bundle` (absolute directory) and make sure it is enabled. Ask again only when blocked on a choice only the user can make.',
    '   Fallback: should `install_bundle` come back `"application": "failed"` with "pnpm printed nothing … and was terminated", call it once more with the same directory (a pnpm that did not exit; the second call completes). Do not run pnpm or `dsh plugin` from the shell on the running profile instead.',
    '3. **Verify before you report.** All of these must pass:',
    '   a. The adapter loaded without errors: `plugin_manager` `list_bundles` shows it enabled with no `error`, and `cordis_inspect_*` shows what it registered.',
    '   b. Each behaviour the acceptance criteria name happens: exercise it and observe the result (the tool\'s answer, the command\'s output, the hook acting, the surface\'s value).',
    `   c. \`${VERIFY_TOOL}\` with \`${verifyArgs}\` answers \`"covered": true\`.`,
    '   When a check fails, fix the cause and run all three again.',
    '   To check what the page shows, use runtime inspection: `cordis_inspect_list`, then `cordis_inspect_query` on the Client `Slots.listSubTree` (the live slot tree and props, when a page is connected); if that cannot show it, ask the user to look and confirm. Never read DSH\'s access token or logs, `/proc` of another process, or another process\'s files, and never drive a browser with credentials taken from them.',
    '4. **Report immediately when step 3 passes.** Do not start or wait for optional reviews before sending the final report; give the result first, then mention any review still running. Say what now works, with the evidence (what each check showed, including the `' + VERIFY_TOOL + '` answer), where the source is, and what still differs from the original. If you cannot close the gap, say exactly what blocks it, what you tried, and what the user can do.',
    '',
    '---',
    '',
  ]
  return `${protocol.join('\n')}\n${input.brief}`
}
