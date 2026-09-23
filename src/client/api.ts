/**
 * Host route calls, with the failure contract made explicit.
 *
 * Every helper resolves `undefined` on success and the server's message on
 * failure, so no caller has to wrap a fetch in a try/catch to stay honest
 * about what happened. A failure is therefore always reported, never swallowed.
 */

/** Route prefix matching the host half. */
const PREFIX = '/dsh-workspace-menu'

/**
 * The platform's `fetch`, read off `globalThis` at call time.
 *
 * A bundle factory is invoked with `require` and nothing else, so an
 * unqualified `fetch` is a ReferenceError inside a plugin. This is not
 * theoretical: exactly that shipped once in a default-parameter position
 * (`fetchImpl = fetch`), and it presented as "the Host preference store is
 * unreachable" while the route answered 200 to every probe. Every request this
 * plugin makes goes through here, so there is one place to be right.
 * @returns the fetch to use.
 * @throws when the platform exposes no fetch.
 */
function platformFetch(): typeof fetch {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') throw new Error('this platform exposes no fetch')
  return candidate.bind(globalThis) as typeof fetch
}

/** What this Host can do, as far as the client can tell. */
export interface HostCapabilities {
  platform: string
  /** The Host's Web-server port; 0 when it could not be read. */
  port: number
  /** `true`/`false` when the peer route answered clearly, `undefined` when not. */
  archiveManager: boolean | undefined
}

/** The archive manager's permanent-deletion route. */
const ARCHIVE_MANAGER_DELETE_PATH = '/api/dsh-archive-manager/delete'

/**
 * A session id no real session can have. The presence probe below sends it, so
 * an endpoint that does exist answers "unknown session" without removing
 * anything.
 */
const ARCHIVE_MANAGER_PROBE_SESSION = '__dsh-workspace-menu-probe__'

/**
 * Whether the archive manager's permanent-deletion route answers on the origin
 * the browser is already talking to.
 *
 * Same-origin, so no loopback or LAN-address guesswork: the page's own origin is
 * the Host. The answer is deliberately shy — a route that is merely missing
 * answers 404, so 404 is read as "absent", a definite client error as "present",
 * and anything else (a redirect to the SPA shell, a proxy error, a timeout) as
 * unknown rather than a confident "no".
 * @returns true/false when the wire answered clearly, undefined when it did not.
 */
async function probeArchiveManager(): Promise<boolean | undefined> {
  try {
    const response = await platformFetch()(ARCHIVE_MANAGER_DELETE_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Marks this as a presence probe, so a manager that understands the
        // header can refuse it outright.
        'x-dsh-workspace-menu-probe': '1',
      },
      body: JSON.stringify({ sessionId: ARCHIVE_MANAGER_PROBE_SESSION }),
    })
    if (response.status === 404) return false
    if (response.ok || response.status === 400 || response.status === 409 || response.status === 422) return true
    return undefined
  } catch {
    return undefined
  }
}

interface HostErrorBody {
  error?: { code?: string; message?: string }
}

/**
 * POST one JSON body and read the shared `{ ok, error }` envelope.
 * @param route - route path after the plugin prefix.
 * @param body - request body.
 * @returns undefined on success, the failure message otherwise.
 */
async function post(route: string, body: unknown): Promise<string | undefined> {
  try {
    const response = await platformFetch()(`${PREFIX}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok) return undefined
    try {
      const data = await response.json() as HostErrorBody
      return data.error?.message ?? `HTTP ${response.status}`
    } catch {
      return `HTTP ${response.status}`
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Reveal a path in the operating system's file manager.
 * @param path - absolute host path.
 * @returns undefined on success, the failure message otherwise.
 */
export function revealInFileManager(path: string): Promise<string | undefined> {
  return post('/open-in-explorer', { path })
}

/**
 * Remove one registered workspace directory from disk.
 * @param path - the workspace's canonical path.
 * @returns undefined on success, the failure message otherwise.
 */
export function deleteWorkspaceDirectory(path: string): Promise<string | undefined> {
  return post('/delete-workspace-directory', { path })
}

/**
 * Delete one session's stored log through the archive manager.
 *
 * Permanent session deletion is a capability this plugin deliberately does not
 * implement itself; the archive manager owns those storage files.
 * @param sessionId - the session to delete.
 * @returns undefined on success, the failure message otherwise.
 */
export async function deleteSessionRecord(sessionId: string): Promise<string | undefined> {
  try {
    const response = await platformFetch()('/api/dsh-archive-manager/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (response.ok) return undefined
    try {
      const data = await response.json() as { error?: string }
      return data.error ?? `HTTP ${response.status}`
    } catch {
      return `HTTP ${response.status}`
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Ask the Host what it can do, then settle the one capability that only the
 * wire can answer.
 * @returns the capability report, or undefined when the route is absent.
 */
export async function fetchCapabilities(): Promise<HostCapabilities | undefined> {
  let platform = 'unknown'
  let port = 0
  try {
    const response = await platformFetch()(`${PREFIX}/capabilities`, { method: 'GET' })
    if (!response.ok) return undefined
    const data = await response.json() as { platform?: unknown; port?: unknown }
    if (typeof data.platform === 'string') platform = data.platform
    if (typeof data.port === 'number' && Number.isFinite(data.port)) port = data.port
  } catch {
    return undefined
  }
  // The archive-manager answer is settled on the wire: whether the route exists
  // is exactly the question its presence has to satisfy.
  return { platform, port, archiveManager: await probeArchiveManager() }
}
