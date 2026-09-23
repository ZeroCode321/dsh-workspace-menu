/**
 * Break down the pinned row's box model.
 *
 * "The mark sits too far from the name" has been guessed at twice. This prints
 * every child of the row with its offset, width, and computed margins, so the
 * answer is a number rather than a theory.
 *
 * Usage: node inspect-pin-row.mjs [url] [edgePath]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:3080/'
const edge = process.argv[3] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const port = 9345
const profile = mkdtempSync(join(tmpdir(), 'dsh-pin-row-'))
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

/** Every child of the pinned row, with the box each one actually occupies. */
const ROW_BOX = `(() => {
  const row = [...document.querySelectorAll('[role="treeitem"]')].find(n => n.dataset.dshPinned === 'true')
  if (row === undefined) return { error: 'no pinned row' }
  const rowBox = row.getBoundingClientRect()
  const strip = row.querySelector('[data-dsh-marker]')
  const whale = row.querySelector('[data-dsh-pin-whale]')
  const describe = (node) => {
    if (node === null || node === undefined) return null
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return {
      tag: node.tagName.toLowerCase(),
      cls: node.className === '' ? null : String(node.className).split(' ')[0],
      marker: node.getAttribute('data-dsh-marker'),
      whale: node.hasAttribute('data-dsh-pin-whale'),
      left: Math.round((box.left - rowBox.left) * 100) / 100,
      right: Math.round((box.right - rowBox.left) * 100) / 100,
      width: Math.round(box.width * 100) / 100,
      marginLeft: style.marginLeft,
      marginRight: style.marginRight,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      gap: style.gap,
      flex: style.flex,
      display: style.display,
    }
  }
  return {
    rowLeft: 0,
    rowWidth: Math.round(rowBox.width * 100) / 100,
    rowGap: getComputedStyle(row).gap,
    rowPadding: getComputedStyle(row).padding,
    children: [...row.children].map(describe),
    stripChildren: strip === null ? [] : [...strip.children].map(describe),
    whaleChildren: whale === null ? [] : [...whale.children].map(describe),
    whaleSvg: whale === null ? null : describe(whale.querySelector('svg')),
  }
})()`

try {
  const ws = await target()
  const { send, close } = connect(ws)
  await send('Page.enable')
  await send('Runtime.enable')
  await sleep(13_000)

  const report = await evaluate(send, ROW_BOX)
  console.log(JSON.stringify(report, null, 1))
  close()
} finally {
  child.kill()
  await sleep(1500)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
}
