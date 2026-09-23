/**
 * Feature catalog — the single source of truth shared by both halves.
 *
 * The Host registers one settings-namespace field per key (its durable
 * default lives in `defaultEnabled`), and the client renders one switch per
 * key in the General settings row. Nothing may rely on a second list: a key
 * that exists here but not in the Host schema is refused by the settings
 * write fence, and a key that exists in the schema but not here is dead
 * configuration.
 */

/** One toggleable behavior of the row menu. */
export type FeatureKey =
  | 'dblclick'
  | 'contextmenu'
  | 'groupPin'
  | 'workspacePin'
  | 'workspaceRename'
  | 'workspaceOpenExplorer'
  | 'workspaceCopyPath'
  | 'workspaceNewSession'
  | 'workspaceDelete'
  | 'workspaceDeleteDisk'
  | 'sessionPin'
  | 'sessionRename'
  | 'sessionUnread'
  | 'sessionArchive'
  | 'sessionFork'
  | 'sessionCopyLink'
  | 'sessionCopyTitle'
  | 'sessionOpenWindow'
  | 'sessionOpenFolder'
  | 'sessionCompact'
  | 'sessionDelete'

/** One feature's declaration. */
export interface FeatureDefinition {
  /** Settings field / localStorage slot key. */
  readonly key: FeatureKey
  /** Whether the feature is on for a profile that has never written the field. */
  readonly defaultEnabled: boolean
  /** English switch label. */
  readonly labelEn: string
  /** Chinese switch label. */
  readonly labelZh: string
}

/**
 * Every feature in menu order, grouped by surface.
 *
 * `defaultEnabled: false` marks the four actions DSH's own row menu already
 * ships (rename / archive / fork / new session): the plugin offers them for
 * one-menu convenience, but a default profile should not show duplicates.
 */
export const FEATURE_GROUPS: readonly { readonly titleEn: string; readonly titleZh: string; readonly items: readonly FeatureDefinition[] }[] = [
  {
    titleEn: 'Trigger',
    titleZh: '触发方式',
    items: [
      { key: 'dblclick', defaultEnabled: true, labelEn: 'Double-click opens the menu', labelZh: '双击打开菜单' },
      { key: 'contextmenu', defaultEnabled: true, labelEn: 'Right-click opens the menu', labelZh: '右键打开菜单' },
    ],
  },
  {
    titleEn: 'Workspace actions',
    titleZh: '工作区动作',
    items: [
      { key: 'groupPin', defaultEnabled: true, labelEn: 'Project row: pin / unpin', labelZh: '项目行：置顶 / 取消置顶' },
      { key: 'workspacePin', defaultEnabled: true, labelEn: 'Pin / unpin', labelZh: '置顶 / 取消置顶' },
      { key: 'workspaceOpenExplorer', defaultEnabled: true, labelEn: 'Reveal in file manager', labelZh: '在文件管理器中打开' },
      { key: 'workspaceCopyPath', defaultEnabled: true, labelEn: 'Copy path', labelZh: '复制路径' },
      { key: 'workspaceDelete', defaultEnabled: true, labelEn: 'Remove from workspace list (keeps the directory)', labelZh: '从工作区列表移除（保留目录）' },
      { key: 'workspaceDeleteDisk', defaultEnabled: true, labelEn: 'Delete workspace and its directory', labelZh: '删除工作区（含磁盘目录）' },
      { key: 'workspaceRename', defaultEnabled: false, labelEn: 'Rename (also in the built-in menu)', labelZh: '重命名（内置菜单已有）' },
      { key: 'workspaceNewSession', defaultEnabled: false, labelEn: 'New session (also in the built-in menu)', labelZh: '新建会话（内置菜单已有）' },
    ],
  },
  {
    titleEn: 'Session actions',
    titleZh: '会话动作',
    items: [
      { key: 'sessionPin', defaultEnabled: true, labelEn: 'Pin / unpin', labelZh: '置顶 / 取消置顶' },
      { key: 'sessionUnread', defaultEnabled: true, labelEn: 'Mark unread / read', labelZh: '标记未读 / 已读' },
      { key: 'sessionCopyLink', defaultEnabled: true, labelEn: 'Copy session link', labelZh: '复制会话链接' },
      { key: 'sessionCopyTitle', defaultEnabled: true, labelEn: 'Copy session title', labelZh: '复制会话标题' },
      { key: 'sessionOpenWindow', defaultEnabled: true, labelEn: 'Open in a new window', labelZh: '在新窗口中打开' },
      { key: 'sessionOpenFolder', defaultEnabled: true, labelEn: 'Reveal working directory', labelZh: '打开所在目录' },
      { key: 'sessionDelete', defaultEnabled: true, labelEn: 'Delete session and its log', labelZh: '删除会话（含日志记录）' },
      { key: 'sessionRename', defaultEnabled: false, labelEn: 'Rename (also in the built-in menu)', labelZh: '重命名（内置菜单已有）' },
      { key: 'sessionCompact', defaultEnabled: true, labelEn: 'Compact context', labelZh: '压缩上下文' },
      { key: 'sessionFork', defaultEnabled: false, labelEn: 'Fork (also in the built-in menu)', labelZh: '分叉会话（内置菜单已有）' },
      { key: 'sessionArchive', defaultEnabled: false, labelEn: 'Archive (also in the built-in menu)', labelZh: '归档会话（内置菜单已有）' },
    ],
  },
]

/** Every definition, flattened in menu order. */
export const FEATURES: readonly FeatureDefinition[] = FEATURE_GROUPS.flatMap(group => group.items)

/** Every feature key, flattened in menu order. */
export const FEATURE_KEYS: readonly FeatureKey[] = FEATURES.map(feature => feature.key)

/** Resolved enablement of every feature. */
export type FeatureFlags = Record<FeatureKey, boolean>

/** The all-defaults flag map. */
export function defaultFlags(): FeatureFlags {
  const flags = {} as FeatureFlags
  for (const feature of FEATURES) flags[feature.key] = feature.defaultEnabled
  return flags
}
