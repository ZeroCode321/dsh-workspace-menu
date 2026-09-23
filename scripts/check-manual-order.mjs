/**
 * Does the sidebar render the registry's session order once it is in manual mode?
 *
 * The minimal question left: with `orderBy: 'manual'` in the shell's own view
 * store and a registry account whose first entry is known, does the rendered
 * order match the registry? No clicks, no pinning — one read on load.
 *
 * Usage: node check-manual-order.mjs [url] [edgePath]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:3080/'
const edge = process.argv[3] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const port = 9343
const profile = mkdtempSync(join(tmpdir(), 'dsh-manual-order-'))
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

try {
  const ws = await target()
  const { send, close } = connect(ws)
  await send('Page.enable')
  await send('Runtime.enable')
  await sleep(14_000)

  const first = await evaluate(send, `(() => {
    const view = (() => { try { return JSON.parse(localStorage.getItem('dsh.workspace.view.v5') ?? 'null') } catch { return null } })()
    const rows = [...document.querySelectorAll('[role="treeitem"]')]
      .filter(n => n.dataset.dshSessionId !== undefined)
      .map(n => ({ id: n.dataset.dshSessionId, pinned: n.dataset.dshPinned, title: (n.textContent ?? '').trim().slice(0, 16) }))
    return { orderBy: view?.orderBy ?? '(absent)', rows }
  })()`)
  console.log('orderBy        :', first.orderBy)
  console.log('rendered order :')
  for (const row of first.rows) console.log(`   ${row.pinned === 'true' ? 'PIN ' : '    '}${row.id}  ${row.title}`)

  // Force the shell to re-derive by reloading the page: the store may have
  // reconciled before the mode was persisted on the earlier pass.
  await send('Page.reload', { ignoreCache: true })
  await sleep(14_000)

  const second = await evaluate(send, `(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')]
      .filter(n => n.dataset.dshSessionId !== undefined)
      .map(n => ({ id: n.dataset.dshSessionId, pinned: n.dataset.dshPinned, title: (n.textContent ?? '').trim().slice(0, 16) }))
    return rows
  })()`)
  console.log('')
  console.log('AFTER RELOAD — rendered order :')
  for (const row of second) console.log(`   ${row.pinned === 'true' ? 'PIN ' : '    '}${row.id}  ${row.title}`)

  const same = first.rows.length === second.length && first.rows.every((row, i) => row.id === second[i]?.id)
  console.log('')
  console.log('order stable across reload:', same)
  console.log('first row is the PINNED one:', second[0]?.pinned === 'true')
  close()
} finally {
  child.kill()
  await sleep(1500)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
}
