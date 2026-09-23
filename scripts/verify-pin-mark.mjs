/**
 * Measure the pin mark against the row it sits in, and prove that pinning an
 * ungrouped session actually moves the row.
 *
 * Two claims are checked, both of which have been wrong before:
 *
 * 1. The gap between the whale and the title. The whale's layout box is 16px but
 *    its painted box swings 1.01px wider at the deepest point of the dive, so the
 *    reserve has to cover that — and no more, or the row reads as broken.
 * 2. The order, after pinning a session the registry does not account for (one in
 *    the ungrouped bucket). A pin there has to reorder the rendered tree; the
 *    registry has no account to reorder.
 *
 * Usage: node verify-pin-mark.mjs [url] [edgePath]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:3080/'
const edge = process.argv[3] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const port = 9339
const profile = mkdtempSync(join(tmpdir(), 'dsh-pin-verify-'))
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

/** Right-click the Nth session row and pick a menu entry by its label. */
/**
 * Right-click the Nth ACTIONABLE session row.
 *
 * Blank sessions render no row actions at all (the shell gates them on
 * `!row.blank`), so a script that grabs "the last session row" can silently do
 * nothing. Actionable means the row carries the trailing menu button.
 */
const OPEN_MENU_ON = (index) => `(() => {
  const rows = [...document.querySelectorAll('[role="treeitem"]')]
    .filter(n => n.dataset.dshSessionId !== undefined && n.querySelector('button[aria-label]') !== null)
  const row = rows[${index}]
  if (row === undefined) return false
  const rect = row.getBoundingClientRect()
  const init = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + 24, clientY: rect.top + rect.height / 2, button: 2, buttons: 2 }
  let event
  try { event = new PointerEvent('contextmenu', { ...init, pointerType: 'mouse' }) } catch { event = new MouseEvent('contextmenu', init) }
  row.dispatchEvent(event)
  return true
})()`

const CLICK = (label) => `(() => {
  const item = [...document.querySelectorAll('[role="menuitem"], [role="option"], button')]
    .filter(node => (node.textContent ?? '').trim() === ${JSON.stringify(label)}).pop()
  if (item === undefined) return false
  const rect = item.getBoundingClientRect()
  const init = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + 4, clientY: rect.top + 4, button: 0 }
  item.dispatchEvent(new MouseEvent('pointerdown', init))
  item.dispatchEvent(new MouseEvent('mousedown', init))
  item.dispatchEvent(new MouseEvent('mouseup', init))
  item.click()
  return true
})()`

/** Session row order and the mark's gap to its own title. */
const REPORT = (ms) => `(() => {
  const rows = [...document.querySelectorAll('[role="treeitem"]')]
  const sessions = rows
    .filter(n => n.dataset.dshSessionId !== undefined)
    .map(n => ({ id: n.dataset.dshSessionId, pinned: n.dataset.dshPinned === 'true', title: (n.textContent ?? '').trim().slice(0, 24) }))
  const pinnedRow = rows.find(n => n.dataset.dshPinned === 'true' && n.querySelector('[data-dsh-pin-whale]') !== null)
  let gap = null
  let markBox = null
  let titleLeft = null
  let whaleRight = null
  if (pinnedRow !== undefined && pinnedRow !== undefined) {
    const mark = pinnedRow.querySelector('[data-dsh-pin-whale]')
    for (const animation of document.getAnimations()) {
      const t = animation.effect?.target
      if (t !== null && t !== undefined && (mark === t || mark.contains(t))) {
        animation.pause()
        animation.currentTime = ${ms}
      }
    }
    const whaleSvg = mark.querySelector('svg')
    markBox = [Math.round(mark.getBoundingClientRect().width * 100) / 100, Math.round(mark.getBoundingClientRect().height * 100) / 100]
    whaleRight = whaleSvg === null ? null : Math.round((whaleSvg.getBoundingClientRect().right - mark.getBoundingClientRect().left) * 100) / 100
    // The title cell is the sibling span that carries the text.
    const rowBox = pinnedRow.getBoundingClientRect()
    // The title cell: the DIRECT child span that carries the text, excluding the
    // marker strip and anything inside it. Walking direct children keeps a
    // wrapper far to the right from being mistaken for the title.
    const strip = pinnedRow.querySelector('[data-dsh-marker]')
    const titleNode = [...pinnedRow.children]
      .filter(n => n !== strip && !n.hasAttribute('data-dsh-marker'))
      .find(n => (n.textContent ?? '').trim().length > 0)
    titleLeft = titleNode === undefined ? null : Math.round((titleNode.getBoundingClientRect().left - rowBox.left) * 100) / 100
    gap = titleLeft === null || whaleRight === null ? null : Math.round((titleLeft - whaleRight) * 100) / 100
  }
  return { sessions: sessions.slice(0, 6), markBox, whaleRight, titleLeft, gap }
})()`

try {
  const ws = await target()
  const { send, close } = connect(ws)
  await send('Page.enable')
  await send('Runtime.enable')
  await sleep(12_000)

  // Pin the LAST session row: if it is already first, the move proves nothing.
  const before = await evaluate(send, REPORT(0))
  console.log('BEFORE order:', JSON.stringify(before.sessions))

  await evaluate(send, OPEN_MENU_ON(-1))
  await sleep(1200)
  const clicked = await evaluate(send, CLICK('置顶'))
  console.log('actionable rows:', await evaluate(send, `[...document.querySelectorAll('[role="treeitem"]')].filter(n => n.dataset.dshSessionId !== undefined && n.querySelector('button[aria-label]') !== null).length`))
  console.log('clicked 置顶:', clicked)
  await sleep(2000)

  const after = await evaluate(send, REPORT(0))
  console.log('AFTER  order:', JSON.stringify(after.sessions))
  console.log('')
  console.log('mark box          :', JSON.stringify(after.markBox))
  console.log('whale right edge  :', after.whaleRight)
  console.log('title left edge   :', after.titleLeft)
  console.log('GAP to title      :', after.gap, 'px')

  for (const ms of [0, 900, 1440, 2300]) {
    const sample = await evaluate(send, REPORT(ms))
    console.log(`  t=${String(ms).padStart(4)}ms  whaleRight=${sample.whaleRight}  gap=${sample.gap}`)
  }

  await evaluate(send, OPEN_MENU_ON(0))
  await sleep(1200)
  await evaluate(send, CLICK('取消置顶'))
  await sleep(1500)
  const restored = await evaluate(send, REPORT(0))
  console.log('')
  console.log('AFTER unpin order:', JSON.stringify(restored.sessions))
  close()
} finally {
  child.kill()
  await sleep(1500)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
}
