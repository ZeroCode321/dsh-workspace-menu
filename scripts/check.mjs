#!/usr/bin/env node
/**
 * Package sanity check for dsh-workspace-menu.
 *
 * Verifies the bundle manifest, the files the package promises to ship, and —
 * the part a plain file check cannot see — that the client bundle only requires
 * specifiers the shell's frozen module table can actually answer. A require the
 * table cannot resolve is a guaranteed runtime throw, so the check reads the
 * built bundle's own `require()` calls and matches them against the declared
 * `dsh.client.inject` edges plus DSH's platform modules.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

/** Specifiers DSH's shell seeds into the frozen module table. */
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
])

/** Modules the client bundle may resolve from the loader table. */
const ALLOWED_REQUIRES = new Set([
  ...PLATFORM_MODULES,
  '@deepseek-ai/dsh-client-runtime/client',
])

const errors = []

if (!pkg.dsh?.bundle?.patch) {
  errors.push('package.json: missing dsh.bundle.patch')
} else if (!existsSync(resolve(root, pkg.dsh.bundle.patch))) {
  errors.push(`package.json: dsh.bundle.patch file not found: ${pkg.dsh.bundle.patch}`)
}

for (const file of ['lib/index.js', 'lib/types/index.d.ts', 'lib/client.js', 'cordis.patch.yml', 'LICENSE']) {
  if (!existsSync(resolve(root, file))) errors.push(`missing file: ${file}`)
}

if (errors.length === 0) {
  const inject = pkg.dsh?.client?.inject
  if (!Array.isArray(inject) || inject.length === 0) {
    errors.push('package.json: dsh.client.inject must list the client entries this bundle needs')
  }
  if (pkg.dsh?.client?.platform !== 'web') {
    errors.push('package.json: dsh.client.platform must be "web"')
  }

  // Line endings belong to whoever checked the file out, not to the contract.
  const client = readFileSync(resolve(root, 'lib/client.js'), 'utf8').replace(/\r\n/g, '\n')
  const banner = new RegExp(
    `window\\.__ModuleLoader__\\.load\\(\\{\\s*id:\\s*${JSON.stringify(pkg.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`,
  )
  if (!banner.test(client)) {
    errors.push('lib/client.js: the module-loader banner does not match the package name')
  }
  if (!/return module\.exports;\s*\}\s*\}\);/.test(client)) {
    errors.push('lib/client.js: the module-loader footer is missing')
  }

  const required = new Set([...client.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]))
  for (const specifier of required) {
    if (!ALLOWED_REQUIRES.has(specifier)) {
      errors.push(`lib/client.js: require("${specifier}") is not a module-table entry — it would throw at boot`)
      continue
    }
    const packageName = specifier === '@deepseek-ai/dsh-client-runtime/client'
      ? '@deepseek-ai/dsh-client-runtime'
      : specifier
    if (ALLOWED_REQUIRES.has(specifier) && !PLATFORM_MODULES.has(specifier) && !inject.includes(packageName)) {
      errors.push(`lib/client.js: require("${specifier}") is not declared in dsh.client.inject`)
    }
  }

  const host = readFileSync(resolve(root, 'lib/index.js'), 'utf8')
  for (const contract of ['export function apply', 'export const inject', 'export const name']) {
    if (!host.includes(contract)) errors.push(`lib/index.js: missing host contract "${contract}"`)
  }

  // A bundle factory is invoked with `require` and nothing else, so a bare
  // platform FUNCTION used inside it — including in a default-parameter
  // position, which is evaluated in module scope — is a ReferenceError before
  // any code runs. Exactly this shipped once as `fetchImpl = fetch`, and it
  // presented as "the Host preference store is unreachable" while the route
  // answered 200 to every probe. Class constructors are exempt: they are only
  // reached from the rendered tree, by which point the globals exist.
  if (/(^|[^.\w'"`$])fetch\s*\(/.test(client)) {
    errors.push('lib/client.js: bare fetch(...) call — read it off globalThis, or the factory throws at boot')
  }

  // The two halves must agree on the routes, or a menu action silently 404s.
  // The client composes the prefix at runtime, so each half is checked in its
  // own spelling: a called route appears as a quoted suffix (`post("/x")`) or
  // as a template tail (`fetch(`${PREFIX}/x`)`).
  for (const route of ['open-in-explorer', 'delete-workspace-directory', 'capabilities']) {
    if (!host.includes(`\${ROUTE_PREFIX}/${route}`) && !host.includes(`/dsh-workspace-menu/${route}`)) {
      errors.push(`lib/index.js: no handler for /dsh-workspace-menu/${route}`)
    }
    if (!client.includes(`"/${route}"`) && !client.includes(`\`\${PREFIX}/${route}\``)) {
      errors.push(`lib/client.js: no caller for /dsh-workspace-menu/${route}`)
    }
  }
}

if (errors.length > 0) {
  console.error('check failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log('check ok')
