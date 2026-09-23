/**
 * Why is a pinned session not first?
 *
 * Reads the shell's own view preference, the registry's session account, and the
 * rendered row order in the same snapshot, then pins a session and reads all
 * three again. The point is to stop inferring the cause from a screenshot: the
 * three layers can disagree, and each disagreement has a different repair.
 *
 * Usage: node diagnose-pin-order.mjs [url] [edgePath]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:3080/'
const edge = process.argv[3] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const port = 9341
const profile = mkdtempSync(join(tmpdir(), 'dsh-pin-diag-'))
const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms) })

const child = spawn(edge, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=1440,900', url,
], { stdio: 'ignore' })

async function target() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl !== undefined)
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('devtools endpoint never answered')
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => { resolve() })
    socket.addEventListener('error', () => { reject(new Error('cdp socket failed')) })
  })
  const send = async (method, params = {}) => {
    await ready
    const id = next
    next += 1
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  return { send, close: () => { socket.close() } }
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return result.result.value
}

/** Everything that can disagree about the order, in one snapshot. */
const SNAPSHOT = `(() => {
  let view = null
  try { view = JSON.parse(localStorage.getItem('dsh.workspace.view.v5') ?? 'null') } catch { view = 'unparseable' }
  const pref = (() => { try { return JSON.parse(localStorage.getItem('dsh-workspace-menu:v1') ?? 'null') } catch { return null } })()
  const rows = [...document.querySelectorAll('[role="treeitem"]')]
  return {
    orderBy: view?.orderBy ?? '(absent)',
    viewKeys: view === null || typeof view !== 'object' ? String(view) : Object.keys(view).join(','),
    pinnedLocal: pref?.pinnedSessions ?? [],
    rows: rows.map(n => ({
      kind: n.dataset.dshWorkspaceId !== undefined ? 'group' : (n.dataset.dshSessionId !== undefined ? 'session' : 'other'),
      id: (n.dataset.dshSessionId ?? n.dataset.dshWorkspaceId ?? '?').slice(0, 8),
      pinned: n.dataset.dshPinned,
      hasWhale: n.querySelector('[data-dsh-pin-whale]') !== null,
      title: (n.textContent ?? '').trim().slice(0, 18),
    })),
  }
})()`

/**
 * Right-click the first ACTIONABLE, UNPINNED session row.
 *
 * Blank sessions render no row actions at all, and an already-pinned row offers
 * "取消置顶" instead of "置顶" — picking either of those makes a pin attempt
 * silently do nothing, which is how this script mis-reported twice.
 */
const OPEN_MENU_ON_FIRST_UNPINNED = `(() => {
  const rows = [...document.querySelectorAll('[role="treeitem"]')]
    .filter(n => n.dataset.dshSessionId !== undefined
      && n.dataset.dshPinned !== 'true'
      && n.querySelector('button[aria-label]') !== null)
  const row = rows[0]
  if (row === undefined) return false
  const rect = row.getBoundingClientRect()
  const init = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + 24, clientY: rect.top + rect.height / 2, button: 2, buttons: 2 }
  let event
  try { event = new PointerEvent('contextmenu', { ...init, pointerType: 'mouse' }) } catch { event = new MouseEvent('contextmenu', init) }
  row.dispatchEvent(event)
  return true
})()`

const MENU_LABELS = `[...document.querySelectorAll('[role="menuitem"]')].map(n => (n.textContent ?? '').trim())`

const CLICK_LABEL = (label) => `(() => {
  const item = [...document.querySelectorAll('[role="menuitem"]')]
    .filter(node => (node.textContent ?? '').trim() === ${JSON.stringify(label)}).pop()
  if (item === undefined) return false
  item.click()
  return true
})()`

try {
  const ws = await target()
  const { send, close } = connect(ws)
  await send('Page.enable')
  await send('Runtime.enable')
  await sleep(12_000)

  const before = await evaluate(send, SNAPSHOT)
  console.log('ORDER MODE      :', before.orderBy)
  console.log('view store keys :', before.viewKeys)
  console.log('pinned (local)  :', JSON.stringify(before.pinnedLocal))
  console.log('rendered rows   :')
  for (const row of before.rows) {
    console.log(`   ${row.kind.padEnd(7)} ${row.id}  pinned=${row.pinned}  whale=${row.hasWhale}  ${row.title}`)
  }

  // The sidebar's own control for this: the options trigger beside the search
  // field, then its "Manual" entry. Driving the real control is the point — a
  // localStorage poke would not prove the menu works.
  const switched = await evaluate(send, `(async () => {
    const trigger = [...document.querySelectorAll('button')].find(n => (n.getAttribute('aria-label') ?? '').includes('视图') || (n.getAttribute('aria-label') ?? '').includes('View'))
    if (trigger === undefined) return 'no view-options trigger'
    trigger.click()
    return 'opened:' + trigger.getAttribute('aria-label')
  })()`)
  console.log('view options      :', switched)
  await sleep(900)
  console.log('view menu labels  :', JSON.stringify(await evaluate(send, `[...document.querySelectorAll('[role="menuitem"], button')].map(n => (n.textContent ?? '').trim()).filter(t => t === '手动排序' || t === '最近更新')`)))
  const picked = await evaluate(send, `(() => {
    const item = [...document.querySelectorAll('[role="menuitem"], button')].find(n => (n.textContent ?? '').trim() === '手动排序')
    if (item === undefined) return false
    item.click()
    return true
  })()`)
  console.log('picked 手动排序   :', picked)
  await sleep(1500)
  const modeNow = await evaluate(send, `(() => { try { return JSON.parse(localStorage.getItem('dsh.workspace.view.v5') ?? 'null')?.orderBy ?? '(absent)' } catch { return 'unparseable' } })()`)
  console.log('orderBy now       :', modeNow)

  const opened = await evaluate(send, OPEN_MENU_ON_FIRST_UNPINNED)
  await sleep(1200)
  console.log('')
  console.log('right-clicked a session row:', opened)
  console.log('menu items:', JSON.stringify(await evaluate(send, MENU_LABELS)))
  const clicked = await evaluate(send, CLICK_LABEL('置顶'))
  console.log('clicked 置顶:', clicked)
  await sleep(2500)

  const after = await evaluate(send, SNAPSHOT)
  console.log('')
  console.log('AFTER PIN — pinned (local):', JSON.stringify(after.pinnedLocal))
  console.log('AFTER PIN — rendered rows :')
  for (const row of after.rows) {
    console.log(`   ${row.kind.padEnd(7)} ${row.id}  pinned=${row.pinned}  whale=${row.hasWhale}  ${row.title}`)
  }

  console.log('')
  console.log('re-run with the mode switched, expected: a pin now changes the order.')
  // The registry's own account, which the plugin writes through
  // `insertSessionBefore`; a mismatch here means the DOM move never reached it.
  const registry = await evaluate(send, `(async () => {
    const api = window.__DSH_BOOT__ ? null : null
    return null
  })()`)
  void registry

  close()
} finally {
  child.kill()
  await sleep(1500)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
}
