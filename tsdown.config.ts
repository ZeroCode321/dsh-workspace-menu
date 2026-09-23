/**
 * Client-half bundle.
 *
 * Mirrors DSH's own client-bundle contract: a closure-factory artifact that
 * registers itself with `window.__ModuleLoader__.load`, resolving the platform
 * modules from the shell's frozen module table and inlining everything else.
 *
 * The externals list is exactly DSH's `PLATFORM_MODULES` plus the documented
 * `dsh-client-runtime/client` store exemption — a specifier the table cannot
 * answer is a guaranteed runtime throw, so this list is a contract rather than
 * a preference.
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dsh-external/dsh-workspace-menu'

/** The shell's frozen module table, plus the documented runtime store exemption. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-web-react',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: CLIENT_EXTERNALS,
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]
