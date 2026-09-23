/**
 * Measure the whale's own art inside the mark, so the water can be placed
 * against it instead of guessed at.
 *
 * Reads the glyph path's bounding box in its own units and converts it into
 * mark-relative pixels, then does the same for every effect path. The numbers
 * this prints are what `WhaleMark`'s constants are chosen from.
 *
 * Usage: node fit-pin-whale.mjs [url] [edgePath]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:3080/'
const edge = process.argv[3]
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const port = 9337
const profile = mkdtempSync(join(tmpdir(), 'dsh-pin-fit-'))
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

const OPEN_MENU = `(() => {
  const row = [...document.querySelectorAll('[role="treeitem"]')].find(node => node.dataset.dshSessionId !== undefined)
  if (row === undefined) return false
  const rect = row.getBoundingClientRect()
  const init = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + 24, clientY: rect.top + rect.height / 2, button: 2, buttons: 2 }
  let event
  try { event = new PointerEvent('contextmenu', { ...init, pointerType: 'mouse' }) } catch { event = new MouseEvent('contextmenu', init) }
  row.dispatchEvent(event)
  return true
})()`

/**
 * Convert each path's user-unit box into mark-relative pixels.
 *
 * The map from user units to mark pixels is read from the rendered box of the
 * layer that owns the path, so no scale constant is duplicated here.
 */
const FIT = (ms) => `(() => {
  const row = [...document.querySelectorAll('[role="treeitem"]')].find(node => node.dataset.dshPinned === 'true')
  if (row === undefined) return null
  const mark = row.querySelector('[data-dsh-pin-whale]')
  if (mark === null) return null
  const animations = document.getAnimations().filter(a => {
    const target = a.effect?.target
    return target !== null && target !== undefined && (mark === target || mark.contains(target))
  })
  for (const animation of animations) {
    animation.pause()
    animation.currentTime = ${ms}
  }
  const markBox = mark.getBoundingClientRect()
  const toMark = (node) => {
    const box = node.getBoundingClientRect()
    const view = node.getAttribute('viewBox') ?? node.ownerSVGElement?.getAttribute('viewBox')
    const units = view === null || view === undefined ? null : parseFloat(view.split(' ')[2])
    const px = units === null ? null : box.width / units
    return {
      box: [box.x - markBox.x, box.y - markBox.y, box.width, box.height].map(v => Math.round(v * 100) / 100),
      unitsToPx: px === null ? null : Math.round(px * 10000) / 10000,
    }
  }
  const glyphSvg = [...mark.querySelectorAll('svg')].find(node => node.querySelector('path[d^="M22.9168"]') !== null)
  const effectSvg = [...mark.querySelectorAll('svg')].find(node => node !== glyphSvg)
  const glyphPath = glyphSvg === undefined ? undefined : glyphSvg.querySelector('path')
  const report = {
    mark: [Math.round(markBox.width * 100) / 100, Math.round(markBox.height * 100) / 100],
    whaleOpacity: getComputedStyle(mark.querySelector('.whale')).opacity,
    glyphSvg: glyphSvg === undefined ? null : toMark(glyphSvg),
    glyphPath: glyphPath === undefined || glyphPath === null ? null : toMark(glyphPath),
    effects: [],
  }
  if (effectSvg !== undefined) {
    const svgInfo = toMark(effectSvg)
    report.effectSvg = svgInfo
    for (const path of effectSvg.querySelectorAll('path')) {
      const info = toMark(path)
      // Where this path's own midline sits, in mark pixels.
      const own = path.getBBox()
      const unit = svgInfo.unitsToPx
      const centre = unit === null ? null : Math.round((svgInfo.box[1] + (own.y + own.height / 2) * unit) * 100) / 100
      report.effects.push({ kind: path.getAttribute('class'), box: info.box, ownUnits: [Math.round(own.y * 100) / 100, Math.round(own.height * 100) / 100], midlineY: centre })
    }
  }
  return report
})()`

try {
  const ws = await target()
  const { send, close } = connect(ws)
  await send('Page.enable')
  await send('Runtime.enable')
  await sleep(12_000)
  await evaluate(send, OPEN_MENU)
  await sleep(1200)
  await evaluate(send, CLICK('置顶'))
  await sleep(2500)

  for (const ms of [0, 900, 1440, 2300]) {
    const report = await evaluate(send, FIT(ms))
    if (report === null) { console.log('no mark at', ms, 'ms'); continue }
    console.log(`\n=== t=${ms}ms  mark=${report.mark.join('x')}  whaleOpacity=${report.whaleOpacity}`)
    console.log('  glyph svg  box:', JSON.stringify(report.glyphSvg?.box), 'unitsToPx=', report.glyphSvg?.unitsToPx)
    console.log('  glyph path box:', JSON.stringify(report.glyphPath?.box))
    console.log('  effect svg box:', JSON.stringify(report.effectSvg?.box), 'unitsToPx=', report.effectSvg?.unitsToPx)
    for (const effect of report.effects) {
      console.log(`    ${String(effect.kind).padEnd(8)} box=${JSON.stringify(effect.box)} ownY=${effect.ownUnits[0]}..${effect.ownUnits[0] + effect.ownUnits[1]} midlineY=${effect.midlineY}`)
    }
  }

  await evaluate(send, OPEN_MENU)
  await sleep(1200)
  await evaluate(send, CLICK('取消置顶'))
  await sleep(1500)
  console.log('\npinned after restore:', await evaluate(send, `document.querySelectorAll('[role="treeitem"][data-dsh-pinned="true"]').length`))
  close()
} finally {
  child.kill()
  await sleep(1500)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
}
