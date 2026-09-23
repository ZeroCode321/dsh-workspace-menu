/**
 * The workspace browser's own session order, as the shell persists it.
 *
 * `dsh.workspace.view.v5` holds `sessionOrderByAccount`, and
 * `reconciledSessionOrder` PREFERS that stored order over the registry account
 * whenever the key exists (the registry is then only consulted to append
 * sessions the view has not seen). Reordering the registry alone is therefore
 * invisible: it is the view order that renders.
 *
 * Writing this key from outside the shell is not a preference — it is the only
 * way an ordering action can be visible at all, and it is what DSH's own drag
 * does (`setSessionOrder`, `stores.ts`). When the operator returns to the
 * registry's own order the key is REMOVED rather than set to a copy of it, so
 * the view falls back to the registry by the same rule the shell uses.
 */

/** The shell's persisted view store key. */
const VIEW_STORE_KEY = 'dsh.workspace.view.v5'

/** Field inside it that holds one session order per account. */
const ORDER_FIELD = 'sessionOrderByAccount'

/** The ungrouped bucket's account key, as the shell spells it. */
export const UNGROUPED_ACCOUNT = ''

interface ViewStore {
  [ORDER_FIELD]?: Record<string, string[]>
  [other: string]: unknown
}

/**
 * Publish one account's session order to the shell's view store.
 *
 * A best-effort write by design: this is a view preference owned by the shell,
 * and a browser that refuses storage must not break the ordering action that is
 * already applied to the registry.
 * @param accountKey - workspace id, or the empty string for the ungrouped bucket.
 * @param order - the order to render.
 * @param natural - the registry's own order; when `order` matches it the stored
 *   key is removed so the shell falls back to the registry by its own rule.
 */
export function writeShellSessionOrder(
  accountKey: string,
  order: readonly string[],
  natural: readonly string[],
): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEW_STORE_KEY) ?? '{}') as ViewStore
    const accounts: Record<string, string[]> = { ...(parsed[ORDER_FIELD] ?? {}) }
    const sameAsRegistry = order.length === natural.length
      && order.every((id, index) => id === natural[index])
    if (sameAsRegistry) delete accounts[accountKey]
    else accounts[accountKey] = [...order]
    localStorage.setItem(VIEW_STORE_KEY, JSON.stringify({ ...parsed, [ORDER_FIELD]: accounts }))
  } catch {
    // The registry side of the action still stands; only the view hint is lost.
  }
}
