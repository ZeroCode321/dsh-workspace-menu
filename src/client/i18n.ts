/**
 * Dictionary registration for this plugin's own locale namespace.
 *
 * DSH's locale service resolves `ns → active locale → zh fallback → the key
 * itself`, so registering both shipped locales keeps every menu string honest
 * when the shell is switched to English. `zh` is the source of truth and `en`
 * is checked against the same key union at compile time.
 */
import { FEATURES, FEATURE_GROUPS } from '../features.js'

/** Translation function bound to this plugin's namespace. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Chinese dictionary — the source of truth for the key union. */
const zh = {
  'menu.copyPath': '复制路径',
  'menu.revealWorkspace': '在文件管理器中打开',
  'menu.newSession': '新建会话',
  'menu.rename': '重命名',
  'menu.removeWorkspace': '从工作区列表移除',
  'menu.deleteWorkspace': '删除工作区（含目录）',
  'menu.pin': '置顶',
  'menu.unpin': '取消置顶',
  'menu.markUnread': '标记为未读',
  'menu.markRead': '标记为已读',
  'menu.archive': '归档会话',
  'menu.compact': '压缩上下文（继续对话）',
  'toast.compacted': '上下文已压缩，可以继续对话',
  'menu.fork': '分叉会话',
  'menu.copyLink': '复制会话链接',
  'menu.copyTitle': '复制会话标题',
  'menu.copyGroupTitle': '复制项目名称',
  'menu.openWindow': '在新窗口打开（并复制链接）',
  'menu.revealSession': '打开所在目录',
  'menu.deleteSession': '删除会话（含日志）',
  'toast.pinned': '已置顶',
  'toast.unpinned': '已取消置顶',
  'toast.markedUnread': '已标记为未读',
  'toast.markedRead': '已标记为已读',
  'toast.pathCopied': '路径已复制',
  'toast.linkCopied': '链接已复制',
  'toast.titleCopied': '标题已复制',
  'toast.copyFailed': '复制失败',
  'toast.opened': '已在文件管理器中打开',
  'toast.workspaceRemoved': '已从工作区列表移除',
  'toast.sessionDeleted': '会话已删除',
  'toast.workspaceDeleted': '工作区及其目录已删除',
  'toast.sessionDeletePartial': '会话记录未能删除：{message}',
  'toast.failed': '{action}失败：{message}',
  'dialog.renameWorkspace': '重命名工作区',
  'dialog.renameWorkspaceDescription': '输入新的工作区名称。',
  'dialog.renameSession': '重命名会话',
  'dialog.renameSessionDescription': '输入新的会话标题。',
  'dialog.newName': '名称',
  'dialog.cancel': '取消',
  'dialog.save': '保存',
  'dialog.emptyName': '名称不能为空',
  'dialog.deleteWorkspaceTitle': '删除工作区及其目录',
  'dialog.deleteWorkspaceBody': '这会永久删除磁盘目录 {path}，其下所有文件都会被移除。',
  'dialog.deleteWorkspaceSessions': '该工作区名下还有 {count} 个会话，删除目录时它们的记录会一并消失。',
  'dialog.deleteSessionTitle': '删除会话及其日志',
  'dialog.deleteSessionBody': '这会永久删除会话“{title}”的日志记录。目录与工作区不受影响。',
  'dialog.archiveManagerMissing': '未检测到归档管理插件，本插件无法删除日志文件；该会话可能在重新扫描后再次出现。',
  'dialog.deleteWorkspaceLogsPending': '本机未安装归档管理插件，无法清理该工作区 {count} 条会话的日志记录：目录仍会被删除，那些记录会作为孤立条目留在 Host 上，需要在「设置 → 插件」里手动清理。若要保留目录，请取消并改用「从工作区列表移除」。',
  'toast.sessionLogsPending': '目录已删除，但有 {count} 条会话日志未能清理（缺归档管理插件）',
  'dialog.acknowledge': '我已了解此操作不可撤销',
  'dialog.confirmDeleteWorkspace': '删除工作区',
  'dialog.confirmDeleteSession': '删除会话',
  'dialog.removeWorkspaceTitle': '从工作区列表移除',
  'dialog.removeWorkspaceBody': '只会从 DSH 的工作区列表中移除“{title}”，目录与会话记录都保留在磁盘上。',
  'dialog.confirmRemove': '移除',
  'settings.title': '工作区菜单',
  'settings.description': '开关工作区 / 会话行右键与双击菜单里的各项功能。',
  'settings.statusLoading': '正在连接 Host 偏好存储…',
  'settings.statusMemory': '当前浏览器是远程连接，设置只在本进程生效。',
  'settings.statusUnavailable': '未能安装 Host 偏好传输，改动仅保留在此浏览器。',
  'settings.statusSettings': '偏好保存在 DSH 设置命名空间里。',
  'settings.archiveMissing': '未检测到归档管理插件，删除会话日志的动作已隐藏。',
  'settings.resetGroup': '恢复本组默认值',
  'settings.transport': '偏好存储：{transport}',
  'toast.rowUnidentified': '工作区菜单：连续 {count} 次无法识别侧栏行的结构，菜单可能已失效（DSH 改动了行组件）。请把这条消息报告给插件维护者。',
  'workspace': '工作区',
  'session': '会话',
} as const satisfies Record<string, string>

/** Translation key union taken from the zh dictionary. */
export type LocaleKey = keyof typeof zh

/** English dictionary, required to cover every zh key. */
const en: Record<LocaleKey, string> = {
  'menu.copyPath': 'Copy path',
  'menu.revealWorkspace': 'Reveal in file manager',
  'menu.newSession': 'New session',
  'menu.rename': 'Rename',
  'menu.removeWorkspace': 'Remove from workspace list',
  'menu.deleteWorkspace': 'Delete workspace and its directory',
  'menu.pin': 'Pin',
  'menu.unpin': 'Unpin',
  'menu.markUnread': 'Mark unread',
  'menu.markRead': 'Mark read',
  'menu.archive': 'Archive session',
  'menu.compact': 'Compact context (keep going)',
  'toast.compacted': 'Context compacted; you can keep going',
  'menu.fork': 'Fork session',
  'menu.copyLink': 'Copy session link',
  'menu.copyTitle': 'Copy session title',
  'menu.copyGroupTitle': 'Copy project name',
  'menu.openWindow': 'Open in a new window (copies the link)',
  'menu.revealSession': 'Reveal working directory',
  'menu.deleteSession': 'Delete session and its log',
  'toast.pinned': 'Pinned',
  'toast.unpinned': 'Unpinned',
  'toast.markedUnread': 'Marked unread',
  'toast.markedRead': 'Marked read',
  'toast.pathCopied': 'Path copied',
  'toast.linkCopied': 'Link copied',
  'toast.titleCopied': 'Title copied',
  'toast.copyFailed': 'Copy failed',
  'toast.opened': 'Opened in the file manager',
  'toast.workspaceRemoved': 'Removed from the workspace list',
  'toast.sessionDeleted': 'Session deleted',
  'toast.workspaceDeleted': 'Workspace and its directory deleted',
  'toast.sessionDeletePartial': 'The session log was not deleted: {message}',
  'toast.failed': '{action} failed: {message}',
  'dialog.renameWorkspace': 'Rename workspace',
  'dialog.renameWorkspaceDescription': 'Enter a new workspace name.',
  'dialog.renameSession': 'Rename session',
  'dialog.renameSessionDescription': 'Enter a new session title.',
  'dialog.newName': 'Name',
  'dialog.cancel': 'Cancel',
  'dialog.save': 'Save',
  'dialog.emptyName': 'The name cannot be empty',
  'dialog.deleteWorkspaceTitle': 'Delete the workspace and its directory',
  'dialog.deleteWorkspaceBody': 'This permanently deletes the directory {path} and every file beneath it.',
  'dialog.deleteWorkspaceSessions': 'This workspace still accounts for {count} session(s); their records disappear with the directory.',
  'dialog.deleteSessionTitle': 'Delete the session and its log',
  'dialog.deleteSessionBody': 'This permanently deletes the stored log of "{title}". The directory and workspace are untouched.',
  'dialog.archiveManagerMissing': 'The archive manager plugin is not loaded, so this plugin cannot delete the log file; the session may reappear after a rescan.',
  'dialog.deleteWorkspaceLogsPending': 'The archive manager plugin is not loaded, so the logs of this workspace\'s {count} session(s) cannot be purged: the directory is still removed, and those records stay behind as orphans to clean up in Settings → Plugins. To keep the directory, cancel and use "Remove from the workspace list" instead.',
  'toast.sessionLogsPending': 'Directory deleted, but {count} session log(s) could not be purged (no archive manager)',
  'dialog.acknowledge': 'I understand this cannot be undone',
  'dialog.confirmDeleteWorkspace': 'Delete workspace',
  'dialog.confirmDeleteSession': 'Delete session',
  'dialog.removeWorkspaceTitle': 'Remove from the workspace list',
  'dialog.removeWorkspaceBody': 'Only the DSH workspace entry "{title}" is removed; the directory and session logs stay on disk.',
  'dialog.confirmRemove': 'Remove',
  'settings.title': 'Workspace menu',
  'settings.description': 'Turn the individual workspace / session row actions on or off.',
  'settings.statusLoading': 'Connecting to the Host preference store…',
  'settings.statusMemory': 'This browser is a remote connection, so settings apply to this process only.',
  'settings.statusUnavailable': 'No Host preference transport could be installed; changes stay in this browser.',
  'settings.statusSettings': 'Preferences live in the DSH settings namespace.',
  'settings.archiveMissing': 'The archive manager plugin is not loaded, so session-log deletion is hidden.',
  'settings.resetGroup': 'Reset this group',
  'settings.transport': 'Preference store: {transport}',
  'toast.rowUnidentified': 'Workspace menu: {count} sidebar rows in a row could not be identified, so the menu is likely broken (DSH changed its row components). Please report this message to the plugin maintainer.',
  'workspace': 'workspace',
  'session': 'session',
}

/** Fallback translator used when the locale service is absent. */
function fallback(key: string): string {
  return (zh as Record<string, string>)[key] ?? key
}

/**
 * Register this plugin's dictionaries and bind its translator.
 * @param locale - the locale service, when the shell provides one.
 * @returns the bound translator and a disposer releasing both dictionaries.
 */
export function installLocale(locale: LocaleLike | undefined): { t: Translate; dispose: () => void } {
  if (locale === undefined || typeof locale.register !== 'function') {
    return { t: fallback, dispose: () => undefined }
  }
  const releases: (() => void)[] = []
  try {
    releases.push(locale.register('workspace-menu', 'zh', zh))
    releases.push(locale.register('workspace-menu', 'en', en))
  } catch {
    // A duplicate namespace (a second plugin instance) keeps the first owner.
  }
  const bound: Translate | undefined = typeof locale.bind === 'function'
    ? locale.bind('workspace-menu')
    : undefined
  return {
    t: bound === undefined
      ? fallback
      : (key, params) => {
        const text = bound(key, params)
        return text === key ? fallback(key) : text
      },
    dispose: () => {
      for (const release of releases) release()
    },
  }
}

/** The slice of the locale service this plugin consumes. */
export interface LocaleLike {
  register(ns: string, locale: string, dict: Record<string, string>): () => void
  bind(ns: string): Translate
}

/**
 * Feature-switch labels, resolved per locale straight from the catalog so the
 * Host schema, the settings row, and every menu share one key list.
 * @param key - feature key.
 * @param active - active locale id.
 * @returns the label in the requested locale.
 */
export function featureLabel(key: string, active: string): string {
  const feature = FEATURES.find(candidate => candidate.key === key)
  if (feature === undefined) return key
  return active === 'zh' ? feature.labelZh : feature.labelEn
}

/** Group headings, resolved per locale. */
export function groupTitle(index: number, active: string): string {
  const group = FEATURE_GROUPS[index]
  if (group === undefined) return ''
  return active === 'zh' ? group.titleZh : group.titleEn
}
