/**
 * Incremental row painting.
 *
 * The previous implementation re-scanned every `[role="treeitem"]` on every DOM
 * mutation and walked each node's fiber chain — work proportional to the whole
 * sidebar, repeated for every streamed token. This painter inverts that: a
 * mutation only marks the rows it plausibly touched (its target's row, plus any
 * rows inside added subtrees), and one animation frame coalesces the batch. A
 * full sweep remains available for the cases that genuinely need it (first
 * paint, a store refresh, a closed menu).
 */
import { findRow, hoistPinnedSessions, paintRow, resolveRow, type RowFlags, type RowStores } from './rows.js'
import type { PreferencesStore } from './state.js'

/** Cap on rows probed inside one added subtree, so one huge insert cannot stall a frame. */
const MAX_PROBED_ROWS_PER_MUTATION = 400

/** Live painter bound to one plugin activation. */
export interface RowPainter {
  /** Mark one row dirty (and its subtree, when rows can nest). */
  touch: (node: Node) => void
  /** Re-paint every row currently in the document. */
  sweep: () => void
  /** Observe the sidebar and paint on change. */
  start: () => void
  /** Stop observing and cancel pending frames. */
  dispose: () => void
}

/**
 * Create a row painter.
 * @param stores - client stores used to resolve a row's identity.
 * @param preferences - the preference store whose lists drive the flags.
 * @returns the painter.
 */
export function createRowPainter(stores: RowStores, preferences: PreferencesStore): RowPainter {
  const dirty = new Set<Element>()
  let frame = 0
  let observer: MutationObserver | undefined
  let fullSweepPending = false
  /** Rows painted since the last hoist, so idle churn does not reorder. */
  let paintedRows = 0
  /** Last pin list the rows were reconciled against. */
  let lastPinnedSignature = ''
  // Maps a painted row to the flags it currently carries, so an unchanged row
  // costs no DOM write at all.
  const painted = new WeakMap<Element, string>()

  const flagsFor = (kind: 'workspace' | 'session' | 'group', id: string, groupKey: string): RowFlags => {
    const snapshot = preferences.getSnapshot()
    // A top-level row is pinned through the group list, so a workspace folder
    // and the ungrouped bucket share one order and can never disagree about
    // which of them is lifted.
    const pinned = kind === 'session'
      ? snapshot.pinnedSessions.includes(id)
      : snapshot.pinnedGroups.includes(groupKey)
    return {
      kind,
      id,
      pinned,
      unread: kind === 'session' && snapshot.unreadSessions.includes(id),
    }
  }

  const paint = (row: Element): void => {
    const target = resolveRow(row as HTMLElement, stores)
    if (target === undefined) {
      if (painted.has(row)) {
        paintRow(row as HTMLElement, undefined)
        painted.delete(row)
      }
      return
    }
    const flags = flagsFor(target.kind, target.id, target.groupKey ?? target.id)
    const signature = `${flags.kind}:${flags.id}:${flags.pinned ? 1 : 0}:${flags.unread ? 1 : 0}`
    if (painted.get(row) === signature) return
    painted.set(row, signature)
    paintRow(row as HTMLElement, flags)
  }

  const flush = (): void => {
    frame = 0
    if (fullSweepPending) {
      fullSweepPending = false
      dirty.clear()
      for (const row of document.querySelectorAll('[role="treeitem"]')) paint(row)
      paintedRows = dirty.size + 1
    } else {
      const rows = [...dirty]
      dirty.clear()
      for (const row of rows) {
        if (!row.isConnected) continue
        paint(row)
        paintedRows += 1
      }
    }
    // After the marks, the invariant they advertise: a pinned row sits where it
    // says it does. The stores are written on the action, but the shell also
    // rewrites its own view order from its baseline, so the SCREEN is reconciled
    // here rather than assumed to follow.
    //
    // WHY THERE IS NO ORDER-MODE GATE ANY MORE: this used to bail out unless the
    // sidebar was in its manual sorting mode, on the theory that hoisting while
    // the shell sorts by "Last updated" would fight its reconciliation. Measured
    // against a live GUI, that gate was the whole bug: the default mode is
    // "updated", so `shellUsesManualOrder()` was false, the hoist never ran, and
    // a pin drew its marker and moved NOTHING — the order stayed exactly as the
    // sort produced it. `orderWithPins` and the store writes were dead code on
    // the default configuration. Re-asserting the pin is not a fight the shell
    // wins by default; it is the visible form of what the operator asked for, and
    // a moved row is itself a mutation, so the loop reconciles instead of
    // spinning: once the pinned row leads its run, the next pass has nothing left
    // to move.
    const pinned = preferences.getSnapshot().pinnedSessions
    const signature = pinned.join('|')
    if (paintedRows > 0 || signature !== lastPinnedSignature) {
      paintedRows = 0
      lastPinnedSignature = signature
      hoistPinnedSessions(pinned, stores)
    }
  }

  const schedule = (): void => {
    if (frame !== 0) return
    frame = window.requestAnimationFrame(flush)
  }

  const touch = (node: Node): void => {
    const element = node instanceof Element ? node : node.parentElement
    if (element === null || element === undefined) return
    const row = findRow(element)
    if (row !== undefined) dirty.add(row)
    if (!(node instanceof Element)) return
    // A subtree insert can carry rows that are not the row itself (a group
    // re-render); probing only within the inserted subtree keeps that bounded.
    const nested = node.querySelectorAll('[role="treeitem"]')
    let probed = 0
    for (const candidate of nested) {
      if (probed >= MAX_PROBED_ROWS_PER_MUTATION) break
      probed += 1
      dirty.add(candidate)
    }
    if (nested.length > 0) schedule()
  }

  const sweep = (): void => {
    fullSweepPending = true
    schedule()
  }

  const onMutations = (records: readonly MutationRecord[]): void => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const added of record.addedNodes) touch(added)
        for (const removed of record.removedNodes) {
          // A removed row leaves the WeakMap on its own; nothing to do until it
          // (or a recycled node) comes back with a fresh mutation.
          void removed
        }
        continue
      }
      touch(record.target)
    }
  }

  return {
    touch,
    sweep,
    start: () => {
      if (observer !== undefined || document.body === null) return
      observer = new MutationObserver((records) => { onMutations(records) })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      sweep()
    },
    dispose: () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      frame = 0
      dirty.clear()
      observer?.disconnect()
      observer = undefined
    },
  }
}
