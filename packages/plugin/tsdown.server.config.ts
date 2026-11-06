import type { UserConfig } from 'tsdown'

/**
 * Self-contained server bundle for local installation.
 *
 * The workspace packages (@dsh2claude/core and both adapters) are inlined so
 * `dsh plugin add <path>` does not need to resolve `workspace:` protocols.
 * Host packages stay external and come from the DSH profile.
 */
export default {
  entry: { index: 'src/index.ts' },
  outDir: 'local-package/lib',
  format: ['esm'],
  platform: 'node',
  dts: false,
  clean: true,
  target: 'es2024',
  deps: {
    alwaysBundle: [/^@dsh2claude\//],
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-util-values',
      '@deepseek-ai/schemastery',
      'yaml',
    ],
  },
  outputOptions: { entryFileNames: 'index.js' },
} satisfies UserConfig
