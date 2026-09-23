/**
 * Bundle the unit tests to `lib/tests/` so Node's own test runner can execute
 * them without a TypeScript loader.
 *
 * The three platform modules are aliased to tiny local stand-ins: the suite
 * covers decision logic, and resolving the real React — let alone the shell's
 * primitives, which pull in shiki, katex, and a markdown pipeline — would both
 * dominate the artifact and require a browser-grade module graph to load.
 */
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

/** Absolute path of one stub module. */
const stub = (name: string): string => fileURLToPath(new URL(`./tests/stubs/${name}`, import.meta.url))

const tests: UserConfig = {
  entry: { logic: 'tests/logic.test.ts' },
  outDir: 'lib/tests',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  dts: false,
  sourcemap: false,
  clean: false,
  // Aliases only. An external declaration here would win over the alias and
  // leave the artifact importing the real packages at run time.
  alias: {
    'react-dom/client': stub('react-dom-client.ts'),
    react: stub('react.ts'),
    '@deepseek-ai/dsh-client-ui-primitives': stub('ui-primitives.ts'),
  },
}

export default [tests] satisfies UserConfig[]
