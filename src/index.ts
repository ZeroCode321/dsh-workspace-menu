/**
 * @dsh-external/dsh-workspace-menu — host half.
 *
 * Two capabilities the browser cannot have on its own, plus the durable
 * settings namespace the browser half stores its preferences in:
 *
 * - `POST /dsh-workspace-menu/open-in-explorer` — reveal a directory (or
 *   select a file) in the platform's file manager: `explorer.exe` on Windows,
 *   `open` on macOS, and `xdg-open` → `gio` → `nautilus` → `dolphin` →
 *   `thunar` → `pcmanfm` on Linux.
 * - `POST /dsh-workspace-menu/delete-workspace-directory` — remove ONE
 *   directory this Host has registered as a workspace. It is the narrowest
 *   route that can express the operation: the target must still be a live
 *   registry entry, must resolve to itself through `realpath` (so a symlink
 *   or junction cannot redirect the `rm -rf`), must live on a volume a
 *   registered workspace already occupies, and must not be, contain, or sit
 *   inside an irreplaceable path (the user home, `$DSH_HOME`, the process
 *   cwd, a drive root).
 * - namespace `workspace-menu` — feature toggles and the pinned-id lists, so
 *   one profile carries one preference set across browsers.
 *
 * Both routes are fence-guarded with the same loopback / trusted-host / Origin
 * rules DSH's own API routes use, and every failure carries a machine code.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from 'node:path'
import type { Context } from 'cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { FEATURES, defaultFlags, type FeatureFlags, type FeatureKey } from './features.js'

/** Stable Cordis plugin name. */
export const name = '@dsh-external/dsh-workspace-menu'

/** Services required before either route can be registered. */
export const inject = ['webServer', 'webRuntime', 'settings', 'workspaceRegistry']

/** Settings namespace owning this plugin's durable preferences. */
export const SETTINGS_NAMESPACE = settingsNamespace('workspace-menu')

/**
 * Durable preferences document, beside the rest of the profile's state.
 *
 * WHY A FILE AND NOT ONLY THE SETTINGS NAMESPACE: DSH answers `settings.*`
 * calls for a HOST-SIDE ALLOWLIST of namespaces, not for every registered one
 * (`packages/client/ui-settings-plugins/README.md`: "Exposure is a Host
 * allowlist, not a plugin declaration — a namespace absent from the api-proxy's
 * allowlist answers `settings-not-exposed` even when its owner registered it").
 * A third-party plugin therefore cannot reach its own namespace from the
 * browser at all: the registration succeeds, and the browser is still answered
 * with nothing. This file is how the preference actually becomes durable, and
 * the namespace registration above is kept so that a deployment which DOES
 * expose it (or a future DSH that stops allowlisting) is picked up for free.
 */
const PREFERENCES_FILE = 'workspace-menu.json'

/** Field carrying the feature-flag map. */
export const FEATURES_FIELD = 'features'

/** Field carrying pinned workspace ids (newline-separated). */
export const PINNED_WORKSPACES_FIELD = 'pinnedWorkspaces'

/** Field carrying pinned session ids (newline-separated). */
export const PINNED_SESSIONS_FIELD = 'pinnedSessions'

/** Field carrying pinned top-level row keys (newline-separated; '' is the ungrouped bucket). */
export const PINNED_GROUPS_FIELD = 'pinnedGroups'

/** Field carrying unread-marked session ids (newline-separated). */
export const UNREAD_SESSIONS_FIELD = 'unreadSessions'

/** Route prefix shared by this plugin's host routes. */
const ROUTE_PREFIX = '/dsh-workspace-menu'

/**
 * One fact about the Host this plugin cannot read from its own services: which
 * optional capabilities the deployment actually carries. The port is reported
 * so the browser can probe a peer route on the origin it is already talking to,
 * instead of the Host reaching back into itself over loopback.
 */
interface HostEnvironment {
  /** `process.platform` of the Host, for platform-specific copy. */
  platform: string
  /** The port the Web server is listening on. */
  port: number
}

/**
 * Durable section schema. Every feature key is a required boolean with a
 * default, so an absent field resolves to the catalog's own default rather
 * than to a second, drifting list; the id lists are newline-separated strings
 * (arbitrarily long, and always a plain JSON scalar for the wire).
 */
const WorkspaceMenuSchema = z.object({
  [FEATURES_FIELD]: z.object(
    Object.fromEntries(FEATURES.map(feature => [feature.key, z.boolean().default(feature.defaultEnabled)])),
  ),
  [PINNED_WORKSPACES_FIELD]: z.string().default(''),
  [PINNED_SESSIONS_FIELD]: z.string().default(''),
  [PINNED_GROUPS_FIELD]: z.string().default(''),
  [UNREAD_SESSIONS_FIELD]: z.string().default(''),
})

/** Resolved section shape. */
export interface WorkspaceMenuSettings {
  features: Record<string, boolean>
  pinnedWorkspaces: string
  pinnedGroups: string
  pinnedSessions: string
  unreadSessions: string
}

/** The composition base layer: the catalog's own defaults, nothing else. */
function baseLayer(): WorkspaceMenuSettings {
  return {
    features: defaultFlags(),
    pinnedWorkspaces: '',
    pinnedGroups: '',
    pinnedSessions: '',
    unreadSessions: '',
  }
}

interface RouteLease {
  references: number
  dispose: () => void
}

/**
 * The development hot-reloader can apply the same linked bundle more than
 * once, and `webServer.register` rejects a duplicate exact route outright.
 * Route ownership is therefore shared by every plugin instance on one server
 * and released by the last one out.
 */
const routeLeases = new WeakMap<object, RouteLease>()

/**
 * What happened when this plugin registered its settings namespace.
 *
 * Reported through the capability route because "the preference row says the
 * namespace is unavailable" has two very different causes on the wire — the
 * registration threw, or it never ran — and a bare success/failure flag cannot
 * tell them apart after the fact. The live service is also asked directly, so
 * the answer distinguishes "we registered it" from "it is still registered".
 */
interface SettingsRegistrationReport {
  /** Outcome of this plugin's own register call. */
  outcome: 'ok' | 'threw' | 'not-attempted'
  /** The failure message, when the call threw. */
  message?: string
  /** Whether the live settings service still holds the namespace. */
  present: boolean
}

/** Filled by apply(); read by the capability route. */
let settingsReport: SettingsRegistrationReport = { outcome: 'not-attempted', present: false }

/** One route failure, serialized as the shared `{ ok, error }` envelope. */
interface RouteFailure {
  status: number
  code: string
  message: string
}

/**
 * The durable preferences shape as stored, and the shape the wire carries.
 *
 * Id lists travel as newline-separated strings for the same reason the settings
 * schema used them: the value stays a plain JSON scalar regardless of length,
 * and the decoder on the other side accepts nothing else.
 */
interface StoredPreferences {
  features: Record<string, boolean>
  pinnedWorkspaces: string
  pinnedGroups: string
  pinnedSessions: string
  unreadSessions: string
}

/** The profile's DSH home, or the conventional fallback. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Absolute path of the preferences document. */
function preferencesPath(): string {
  return join(dshHome(), PREFERENCES_FILE)
}

/**
 * Read the stored preferences.
 *
 * A missing file is the normal first-run state and answers `undefined`; a file
 * that cannot be read or parsed is reported as `undefined` too, because a
 * corrupt preference must never take the plugin down — the client falls back to
 * its cache and the next write replaces the file.
 * @returns the stored section, or undefined when there is nothing usable.
 */
async function readPreferences(): Promise<StoredPreferences | undefined> {
  let raw: string
  try {
    raw = await readFile(preferencesPath(), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPreferences>
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const features: Record<string, boolean> = {}
    const source = typeof parsed.features === 'object' && parsed.features !== null ? parsed.features : {}
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'boolean') features[key] = value
    }
    const idList = (value: unknown): string => (typeof value === 'string' ? value : '')
    return {
      features,
      pinnedWorkspaces: idList(parsed.pinnedWorkspaces),
      pinnedGroups: idList(parsed.pinnedGroups),
      pinnedSessions: idList(parsed.pinnedSessions),
      unreadSessions: idList(parsed.unreadSessions),
    }
  } catch {
    return undefined
  }
}

/**
 * Replace the preferences document.
 *
 * Written through a temporary file in the same directory and renamed into
 * place, so a crash mid-write cannot leave a half-document that the next boot
 * would read as the operator's choices.
 * @param section - the complete next section.
 */
async function writePreferences(section: StoredPreferences): Promise<void> {
  const path = preferencesPath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(section, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/** Coerce a request body into the stored section, or a failure. */
function parsePreferences(body: unknown): StoredPreferences | RouteFailure {
  if (typeof body !== 'object' || body === null) {
    return fail(400, 'bad-request', 'a preference object is required')
  }
  const source = body as Record<string, unknown>
  const features: Record<string, boolean> = {}
  if (source.features !== undefined) {
    if (typeof source.features !== 'object' || source.features === null || Array.isArray(source.features)) {
      return fail(400, 'bad-request', 'features must be an object of booleans')
    }
    for (const [key, value] of Object.entries(source.features)) {
      if (typeof value !== 'boolean') return fail(400, 'bad-request', `feature "${key}" must be a boolean`)
      features[key] = value
    }
  }
  const idList = (value: unknown, field: string): string | RouteFailure => {
    if (value === undefined) return ''
    if (typeof value !== 'string') return fail(400, 'bad-request', `${field} must be a newline-separated string`)
    return value
  }
  const pinnedWorkspaces = idList(source.pinnedWorkspaces, 'pinnedWorkspaces')
  if (isFail(pinnedWorkspaces)) return pinnedWorkspaces
  const pinnedGroups = idList(source.pinnedGroups, 'pinnedGroups')
  if (isFail(pinnedGroups)) return pinnedGroups
  const pinnedSessions = idList(source.pinnedSessions, 'pinnedSessions')
  if (isFail(pinnedSessions)) return pinnedSessions
  const unreadSessions = idList(source.unreadSessions, 'unreadSessions')
  if (isFail(unreadSessions)) return unreadSessions
  return { features, pinnedWorkspaces, pinnedGroups, pinnedSessions, unreadSessions }
}

function fail(status: number, code: string, message: string): RouteFailure {
  return { status, code, message }
}

function isFail(value: unknown): value is RouteFailure {
  return typeof value === 'object' && value !== null && 'status' in value && 'code' in value
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** The loopback / trusted-host / Origin fence shared by both routes. */
function isTrustedApiRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = header(req, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    size += chunk.length
    if (size > 1024 * 1024) throw fail(413, 'body-too-large', 'request body exceeds 1 MiB')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeFailure(res: ServerResponse, failure: RouteFailure): void {
  writeJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
}

/** Coerce any thrown value into a route failure, keeping deliberate ones intact. */
function asFailure(error: unknown, fallbackCode: string, fallbackStatus = 500): RouteFailure {
  if (isFail(error)) return error
  return fail(fallbackStatus, fallbackCode, error instanceof Error ? error.message : String(error))
}

/** Absolute, control-character-free path from a request body, or a failure. */
function requireAbsolutePath(body: unknown, field: string): string | RouteFailure {
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const raw = typeof record[field] === 'string' ? record[field] : ''
  if (raw === '' || !isAbsolute(raw)) return fail(400, 'bad-request', 'an absolute path is required')
  if (raw.includes('\0')) return fail(400, 'bad-request', 'the path carries a NUL byte')
  return normalize(raw)
}

/** Case-insensitive path equality shaped for the running platform. */
function samePath(a: string, b: string): boolean {
  const left = normalize(a)
  const right = normalize(b)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/** Whether `child` sits inside `parent` (or equals it). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(normalize(parent), normalize(child))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return !rel.split(sep).includes('..')
}

/** Paths the plugin will never remove, however the client asks. */
function protectedPaths(): string[] {
  const candidates = [
    homedir(),
    process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    process.cwd(),
    process.env.SystemRoot ?? '',
    process.env.USERPROFILE ?? '',
  ]
  return candidates.filter(candidate => candidate !== '')
}

/**
 * Decide whether one directory may be removed, using the live workspace
 * registry as the allow-list and the filesystem's own canonical paths as the
 * authority (a symlink or junction therefore cannot redirect the removal).
 * @param ctx - host context carrying the workspace registry.
 * @param requested - absolute directory path from the client.
 * @returns the canonical path actually removed.
 */
async function assertRemovable(ctx: AppContext, requested: string): Promise<string> {
  const workspaces = ctx.workspaceRegistry.list()
  if (workspaces.length === 0) {
    throw fail(409, 'no-workspace', 'this Host has no registered workspace to delete')
  }

  // The registry owns the authoritative spelling; a caller may hold another.
  const owner = workspaces.find(workspace => samePath(workspace.path, requested))
  if (owner === undefined) {
    throw fail(403, 'not-a-workspace', 'refusing to delete a directory this Host does not own as a workspace')
  }

  let canonical: string
  try {
    canonical = await realpath(owner.path)
  } catch (error) {
    throw fail(404, 'missing-directory', `the workspace directory is gone: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!samePath(canonical, owner.path)) {
    throw fail(409, 'path-redirected', 'the workspace path resolves elsewhere; refusing to delete through a link')
  }

  const info = await stat(canonical).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw fail(409, 'not-a-directory', 'the workspace path is not a directory')
  }

  for (const guarded of protectedPaths()) {
    if (isInside(guarded, canonical)) {
      throw fail(403, 'protected-path', `refusing to delete a protected location (${guarded})`)
    }
  }

  // A removable target needs a real parent on a volume the registry already
  // uses: a workspace on C: never authorises deleting a tree on D:, and a
  // drive root has no parent and therefore never passes.
  if (!workspaces.some(workspace => samePath(parse(workspace.path).root, parse(canonical).root))) {
    throw fail(403, 'foreign-volume', 'refusing to delete outside the volumes this Host already owns')
  }
  const parent = dirname(canonical)
  const parentInfo = await stat(parent).catch(() => undefined)
  if (parentInfo === undefined || !parentInfo.isDirectory()) {
    throw fail(409, 'missing-parent', 'the workspace parent directory cannot be verified')
  }

  return canonical
}

function isDirectoryPath(path: string): Promise<boolean> {
  return stat(path).then(info => info.isDirectory(), () => false)
}

function spawnOpener(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.on('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      if (code === 0 || code === null) resolve()
      else reject(new Error(`opener exited with code ${code}`))
    })
  })
}

async function openInOs(rawPath: string): Promise<void> {
  const path = normalize(rawPath)
  if (process.platform === 'win32') {
    const explorer = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'explorer.exe')
      : 'explorer.exe'
    // A file gets selected inside its folder; a directory just opens.
    const args = await isDirectoryPath(path) ? [path] : [`/select,${path}`]
    await spawnOpener(explorer, args)
    return
  }
  if (process.platform === 'darwin') {
    await spawnOpener('open', [path])
    return
  }
  const candidates: { cmd: string; args: string[] }[] = [
    { cmd: 'xdg-open', args: [path] },
    { cmd: 'gio', args: ['open', path] },
    { cmd: 'nautilus', args: [path] },
    { cmd: 'dolphin', args: [path] },
    { cmd: 'thunar', args: [path] },
    { cmd: 'pcmanfm', args: [path] },
  ]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      await spawnOpener(candidate.cmd, candidate.args)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw fail(501, 'no-file-manager', lastError instanceof Error ? lastError.message : 'no file manager available')
}

/** The host context surface this plugin consumes. */
type AppContext = Context & {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
  webRuntime: { trustedHosts: string[] }
  settings: {
    register<T>(ns: typeof SETTINGS_NAMESPACE, schema: z<T>, options?: { base?: Partial<T> }): unknown
  }
  workspaceRegistry: { list(): readonly { readonly path: string }[] }
  /** Host logger, when the composition provides one. */
  logger?: { warn?: (...args: unknown[]) => void }
  /** Load one dependent service before running `callback` (cordis DI). */
  inject: (deps: readonly string[], callback: (ctx: AppContext) => void) => unknown
}

async function handleOpenInExplorer(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
    writeFailure(res, fail(403, 'forbidden', 'forbidden'))
    return
  }
  if (req.method !== 'POST') {
    writeFailure(res, fail(405, 'method-error', 'method not allowed'))
    return
  }
  const path = requireAbsolutePath(await readJsonBody(req), 'path')
  if (isFail(path)) throw path
  await openInOs(path)
  writeJson(res, 200, { ok: true })
}

async function handleDeleteWorkspaceDirectory(ctx: AppContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
    writeFailure(res, fail(403, 'forbidden', 'forbidden'))
    return
  }
  if (req.method !== 'POST') {
    writeFailure(res, fail(405, 'method-error', 'method not allowed'))
    return
  }
  const path = requireAbsolutePath(await readJsonBody(req), 'path')
  if (isFail(path)) throw path
  const canonical = await assertRemovable(ctx, path)
  await rm(canonical, { recursive: true, force: true })
  writeJson(res, 200, { ok: true, path: canonical })
}

/**
 * Serve the durable preferences document.
 *
 * `GET` reports the stored section, or `null` for the first-run state; `POST`
 * validates and replaces it. Both answers carry the section back, so a client
 * never has to guess whether its write landed.
 */
async function handlePreferences(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET') {
    // `null` rather than an omitted key: JSON.stringify drops undefined, and a
    // client must be able to tell "no stored preferences" from "field absent".
    writeJson(res, 200, { ok: true, preferences: await readPreferences() ?? null })
    return
  }
  if (req.method !== 'POST') {
    writeFailure(res, fail(405, 'method-error', 'method not allowed'))
    return
  }
  const section = parsePreferences(await readJsonBody(req))
  if (isFail(section)) throw section
  await writePreferences(section)
  writeJson(res, 200, { ok: true, preferences: section })
}

/**
 * Report what this Host can actually do, so the client can hide an action
 * instead of offering one that must fail.
 */
function handleCapabilities(ctx: AppContext, _req: IncomingMessage, res: ServerResponse): void {
  const environment: HostEnvironment = {
    platform: process.platform,
    port: capabilityPort(ctx),
  }
  writeJson(res, 200, { ok: true, ...environment, settings: describeSettingsRegistration(ctx) })
}

/**
 * Re-read the live settings service so the report reflects the present, not the
 * past: a namespace can be registered and later released with its fiber.
 * @param ctx - host context carrying the settings service.
 * @returns the registration report.
 */
function describeSettingsRegistration(ctx: AppContext): SettingsRegistrationReport {
  let present = false
  try {
    const namespaces = (ctx.settings as unknown as { describe?: () => { ns: unknown }[] }).describe?.() ?? []
    present = namespaces.some(candidate => String(candidate.ns) === String(SETTINGS_NAMESPACE))
  } catch {
    present = false
  }
  return { ...settingsReport, present }
}

/**
 * The listening port, when this webserver revision exposes it.
 * @param ctx - host context carrying the webserver service.
 * @returns the port, or 0 when it cannot be read.
 */
function capabilityPort(ctx: AppContext): number {
  const port = (ctx as unknown as { webServer?: { port?: unknown } }).webServer?.port
  return typeof port === 'number' && Number.isFinite(port) ? port : 0
}

/** Register both routes exactly once per WebServer, whatever the loader does. */
function acquireRoutes(ctx: AppContext): () => void {
  const existing = routeLeases.get(ctx.webServer)
  if (existing !== undefined) {
    existing.references += 1
    return () => releaseRoutes(ctx.webServer, existing)
  }

  const dispatch = (run: (ctx: AppContext, req: IncomingMessage, res: ServerResponse) => Promise<void>) =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        await run(ctx, req, res)
      } catch (error) {
        writeFailure(res, asFailure(error, 'route-failed'))
      }
    }

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/open-in-explorer`,
      handler: dispatch(handleOpenInExplorer),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/delete-workspace-directory`,
      handler: dispatch(handleDeleteWorkspaceDirectory),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/preferences`,
      handler: async (req, res) => {
        try {
          if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
            // Logged rather than silently refused: a browser-side "cannot reach
            // the store" report has to be matchable against what arrived.
            ctx.logger?.warn?.('@dsh-external/dsh-workspace-menu: preferences refused by the trust fence', {
              host: header(req, 'host'),
              origin: header(req, 'origin'),
              site: header(req, 'sec-fetch-site'),
            })
            writeFailure(res, fail(403, 'forbidden', 'forbidden'))
            return
          }
          await handlePreferences(req, res)
        } catch (error) {
          writeFailure(res, asFailure(error, 'preferences-failed'))
        }
      },
    }),
    // Capability reporting needs the inventory gateway, which only some
    // compositions load. Reporting `undefined` keeps this feature strictly
    // additive: without the gateway the client falls back to offering the
    // action with its dependency named.
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/capabilities`,
      handler: (req, res) => {
        try {
          handleCapabilities(ctx, req, res)
        } catch (error) {
          writeFailure(res, asFailure(error, 'capability-failed'))
        }
      },
    }),
  ]
  const lease: RouteLease = {
    references: 1,
    dispose: () => {
      for (const dispose of disposers) dispose()
    },
  }
  routeLeases.set(ctx.webServer, lease)
  return () => releaseRoutes(ctx.webServer, lease)
}

function releaseRoutes(webServer: object, lease: RouteLease): void {
  lease.references -= 1
  if (lease.references !== 0 || routeLeases.get(webServer) !== lease) return
  routeLeases.delete(webServer)
  lease.dispose()
}

/**
 * @param ctx - host context carrying the web server, settings provider, and workspace registry.
 */
export function apply(ctx: AppContext): void {
  try {
    ctx.settings.register(SETTINGS_NAMESPACE, WorkspaceMenuSchema, { base: baseLayer() })
    settingsReport = { outcome: 'ok', present: true }
  } catch (error) {
    settingsReport = {
      outcome: 'threw',
      message: error instanceof Error ? error.message : String(error),
      present: false,
    }
    // Never fatal: the plugin degrades to local-only preferences, and the
    // capability route reports exactly why.
    ctx.logger?.warn?.('@dsh-external/dsh-workspace-menu: settings namespace registration failed', error)
  }
  ctx.effect(() => acquireRoutes(ctx), '@dsh-external/dsh-workspace-menu: host routes')
}

export type { FeatureFlags, FeatureKey }
