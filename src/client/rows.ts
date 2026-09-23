/**
 * Bridge between DSH's rendered workspace/session rows and this plugin.
 *
 * DSH's sidebar ships no row-level extension point, so a row is identified the
 * only way that survives React's opaque DOM: the props React itself put on the
 * row's fiber. Everything ELSE about a row — its canonical path, session list,
 * cwd, title — is read from the official `workspaces` / `sessions` services, so
 * the fiber walk is confined to the one job it alone can do: answering "which
 * workspace or session is this DOM node?".
 *
 * The row-identity types live in `rows-types.ts` so the action layer can use
 * them without pulling DOM reach into its module graph.
 */
import { createElement, Fragment, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ISessions, IWorkspaces, SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { WhaleMark } from './WhaleMark.js'
import type { RowFlags, RowKind, RowStores, RowTarget } from './rows-types.js'

/**
 * Brand a raw id the way DSH's own id factories do.
 *
 * Declared locally instead of importing the host-side factories: those are the
 * Host's module surface, while these brands are erased at build time and the
 * client runtime's public subpath exports the types only.
 */
function asWorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

function asSessionId(id: string): SessionId {
  return id as SessionId
}

export type { RowFlags, RowKind, RowStores, RowTarget } from './rows-types.js'

const MAX_FIBER_DEPTH = 40

/**
 * Walk up from a DOM node's React fiber looking for the props that identify a
 * workspace group header or a session row.
 * @param el - a node inside a `role="treeitem"` row.
 * @returns the identifying props, or undefined for other trees that also use treeitem.
 */
function fiberRowProps(el: Element): Record<string, unknown> | undefined {
  const key = Object.keys(el).find(candidate => candidate.startsWith('__reactFiber$'))
  if (key === undefined) return undefined
  let fiber: unknown = (el as unknown as Record<string, unknown>)[key]
  for (let depth = 0; fiber !== null && fiber !== undefined && depth < MAX_FIBER_DEPTH; depth += 1) {
    const props = (fiber as { memoizedProps?: Record<string, unknown> }).memoizedProps
    if (props !== undefined) {
      const node = props.node as { id?: unknown; updatedAt?: unknown; blank?: unknown } | undefined
      const isSessionNode = node !== undefined
        && node.id !== undefined
        && typeof node.updatedAt === 'number'
        && typeof node.blank === 'boolean'
      if (isSessionNode || props.group !== undefined) return props
    }
    fiber = (fiber as { return?: unknown }).return
  }
  return undefined
}

/** The nearest row element for an event target. */
export function findRow(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined
  const row = target.closest('[role="treeitem"]')
  return row instanceof HTMLElement ? row : undefined
}

/**
 * Identify one row against the official stores.
 * @param row - the `role="treeitem"` element.
 * @param stores - the client's session and workspace services.
 * @returns the identified row, or undefined for a foreign treeitem.
 */
export function resolveRow(row: HTMLElement, stores: RowStores): RowTarget | undefined {
  const props = fiberRowProps(row)
  if (props === undefined) return undefined

  const node = props.node as { id?: unknown; title?: unknown; displayTitle?: unknown } | undefined
  if (node !== undefined && node.id !== undefined) {
    const id = String(node.id)
    const session = stores.sessions.list.getSnapshot().byId[id]
    const workspaceId = stores.workspaces.list.getSnapshot().items
      .find(workspace => workspace.sessionIds.includes(id))?.workspaceId
    const title = session?.displayTitle
      ?? (typeof node.displayTitle === 'string' && node.displayTitle !== '' ? node.displayTitle : undefined)
      ?? (typeof node.title === 'string' && node.title !== '' ? node.title : undefined)
      ?? id
    return { kind: 'session', id: asSessionId(id), title, session, workspaceId }
  }

  const group = props.group as { key?: unknown; workspaceId?: unknown; label?: unknown; sessionCount?: unknown } | undefined
  if (group === undefined) return undefined
  const groupKey = typeof group.key === 'string' ? group.key : ''
  const id = group.workspaceId === undefined ? '' : String(group.workspaceId)
  const workspace = id === ''
    ? undefined
    : stores.workspaces.list.getSnapshot().items.find(candidate => candidate.workspaceId === id)
  const label = typeof group.label === 'string' && group.label !== '' ? group.label : undefined
  const title = workspace?.title ?? label ?? id
  const sessionCount = typeof group.sessionCount === 'number' ? group.sessionCount : undefined

  // A row with no backing Workspace is the bucket for sessions that belong to
  // none. It is still a top-level row the operator can pin, so it is reported
  // as a group whose id is the shell's own key for that bucket (the empty
  // string) rather than dropped.
  if (workspace === undefined && id === '') {
    return { kind: 'group', id: asSessionId(groupKey), groupKey, title, sessionCount }
  }
  return { kind: 'workspace', id: asWorkspaceId(id), groupKey, title, workspace, sessionCount }
}

/**
 * The canonical order an identifier list should take for a surface: the
 * registry's own order with pinned ids lifted, in pin order, to the front —
 * and ids the registry no longer holds dropped, so a deleted workspace cannot
 * leave a ghost behind a pin.
 *
 * Both inputs are sanitised first: a pin list can arrive from a hand-edited
 * settings document, and a duplicated id would otherwise be emitted twice.
 * @param natural - registry order of ids.
 * @param pinned - pinned ids in pin order.
 * @returns the ordered id list, each id present at most once.
 */
export function orderWithPins(natural: readonly string[], pinned: readonly string[]): string[] {
  const known = new Set(natural)
  const pinnedPresent = [...new Set(pinned)].filter(id => known.has(id))
  const pinnedSet = new Set(pinnedPresent)
  return [...pinnedPresent, ...natural.filter(id => !pinnedSet.has(id))]
}

/**
 * The pin list after pinning one id: the id first, then the existing pins with
 * every occurrence of that id removed.
 * @param pinned - current pin list.
 * @param id - the id being pinned.
 * @returns the new pin list.
 */
export function pinFront(pinned: readonly string[], id: string): string[] {
  return [id, ...pinOut(pinned, id)]
}

/**
 * The pin list after unpinning one id; every occurrence is dropped, so a
 * hand-edited document cannot leave the id pinned after the operator unpinned it.
 * @param pinned - current pin list.
 * @param id - the id being unpinned.
 * @returns the new pin list.
 */
export function pinOut(pinned: readonly string[], id: string): string[] {
  return pinned.filter(candidate => candidate !== id)
}

/** One entry of a row run: a stable key, its rendered position, and its pin rank. */
export interface RunEntry {
  /** Row key (a session id here). */
  id: string
  /** Position in the run as currently rendered. */
  position: number
  /** Index in the pin list, or undefined when the row is not pinned. */
  rank: number | undefined
}

/**
 * The order a run of rows should take: pinned rows first, in pin order, then
 * every other row in the order it is already rendered in.
 *
 * Kept separate from the DOM so the one thing that used to be silently wrong is
 * testable without a browser. It was: the reorder was written as a tail-to-head
 * replay against each entry's successor, which is correct only while the list
 * holds a SINGLE pinned row. With two or more, the "successor" of a pinned row
 * was itself part of the group being moved, so the loop inserted elements in
 * front of themselves — a no-op the DOM reports as a mutation — and the visible
 * order never changed. Two pinned rows, one pin each, and "置顶还是未生效".
 * @param entries - the rows currently rendered, in rendered order.
 * @returns the keys in their target order.
 */
export function sessionRunOrder(entries: readonly RunEntry[]): string[] {
  const weight = (entry: RunEntry, position: number): number =>
    entry.rank === undefined ? entries.length + position : entry.rank
  return entries
    .map((entry, position) => ({ entry, weight: weight(entry, position) }))
    .sort((left, right) => (left.weight - right.weight))
    .map(pair => pair.entry.id)
}

/**
 * The element that actually has to move for a row to change position.
 *
 * A `[role="treeitem"]` row is NOT a sibling of the other rows. DSH wraps each
 * one in a keyed React wrapper (`SPAN._root_…`) with exactly one element child,
 * and those wrappers — not the rows — are the repeating children of the list
 * container. Moving a row's `div` therefore moves it INSIDE its own wrapper: the
 * DOM order of the rows changes, the screen does not, and the next React render
 * puts it back. That is why every earlier attempt looked correct in the DOM and
 * still showed the row in place — the hoist was rearranging the inside of the
 * boxes instead of the boxes.
 *
 * The outermost ancestor is taken rather than the wrapper by name: any number of
 * single-child wrappers may sit between the row and the list, and the one that
 * matters is the highest one whose parent also holds other rows.
 * @param row - a `[role="treeitem"]` element.
 * @returns the ancestor to move (the row itself when it is already a sibling).
 */
function movableRowAncestor(row: HTMLElement): HTMLElement {
  let node: HTMLElement = row
  for (let depth = 0; depth < 8; depth += 1) {
    const parent: HTMLElement | null = node.parentElement
    if (parent === null) break
    if (parent.children.length > 1) break
    node = parent
  }
  return node
}

/**
 * Reorder one continuous run of sibling row elements to the target key order.
 *
 * Replayed BACKWARDS — the last row is placed first, then the one before it in
 * front of it, and so on — so each row lands directly behind its predecessor,
 * every time. (The forward direction looks equivalent and is not: row `i+1` is
 * still somewhere to the right of the anchor when row `i` is inserted, so the
 * insert becomes a no-op and the move silently does nothing. That is the second
 * half of the "置顶还是未生效" bug, found only after the ordering math was fixed
 * and the DOM still refused to move.)
 *
 * Rows already in place are left alone, so a run that is already correct
 * produces no DOM writes and therefore no repaint.
 * @param elements - the run's elements, indexed by key.
 * @param order - the target key order (keys missing from `elements` are skipped).
 */
export function reorderDomRun(
  elements: ReadonlyMap<string, HTMLElement>,
  order: readonly string[],
): void {
  const present = order
    .map(id => elements.get(id))
    .filter((node): node is HTMLElement => node !== undefined)
    .map(movableRowAncestor)
  for (let position = present.length - 1; position >= 1; position -= 1) {
    const element = present[position]
    const predecessor = present[position - 1]
    if (element === undefined || predecessor === undefined) continue
    if (predecessor.nextElementSibling === element) continue
    const parent = element.parentElement
    if (parent === null || predecessor.parentElement !== parent) continue
    parent.insertBefore(predecessor, element)
  }
}

/**
 * Move one id to a target position inside a list.
 * @param ids - current order.
 * @param id - the id to move (ignored when absent).
 * @param position - 0-based destination index.
 * @returns the new order.
 */
export function moveTo(ids: readonly string[], id: string, position: number): string[] {
  if (!ids.includes(id)) return [...ids]
  const next = ids.filter(item => item !== id)
  const index = Math.max(0, Math.min(position, next.length))
  next.splice(index, 0, id)
  return next
}

/** Registry order of every workspace id. */
export function naturalWorkspaces(stores: RowStores): string[] {
  return stores.workspaces.list.getSnapshot().items.map(workspace => workspace.workspaceId)
}

/** Account order of one workspace's session ids. */
export function naturalSessions(stores: RowStores, workspaceId: string): string[] {
  const workspace = stores.workspaces.list.getSnapshot().items
    .find(candidate => candidate.workspaceId === workspaceId)
  return workspace === undefined ? [] : [...workspace.sessionIds]
}

/**
 * Push a desired workspace order into the durable registry.
 *
 * `insertBefore` moves exactly the named id, so replaying the target order from
 * the tail towards the head converges on it while touching only the rows that
 * actually differ from the registry's current order.
 * @param stores - client stores.
 * @param order - desired id order (ids absent from the registry are skipped).
 * @param natural - registry order before the move.
 * @returns resolution after every needed move settled.
 */
export async function applyWorkspaceOrder(
  stores: RowStores,
  order: readonly string[],
  natural: readonly string[],
): Promise<void> {
  const known = new Set(natural)
  const target = order.filter(id => known.has(id))
  let current = natural.filter(id => known.has(id))
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const id = target[index]
    if (id === undefined || current[index] === id) continue
    await stores.workspaces.insertBefore(id, target[index + 1])
    current = moveTo(current, id, index)
  }
}

/**
 * Push a desired session order into one workspace.
 * @param stores - client stores.
 * @param workspaceId - owning workspace.
 * @param order - desired session id order.
 * @param natural - account order before the move.
 * @returns resolution after every needed move settled.
 */
export async function applySessionOrder(
  stores: RowStores,
  workspaceId: string,
  order: readonly string[],
  natural: readonly string[],
): Promise<void> {
  const known = new Set(natural)
  const target = order.filter(id => known.has(id))
  let current = natural.filter(id => known.has(id))
  for (let index = target.length - 1; index >= 0; index -= 1) {
    const id = target[index]
    if (id === undefined || current[index] === id) continue
    await stores.workspaces.insertSessionBefore(workspaceId, id, target[index + 1])
    current = moveTo(current, id, index)
  }
}

/** How many unresolvable rows in a row before the plugin says so out loud. */
export const UNRESOLVED_ALERT_THRESHOLD = 3

/**
 * Counts rows the plugin could not identify.
 *
 * The fiber walk is the one place this plugin depends on DSH's internal
 * structure rather than a published contract, and when that structure changes
 * it fails SILENTLY — the row menu simply never appears. This counter turns the
 * failure into a report the operator can act on: one message per run of
 * failures, not one per click.
 */
export class UnresolvedRowWatch {
  private count = 0

  /**
   * Record one unresolvable row.
   * @returns true when the operator should be told, once per run of failures.
   */
  record(): boolean {
    this.count += 1
    if (this.count < UNRESOLVED_ALERT_THRESHOLD) return false
    this.count = 0
    return true
  }

  /** Record a row the plugin understood, clearing any run of failures. */
  reset(): void {
    this.count = 0
  }
}

/** Marker element attribute; the plugin inserts and removes these itself. */
const MARKER_ATTR = 'data-dsh-marker'

/**
 * One row's marker strip, rendered through its own React root.
 *
 * The markers are React elements, so each strip owns a root and unmounts it with
 * the strip. A WeakMap keeps the painter's DOM-only view intact while still
 * rendering React children properly.
 */
const markerRoots = new WeakMap<Element, { unmount: () => void }>()


/**
 * Remove a row's marker strip and release its root.
 * @param row - the row element.
 */
function clearMarkers(row: HTMLElement): void {
  for (const existing of row.querySelectorAll(`:scope > [${MARKER_ATTR}]`)) {
    markerRoots.get(existing)?.unmount()
    markerRoots.delete(existing)
    existing.remove()
  }
}

/**
 * Build one row's marker strip.
 * @param flags - the resolved flags.
 * @returns the strip element, or undefined when there is nothing to show.
 */
function buildMarkers(flags: RowFlags): HTMLElement | undefined {
  if (!flags.pinned && !flags.unread) return undefined
  const strip = document.createElement('span')
  strip.setAttribute(MARKER_ATTR, 'strip')
  // The visible gap and the rotation allowance are separate numbers now: the
  // whale swings 1.01px past its own right edge at the deepest point of the dive
  // (measured with `scripts/fit-pin-whale.mjs`), so the reserve only has to
  // cover that plus a pixel of slack. Padding it by a whole glyph width is what
  // opened the canyon between the mark and the title.
  // The gap the operator sees is not this strip's own `gap`: the shell puts an
  // empty 16px slot (`span.…_slot`) between the marker strip and the title, and
  // the title carries a further 4px of its own left margin. Measured in a live
  // row: whale ends at x=24, the title starts at x=45. This negative right margin
  // cancels most of that dead space so the whale sits next to its title while
  // still leaving the unread grid its room. The whale never grows past its own
  // 16px box by more than 1.7px (the widest rotated pose measures 19.4px), so the
  // remaining ~11px cannot be reached.
  strip.style.cssText = 'display:inline-flex;align-items:center;gap:1px;flex:none;margin-right:-6px;'
  const children: ReactNode[] = []
  if (flags.pinned) {
    // The pinned mark is the brand whale, blue and animated (see `WhaleMark`),
    // plus a row tint painted by the stylesheet (see `paintRow`) so a pinned row
    // reads as pinned from a scan, not only from spotting a 15px glyph.
    children.push(createElement(WhaleMark, { key: 'pinned' }))
  }
  if (flags.unread) {
    children.push(createElement('span', {
      key: 'unread',
      title: 'Unread',
      style: { display: 'inline-flex', alignItems: 'center', color: 'var(--dsw-alias-state-warn-primary)' },
    }, createElement('span', {
      style: {
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: 'currentColor',
        display: 'block',
        boxShadow: '0 0 0 2px color-mix(in srgb, currentColor 25%, transparent)',
      },
    })))
  }
  const root = createRoot(strip)
  root.render(createElement(Fragment, null, ...children))
  markerRoots.set(strip, root)
  return strip
}

/**
 * Write this plugin's per-row flags onto one DOM row.
 *
 * Both facts get a real, visible marker rather than a data attribute the
 * stylesheet turns into a 2px inset: the previous spelling was technically
 * correct and practically invisible, which is indistinguishable from the feature
 * not working at all. The strip is prepended INSIDE the row, so React's own
 * children keep their order and positions.
 * @param row - the row element.
 * @param flags - resolved flags, or undefined to clear them.
 */
export function paintRow(row: HTMLElement, flags: RowFlags | undefined): void {
  clearMarkers(row)

  if (flags === undefined) {
    delete row.dataset.dshWorkspaceId
    delete row.dataset.dshSessionId
    delete row.dataset.dshPinned
    delete row.dataset.dshUnread
    delete row.dataset.dshTint
    return
  }
  if (flags.kind === 'session') {
    row.dataset.dshSessionId = flags.id
    delete row.dataset.dshWorkspaceId
  } else {
    row.dataset.dshWorkspaceId = flags.id
    delete row.dataset.dshSessionId
  }
  row.dataset.dshPinned = flags.pinned ? 'true' : 'false'
  row.dataset.dshUnread = flags.unread ? 'true' : 'false'
  // Painted as a row tint so a pinned row is findable by scanning, not only by
  // spotting a 14px glyph.
  if (flags.pinned) row.dataset.dshTint = flags.unread ? 'both' : 'pinned'
  else if (flags.unread) row.dataset.dshTint = 'unread'
  else delete row.dataset.dshTint

  const strip = buildMarkers(flags)
  if (strip !== undefined) row.prepend(strip)
}
/**
 * The top-level row keys in their current rendered order.
 *
 * Read from the DOM because the shell owns the tree: `group.key` is not exposed
 * on any client service, so the rendered rows are the only faithful record of
 * what order the operator is looking at.
 * @param stores - client stores, to tell a group row from a session row.
 * @returns group keys in document order.
 */
export function renderedGroupOrder(stores: RowStores): string[] {
  const keys: string[] = []
  for (const row of document.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
    const target = resolveRow(row, stores)
    if (target === undefined || target.kind === 'session') continue
    const key = target.groupKey ?? ''
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

/**
 * Move every top-level row into the operator's order.
 *
 * Replayed from the tail towards the head against each row's own successor, so
 * only the rows that actually differ move. Unknown keys are ignored: a pin for a
 * workspace that no longer exists must not strand the rest.
 * @param order - the operator's order (pinned first, in pin order).
 * @param stores - client stores, to resolve each rendered row.
 */
export function applyGroupOrderToDom(order: readonly string[], stores: RowStores): void {
  const rows = new Map<string, HTMLElement>()
  for (const row of document.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
    const target = resolveRow(row, stores)
    if (target === undefined || target.kind === 'session') continue
    const key = target.groupKey ?? ''
    if (!rows.has(key)) rows.set(key, row)
  }
  const known = [...rows.keys()]
  const target = order.filter(key => rows.has(key))
  for (const key of known) if (!target.includes(key)) target.push(key)

  for (let index = target.length - 1; index >= 0; index -= 1) {
    const element = rows.get(target[index] ?? '')
    if (element === undefined) continue
    const next = rows.get(target[index + 1] ?? '')
    element.parentElement?.insertBefore(element, next ?? null)
  }
}
/**
 * Reorder the SESSION rows inside every rendered group to match `order`.
 *
 * WHY THE DOM IS PART OF THIS: DSH renders from the workspace browser's OWN
 * persisted view order (`sessionOrderByAccount` inside `dsh.workspace.view.v5`).
 * Once that key exists for a workspace, the registry account is only used to
 * APPEND sessions it has not seen (`reconciledSessionOrder`), so writing the
 * registry is invisible on its own. The plugin writes both, and moves the rows
 * too, so the visible result does not depend on which of the two the shell
 * reconciles first.
 * @param order - session ids, pinned first in pin order.
 * @param stores - client stores, to resolve each rendered row.
 */
export function orderSessionRowsInGroups(order: readonly string[], stores: RowStores): void {
  const rank = new Map<string, number>()
  order.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index) })

  for (const run of renderedSessionRuns(stores)) {
    if (run.length < 2) continue
    const elements = new Map<string, HTMLElement>()
    const entries: RunEntry[] = []
    run.forEach((element, position) => {
      const resolved = resolveRow(element, stores)
      if (resolved === undefined) return
      const id = String(resolved.id)
      elements.set(id, element)
      entries.push({ id, position, rank: rank.get(id) })
    })
    if (entries.length < 2) continue
    reorderDomRun(elements, sessionRunOrder(entries))
  }
}

/**
 * The registry's order for the ungrouped bucket — which the registry does not
 * account for, so the shell's own rendered order stands in for it.
 * @param stores - client stores, to resolve each rendered row.
 * @returns session ids in rendered order.
 */
export function naturalUngroupedSessions(stores: RowStores): string[] {
  // No DOM means no rendered order to read: the unit suite runs these modules
  // under Node, where the natural order is unknown rather than empty by intent.
  // The action still records the pin, which is what the suite asserts.
  if (typeof document === 'undefined') return []
  const ids: string[] = []
  for (const row of document.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
    const target = resolveRow(row, stores)
    if (target === undefined || target.kind !== 'session' || target.workspaceId !== undefined) continue
    ids.push(target.id)
  }
  return ids
}

/**
 * Hoist the pinned sessions to the front of every rendered group.
 *
 * WHY THIS EXISTS ON TOP OF THE STORES: the sidebar renders from its own
 * persisted view order, and the plugin writes that store when it pins. But the
 * shell also rewrites that store from its own baseline whenever it reconciles,
 * so a written order can be replaced by one reconciled before the write landed —
 * leaving the registry, the view store, and the screen disagreeing. This pass
 * runs after every paint and makes the SCREEN follow the pin list, whatever the
 * two stores currently say. It is the visible invariant; the writes are what
 * make it survive a reload.
 *
 * It never crosses a group boundary: a run of session rows ends at the next
 * non-session row.
 * @param pinned - pinned session ids, in pin order.
 * @param stores - client stores, to resolve each rendered row.
 */
export function hoistPinnedSessions(pinned: readonly string[], stores: RowStores): void {
  if (typeof document === 'undefined' || pinned.length === 0) return
  const rank = new Map<string, number>()
  pinned.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index) })

  for (const run of renderedSessionRuns(stores)) {
    const elements = new Map<string, HTMLElement>()
    const entries: RunEntry[] = []
    run.forEach((element, position) => {
      const resolved = resolveRow(element, stores)
      if (resolved === undefined) return
      const id = String(resolved.id)
      elements.set(id, element)
      entries.push({ id, position, rank: rank.get(id) })
    })
    if (!entries.some(entry => entry.rank !== undefined)) continue
    reorderDomRun(elements, sessionRunOrder(entries))
  }
}

/**
 * The rendered rows, split into continuous runs of session rows.
 *
 * A run ends at the first row that is not a session: group headers, workspace
 * folders, and the ungrouped bucket each break it, so a hoist can never move a
 * session out of the group it belongs to.
 * @param stores - client stores, to resolve each rendered row.
 * @returns one array of elements per run, in document order.
 */
function renderedSessionRuns(stores: RowStores): HTMLElement[][] {
  const runs: HTMLElement[][] = []
  let current: HTMLElement[] = []
  for (const row of document.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
    const target = resolveRow(row, stores)
    if (target !== undefined && target.kind === 'session') {
      current.push(row)
      continue
    }
    if (current.length > 0) runs.push(current)
    current = []
  }
  if (current.length > 0) runs.push(current)
  return runs
}

/** Narrow the client services to the row store face. */
export function storesOf(sessions: ISessions, workspaces: IWorkspaces): RowStores {
  return { sessions, workspaces }
}

export type { RowKind as RowSurface }
