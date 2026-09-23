/**
 * @dsh-external/dsh-workspace-menu — client half.
 *
 * Enhances the sidebar's workspace and session rows with the management actions
 * DSH's own row menu does not carry: pin, unread, copy path/link/title, reveal
 * in the file manager, open in a new window, and guarded deletion. The plugin
 * adds no menu implementation of its own: the actions render through DSH's
 * `Menu` primitive and every dialog through DSH's `Modal` /
 * `RiskConfirmation` primitives, so the surface behaves like shipped UI.
 *
 * Three things are deliberately delegated rather than reimplemented:
 * - row identity -> the props React put on the row's fiber (DSH ships no
 *   row-level slot), resolved against the official session/workspace stores;
 * - durable preferences -> the Host's `workspace-menu` settings namespace;
 * - permanent session-log deletion -> `@mlgbnb/dsh-archive-manager`.
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from 'cordis'
import type {
  ISessions,
  IWorkspaces,
  SessionId,
  WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.general.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { FEATURE_GROUPS, type FeatureKey } from '../features.js'
import { groupActions, sessionActions, workspaceActions, type ActionContext, type RowAction } from './actions.js'
import {
  deleteSessionRecord,
  deleteWorkspaceDirectory,
  fetchCapabilities,
  revealInFileManager,
  type HostCapabilities,
} from './api.js'
import { featureLabel, groupTitle, installLocale, type LocaleLike, type Translate } from './i18n.js'
import { RowMenuHost, type MenuHostHandle } from './menu.js'
import { createRowPainter } from './painter.js'
import { applyGroupOrderToDom, findRow, orderSessionRowsInGroups, renderedGroupOrder, resolveRow, storesOf, UnresolvedRowWatch, type RowStores, type RowTarget } from './rows.js'
import { createPreferencesTransport, PreferencesStore, type HostScope } from './state.js'

/** Stable plugin id, used for effect labels and the settings row id. */
const PLUGIN_ID = '@dsh-external/dsh-workspace-menu'

/** Settings namespace owned by the host half. */
const SETTINGS_NAMESPACE = 'workspace-menu'

/** Host container for the plugin's React root. */
const ROOT_ID = 'dsh-workspace-menu-root'

/**
 * Build marker shown in the settings row.
 *
 * Several rounds were spent unable to tell "the browser is running an older
 * module" from "the current module is broken", because both look identical from
 * the Host side. A visible marker ends that: the row states exactly which build
 * is live.
 */
const BUILD_TAG = 'v9-hardening'

/**
 * Services this plugin requires.
 *
 * `remote.commands` is listed because the compact action reaches the command
 * plane: cordis enforces `inject` on PROPERTY ACCESS, so `ctx.remote.commands`
 * (and equally `ctx.get('remote').commands`) throws
 * `cannot get property "remote.commands" without inject` unless the key is
 * declared here. `ctx.get` is not an escape hatch from that check.
 */
export const inject = [
  'slots', 'sessions', 'workspaces', 'settingsScope', 'connection', 'remote', 'remote.commands', 'locale',
]

/**
 * The slice of the slot registry this plugin registers into. Declared
 * structurally instead of imported: the registry service's class type belongs
 * to the renderer's internals, while `inject`/`register` are its published
 * shape (the pattern other feature packages use at their registration sites).
 */
interface SlotsLike {
  /**
   * Register `callback` to run only while the slot exists. The real service
   * returns a disposer as well; this plugin lets the plugin fiber own that
   * release, so the return value is deliberately not part of the contract here.
   */
  inject(key: string, callback: () => void): void
  register(options: { name: string; id?: string; order?: number }, component: unknown): unknown
}

/** The client context face this plugin consumes. */
type ClientContext = Context & {
  slots: SlotsLike
  sessions: ISessions
  workspaces: IWorkspaces
  settingsScope: { bind<T>(spec: { namespace: string }): HostScope }
  locale: LocaleLike & { getLocale(): { active: string } }
  /** Emit/listen on the cordis event bus (present on every live context). */
  on?: (name: string, listener: (...args: unknown[]) => void) => () => void
  /**
   * Read one service by name without declaring it in `inject`.
   *
   * The command plane is needed only for the `/compact` action, and this plugin
   * must not require it: a composition without it should still load and offer
   * every other action.
   */
  get?: (name: string) => unknown
}

/** Mounted React root plus the imperative handle its callbacks use. */
interface RootHost {
  render: (version: number) => void
  handle: () => MenuHostHandle | undefined
  dispose: () => void
}

/**
 * Mount the plugin's React root once per activation.
 * @param t - translation seat.
 * @returns the mounted host.
 */
function mountRoot(t: Translate): RootHost {
  const container = document.createElement('div')
  container.id = ROOT_ID
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  let handle: MenuHostHandle | undefined
  return {
    render: (version) => {
      root.render(createElement(RowMenuHost, {
        t,
        preferencesVersion: version,
        onReady: (next) => { handle = next },
      }))
    },
    handle: () => handle,
    dispose: () => {
      root.unmount()
      container.remove()
    },
  }
}

/** One switch row, following the General section's own row rhythm. */
function Toggle({ label, checked, onChange }: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}): ReactNode {
  return createElement(
    'label',
    {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        minHeight: 36, fontSize: 13, lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
      },
    },
    createElement('span', null, label),
    createElement('input', {
      type: 'checkbox',
      checked,
      'aria-label': label,
      onChange: (event) => { onChange(event.currentTarget.checked) },
    }),
  )
}

/** Hints the settings row shows under its header. */
function statusLines(preferences: PreferencesStore, host: HostCapabilities | undefined, t: Translate): string[] {
  const lines: string[] = []
  const status = preferences.status
  if (status === 'loading') lines.push(t('settings.statusLoading'))
  if (status === 'memory') lines.push(t('settings.statusMemory'))
  if (status === 'unavailable') lines.push(t('settings.statusUnavailable'))
  if (host?.archiveManager === false) lines.push(t('settings.archiveMissing'))
  // Always shown: which build is live and which store it is using are the two
  // facts an operator cannot infer from the UI, and both turn a support
  // round-trip into a screenshot.
  lines.push(t('settings.transport', { transport: BUILD_TAG + ' | ' + preferences.describeTransport() }))
  return lines
}

/**
 * Build the General-settings row for this plugin: one collapsible block with a
 * switch per feature, grouped exactly as the catalog declares them.
 * @param preferences - preference store.
 * @param locale - reads the active locale id at render time.
 * @param capabilities - reads the Host's capability report.
 * @param t - translation seat.
 * @returns the row component.
 */
function createSettingsRow(
  preferences: PreferencesStore,
  locale: () => string,
  capabilities: () => HostCapabilities | undefined,
  t: Translate,
): () => ReactNode {
  return function SettingsRow(): ReactNode {
    const [version, setVersion] = useState(0)
    const [open, setOpen] = useState(false)
    // Subscribing in an effect (not while rendering) keeps the render phase
    // pure and drops the subscription together with the component.
    useEffect(() => preferences.subscribe(() => { setVersion(candidate => candidate + 1) }), [preferences])
    void version
    const snapshot = preferences.getSnapshot()
    const hints = statusLines(preferences, capabilities(), t)

    return createElement(
      'div',
      { style: { width: '100%', boxSizing: 'border-box' } },
      createElement(
        'button',
        {
          type: 'button',
          'aria-expanded': open,
          onClick: () => { setOpen(!open) },
          style: {
            display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
            padding: '16px 0', border: 'none', borderBottom: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent', cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left',
          },
        },
        createElement(
          'span',
          { style: { display: 'flex', flexDirection: 'column', flex: 1, gap: 4, minWidth: 0 } },
          createElement('span', {
            style: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
          }, t('settings.title')),
          createElement('span', {
            style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
          }, t('settings.description')),
        ),
        createElement('span', {
          'aria-hidden': true,
          style: {
            color: 'var(--dsw-alias-label-tertiary)',
            transition: 'transform .16s ease',
            transform: open ? 'rotate(180deg)' : 'none',
          },
        }, 'v'),
      ),
      open && createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0 16px' } },
        ...hints.map((line, index) => createElement('p', {
          key: `hint-${index}`,
          style: {
            margin: '4px 0',
            fontSize: 12,
            lineHeight: '18px',
            color: 'var(--dsw-alias-state-warn-primary)',
          },
        }, line)),
        ...FEATURE_GROUPS.map((group, groupIndex) => createElement(
          'div',
          { key: group.titleZh },
          createElement('div', {
            style: {
              padding: '12px 0 2px', fontSize: 12, fontWeight: 600, lineHeight: '18px',
              color: 'var(--dsw-alias-label-tertiary)', textTransform: 'uppercase', letterSpacing: '.04em',
            },
          }, groupTitle(groupIndex, locale())),
          ...group.items.map(feature => createElement(Toggle, {
            key: feature.key,
            label: featureLabel(feature.key, locale()),
            checked: snapshot.features[feature.key] !== false,
            onChange: (next: boolean) => { preferences.setFeature(feature.key, next) },
          })),
          createElement(
            'button',
            {
              type: 'button',
              onClick: () => {
                preferences.resetFeatures(group.items.map(feature => feature.key) as FeatureKey[])
              },
              style: {
                alignSelf: 'flex-start', marginTop: 6, padding: 0, border: 'none', background: 'transparent',
                color: 'var(--dsw-alias-label-tertiary)', font: 'inherit', fontSize: 12,
                cursor: 'pointer', textDecoration: 'underline',
              },
            },
            t('settings.resetGroup'),
          ),
        )),
      ),
    )
  }
}

/**
 * Open a session named by `?session=<id>`, waiting for the list to carry it.
 *
 * The retry loop only advances while the document is visible, so a background
 * tab costs nothing, and it stops at the first successful open.
 * @param ctx - client context.
 * @returns the disposer.
 */
function handleDeepLink(ctx: ClientContext): () => void {
  const target = new URLSearchParams(window.location.search).get('session')
  if (target === null || target === '') return () => undefined
  let attempts = 0
  let timer = 0
  const stop = (): void => {
    if (timer !== 0) window.clearInterval(timer)
    timer = 0
  }
  const tick = (): void => {
    if (document.visibilityState !== 'visible') return
    attempts += 1
    if (ctx.sessions.list.getSnapshot().byId[target] !== undefined) {
      stop()
      ctx.sessions.open(target)
      return
    }
    if (attempts >= 30) {
      // One last look before giving up: the list may have settled after the
      // final poll, and opening a session the store just gained is correct.
      stop()
      if (ctx.sessions.list.getSnapshot().byId[target] !== undefined) ctx.sessions.open(target)
    }
  }
  timer = window.setInterval(tick, 250)
  document.addEventListener('visibilitychange', tick)
  return () => {
    stop()
    document.removeEventListener('visibilitychange', tick)
  }
}

/**
 * The one stylesheet this plugin injects.
 *
 * Only row tints: every control it offers is a shell component, which carries
 * its own styles. The tints key on the attributes the painter writes, so a
 * pinned row is findable by scanning the list rather than by spotting a 14px
 * glyph — two rounds of "it works but you cannot see it" made that the point.
 * @returns a disposer removing the stylesheet.
 */
function injectRowStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.dshWorkspaceMenu = 'row-tints'
  style.textContent = `
    [role="treeitem"][data-dsh-tint="pinned"],
    [role="treeitem"][data-dsh-tint="both"] {
      background-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);
      border-radius: 8px;
    }
    [role="treeitem"][data-dsh-tint="unread"] {
      background-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
      border-radius: 8px;
    }
    [role="treeitem"][data-dsh-tint="pinned"]:hover,
    [role="treeitem"][data-dsh-tint="both"]:hover {
      background-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);
    }
    [role="treeitem"][data-dsh-tint="unread"]:hover {
      background-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);
    }
  `
  document.head.appendChild(style)
  return () => stripeRemove(style)
}

/** Remove one node, tolerating a head that was already torn down. */
function stripeRemove(node: HTMLElement): void {
  node.remove()
}

/**
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const stores: RowStores = storesOf(ctx.sessions, ctx.workspaces)
  const { t, dispose: disposeLocale } = installLocale(ctx.locale)
  let locale = ctx.locale?.getLocale?.().active ?? 'zh'
  let capabilities: HostCapabilities | undefined

  // One store instance for the whole activation: every subscriber below holds a
  // reference to this object, so the scope is adopted into it rather than
  // rebuilt around it.
  const preferences = new PreferencesStore()
  let host: RootHost | undefined

  const buildActions = (target: RowTarget, menuHost: MenuHostHandle): RowAction[] => {
    const environment: ActionContext = {
      stores,
      preferences,
      copy: writeClipboard,
      reveal: revealInFileManager,
      deleteWorkspaceDirectory,
      deleteSessionRecord,
      archiveManager: capabilities?.archiveManager,
      applyGroupOrder: (pinnedGroups: readonly string[]) => {
        // Pinned keys first, in pin order; every other rendered row keeps the
        // shell's own order after them.
        const rendered = renderedGroupOrder(stores)
        const pinned = pinnedGroups.filter(key => rendered.includes(key))
        const rest = rendered.filter(key => !pinned.includes(key))
        applyGroupOrderToDom([...pinned, ...rest], stores)
      },
      applySessionPinOrder: (sessionId: SessionId) => {
        // Recompute from the pin list rather than from the one id: the list IS
        // the order, so it is the only input that produces it.
        orderSessionRowsInGroups(preferences.getSnapshot().pinnedSessions, stores)
      },
      applySessionOrder: (order: readonly string[]) => {
        orderSessionRowsInGroups(order, stores)
      },
      compactSession: async (sessionId: SessionId) => {
        // The Host owns `/compact`; the browser reaches it through the command
        // RPC, addressed to the SESSION so the operator never has to open it.
        //
        // `remote.commands` is in this plugin's `inject` (see the note there):
        // cordis enforces inject on property access, so reaching the command
        // plane without that key throws before any call is made. Reading the
        // service through `ctx.get` does NOT bypass the check.
        const remote = ctx.get?.('remote') as {
          commands?: { execute(sessionId: string, line: string): Promise<{ ok: boolean; error?: { code?: string; message?: string } }> }
        } | undefined
        const commands = remote?.commands
        if (commands === undefined || typeof commands.execute !== 'function') {
          return 'command plane unavailable'
        }
        try {
          const result = await commands.execute(sessionId, '/compact')
          if (result.ok) return undefined
          return result.error?.message ?? result.error?.code ?? 'command failed'
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      openSession: (sessionId: SessionId) => { ctx.sessions.open(sessionId) },
      startSession: (workspaceId: WorkspaceId) => { ctx.workspaces.startSession(workspaceId) },
      // Both domains refresh themselves from the Host's change frames, so a
      // destructive action needs no manual reload: the post-condition of every
      // call above is already a fresh list snapshot.
      refresh: () => undefined,
      toast: menuHost.toast,
      rename: async (rowTarget: RowTarget, title: string) => {
        if (rowTarget.kind === 'workspace') {
          await ctx.workspaces.rename(rowTarget.id, title)
          return
        }
        const binding = ctx.sessions.binding(rowTarget.id)
        if (binding === undefined) throw new Error('session binding unavailable')
        const result = await binding.session.rename(title)
        if (!result.ok) throw new Error(result.error.message)
      },
      sessionCount: (workspaceId: string) => {
        const workspace = ctx.workspaces.list.getSnapshot().items
          .find(candidate => candidate.workspaceId === workspaceId)
        // The count is what the plugin can verify: the sessions this workspace
        // still accounts for. Archived-but-unarchived bookkeeping is not
        // readable from the client's public surface, so the copy claims only
        // this number.
        return workspace === undefined ? 0 : workspace.sessionIds.length
      },
      promptName: (options) => menuHost.promptName(options),
      t,
    }
    // A top-level row is a project folder or the ungrouped bucket: it gets the
    // group actions (pin the container, copy its name), not the workspace-menu
    // actions that address a registry workspace.
    if (target.kind === 'group') return groupActions(target, environment)
    return target.kind === 'workspace'
      ? workspaceActions(target, environment)
      : sessionActions(target, environment)
  }

  // Durable preferences. The plugin's own Host route is the transport that
  // actually works for a plugin outside DSH's tree; the settings scope is
  // preferred only when it answers, because a deployment that exposes the
  // namespace (or a DSH that stops allowlisting settings namespaces) makes it
  // the better home. Adopting order matters: the file transport is installed
  // first, and every step is guarded, because an exception thrown before the
  // first adoption would leave the store permanently scope-less — which reads
  // to the operator as "this Host has no preference store" even though the
  // route is answering.
  ctx.effect(() => {
    // Sentinel first: every install outcome below overwrites it, so whatever
    // the row ends up showing is either a real reason or the proof that this
    // callback never ran. That is precisely the difference the last rounds
    // could not observe from outside the browser.
    preferences.noteInstallFailure('effect did not run')
    let fileScope: HostScope | undefined
    try {
      fileScope = createPreferencesTransport(undefined, (reason) => {
        preferences.noteInstallFailure(reason)
      })
      preferences.adoptScope(fileScope, 'host-route')
    } catch (error) {
      preferences.noteInstallFailure(error instanceof Error ? error.message : String(error))
    }

    let unsubscribe: (() => void) | undefined
    try {
      const settings = ctx.settingsScope.bind<Record<string, unknown>>({ namespace: SETTINGS_NAMESPACE })
      // Only a settings scope that has actually ACCEPTED its namespace may
      // displace the file transport. A scope starts at `loading`, and treating
      // "not unavailable yet" as "usable" let a namespace DSH will never expose
      // take the slot and then report itself unavailable — which is exactly how
      // a working Host route looked broken from the settings row.
      const consider = (): void => {
        if (settings.getSnapshot().status === 'ready') preferences.adoptScope(settings, 'settings-namespace')
      }
      unsubscribe = settings.subscribe(consider)
      consider()
    } catch (error) {
      console.warn('[dsh-workspace-menu] settings scope unavailable', error)
    }

    if (fileScope === undefined && preferences.installFailure === 'effect did not run') {
      // The sentinel survived, so the constructor reported nothing and installed
      // nothing: say exactly that instead of pretending to know why.
      preferences.noteInstallFailure('no transport was installed')
    }

    return () => {
      unsubscribe?.()
      preferences.adoptScope(undefined, 'none')
    }
  }, `${PLUGIN_ID}: preferences`)

  // One stylesheet for the plugin's lifetime, injected before the first paint.
  ctx.effect(() => injectRowStyles(), `${PLUGIN_ID}: row tints`)

  ctx.effect(() => () => { disposeLocale() }, `${PLUGIN_ID}: locale dictionaries`)

  ctx.effect(() => {
    void fetchCapabilities().then((value) => { capabilities = value })
    const off = ctx.on?.('locale/change', () => {
      locale = ctx.locale?.getLocale?.().active ?? 'zh'
      host?.render(Date.now())
    })
    return () => { off?.() }
  }, `${PLUGIN_ID}: capabilities and locale`)

  ctx.effect(() => {
    if (document.body === null) return () => undefined
    host = mountRoot(t)
    let version = 0
    const unsubscribe = preferences.subscribe(() => {
      version += 1
      host?.render(version)
    })
    return () => {
      unsubscribe()
      host?.dispose()
      host = undefined
    }
  }, `${PLUGIN_ID}: react root`)

  ctx.effect(() => {
    const painter = createRowPainter(stores, preferences)
    const unsubscribe = preferences.subscribe(() => { painter.sweep() })
    painter.start()
    return () => {
      unsubscribe()
      painter.dispose()
    }
  }, `${PLUGIN_ID}: row rails`)

  ctx.effect(() => {
    // The fiber walk is the one dependency on DSH's internal structure, and it
    // fails silently when that structure moves. The watch reports a run of
    // failures once, so a broken menu is not mistaken for a broken mouse.
    const unresolved = new UnresolvedRowWatch()
    const onRowEvent = (event: MouseEvent): void => {
      if (event.type === 'dblclick' && !preferences.enabled('dblclick')) return
      if (event.type === 'contextmenu' && !preferences.enabled('contextmenu')) return
      const row = findRow(event.target)
      if (row === undefined) return
      const target = resolveRow(row, stores)
      if (target === undefined) {
        if (unresolved.record()) {
          host?.handle()?.toast(t('toast.rowUnidentified', { count: 3 }))
        }
        return
      }
      unresolved.reset()
      event.preventDefault()
      event.stopPropagation()
      const menuHost = host?.handle()
      if (menuHost === undefined) return
      const actions = buildActions(target, menuHost)
      if (actions.length === 0) return
      menuHost.open({ x: event.clientX, y: event.clientY, actions })
    }
    document.addEventListener('dblclick', onRowEvent, true)
    document.addEventListener('contextmenu', onRowEvent, true)
    return () => {
      document.removeEventListener('dblclick', onRowEvent, true)
      document.removeEventListener('contextmenu', onRowEvent, true)
    }
  }, `${PLUGIN_ID}: row menu`)

  ctx.effect(() => handleDeepLink(ctx), `${PLUGIN_ID}: deep link`)

  ctx.effect(
    () => {
      ctx.slots.inject('settings.general.item', () => {
        ctx.slots.register(
          { name: 'settings.general.item', id: PLUGIN_ID, order: 200 },
          createSettingsRow(preferences, () => locale, () => capabilities, t),
        )
      })
    },
    `${PLUGIN_ID}: settings row`,
  )
}