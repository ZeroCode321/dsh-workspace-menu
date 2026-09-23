/**
 * The plugin's React root: the row menu, its confirmation dialogs, and the
 * rename prompt.
 *
 * Rendering goes through DSH's own primitives (`Menu`, `Modal`,
 * `RiskConfirmation`, `Button`, `Toast`), which is what makes the surface
 * visually and behaviorally part of the shipped UI instead of a look-alike:
 * the menu card, its icons, its hover fills, its outside-click/Escape closing,
 * and its viewport clamping are the same code the built-in row menu uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconArchiveOutline20,
  IconBranchOutline16,
  IconBrowseOutline16,
  IconCopyOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconDataOutline16,
  IconEnhanceOutline16,
  IconFollowsystemOutline16,
  IconFullscreenOutline16,
  IconPlusOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
  Input,
  Modal,
  Menu,
  RiskConfirmation,
  Toast,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RowAction } from './actions.js'
import type { Translate } from './i18n.js'

/** Icon key resolved per action, so the catalog stays free of JSX. */
const ACTION_ICONS: Record<string, ReactNode> = {
  pin: <IconEnhanceOutline16 />,
  reveal: <IconBrowseOutline16 />,
  'copy-path': <IconCopyOutline16 />,
  rename: <IconEditOutline16 />,
  'new-session': <IconPlusOutline16 />,
  remove: <IconTrashOutline16 />,
  'delete-disk': <IconTrashOutline16 />,
  unread: <IconFollowsystemOutline16 />,
  archive: <IconArchiveOutline20 size={16} />,
  compact: <IconDataOutline16 />,
  fork: <IconBranchOutline16 />,
  'copy-link': <IconCopyOutline16 />,
  'copy-title': <IconCopyOutline16 />,
  'open-window': <IconFullscreenOutline16 />,
  delete: <IconTrashOutline16 />,
}

/** One open-menu request: the actions plus where the menu should appear. */
export interface MenuRequest {
  /** Pointer coordinates, in viewport space. */
  x: number
  y: number
  actions: readonly RowAction[]
}

/** Imperative handle the plugin uses to drive the mounted React root. */
export interface MenuHostHandle {
  open: (request: MenuRequest) => void
  close: () => void
  toast: (text: string) => void
  /** Text-input dialog used by the rename actions. */
  promptName: (options: { title: string; description: string; initial: string }) => Promise<string | undefined>
}

/** Props of the root component. */
export interface RowMenuHostProps {
  t: Translate
  /** Receives the imperative handle once mounted. */
  onReady: (handle: MenuHostHandle) => void
  /** Subscribed so an open menu re-renders when feature flags change. */
  preferencesVersion: number
}

/** The anchored menu plus every dialog it can raise. */
export function RowMenuHost({ t, onReady, preferencesVersion }: RowMenuHostProps): ReactNode {
  const [request, setRequest] = useState<MenuRequest | undefined>(undefined)
  const [pendingConfirm, setPendingConfirm] = useState<RowAction | undefined>(undefined)
  const [acknowledged, setAcknowledged] = useState(false)
  const [prompt, setPrompt] = useState<{ title: string; description: string; initial: string; resolve: (value: string | undefined) => void } | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [promptError, setPromptError] = useState<string | undefined>(undefined)
  const [toast, setToast] = useState<{ text: string; seq: number } | undefined>(undefined)
  // The menu anchors on a zero-size probe pinned at the pointer: the primitive
  // resolves side/align from the anchor rect, so the card lands on the click.
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const pointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const close = useCallback(() => { setRequest(undefined) }, [])

  const runAction = useCallback((action: RowAction) => {
    setRequest(undefined)
    if (action.confirm !== undefined) {
      setAcknowledged(false)
      setPendingConfirm(action)
      return
    }
    action.run()
  }, [])

  useEffect(() => {
    const handle: MenuHostHandle = {
      open: (next) => {
        pointer.current = { x: next.x, y: next.y }
        setRequest(next)
      },
      close,
      toast: (text) => { setToast({ text, seq: Date.now() }) },
      promptName: (options) => new Promise<string | undefined>((resolve) => {
        setDraft(options.initial)
        setPromptError(undefined)
        setPrompt({ ...options, resolve })
      }),
    }
    onReady(handle)
    // The handle intentionally survives re-renders; only the translation seat
    // and the preference revision are inputs to what it renders.
  }, [onReady, close])

  // An open menu must follow a feature-flag change: closing it is the honest
  // answer, because its item list was computed for the previous flags.
  useEffect(() => { close() }, [preferencesVersion, close])

  const items: readonly MenuEntry[] = useMemo(() => {
    if (request === undefined) return []
    return request.actions.map(action => ({
      id: action.id,
      label: action.label,
      icon: ACTION_ICONS[action.id] ?? <IconEllipsisOutline16 />,
      danger: action.danger === true,
    }))
  }, [request])

  const getAnchorRect = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect() ?? new DOMRect(pointer.current.x, pointer.current.y, 0, 0)
    return new DOMRect(pointer.current.x, pointer.current.y, rect.width, rect.height)
  }, [])

  const confirmAction = pendingConfirm

  return (
    <>
      <Menu
        open={request !== undefined && items.length > 0}
        anchor={<span ref={anchorRef} style={{ position: 'fixed', left: 0, top: 0, width: 0, height: 0 }} />}
        items={items}
        portal
        getAnchorRect={getAnchorRect}
        align="start"
        onClose={close}
        onSelect={(id) => {
          const action = request?.actions.find(candidate => candidate.id === id)
          if (action !== undefined) runAction(action)
        }}
      />

      {confirmAction?.confirm !== undefined && (
        <RiskConfirmation
          open
          title={confirmAction.confirm.title}
          description={confirmAction.confirm.warning === undefined
            ? confirmAction.confirm.body
            : `${confirmAction.confirm.body}\n\n${confirmAction.confirm.warning}`}
          acknowledgeLabel={confirmAction.confirm.acknowledge}
          cancelLabel={t('dialog.cancel')}
          confirmLabel={confirmAction.confirm.confirm}
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
          onCancel={() => { setPendingConfirm(undefined) }}
          onConfirm={() => {
            const action = confirmAction
            setPendingConfirm(undefined)
            action.run()
          }}
        />
      )}

      {prompt !== undefined && (
        <Modal
          open
          title={prompt.title}
          onClose={() => {
            prompt.resolve(undefined)
            setPrompt(undefined)
          }}
          footer={(
            <>
              <Button
                variant="outline"
                onClick={() => {
                  prompt.resolve(undefined)
                  setPrompt(undefined)
                }}
              >
                {t('dialog.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const value = draft.trim()
                  if (value === '') {
                    setPromptError(t('dialog.emptyName'))
                    return
                  }
                  prompt.resolve(value)
                  setPrompt(undefined)
                }}
              >
                {t('dialog.save')}
              </Button>
            </>
          )}
        >
          <p style={{ margin: '0 0 12px', color: 'var(--dsw-alias-label-secondary)' }}>{prompt.description}</p>
          <Input
            type="text"
            autoFocus
            aria-label={t('dialog.newName')}
            value={draft}
            spellCheck={false}
            style={promptError === undefined ? undefined : { borderColor: 'var(--dsw-alias-state-error-primary)' }}
            onChange={(event) => { setDraft(event.currentTarget.value); setPromptError(undefined) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                const value = draft.trim()
                if (value === '') {
                  setPromptError(t('dialog.emptyName'))
                  return
                }
                prompt.resolve(value)
                setPrompt(undefined)
              }
            }}
          />
          {promptError !== undefined && (
            <p style={{ margin: '8px 0 0', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{promptError}</p>
          )}
        </Modal>
      )}

      {toast !== undefined && (
        <Toast
          key={toast.seq}
          text={toast.text}
          onDone={() => { setToast(undefined) }}
        />
      )}
    </>
  )
}
