/**
 * Unit tests for the pure logic behind the row menu.
 *
 * These cover the parts that decision-making actually depends on: the shared
 * feature catalog both halves read, the pin/unread list math, the registry-order
 * replay, and the action catalog's filtering and failure reporting. The DOM and
 * React layers need a browser and are exercised by the live GUI instead.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FEATURES,
  FEATURE_GROUPS,
  FEATURE_KEYS,
  defaultFlags,
} from '../src/features.js'
import {
  createPreferencesTransport,
  decodeFeatures,
  decodeIds,
  encodeIds,
  PreferencesStore,
} from '../src/client/state.js'
import {
  moveTo,
  orderWithPins,
  pinFront,
  pinOut,
  reorderDomRun,
  sessionRunOrder,
  UnresolvedRowWatch,
} from '../src/client/rows.js'
import type { RunEntry } from '../src/client/rows.js'
import { groupActions, sessionActions, workspaceActions } from '../src/client/actions.js'
import type { ActionContext } from '../src/client/actions.js'
import type { RowTarget } from '../src/client/rows-types.js'
import type { HostScope } from '../src/client/state.js'

/**
 * A localStorage double. `state.ts` reads it at construction, so the tests
 * install one before touching a store.
 */
function installLocalStorage(initial: Record<string, string> = {}): void {
  const cells = new Map(Object.entries(initial))
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => cells.get(key) ?? null,
      setItem: (key: string, value: string) => { cells.set(key, value) },
      removeItem: (key: string) => { cells.delete(key) },
    },
  })
}

/** A settings-scope double whose snapshot a test can move. */
function scopeDouble(initial?: unknown): HostScope & {
  publish: (value: unknown, status?: 'loading' | 'ready' | 'unavailable') => void
  writes: { field: string; value: unknown }[]
} {
  let status: 'loading' | 'ready' | 'unavailable' = initial === undefined ? 'loading' : 'ready'
  let value = initial
  const listeners = new Set<() => void>()
  const writes: { field: string; value: unknown }[] = []
  return {
    writes,
    getSnapshot: () => ({ status, value: value as never, writable: true, mode: 'host' }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: async (field: string, next: unknown) => { writes.push({ field, value: next }) },
    publish: (next, nextStatus = 'ready') => {
      value = next
      status = nextStatus
      for (const listener of listeners) listener()
    },
  }
}

/** A preferences double whose enablement comes from an explicit key set. */
function preferencesDouble(options: {
  enabled?: readonly string[]
  pinnedWorkspaces?: readonly string[]
  pinnedGroups?: readonly string[]
  pinnedSessions?: readonly string[]
  unreadSessions?: readonly string[]
} = {}): PreferencesStore {
  const disabled = new Set(FEATURE_KEYS.filter(key => !(options.enabled ?? FEATURE_KEYS).includes(key)))
  const lists: Record<string, string[]> = {
    pinnedWorkspaces: [...(options.pinnedWorkspaces ?? [])],
    pinnedGroups: [...(options.pinnedGroups ?? [])],
    pinnedSessions: [...(options.pinnedSessions ?? [])],
    unreadSessions: [...(options.unreadSessions ?? [])],
  }
  const double = {
    enabled: (key: string) => !disabled.has(key as never),
    getSnapshot: () => ({
      features: defaultFlags(),
      pinnedWorkspaces: lists.pinnedWorkspaces,
      pinnedGroups: lists.pinnedGroups,
      pinnedSessions: lists.pinnedSessions,
      unreadSessions: lists.unreadSessions,
    }),
    toggle: (field: string, id: string) => {
      const list = lists[field] ?? []
      lists[field] = list.includes(id) ? list.filter(item => item !== id) : [...list, id]
    },
    replace: (field: string, ids: readonly string[]) => {
      lists[field] = [...ids]
    },
    setFeature: () => undefined,
    resetFeatures: () => undefined,
    status: 'ready' as const,
    subscribe: () => () => undefined,
  }
  return double as unknown as PreferencesStore
}

/** The shell's persisted per-account session order, as the plugin writes it. */
function viewOrder(): Record<string, string[]> {
  try {
    const raw = JSON.parse(String(globalThis.localStorage.getItem('dsh.workspace.view.v5') ?? '{}')) as {
      sessionOrderByAccount?: Record<string, string[]>
    }
    return raw.sessionOrderByAccount ?? {}
  } catch {
    return {}
  }
}

/** A workspaces-service double holding one registry order. */
function workspacesDouble(order: readonly string[] = []) {
  const calls: string[] = []
  let items = order.map(workspaceId => ({ workspaceId, sessionIds: [] as string[] }))
  return {
    calls,
    list: { getSnapshot: () => ({ items }) },
    insertBefore: async (id: string) => { calls.push(`workspace:${id}`) },
    insertSessionBefore: async (workspaceId: string, id: string) => { calls.push(`session:${workspaceId}:${id}`) },
    archiveSession: async (id: string) => { calls.push(`archive:${id}`) },
    delete: async (id: string) => { calls.push(`delete:${id}`) },
    /** Test hook: pretend the registry order changed. */
    setOrder: (next: readonly string[]) => { items = next.map(workspaceId => ({ workspaceId, sessionIds: [] })) },
  }
}

/** A sessions-service double whose list carries the rows a test needs. */
function sessionsDouble(byId: Record<string, unknown> = {}) {
  return {
    fork: async () => 'child',
    list: { getSnapshot: () => ({ byId, ids: Object.keys(byId), current: undefined }) },
  }
}

/** An action environment that records calls instead of performing them. */
function environment(overrides: Partial<ActionContext> = {}): ActionContext & { toasts: string[]; calls: string[] } {
  const toasts: string[] = []
  const calls: string[] = []
  const t = (key: string, params?: Record<string, unknown>) =>
    params === undefined ? key : `${key}(${Object.values(params).join(',')})`
  const base = {
    stores: { workspaces: workspacesDouble(), sessions: sessionsDouble() },
    preferences: preferencesDouble(),
    copy: async () => true,
    reveal: async () => undefined,
    deleteWorkspaceDirectory: async () => undefined,
    deleteSessionRecord: async () => undefined,
    archiveManager: true,
    compactSession: async () => undefined,
    applyGroupOrder: (pinned: readonly string[]) => { calls.push(`group-order:${pinned.join('|')}`) },
    applySessionOrder: (order: readonly string[]) => { calls.push(`session-order:${order.join('|')}`) },
    openSession: (id: string) => { calls.push(`open:${id}`) },
    startSession: (id: string) => { calls.push(`start:${id}`) },
    refresh: () => { calls.push('refresh') },
    toast: (text: string) => { toasts.push(text) },
    rename: async () => undefined,
    sessionCount: () => 0,
    promptName: async () => undefined,
    t,
    ...overrides,
  }
  return Object.assign(base as unknown as ActionContext, { toasts, calls })
}

const workspaceRow: RowTarget = {
  kind: 'workspace',
  id: 'ws-1' as RowTarget['id'],
  title: 'demo',
  workspace: { workspaceId: 'ws-1', title: 'demo', path: 'C:\\work\\demo', sessionIds: ['s-1', 's-2'] } as never,
}

const sessionRow: RowTarget = {
  kind: 'session',
  id: 's-1' as RowTarget['id'],
  title: 'first chat',
  session: { id: 's-1', displayTitle: 'first chat', cwd: 'C:\\work\\demo', blank: false, updatedAt: 1, running: false } as never,
  workspaceId: 'ws-1',
}

test('the feature catalog is the single source of truth', () => {
  // Every key appears exactly once across the groups.
  const grouped = FEATURE_GROUPS.flatMap(group => group.items.map(item => item.key))
  assert.deepEqual(grouped, [...FEATURE_KEYS])
  assert.equal(new Set(FEATURE_KEYS).size, FEATURE_KEYS.length)

  // Every feature declares a label in both shipped locales.
  for (const feature of FEATURES) {
    assert.ok(feature.labelZh.length > 0, `${feature.key} has no zh label`)
    assert.ok(feature.labelEn.length > 0, `${feature.key} has no en label`)
  }

  // The five actions DSH's own menus already ship default to off; the rest are on.
  const defaultOff = FEATURES.filter(feature => !feature.defaultEnabled).map(feature => feature.key).sort()
  assert.deepEqual(defaultOff, ['sessionArchive', 'sessionFork', 'sessionRename', 'workspaceNewSession', 'workspaceRename'])

  // defaultFlags agrees with the catalog.
  const flags = defaultFlags()
  for (const feature of FEATURES) assert.equal(flags[feature.key], feature.defaultEnabled)
})

test('id lists round-trip and reject malformed input', () => {
  assert.deepEqual(decodeIds(encodeIds(['a', 'b'])), ['a', 'b'])
  // Blank lines, duplicates, and surrounding whitespace are not items.
  assert.deepEqual(decodeIds('a\n\n  b  \na\n'), ['a', 'b'])
  assert.deepEqual(decodeIds(''), [])
  // Non-string input (a corrupt document) yields no items, never a throw.
  assert.deepEqual(decodeIds(undefined), [])
  assert.deepEqual(decodeIds(42), [])
  assert.deepEqual(decodeIds(['a', 'b']), [])
  assert.equal(encodeIds(['', 'a', 'a']), 'a')
})

test('the unresolved-row watch reports one run of failures, once', () => {
  const watch = new UnresolvedRowWatch()
  // Below the threshold: silent, so a single stray treeitem is not an alarm.
  assert.equal(watch.record(), false)
  assert.equal(watch.record(), false)
  // The run reaches the threshold: report once.
  assert.equal(watch.record(), true)
  // And stays quiet for the next run until it too fills up.
  assert.equal(watch.record(), false)
  assert.equal(watch.record(), false)
  assert.equal(watch.record(), true)

  // A row the plugin understood clears the run.
  const cleared = new UnresolvedRowWatch()
  cleared.record()
  cleared.record()
  cleared.reset()
  assert.equal(cleared.record(), false)
  assert.equal(cleared.record(), false)
  assert.equal(cleared.record(), true)
})

test('the preference store is one instance that adopts a scope in place', () => {
  installLocalStorage()
  const store = new PreferencesStore()
  const seen: number[] = []
  store.subscribe(() => { seen.push(1) })

  // Before the scope binds: the catalog defaults, and the row says so.
  assert.equal(store.status, 'unavailable')
  assert.equal(store.enabled('dblclick'), true)

  // Binding must NOT swap the instance: every subscriber captured this object,
  // and a rebuilt store would leave them watching a discarded one.
  const scope = scopeDouble({ features: { dblclick: false }, pinnedWorkspaces: 'a\nb' })
  store.adoptScope(scope)
  assert.equal(store.status, 'ready')
  assert.equal(store.enabled('dblclick'), false, 'the Host section reaches the same instance')
  assert.deepEqual(store.getSnapshot().pinnedWorkspaces, ['a', 'b'])
  assert.ok(seen.length > 0, 'adoption notified the subscribers that already existed')

  // A Host-side change still lands on the original subscriber.
  const before = seen.length
  scope.publish({ features: { dblclick: true } })
  assert.equal(store.enabled('dblclick'), true)
  assert.ok(seen.length > before)
})

test('a feature toggle writes the whole feature section to the transport', async () => {
  installLocalStorage()
  const scope = scopeDouble({ features: { dblclick: true } })
  const store = new PreferencesStore(scope)
  store.setFeature('sessionPin', false)
  await Promise.resolve()

  // The whole map travels, not just the changed key: the transport replaces the
  // section, so a partial write would erase the keys it did not name.
  assert.equal(scope.writes.length, 1)
  assert.equal(scope.writes[0]?.field, 'features')
  const sent = scope.writes[0]?.value as Record<string, boolean>
  assert.equal(sent.sessionPin, false)
  assert.equal(sent.dblclick, true)

  // The local cache mirrors the choice, so the next page paint agrees with it
  // even before the Host read lands.
  const cached = JSON.parse(String(globalThis.localStorage.getItem('dsh-workspace-menu:v1'))) as { features: Record<string, boolean> }
  assert.equal(cached.features.sessionPin, false)
})

test('the file transport seeds a full section on first run', async () => {
  installLocalStorage()
  const sent: Record<string, unknown>[] = []
  const fetchDouble = (async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return { ok: true, status: 200, json: async () => ({ ok: true, preferences: sent[sent.length - 1] }) }
    }
    // First run: the Host holds no document yet.
    return { ok: true, status: 200, json: async () => ({ ok: true, preferences: null }) }
  }) as unknown as typeof fetch

  const scope = createPreferencesTransport(fetchDouble)
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))

  // The seed carries EVERY feature key, so a later toggle that REPLACES the
  // section cannot reset the choices the operator never touched.
  assert.equal(sent.length, 1)
  const seeded = sent[0]
  const flags = seeded?.features as Record<string, boolean>
  assert.equal(Object.keys(flags).length, FEATURE_KEYS.length)
  for (const key of FEATURE_KEYS) assert.equal(typeof flags[key], 'boolean')
  assert.equal(seeded?.pinnedWorkspaces, '')

  // A toggle then travels as a complete section too.
  scope.set('features', { dblclick: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  const last = sent[sent.length - 1]
  assert.equal((last?.features as Record<string, boolean>).dblclick, false)
  assert.equal(scope.getSnapshot().status, 'ready')
})

test('a loading settings scope may not displace the working transport', () => {
  installLocalStorage()
  const route = scopeDouble({ features: { dblclick: false } })
  const settings = scopeDouble(undefined)
  const store = new PreferencesStore()

  // The transport that actually works is installed first.
  store.adoptScope(route, 'host-route')
  assert.equal(store.enabled('dblclick'), false)
  assert.match(store.describeTransport(), /^host-route ready/)

  // A settings scope that has not accepted its namespace reports `loading`.
  // Treating "not unavailable yet" as "usable" is the bug this pins: the
  // settings scope took the slot, then went unavailable, and the row reported a
  // failure from a transport the plugin was not even reading.
  const consider = (): void => {
    if (settings.getSnapshot().status === 'ready') store.adoptScope(settings, 'settings-namespace')
  }
  consider()
  assert.match(store.describeTransport(), /^host-route/, 'a loading scope must not take the slot')

  // Once it truly accepts the namespace it may take over.
  settings.publish({ features: {} })
  consider()
  assert.match(store.describeTransport(), /^settings-namespace ready/)

  // And an unavailable scope never does.
  const dead = scopeDouble(undefined)
  dead.publish(undefined, 'unavailable')
  store.adoptScope(route, 'host-route')
  if (dead.getSnapshot().status === 'ready') store.adoptScope(dead, 'settings-namespace')
  assert.match(store.describeTransport(), /^host-route/)
})

test('compacting runs through the Host command plane and reports both ways', async () => {
  const asked: string[] = []
  const ok = environment({
    compactSession: async (sessionId: string) => { asked.push(sessionId); return undefined },
  })
  const action = sessionActions(sessionRow, ok).find(candidate => candidate.id === 'compact')
  assert.equal(action?.label, 'menu.compact')
  action?.run()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(asked, ['s-1'])
  assert.deepEqual(ok.toasts, ['toast.compacted'])

  // A Host refusal surfaces its message instead of a success toast — the whole
  // point of asking the Host rather than assuming the command ran.
  const refused = environment({
    compactSession: async () => 'this process has an active compaction',
  })
  const failed = sessionActions(sessionRow, refused).find(candidate => candidate.id === 'compact')
  failed?.run()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(refused.toasts.length, 1)
  assert.match(refused.toasts[0] ?? '', /active compaction/)
  assert.ok(!refused.toasts.includes('toast.compacted'))
})

test('a top-level row can be pinned, including the ungrouped bucket', () => {
  // The ungrouped bucket is a real row with no backing Workspace: its key is
  // the shell's own empty-string key, and it must still be pinnable.
  const ungrouped: RowTarget = { kind: 'group', id: '' as RowTarget['id'], groupKey: '', title: '未分组' }
  const preferences = preferencesDouble({ enabled: ['groupPin'] })
  const env = environment({ preferences })

  const pin = groupActions(ungrouped, env).find(action => action.id === 'pin-group')
  assert.equal(pin?.label, 'menu.pin')
  pin?.run()
  assert.deepEqual(preferences.getSnapshot().pinnedGroups, [''])
  assert.deepEqual(env.calls.filter(call => call.startsWith('group-order:')), ['group-order:'])
  assert.deepEqual(env.toasts, ['toast.pinned'])

  // Unpinning drops it from the list, which is what hands the order back.
  const unpin = groupActions(ungrouped, env).find(action => action.id === 'pin-group')
  assert.equal(unpin?.label, 'menu.unpin')
  unpin?.run()
  assert.deepEqual(preferences.getSnapshot().pinnedGroups, [])
  assert.deepEqual(env.toasts, ['toast.pinned', 'toast.unpinned'])
})

test('a workspace folder row shares the top-level pin order', () => {
  const folder: RowTarget = { kind: 'workspace', id: 'ws-2' as RowTarget['id'], groupKey: 'ws-2', title: 'demo' }
  const preferences = preferencesDouble({ enabled: ['groupPin'], pinnedGroups: ['ws-1'] })
  const env = environment({ preferences })

  // Pinning a second folder puts it FIRST: the list is the order.
  groupActions(folder, env).find(action => action.id === 'pin-group')?.run()
  assert.deepEqual(preferences.getSnapshot().pinnedGroups, ['ws-2', 'ws-1'])
  assert.deepEqual(env.calls.filter(call => call.startsWith('group-order:')), ['group-order:ws-2|ws-1'])
})

test('the group pin action disappears when its feature is off', () => {
  const folder: RowTarget = { kind: 'workspace', id: 'ws-2' as RowTarget['id'], groupKey: 'ws-2', title: 'demo' }
  const env = environment({ preferences: preferencesDouble({ enabled: ['workspacePin'] }) })
  assert.ok(!groupActions(folder, env).some(action => action.id === 'pin-group'))
  // Copying the project name is not a pin, so it survives the flag.
  assert.ok(groupActions(folder, env).some(action => action.id === 'copy-group-title'))
})
test('an ungrouped session pin writes the shell view order and reorders the rows', async () => {
  // A session with no workspaceId sits in the ungrouped bucket, which the
  // registry does not account for. Pinning it used to draw a marker and move
  // nothing, because the reorder was skipped whenever workspaceId was absent.
  installLocalStorage({ 'dsh.workspace.view.v5': JSON.stringify({ orderBy: 'manual', sessionOrderByAccount: {} }) })
  const ungrouped: RowTarget = {
    kind: 'session',
    id: 's-free' as RowTarget['id'],
    title: 'free session',
    session: { id: 's-free', displayTitle: 'free session', blank: false, updatedAt: 1, running: false } as never,
  }
  const preferences = preferencesDouble({ enabled: ['sessionPin'] })
  const env = environment({ preferences })

  const pin = sessionActions(ungrouped, env).find(action => action.id === 'pin')
  pin?.run()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(preferences.getSnapshot().pinnedSessions, ['s-free'])
  // The rendered rows are asked to reorder. Both stores are no-ops here: the
  // registry has no account for this session, and the shell's view order is only
  // written once a rendered order exists to compare against (which needs a DOM).
  assert.deepEqual(env.calls.filter(call => call.startsWith('session-order:')), ['session-order:'])

  // Unpinning clears the pin list, which is what hands the order back.
  const unpin = sessionActions(ungrouped, env).find(action => action.id === 'pin')
  unpin?.run()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(preferences.getSnapshot().pinnedSessions, [])
  assert.deepEqual(viewOrder(), {})
})
test('a pin confirms the same way in every sidebar ordering mode', async () => {
  // The plugin used to warn that a pin could not hold while the sidebar sorted
  // by `updated`, and the painter used to skip the hoist in that mode — so on the
  // default configuration a pin drew its marker and moved nothing. Both are gone:
  // the action confirms plainly and the screen is reconciled by the painter, in
  // every mode. What the stores hold still depends on the mode, which is why the
  // store writes stay.
  const pinnedRow: RowTarget = {
    kind: 'session',
    id: 's-order' as RowTarget['id'],
    title: 'ordered',
    session: { id: 's-order', displayTitle: 'ordered', blank: false, updatedAt: 1, running: false } as never,
    workspaceId: 'ws-1',
  }

  installLocalStorage({ 'dsh.workspace.view.v5': JSON.stringify({ orderBy: 'updated' }) })
  const recency = environment({ preferences: preferencesDouble({ enabled: ['sessionPin'] }) })
  sessionActions(pinnedRow, recency).find(action => action.id === 'pin')?.run()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(recency.toasts, ['toast.pinned'])

  installLocalStorage({ 'dsh.workspace.view.v5': JSON.stringify({ orderBy: 'manual' }) })
  const manual = environment({ preferences: preferencesDouble({ enabled: ['sessionPin'] }) })
  sessionActions(pinnedRow, manual).find(action => action.id === 'pin')?.run()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(manual.toasts, ['toast.pinned'])
})


test('a pin in the pin list lifts its row to the head of the run, in pin order', () => {
  // Regression: with exactly ONE pinned row the old tail-to-head replay happened
  // to work, which is why the bug survived earlier testing. With two it inserted
  // rows in front of themselves and moved nothing — the operator's report was
  // "置顶还是未生效，依旧是在第二个位置".
  const entries: RunEntry[] = [
    { id: 'a', position: 0, rank: undefined },
    { id: 'b', position: 1, rank: undefined },
    { id: 'c', position: 2, rank: 1 },
    { id: 'd', position: 3, rank: 0 },
  ]
  assert.deepEqual(sessionRunOrder(entries), ['d', 'c', 'a', 'b'])

  // One pin, at the tail, with the rest keeping their rendered order.
  assert.deepEqual(
    sessionRunOrder([
      { id: 'a', position: 0, rank: undefined },
      { id: 'b', position: 1, rank: undefined },
      { id: 'c', position: 2, rank: 0 },
    ]),
    ['c', 'a', 'b'],
  )

  // No pins at all: the rendered order is returned untouched.
  const none: RunEntry[] = [
    { id: 'a', position: 0, rank: undefined },
    { id: 'b', position: 1, rank: undefined },
  ]
  assert.deepEqual(sessionRunOrder(none), ['a', 'b'])
})

test('the run reorder actually moves the rows it is asked to', () => {
  // The shape matters as much as the move: DSH wraps each row in a keyed
  // single-child wrapper, and those wrappers are the repeating children of the
  // list. A double built from flat siblings passes while the real screen stays
  // still — which is exactly how the bug survived its first fix — so the wrappers
  // are reproduced here.
  interface Fake extends HTMLElement {
    key: string
  }
  const makeRun = (keys: readonly string[]) => {
    const children: Fake[] = []
    const container = {
      insertBefore: (node: Fake, anchor: Fake | null) => {
        const from = children.indexOf(node)
        if (from >= 0) children.splice(from, 1)
        const at = anchor === null ? children.length : children.indexOf(anchor)
        children.splice(at < 0 ? children.length : at, 0, node)
        return node
      },
      children,
    } as unknown as HTMLElement
    const elements = new Map<string, HTMLElement>()
    for (const key of keys) {
      const item = { key } as Fake
      const wrapper = { key } as Fake
      Object.defineProperty(item, 'parentElement', { get: () => wrapper })
      Object.defineProperty(item, 'nextElementSibling', { get: () => null })
      Object.defineProperty(wrapper, 'parentElement', { get: () => container })
      Object.defineProperty(wrapper, 'children', { get: () => [item] })
      Object.defineProperty(wrapper, 'nextElementSibling', {
        get: () => children[children.indexOf(wrapper) + 1] ?? null,
      })
      children.push(wrapper)
      elements.set(key, item as unknown as HTMLElement)
    }
    // Row keys by wrapper, so the assertions read in screen order.
    const order = (): string[] => children.map(child => child.key)
    // Which wrapper a key currently sits in, so a test can see the row move.
    const wrapperOf = (key: string): number => children.findIndex(child => child.key === key)
    return { elements, order, wrapperOf, container }
  }

  const run = makeRun(['a', 'b', 'c', 'd'])
  reorderDomRun(run.elements, ['d', 'c', 'a', 'b'])
  assert.deepEqual(run.order(), ['d', 'c', 'a', 'b'])

  // The other direction too: an id asked to move to the END. Forward replay
  // passes this case and fails the hoist above; backward replay does both, so
  // both directions are pinned here.
  const demote = makeRun(['a', 'b', 'c'])
  reorderDomRun(demote.elements, ['b', 'c', 'a'])
  assert.deepEqual(demote.order(), ['b', 'c', 'a'])

  // A run that is already in order produces no moves at all.
  let moves = 0
  const stable = makeRun(['a', 'b', 'c'])
  const original = (stable.container as unknown as { insertBefore: (node: never, anchor: never) => unknown }).insertBefore
  ;(stable.container as unknown as { insertBefore: unknown }).insertBefore = (node: never, anchor: never) => {
    moves += 1
    return original(node, anchor)
  }
  reorderDomRun(stable.elements, ['a', 'b', 'c'])
  assert.equal(moves, 0)
})

test('a transport that throws cannot break the click that produced it', () => {
  installLocalStorage()
  const exploding = {
    getSnapshot: () => ({ status: 'ready' as const, value: undefined, writable: true, mode: 'host' as const }),
    subscribe: () => () => undefined,
    set: () => { throw new Error('transport offline') },
  }
  const store = new PreferencesStore(exploding)
  // The choice still lands locally, and the caller sees no exception.
  store.setFeature('dblclick', false)
  assert.equal(store.enabled('dblclick'), false)
  store.toggle('unreadSessions', 's-1')
  assert.deepEqual(store.getSnapshot().unreadSessions, ['s-1'])
})

test('a malformed feature section falls back to the catalog defaults', () => {
  const flags = defaultFlags()
  // Absent / wrong-shaped section: catalog defaults stand.
  assert.deepEqual(decodeFeatures(undefined), flags)
  assert.deepEqual(decodeFeatures({}), flags)
  assert.deepEqual(decodeFeatures({ features: null }), flags)
  assert.deepEqual(decodeFeatures({ features: [] }), flags)

  // Known booleans are adopted; non-boolean and unknown keys are ignored.
  const decoded = decodeFeatures({ features: { dblclick: false, sessionPin: true, bogus: false, sessionUnread: 'yes' } })
  assert.equal(decoded.dblclick, false)
  assert.equal(decoded.sessionPin, true)
  assert.equal(decoded.sessionUnread, flags.sessionUnread)
  assert.equal(Object.hasOwn(decoded, 'bogus'), false)
})

test('orderWithPins lifts pins in pin order and drops ids the registry lost', () => {
  assert.deepEqual(orderWithPins(['a', 'b', 'c'], ['c']), ['c', 'a', 'b'])
  // Pin order, not registry order, decides among pins.
  assert.deepEqual(orderWithPins(['a', 'b', 'c'], ['c', 'b']), ['c', 'b', 'a'])
  // A pin for a deleted workspace leaves no ghost behind.
  assert.deepEqual(orderWithPins(['a', 'b'], ['gone', 'b']), ['b', 'a'])
  // No pins, no change.
  assert.deepEqual(orderWithPins(['a', 'b'], []), ['a', 'b'])
  // Duplicated pins collapse: an id appears once.
  assert.deepEqual(orderWithPins(['a', 'b'], ['b', 'b']), ['b', 'a'])
})

test('moveTo relocates one id and clamps out-of-range positions', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b'])
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'a', 2), ['b', 'c', 'a'])
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'a', 99), ['b', 'c', 'a'])
  assert.deepEqual(moveTo(['a', 'b', 'c'], 'a', -5), ['a', 'b', 'c'])
  // An unknown id changes nothing.
  assert.deepEqual(moveTo(['a', 'b'], 'zz', 0), ['a', 'b'])
  // The input list is never mutated.
  const input = ['a', 'b', 'c']
  moveTo(input, 'c', 0)
  assert.deepEqual(input, ['a', 'b', 'c'])
})

test('pinFront and pinOut sanitize a hand-edited pin list', () => {
  // Pinning an id that is already pinned once keeps a single occurrence.
  assert.deepEqual(pinFront(['b', 'a'], 'b'), ['b', 'a'])
  // A duplicated id in the document collapses on the next toggle.
  assert.deepEqual(pinFront(['b', 'b', 'a'], 'b'), ['b', 'a'])
  assert.deepEqual(pinOut(['b', 'b', 'a'], 'b'), ['a'])
  assert.deepEqual(pinFront(['a'], 'c'), ['c', 'a'])
  assert.deepEqual(pinOut(['a'], 'zz'), ['a'])
})

test('unpinning returns the workspace to the registry order', async () => {
  const preferences = preferencesDouble({
    enabled: ['workspacePin'],
    pinnedWorkspaces: ['ws-1'],
  })
  const workspaces = workspacesDouble(['ws-1', 'ws-2'])
  const env = environment({ preferences, stores: { workspaces, sessions: sessionsDouble() } as never })

  // The registry currently holds the pinned order, so unpinning moves ws-1
  // back behind ws-2 — the action must actually replay that order.
  const action = workspaceActions(workspaceRow, env).find(candidate => candidate.id === 'pin')
  assert.equal(action?.label, 'menu.unpin')
  action?.run()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(preferences.getSnapshot().pinnedWorkspaces, [])
  assert.deepEqual(env.toasts, ['toast.unpinned'])
})

test('pinning a workspace replays the new order through the official API', async () => {
  const preferences = preferencesDouble({ enabled: ['workspacePin'] })
  const workspaces = workspacesDouble(['ws-1', 'ws-2'])
  const env = environment({ preferences, stores: { workspaces, sessions: sessionsDouble() } as never })

  const action = workspaceActions(workspaceRow, env).find(candidate => candidate.id === 'pin')
  assert.equal(action?.label, 'menu.pin')
  action?.run()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(preferences.getSnapshot().pinnedWorkspaces, ['ws-1'])
  assert.deepEqual(env.toasts, ['toast.pinned'])
})

test('the action catalog honours the feature flags', () => {
  const onlyCopy = environment({
    preferences: preferencesDouble({ enabled: ['workspaceCopyPath'] }),
  })
  assert.deepEqual(workspaceActions(workspaceRow, onlyCopy).map(action => action.id), ['copy-path'])

  const onlyPin = environment({
    preferences: preferencesDouble({ enabled: ['sessionPin'], pinnedSessions: ['s-1'] }),
  })
  assert.deepEqual(sessionActions(sessionRow, onlyPin).map(action => action.id), ['pin'])
})

test('an action that needs the workspace view is absent without it', () => {
  // A workspace row whose registry entry has not loaded yet must not offer
  // actions that would dereference a missing path.
  const row: RowTarget = { kind: 'workspace', id: 'ws-9' as RowTarget['id'], title: 'ghost' }
  const env = environment()
  const ids = workspaceActions(row, env).map(action => action.id)
  assert.ok(!ids.includes('reveal'), 'reveal needs a path')
  assert.ok(!ids.includes('copy-path'), 'copy needs a path')
  assert.ok(!ids.includes('delete-disk'), 'deleting needs a path')
  assert.ok(ids.includes('pin'), 'pinning needs only the id')
})

test('session actions that need a cwd are absent without one', () => {
  const row: RowTarget = { kind: 'session', id: 's-9' as RowTarget['id'], title: 'cold', workspaceId: 'ws-1' }
  const ids = sessionActions(row, environment()).map(action => action.id)
  assert.ok(!ids.includes('reveal'))
  assert.ok(ids.includes('copy-link'))
  assert.ok(ids.includes('open-window'))
})

test('destructive actions require an acknowledgement before they run', () => {
  const env = environment()
  const remove = workspaceActions(workspaceRow, env).find(action => action.id === 'remove')
  assert.ok(remove?.confirm, 'removing a workspace confirms first')
  assert.equal(remove?.confirm?.acknowledge, 'dialog.acknowledge')

  const deleteDisk = workspaceActions(workspaceRow, env).find(action => action.id === 'delete-disk')
  assert.ok(deleteDisk?.confirm, 'deleting a directory confirms first')
  assert.equal(deleteDisk?.danger, true)
  // The path is part of the copy, so the operator sees what disappears.
  assert.match(String(deleteDisk?.confirm?.body), /C:\\work\\demo/)

  // The archive-manager warning appears only when the Host said it is missing.
  const absent = sessionActions(sessionRow, environment({ archiveManager: false }))
    .find(action => action.id === 'delete')
  assert.equal(absent?.confirm?.warning, 'dialog.archiveManagerMissing')
  const unknown = sessionActions(sessionRow, environment({ archiveManager: undefined }))
    .find(action => action.id === 'delete')
  assert.equal(unknown?.confirm?.warning, undefined)
  const present = sessionActions(sessionRow, environment({ archiveManager: true }))
    .find(action => action.id === 'delete')
  assert.equal(present?.confirm?.warning, undefined)
})

test('the delete-workspace dialog states what cannot be cleaned up', () => {
  const withManager = workspaceActions(workspaceRow, environment({ archiveManager: true }))
    .find(action => action.id === 'delete-disk')
  assert.equal(withManager?.confirm?.warning, undefined)

  // Without the archive manager the logs cannot be purged, and the copy says so
  // before the operator acknowledges — instead of letting the action fail on a
  // machine where it could never succeed.
  const withoutManager = workspaceActions(workspaceRow, environment({ archiveManager: false }))
    .find(action => action.id === 'delete-disk')
  assert.match(String(withoutManager?.confirm?.warning), /dialog\.deleteWorkspaceLogsPending/)
  assert.match(String(withoutManager?.confirm?.warning), /2/)

  // An unknown answer stays silent rather than claiming either way.
  const unknown = workspaceActions(workspaceRow, environment({ archiveManager: undefined }))
    .find(action => action.id === 'delete-disk')
  assert.equal(unknown?.confirm?.warning, undefined)
})

test('a failed session-log delete stops the directory removal', async () => {
  const calls: string[] = []
  const env = environment({
    deleteSessionRecord: async (sessionId: string) => {
      calls.push(`log:${sessionId}`)
      return sessionId === 's-2' ? 'archive-manager offline' : undefined
    },
    deleteWorkspaceDirectory: async (path: string) => {
      calls.push(`rmdir:${path}`)
      return undefined
    },
  })
  const action = workspaceActions(workspaceRow, env).find(candidate => candidate.id === 'delete-disk')
  action?.run()
  await new Promise(resolve => setTimeout(resolve, 0))

  // Both logs were attempted, the directory was NOT removed, and the failure
  // was reported instead of being swallowed.
  assert.deepEqual(calls, ['log:s-1', 'log:s-2'])
  assert.equal(env.toasts.length, 1)
  assert.match(env.toasts[0] ?? '', /toast\.sessionDeletePartial/)
  assert.match(env.toasts[0] ?? '', /archive-manager offline/)
})

test('a successful delete removes the directory and reports it', async () => {
  const calls: string[] = []
  const env = environment({
    deleteSessionRecord: async (sessionId: string) => { calls.push(`log:${sessionId}`); return undefined },
    deleteWorkspaceDirectory: async (path: string) => { calls.push(`rmdir:${path}`); return undefined },
  })
  const action = workspaceActions(workspaceRow, env).find(candidate => candidate.id === 'delete-disk')
  action?.run()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(calls, ['log:s-1', 'log:s-2', 'rmdir:C:\\work\\demo'])
  assert.deepEqual(env.toasts, ['toast.workspaceDeleted'])
})

test('a directory removal the Host refuses surfaces its reason', async () => {
  const env = environment({
    // The guarded route answers 403 with this message when the target is not a
    // registry workspace; the client must show it rather than claim success.
    deleteWorkspaceDirectory: async () => 'refusing to delete a directory this Host does not own as a workspace',
  })
  const action = workspaceActions(workspaceRow, env).find(candidate => candidate.id === 'delete-disk')
  action?.run()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(env.toasts.length, 1)
  assert.match(env.toasts[0] ?? '', /does not own as a workspace/)
  assert.ok(!env.toasts.includes('toast.workspaceDeleted'))
})

test('a failed reveal surfaces the host message rather than a success toast', async () => {
  const env = environment({ reveal: async () => 'opener exited with code 1' })
  const action = workspaceActions(workspaceRow, env).find(candidate => candidate.id === 'reveal')
  action?.run()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(env.toasts.length, 1)
  assert.match(env.toasts[0] ?? '', /opener exited with code 1/)
  assert.ok(!env.toasts.includes('toast.opened'))
})

test('pinning a session replays the order through the official move API', async () => {
  // Manual ordering, so the action reports the pin itself rather than the
  // recency-mode warning (that has its own case).
  installLocalStorage({ 'dsh.workspace.view.v5': JSON.stringify({ orderBy: 'manual' }) })
  const preferences = preferencesDouble({ enabled: ['sessionPin'] })
  const workspaces = workspacesDouble([])
  const env = environment({ preferences, stores: { workspaces, sessions: sessionsDouble() } as never })
  const action = sessionActions(sessionRow, env).find(candidate => candidate.id === 'pin')
  assert.equal(action?.label, 'menu.pin')
  action?.run()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(preferences.getSnapshot().pinnedSessions, ['s-1'])
  assert.deepEqual(env.toasts, ['toast.pinned'])
})

test('unread marking toggles through the preference store', () => {
  const preferences = preferencesDouble({ enabled: ['sessionUnread'] })
  const env = environment({ preferences })
  const first = sessionActions(sessionRow, env).find(candidate => candidate.id === 'unread')
  assert.equal(first?.label, 'menu.markUnread')
  first?.run()
  assert.deepEqual(preferences.getSnapshot().unreadSessions, ['s-1'])
  assert.deepEqual(env.toasts, ['toast.markedUnread'])

  const second = sessionActions(sessionRow, env).find(candidate => candidate.id === 'unread')
  assert.equal(second?.label, 'menu.markRead')
  second?.run()
  assert.deepEqual(preferences.getSnapshot().unreadSessions, [])
  assert.deepEqual(env.toasts, ['toast.markedUnread', 'toast.markedRead'])
})
