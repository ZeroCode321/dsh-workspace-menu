/**
 * The two facts a row target needs, and the store face that resolves them.
 *
 * Kept free of DOM access so the action layer can be reasoned about (and
 * tested) without a rendered row.
 */
import type {
  ISessions,
  IWorkspaces,
  SessionId,
  SessionSummary,
  WorkspaceId,
  WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Which surface a row belongs to.
 *
 * group is a top-level project row: a real Workspace folder, or the bucket
 * that owns the sessions belonging to no Workspace (its id is the empty
 * string, which is the shell's own key for that bucket). The shell renders both
 * through the same row component, and both are real things an operator wants
 * pinned.
 */
export type RowKind = 'workspace' | 'session' | 'group'

/** One identified row, resolved against the official stores. */
export interface RowTarget {
  kind: RowKind
  /** Workspace id or session id, branded per {@link kind}. */
  id: WorkspaceId | SessionId
  /** Display title: the registry's own for a workspace, the live row's for a session. */
  title: string
  /** Top-level row key for a group row: the workspace id, or '' for the ungrouped bucket. */
  groupKey?: string
  /** Session ids the group currently shows, for the copy/empty states. */
  sessionCount?: number
  /** The registry view, for a workspace row. */
  workspace?: WorkspaceView
  /** The session summary, for a session row. */
  session?: SessionSummary
  /** Owning workspace id, for a session row. */
  workspaceId?: string
}

/** The client stores this plugin reads. */
export interface RowStores {
  sessions: ISessions
  workspaces: IWorkspaces
}

/** The per-row flags this plugin paints as data attributes. */
export interface RowFlags {
  kind: RowKind
  id: string
  pinned: boolean
  unread: boolean
}
