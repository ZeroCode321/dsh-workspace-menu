/**
 * Preference state: durable feature flags and the personal pin/unread lists.
 *
 * The Host's `workspace-menu` settings namespace is the source of truth, so
 * one profile behaves the same in every browser. While that namespace is
 * unavailable (remote browser → memory mode, or a Host without the settings
 * provider) the same shape is cached in `localStorage`, which is also what
 * makes the very first paint agree with the last session's choice.
 */
import { FEATURE_KEYS, defaultFlags, type FeatureFlags, type FeatureKey } from '../features.js'

/** The four id lists this plugin owns. */
export interface PinnedLists {
  pinnedWorkspaces: readonly string[]
  /** Top-level rows (workspace folders and the ungrouped bucket), in pin order. */
  pinnedGroups: readonly string[]
  pinnedSessions: readonly string[]
  unreadSessions: readonly string[]
}

/** Everything the client persists. */
export interface Preferences extends PinnedLists {
  features: FeatureFlags
}

/** Settings field names on the Host namespace. */
export const FEATURES_FIELD = 'features'
export const PINNED_WORKSPACES_FIELD = 'pinnedWorkspaces'
export const PINNED_SESSIONS_FIELD = 'pinnedSessions'
export const PINNED_GROUPS_FIELD = 'pinnedGroups'
export const UNREAD_SESSIONS_FIELD = 'unreadSessions'

const STORAGE_KEY = 'dsh-workspace-menu:v1'

/** Split a newline-separated id list, dropping blanks and duplicates. */
export function decodeIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return []
  const seen = new Set<string>()
  for (const line of raw.split('\n')) {
    const id = line.trim()
    if (id !== '') seen.add(id)
  }
  return [...seen]
}

/** Encode an id list for storage. */
export function encodeIds(ids: readonly string[]): string {
  return [...new Set(ids.filter(id => id !== ''))].join('\n')
}

/** Merge one settings section over the defaults, ignoring malformed fields. */
export function decodeFeatures(section: unknown): FeatureFlags {
  const flags = defaultFlags()
  const raw = (section as { features?: unknown } | null)?.features
  if (typeof raw !== 'object' || raw === null) return flags
  for (const key of FEATURE_KEYS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'boolean') flags[key] = value
  }
  return flags
}

function readCache(): Preferences | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as Partial<Preferences>
    return {
      features: decodeFeatures(parsed),
      pinnedWorkspaces: decodeIds(encodeIds(parsed.pinnedWorkspaces ?? [])),
      pinnedGroups: decodeIds(encodeIds(parsed.pinnedGroups ?? [])),
      pinnedSessions: decodeIds(encodeIds(parsed.pinnedSessions ?? [])),
      unreadSessions: decodeIds(encodeIds(parsed.unreadSessions ?? [])),
    }
  } catch {
    return undefined
  }
}

function writeCache(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      features: preferences.features,
      pinnedWorkspaces: preferences.pinnedWorkspaces,
      pinnedGroups: preferences.pinnedGroups,
      pinnedSessions: preferences.pinnedSessions,
      unreadSessions: preferences.unreadSessions,
    }))
  } catch {
    // Storage unavailable (private mode): the Host namespace still carries the choice.
  }
}

/**
 * Whether the shell is ordering sessions manually.
 *
 * The sidebar sorts by `updated` BY DEFAULT and, in that mode, actively promotes
 * any session whose activity is newer — DSH's own session drag is disabled there
 * too (`WorkspaceBrowser.tsx`: `if (orderBy === 'updated' || ...) return`). A
 * pinned order is therefore not merely ignored: it is recomputed away on every
 * list refresh, which looks exactly like "pinning does nothing". The plugin can
 * do nothing about that policy, so it detects it and says so.
 * @returns true when the shell's own persisted view store says manual ordering.
 */
export function shellUsesManualOrder(): boolean {
  try {
    const raw = localStorage.getItem('dsh.workspace.view.v5')
    if (raw === null) return false
    const parsed = JSON.parse(raw) as { orderBy?: unknown }
    return parsed.orderBy === 'manual'
  } catch {
    return false
  }
}

/** The slice of a Host preference transport this plugin uses. */
export interface HostScope {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: Record<string, unknown> | undefined
    writable: boolean
    mode: 'host' | 'memory'
    /** Why the last request failed, when one did. */
    detail?: string | undefined
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): void
}

/**
 * The platform's `fetch`, read off `globalThis` at call time.
 *
 * A bundle factory is invoked with `require` and nothing else, so an unqualified
 * `fetch` is a ReferenceError inside a plugin — including in a default parameter
 * position, which is evaluated in module scope. Reading the property is also the
 * safer spelling under a future loader that injects a scoped `fetch`.
 * @returns the fetch to use.
 * @throws when the platform has no fetch at all.
 */
function resolveFetch(): typeof fetch {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') {
    throw new Error('this platform exposes no fetch')
  }
  return candidate.bind(globalThis) as typeof fetch
}

/**
 * A [`HostScope`] over this plugin's own Host route rather than the settings
 * wire.
 *
 * The settings wire is not reachable for a third-party plugin: DSH answers
 * `settings.*` from a HOST-SIDE ALLOWLIST of namespaces, so a namespace that is
 * registered but unlisted reads as `settings-not-exposed` from the browser (see
 * the note in `src/index.ts`). This transport reads the Host's preferences
 * document on construction and writes the whole section back on every change.
 * Writes coalesce to the latest state — the section is a superset of every
 * field, so a superseded write never needs replaying.
 * @param fetchImpl - the fetch to use. Defaults to the platform's own `fetch`,
 *   resolved AT CALL TIME off `globalThis`: a bare `fetch` default would be
 *   evaluated in MODULE scope, and DSH's module loader injects only `require`
 *   into a bundle factory, so the bare identifier is not defined there and the
 *   default would throw before a single request was made.
 * @returns the scope.
 */
export function createPreferencesTransport(
  fetchImpl?: typeof fetch,
  onFatal?: (reason: string) => void,
): HostScope {
  let doFetch: typeof fetch
  try {
    doFetch = fetchImpl ?? resolveFetch()
  } catch (error) {
    // Reported rather than thrown: a transport that cannot even be built must
    // still leave the plugin usable, and the operator needs to see WHY the
    // Host store is not in use — a console-only report has already cost several
    // round trips.
    onFatal?.(error instanceof Error ? error.message : String(error))
    throw error
  }
  const listeners = new Set<() => void>()
  let value: Record<string, unknown> | undefined
  let status: 'loading' | 'ready' | 'unavailable' = 'loading'
  let inFlight = false
  let queued: Record<string, unknown> | undefined
  // The exact reason a request failed. Without it the row can only say
  // "unavailable", which is the same word for a blocked request, a 403 from the
  // trust fence, and a 500 from the route — three different repairs.
  let failure: string | undefined

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  const send = async (section: Record<string, unknown>): Promise<void> => {
    if (inFlight) {
      queued = section
      return
    }
    inFlight = true
    try {
      const response = await doFetch('/dsh-workspace-menu/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(section),
      })
      if (!response.ok) {
        failure = `POST HTTP ${response.status}`
        notify()
        return
      }
      failure = undefined
      const body = await response.json() as { preferences?: unknown }
      // The answer is the stored section, so the scope adopts what the Host
      // actually persisted instead of assuming the write landed as sent.
      value = typeof body.preferences === 'object' && body.preferences !== null
        ? body.preferences as Record<string, unknown>
        : value
      status = 'ready'
      notify()
    } catch (error) {
      // The local cache still holds the operator's choice for this browser; the
      // next write retries the whole section.
      failure = `POST ${error instanceof Error ? error.message : String(error)}`
      notify()
    } finally {
      inFlight = false
      const next = queued
      queued = undefined
      if (next !== undefined) void send(next)
    }
  }

  void (async () => {
    try {
      // `cache: 'no-store'` so a cached response can never mask whether the
      // request was actually made: this probe's whole job is to be observed.
      const response = await doFetch('/dsh-workspace-menu/preferences', {
        method: 'GET',
        cache: 'no-store',
      })
      if (!response.ok) {
        failure = `GET HTTP ${response.status}`
        status = 'unavailable'
        notify()
        return
      }
      failure = undefined
      const body = await response.json() as { preferences?: unknown }
      const stored = body.preferences
      if (typeof stored === 'object' && stored !== null) {
        value = stored as Record<string, unknown>
      } else {
        // First run. Seed the document with the full resolved section rather
        // than leaving it empty: the transport REPLACES the section on every
        // write, so an empty baseline would make the first toggle persist only
        // the key it names and silently reset every other choice.
        value = {
          [FEATURES_FIELD]: defaultFlags(),
          [PINNED_WORKSPACES_FIELD]: '',
          [PINNED_GROUPS_FIELD]: '',
          [PINNED_SESSIONS_FIELD]: '',
          [UNREAD_SESSIONS_FIELD]: '',
        }
        void send(value)
      }
      status = 'ready'
      notify()
    } catch (error) {
      failure = `GET ${error instanceof Error ? error.message : String(error)}`
      status = 'unavailable'
      notify()
    }
  })()

  return {
    getSnapshot: () => ({ status, value, writable: true, mode: 'host', detail: failure }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (field, next) => {
      const section: Record<string, unknown> = { ...value }
      section[field] = next
      value = section
      notify()
      void send(section)
    },
  }
}

/**
 * One observable preference store over the Host namespace plus its local cache.
 *
 * Reads are synchronous (the settings snapshot is a stable reference), writes
 * update the in-memory value immediately, persist locally, and queue the Host
 * write. A rejected Host write is reported to the caller rather than swallowed.
 */
export class PreferencesStore {
  private preferences: Preferences
  private readonly listeners = new Set<() => void>()
  private scope: HostScope | undefined
  private lastStatus: string | undefined
  /** Last transport failure, surfaced by describeTransport(). */
  private lastTransportError: string | undefined
  /** Which transport is installed, surfaced by describeTransport(). */
  private source = 'none'
  /** Why no transport could be installed, when that is the case. */
  installFailure: string | undefined

  /**
   * Record why no transport could be installed.
   * @param reason - the failure message.
   */
  noteInstallFailure(reason: string): void {
    this.installFailure = reason
    this.notify()
  }

  /**
   * @param scope - bound settings scope; omitted for the local-cache-only mode.
   */
  constructor(scope?: HostScope) {
    this.preferences = readCache() ?? {
      features: defaultFlags(),
      pinnedWorkspaces: [],
      pinnedGroups: [],
      pinnedSessions: [],
      unreadSessions: [],
    }
    this.adoptScope(scope)
  }

  /**
   * Point this store at a settings scope (or at none) and adopt its snapshot.
   *
   * The instance is deliberately NOT rebuilt: the settings row, the row painter,
   * and every action builder hold a reference to this object, so swapping it
   * would leave those subscribers watching a discarded store — the switches
   * would silently stop reflecting the Host.
   * @param scope - the bound scope, or undefined to fall back to the local cache.
   */
  adoptScope(scope: HostScope | undefined, source = 'unknown'): void {
    this.scope = scope
    this.source = source
    this.lastTransportError = undefined
    // A real transport supersedes whatever the install attempt recorded.
    this.installFailure = undefined
    if (scope === undefined) {
      this.lastStatus = 'none'
      this.notify()
      return
    }
    this.adopt(scope.getSnapshot())
    scope.subscribe(() => { this.adopt(scope.getSnapshot()) })
  }

  /** @returns the current preferences (stable reference until a change). */
  getSnapshot(): Preferences {
    return this.preferences
  }

  /** Observe preference replacements. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Whether one feature is enabled. */
  enabled(key: FeatureKey): boolean {
    return this.preferences.features[key] !== false
  }

  /**
   * Current settings status, for the row's explanatory line.
   *
   * `unavailable` deliberately means "no transport is installed at all", not
   * "the transport could not reach the Host": the two need different copy,
   * because only the first one means the plugin had nowhere to put a
   * preference. A transport that is installed but unreachable reports its own
   * status (`loading`), so the row never claims a working store it does not
   * have.
   */
  get status(): 'loading' | 'ready' | 'unavailable' | 'memory' {
    if (this.scope === undefined) return 'unavailable'
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status === 'ready' && snapshot.mode === 'memory') return 'memory'
    return snapshot.status
  }

  /**
   * Where the preferences are actually being kept, for the settings row's
   * diagnostic line. This is the one fact an operator cannot infer from the
   * UI, and every alternative — guessing from a status word, reading the
   * browser console — has cost more than showing it.
   * @returns the transport label and, when the Host answered, its status.
   */
  describeTransport(): string {
    if (this.scope === undefined) {
      return this.installFailure === undefined ? this.source : `${this.source} (${this.installFailure})`
    }
    const snapshot = this.scope.getSnapshot()
    const detail = this.lastTransportError ?? snapshot.detail
    return `${this.source} ${snapshot.status}${detail === undefined ? '' : ` (${detail})`}`
  }

  /** Flip one feature and persist it. */
  setFeature(key: FeatureKey, value: boolean): void {
    this.commit({ features: { ...this.preferences.features, [key]: value } })
    this.persist(FEATURES_FIELD, this.preferences.features)
  }

  /** Reset one group's keys to their catalog defaults. */
  resetFeatures(keys: readonly FeatureKey[]): void {
    const features = { ...this.preferences.features }
    for (const key of keys) {
      delete features[key]
    }
    const resolved = { ...defaultFlags(), ...features }
    this.commit({ features: resolved })
    this.persist(FEATURES_FIELD, resolved)
  }

  /** Toggle one id inside a list. */
  toggle(field: 'pinnedWorkspaces' | 'pinnedGroups' | 'pinnedSessions' | 'unreadSessions', id: string): void {
    const current = this.preferences[field]
    const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    this.commit({ [field]: next } as Partial<Preferences>)
    this.persist(fieldName(field), encodeIds(next))
  }

  /** Replace one list wholesale (used when the durable order is rewritten). */
  replace(field: 'pinnedWorkspaces' | 'pinnedGroups' | 'pinnedSessions' | 'unreadSessions', ids: readonly string[]): void {
    this.commit({ [field]: ids } as Partial<Preferences>)
    this.persist(fieldName(field), encodeIds(ids))
  }

  /** Adopt a Host section over the local cache. */
  private adopt(snapshot: ReturnType<HostScope['getSnapshot']>): void {
    const status = `${snapshot.status}/${snapshot.writable ? 'w' : 'r'}`
    if (snapshot.status !== 'ready' || snapshot.value === undefined) {
      // The status line is the only thing that can change while nothing is
      // accepted, so an unchanged status must not churn the subscribers.
      if (this.lastStatus !== undefined && this.lastStatus !== status) {
        this.lastStatus = status
        this.notify()
        return
      }
      this.lastStatus = status
      return
    }
    this.lastStatus = status
    this.commit({
      features: decodeFeatures(snapshot.value),
      pinnedWorkspaces: decodeIds(snapshot.value.pinnedWorkspaces),
      pinnedGroups: decodeIds(snapshot.value.pinnedGroups),
      pinnedSessions: decodeIds(snapshot.value.pinnedSessions),
      unreadSessions: decodeIds(snapshot.value.unreadSessions),
    }, false)
  }

  /**
   * Hand one field to the transport.
   *
   * A transport that throws synchronously (an unavailable scope, a fetch
   * shim that rejects eagerly) must not break the click that produced it: the
   * local cache already carries the choice, and the next change retries.
   * @param field - namespace field.
   * @param value - the field's next value.
   */
  private persist(field: string, value: unknown): void {
    try {
      this.scope?.set(field, value)
      this.lastTransportError = undefined
    } catch (error) {
      // Recorded for the row's diagnostic line rather than thrown at the click.
      this.lastTransportError = error instanceof Error ? error.message : String(error)
    }
  }

  private commit(patch: Partial<Preferences>, persistLocally = true): void {
    this.preferences = { ...this.preferences, ...patch }
    if (persistLocally) writeCache(this.preferences)
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

function fieldName(field: 'pinnedWorkspaces' | 'pinnedGroups' | 'pinnedSessions' | 'unreadSessions'): string {
  if (field === 'pinnedWorkspaces') return PINNED_WORKSPACES_FIELD
  if (field === 'pinnedGroups') return PINNED_GROUPS_FIELD
  if (field === 'pinnedSessions') return PINNED_SESSIONS_FIELD
  return UNREAD_SESSIONS_FIELD
}
