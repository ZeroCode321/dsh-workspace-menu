/**
 * Row actions: everything a menu can offer, built once and filtered by the
 * user's feature flags and by what this Host can actually do.
 *
 * One builder per surface keeps the menu rendering dumb: it receives a list of
 * ready actions and does not know which feature flag or capability produced it.
 * Dialogs are requested through {@link ActionContext.promptName} /
 * {@link RowAction.confirm} rather than built here, so every dialog is a real
 * DSH primitive rendered by the plugin's React root.
 */
import type { ReactNode } from 'react'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from './i18n.js'
import type { RowStores, RowTarget } from './rows-types.js'
import {
  applySessionOrder,
  applyWorkspaceOrder,
  naturalSessions,
  naturalWorkspaces,
  orderWithPins,
  pinFront,
  pinOut,
} from './rows.js'
import type { PreferencesStore } from './state.js'
import { writeShellSessionOrder } from './shell-view-order.js'
import { naturalUngroupedSessions } from './rows.js'

/** Everything an action needs from the plugin's environment. */
export interface ActionContext {
  stores: RowStores
  preferences: PreferencesStore
  /** Copy text to the clipboard; resolves false when the browser refused. */
  copy: (text: string) => Promise<boolean>
  /**
   * Reveal a path in the Host's file manager. Resolves undefined on success and
   * the failure message otherwise, so callers never throw into a React handler.
   */
  reveal: (path: string) => Promise<string | undefined>
  /** Delete a workspace directory through the guarded host route. */
  deleteWorkspaceDirectory: (path: string) => Promise<string | undefined>
  /** Delete one session log through the archive manager. */
  deleteSessionRecord: (sessionId: string) => Promise<string | undefined>
  /** Whether the archive manager answered as loaded (undefined = unknown). */
  archiveManager: boolean | undefined
  /**
   * Ask the Host to compact one session's context.
   *
   * `/compact` is DSH's OWN command (`@deepseek-ai/dsh-command-compact`); this
   * plugin only puts it on the row where the operator is looking, instead of
   * requiring them to open the session and type it.
   */
  compactSession: (sessionId: SessionId) => Promise<string | undefined>
  /** Open a session by id. */
  openSession: (sessionId: SessionId) => void
  /** Start a new session in a workspace. */
  startSession: (workspaceId: WorkspaceId) => void
  /** Refresh both stores after a destructive change. */
  refresh: () => void
  /** Transient banner text. */
  toast: (text: string) => void
  /** Rename a workspace or session through the official API. */
  rename: (target: RowTarget, title: string) => Promise<void>
  /** Sessions still accounted to a workspace, for the delete copy. */
  sessionCount: (workspaceId: string) => number
  /**
   * Apply the operator's top-level row order to the rendered tree.
   *
   * The shell owns the tree, so this is a DOM-ordered replay rather than a
   * registry write: the pin list IS the order, and the rows are moved to match.
   */
  applyGroupOrder: (pinnedGroups: readonly string[]) => void
  /**
   * Move one pinned session to the top of its rendered group.
   *
   * The fallback for a session the registry does not account for (the ungrouped
   * bucket): there is no `workspaceId`, so no `insertSessionBefore` applies, and
   * the pinned row is moved inside the rendered tree instead.
   */
  applySessionPinOrder: (sessionId: SessionId) => void
  /** Reorder the rendered session rows to match the operator's order. */
  applySessionOrder: (order: readonly string[]) => void
  /** Text-input dialog; resolves undefined when dismissed. */
  promptName: (options: { title: string; description: string; initial: string }) => Promise<string | undefined>
  t: Translate
}

/** One ready-to-render menu action. */
export interface RowAction {
  id: string
  label: string
  icon?: ReactNode
  danger?: boolean
  /** Present when the action needs an explicit confirmation before it runs. */
  confirm?: {
    title: string
    body: string
    warning?: string | undefined
    acknowledge: string
    confirm: string
  }
  run: () => void
}

/** Report one failed action uniformly. */
function reportFailure(ctx: ActionContext, action: string, error: unknown): void {
  ctx.toast(ctx.t('toast.failed', { action, message: error instanceof Error ? error.message : String(error) }))
}

/**
 * Build the actions available on a workspace row.
 * @param target - the identified row.
 * @param ctx - environment and stores.
 * @returns the enabled actions in menu order.
 */
export function workspaceActions(target: RowTarget, ctx: ActionContext): RowAction[] {
  const { preferences, t } = ctx
  const workspace = target.workspace
  const pinned = preferences.getSnapshot().pinnedWorkspaces.includes(target.id)
  const actions: RowAction[] = []

  if (preferences.enabled('workspacePin')) {
    actions.push({
      id: 'pin',
      label: pinned ? t('menu.unpin') : t('menu.pin'),
      run: () => {
        const current = preferences.getSnapshot().pinnedWorkspaces
        const next = pinned ? pinOut(current, target.id) : pinFront(current, target.id)
        preferences.replace('pinnedWorkspaces', next)
        const natural = naturalWorkspaces(ctx.stores)
        const ordered = orderWithPins(natural, next)
        ctx.toast(pinned ? t('toast.unpinned') : t('toast.pinned'))
        // The pin list IS the order: unpinning drops the id and the registry
        // order shows through again, so both directions are reversible.
        void applyWorkspaceOrder(ctx.stores, ordered, natural)
          .catch(error => reportFailure(ctx, pinned ? t('menu.unpin') : t('menu.pin'), error))
      },
    })
  }

  if (preferences.enabled('workspaceOpenExplorer') && workspace !== undefined) {
    actions.push({
      id: 'reveal',
      label: t('menu.revealWorkspace'),
      run: () => {
        void ctx.reveal(workspace.path).then((error) => {
          ctx.toast(error === undefined
            ? t('toast.opened')
            : t('toast.failed', { action: t('menu.revealWorkspace'), message: error }))
        })
      },
    })
  }

  if (preferences.enabled('workspaceCopyPath') && workspace !== undefined) {
    actions.push({
      id: 'copy-path',
      label: t('menu.copyPath'),
      run: () => {
        void ctx.copy(workspace.path).then(ok => ctx.toast(ok ? t('toast.pathCopied') : t('toast.copyFailed')))
      },
    })
  }

  if (preferences.enabled('workspaceRename')) {
    actions.push({
      id: 'rename',
      label: t('menu.rename'),
      run: () => {
        void ctx.promptName({
          title: t('dialog.renameWorkspace'),
          description: t('dialog.renameWorkspaceDescription'),
          initial: target.title,
        }).then((name) => {
          if (name === undefined) return
          void ctx.rename(target, name).catch(error => reportFailure(ctx, t('menu.rename'), error))
        })
      },
    })
  }

  if (preferences.enabled('workspaceNewSession')) {
    actions.push({
      id: 'new-session',
      label: t('menu.newSession'),
      run: () => { ctx.startSession(target.id as WorkspaceId) },
    })
  }

  if (preferences.enabled('workspaceDelete')) {
    actions.push({
      id: 'remove',
      label: t('menu.removeWorkspace'),
      danger: true,
      confirm: {
        title: t('dialog.removeWorkspaceTitle'),
        body: t('dialog.removeWorkspaceBody', { title: target.title }),
        acknowledge: t('dialog.acknowledge'),
        confirm: t('dialog.confirmRemove'),
      },
      run: () => {
        void ctx.stores.workspaces.delete(target.id).then(() => {
          const pinnedIds = preferences.getSnapshot().pinnedWorkspaces
          const next = pinOut(pinnedIds, target.id)
          if (next.length !== pinnedIds.length) preferences.replace('pinnedWorkspaces', next)
          ctx.toast(t('toast.workspaceRemoved'))
        }).catch(error => reportFailure(ctx, t('menu.removeWorkspace'), error))
      },
    })
  }

  if (preferences.enabled('workspaceDeleteDisk') && workspace !== undefined) {
    const sessions = ctx.sessionCount(target.id)
    // Two conditions the operator must know before acknowledging: sessions
    // still accounted to this workspace, and whether their logs can be purged
    // at all. Without the archive manager the logs cannot be freed, which the
    // copy states outright instead of leaving the action to fail.
    const logsPending = ctx.archiveManager === false && workspace.sessionIds.length > 0
    const warnings = [
      sessions > 0 ? t('dialog.deleteWorkspaceSessions', { count: sessions }) : undefined,
      logsPending ? t('dialog.deleteWorkspaceLogsPending', { count: workspace.sessionIds.length }) : undefined,
    ].filter((line): line is string => line !== undefined)
    actions.push({
      id: 'delete-disk',
      label: t('menu.deleteWorkspace'),
      danger: true,
      confirm: {
        title: t('dialog.deleteWorkspaceTitle'),
        body: t('dialog.deleteWorkspaceBody', { path: workspace.path }),
        warning: warnings.length === 0 ? undefined : warnings.join('\n\n'),
        acknowledge: t('dialog.acknowledge'),
        confirm: t('dialog.confirmDeleteWorkspace'),
      },
      run: () => {
        void (async () => {
          // Session logs first: the archive manager owns those files. A failure
          // aborts the directory removal, because removing the directory while
          // its logs survive leaves the operator with orphaned records and no
          // directory to explain them.
          const failures: string[] = []
          for (const sessionId of workspace.sessionIds) {
            const error = await ctx.deleteSessionRecord(sessionId)
            if (error !== undefined) failures.push(error)
          }
          if (failures.length > 0) {
            ctx.toast(t('toast.sessionDeletePartial', { message: failures[0] ?? '' }))
            return
          }
          const error = await ctx.deleteWorkspaceDirectory(workspace.path)
          if (error !== undefined) {
            reportFailure(ctx, t('menu.deleteWorkspace'), error)
            return
          }
          await ctx.stores.workspaces.delete(target.id).catch(() => undefined)
          preferences.replace('pinnedWorkspaces', pinOut(preferences.getSnapshot().pinnedWorkspaces, target.id))
          ctx.refresh()
          ctx.toast(t('toast.workspaceDeleted'))
        })()
      },
    })
  }

  return actions
}

/**
 * Build the actions available on a top-level row (a workspace folder or the
 * bucket that owns sessions belonging to no workspace).
 *
 * A group row is a real, visible container: pinning one lifts EVERYTHING under
 * it, which is the only way to order things when the sessions themselves live
 * in folders the shell controls.
 * @param target - the identified row.
 * @param ctx - environment and stores.
 * @returns the enabled actions in menu order.
 */
export function groupActions(target: RowTarget, ctx: ActionContext): RowAction[] {
  const { preferences, t } = ctx
  const key = target.groupKey ?? ''
  const pinned = preferences.getSnapshot().pinnedGroups.includes(key)
  const actions: RowAction[] = []

  if (preferences.enabled('groupPin')) {
    actions.push({
      id: 'pin-group',
      label: pinned ? t('menu.unpin') : t('menu.pin'),
      run: () => {
        const current = preferences.getSnapshot().pinnedGroups
        const next = pinned ? pinOut(current, key) : pinFront(current, key)
        preferences.replace('pinnedGroups', next)
        ctx.toast(pinned ? t('toast.unpinned') : t('toast.pinned'))
        // The shell orders the tree itself, so the new order is applied to the
        // rendered top-level rows.
        ctx.applyGroupOrder(next)
      },
    })
  }

  actions.push({
    id: 'copy-group-title',
    label: t('menu.copyGroupTitle'),
    run: () => {
      void ctx.copy(target.title).then(ok => ctx.toast(ok ? t('toast.titleCopied') : t('toast.copyFailed')))
    },
  })

  return actions
}

/**
 * Build the actions available on a session row.
 * @param target - the identified row.
 * @param ctx - environment and stores.
 * @returns the enabled actions in menu order.
 */
export function sessionActions(target: RowTarget, ctx: ActionContext): RowAction[] {
  const { preferences, t } = ctx
  const session = target.session
  const snapshot = preferences.getSnapshot()
  const pinned = snapshot.pinnedSessions.includes(target.id)
  const unread = snapshot.unreadSessions.includes(target.id)
  const workspaceId = target.workspaceId
  const actions: RowAction[] = []

  if (preferences.enabled('sessionPin')) {
    actions.push({
      id: 'pin',
      label: pinned ? t('menu.unpin') : t('menu.pin'),
      run: () => {
        const current = preferences.getSnapshot().pinnedSessions
        const next = pinned ? pinOut(current, target.id) : pinFront(current, target.id)
        preferences.replace('pinnedSessions', next)
        // Plain confirmation now. The old branch warned that the sidebar's
        // "Last updated" mode would recompute the order away — true of the
        // stores, but the painter re-asserts the pin on the screen in every
        // ordering mode (see `painter.ts`), so the warning had become a claim
        // about a limitation the plugin no longer has.
        ctx.toast(pinned ? t('toast.unpinned') : t('toast.pinned'))
        if (workspaceId !== undefined) {
          const natural = naturalSessions(ctx.stores, workspaceId)
          const ordered = orderWithPins(natural, next)
          // Both stores, then the rows. The registry account is what the Host
          // serves; the browser's own view order is what it RENDERS from
          // (`reconciledSessionOrder` prefers it whenever it exists). Writing
          // only one of them leaves the visible order wrong.
          writeShellSessionOrder(workspaceId, ordered, natural)
          void applySessionOrder(ctx.stores, workspaceId, ordered, natural)
            .catch(error => reportFailure(ctx, pinned ? t('menu.unpin') : t('menu.pin'), error))
        } else {
          // A session in the ungrouped bucket belongs to no Workspace, so there
          // is no registry account to reorder; its order lives in the shell's own
          // view store and the rendered tree. Without this branch a pin there
          // drew a marker and moved nothing, which reads as "pinning is broken".
          const naturalFree = naturalUngroupedSessions(ctx.stores)
          const orderedFree = orderWithPins(naturalFree, next)
          writeShellSessionOrder('', orderedFree, naturalFree)
          ctx.applySessionOrder(orderedFree)
        }
      },
    })
  }

  if (preferences.enabled('sessionUnread')) {
    actions.push({
      id: 'unread',
      label: unread ? t('menu.markRead') : t('menu.markUnread'),
      run: () => {
        preferences.toggle('unreadSessions', target.id)
        ctx.toast(unread ? t('toast.markedRead') : t('toast.markedUnread'))
      },
    })
  }

  if (preferences.enabled('sessionRename')) {
    actions.push({
      id: 'rename',
      label: t('menu.rename'),
      run: () => {
        void ctx.promptName({
          title: t('dialog.renameSession'),
          description: t('dialog.renameSessionDescription'),
          initial: target.title,
        }).then((name) => {
          if (name === undefined) return
          void ctx.rename(target, name).catch(error => reportFailure(ctx, t('menu.rename'), error))
        })
      },
    })
  }

  if (preferences.enabled('sessionArchive')) {
    actions.push({
      id: 'archive',
      label: t('menu.archive'),
      run: () => {
        void ctx.stores.workspaces.archiveSession(target.id)
          .then(() => { ctx.toast(t('menu.archive')) })
          .catch(error => reportFailure(ctx, t('menu.archive'), error))
      },
    })
  }

  if (preferences.enabled('sessionCompact')) {
    actions.push({
      id: 'compact',
      label: t('menu.compact'),
      run: () => {
        void ctx.compactSession(target.id as SessionId).then((error) => {
          if (error !== undefined) {
            reportFailure(ctx, t('menu.compact'), error)
            return
          }
          ctx.toast(t('toast.compacted'))
          ctx.refresh()
        })
      },
    })
  }

  if (preferences.enabled('sessionFork')) {
    actions.push({
      id: 'fork',
      label: t('menu.fork'),
      run: () => {
        void ctx.stores.sessions.fork({ sessionId: target.id, increaseTitle: true })
          .then((childId) => { ctx.openSession(childId) })
          .catch(error => reportFailure(ctx, t('menu.fork'), error))
      },
    })
  }

  if (preferences.enabled('sessionCopyLink')) {
    actions.push({
      id: 'copy-link',
      label: t('menu.copyLink'),
      run: () => {
        void ctx.copy(deepLink(target.id)).then(ok => ctx.toast(ok ? t('toast.linkCopied') : t('toast.copyFailed')))
      },
    })
  }

  if (preferences.enabled('sessionCopyTitle')) {
    actions.push({
      id: 'copy-title',
      label: t('menu.copyTitle'),
      run: () => {
        void ctx.copy(target.title).then(ok => ctx.toast(ok ? t('toast.titleCopied') : t('toast.copyFailed')))
      },
    })
  }

  if (preferences.enabled('sessionOpenWindow')) {
    actions.push({
      id: 'open-window',
      label: t('menu.openWindow'),
      run: () => {
        // The link goes to the clipboard alongside the window: opening a second
        // window onto the session you are already looking at is only useful if
        // the URL itself is the point (sending it on), so the action hands it
        // over instead of leaving the operator to copy it separately.
        void ctx.copy(deepLink(target.id))
        window.open(deepLink(target.id), '_blank')
      },
    })
  }

  const cwd = session?.cwd
  if (preferences.enabled('sessionOpenFolder') && cwd !== undefined) {
    actions.push({
      id: 'reveal',
      label: t('menu.revealSession'),
      run: () => {
        void ctx.reveal(cwd).then((error) => {
          ctx.toast(error === undefined
            ? t('toast.opened')
            : t('toast.failed', { action: t('menu.revealSession'), message: error }))
        })
      },
    })
  }

  if (preferences.enabled('sessionDelete')) {
    actions.push({
      id: 'delete',
      label: t('menu.deleteSession'),
      danger: true,
      confirm: {
        title: t('dialog.deleteSessionTitle'),
        body: t('dialog.deleteSessionBody', { title: target.title }),
        warning: ctx.archiveManager === false ? t('dialog.archiveManagerMissing') : undefined,
        acknowledge: t('dialog.acknowledge'),
        confirm: t('dialog.confirmDeleteSession'),
      },
      run: () => {
        void ctx.deleteSessionRecord(target.id).then((error) => {
          if (error !== undefined) {
            reportFailure(ctx, t('menu.deleteSession'), error)
            return
          }
          preferences.replace('pinnedSessions', pinOut(preferences.getSnapshot().pinnedSessions, target.id))
          ctx.refresh()
          ctx.toast(t('toast.sessionDeleted'))
        })
      },
    })
  }

  return actions
}

/** Deep link opening one session in a fresh or separate window. */
export function deepLink(sessionId: string): string {
  const url = new URL(window.location.href)
  url.searchParams.set('session', sessionId)
  return url.toString()
}
