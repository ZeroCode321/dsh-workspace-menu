/**
 * The pinned row's mark: the brand whale, blue and animated.
 *
 * The pinned row used to carry the shell's pushpin icon; the operator asked for
 * the DeepSeek whale instead, in the brand blue and moving. The geometry — the
 * breach, the spout, the splash, the surface ripple — is the same animation the
 * whale-diving plugin renders beside a running turn, transcribed here rather
 * than imported: the two plugins are separate packages, and a marker that stops
 * rendering because the other plugin was uninstalled would be a worse contract
 * than this duplication. Two of its numbers are deliberately NOT the original's,
 * and both are explained where they live below. Its size is bounded by its own
 * rotation; the script that measures it is scripts/fit-pin-whale.mjs.
 */
import { createElement, type CSSProperties } from 'react'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'

/** Marker strip side, in px; the row rhythm owns it, not this component. */
const BOX = 18

/** FishLogo's native canvas, and therefore the viewBox of the effect layer. */
const VIEW = { width: 23.16, height: 17.04 } as const

/**
 * The whale glyph's box inside `BOX`. FishLogo renders 4 wide per 3 high.
 *
 * Raised from 13 to 16 at the operator's request. The ceiling is a function of
 * the ROTATION, not of taste: the pose keyframes turn the glyph to -25deg while
 * it dives, and a rotated rectangle is wider than the rectangle. Measured with
 * `_chest-build/fit-pin-whale.mjs` at 13px, the swing reached 15.3px wide
 * (t=2300ms) against a 13px box — so the box above grew with the glyph, and the
 * marker strip's margin in `rows.ts` grew to cover the swing rather than let it
 * paint over the title. Both numbers were re-measured at the new size, not
 * extrapolated.
 */
const GLYPH = { width: 16, height: 11.8 } as const

/** The effect layer's own artboard: the whale the stroke paths were drawn around. */
const EFFECT_ART = 22

/** One 3.6s cycle: breach, spout, dive, settle. */
const CYCLE = '3.6s'
const EASING = 'linear'
const LOOP = `${CYCLE} ${EASING} infinite`
const NAME = 'dsh-pin-whale'

/**
 * Where the turn-status artboard's water line (`y=16.3..16.7`) has to land, in
 * mark pixels. The artboard's static `surface` stroke is not used here (see
 * `Effects`), so this anchor positions the ripple that takes its place.
 *
 * Two earlier settings — the glyph's bottom edge, then 14.6px — each put a
 * hairline across the whale's belly. The geometry explains why an anchor that
 * looks right is not right: the glyph's box is 11.8px tall, but its mass is not
 * a rectangle — the lower-left of that box is occupied by the belly and the
 * flipper. Any horizontal line inside the box, at any y that still fits the
 * strip, crosses the body; there is no y that reads as water underneath and
 * stays in the row. So the line is gone and the ripple carries the water: it
 * sits low (measured at y 13.9..15.2 at rest, behind the belly) and comes into
 * view only as the whale dives past it.
 */
const WATER_LINE_IN_MARK = 15

/** …and where its spout (`x=10`) has to land: the glyph's head, which points left. */
const SPOUT_X_IN_MARK = 6

/**
 * The ripple, spout, and splash, as paths scaled from the 22px turn-status
 * animation. They live on their own 22-unit artboard and are mapped onto the
 * mark's viewBox by one transform, so the effect layer and the glyph cannot
 * drift apart: the same scale that sizes the whale places its water.
 *
 * The artboard's static `surface` path is deliberately dropped. In the 22px
 * turn-status row it reads as the sea the whale is diving into; at 16px, inside
 * a marker strip that is only 18px tall, it reads as a line drawn through the
 * animal. See `WATER_LINE_IN_MARK` for the measurement behind that call.
 * @returns the effect-layer svg.
 */
function Effects() {
  const scale = GLYPH.width / EFFECT_ART
  // The artboard is mapped so its surface sits under the glyph's belly and its
  // spout over the glyph's head: place both measured anchors, then scale.
  const shiftX = (SPOUT_X_IN_MARK - 10 * scale) / scale
  const shiftY = (WATER_LINE_IN_MARK - 16.5 * scale) / scale
  const transform = `translate(${shiftX * scale} ${shiftY * scale}) scale(${scale})`
  return createElement('svg', {
    className: 'fx',
    viewBox: `0 0 ${VIEW.width} ${VIEW.height}`,
    'aria-hidden': 'true',
  },
  createElement('g', { transform },
  createElement('path', { className: 'ripple', pathLength: 1, d: 'M4 16.4 Q11 18.2 18 16.4' }),
  createElement('path', { className: 'spray', pathLength: 1, d: 'M9.8 5.2 C9.7 4.1 9.8 3.2 10.2 2.6' }),
  createElement('path', { className: 'spray', pathLength: 1, d: 'M10.2 2.6 C9.2 1.9 8.3 2 7.8 2.7' }),
  createElement('path', { className: 'spray', pathLength: 1, d: 'M10.2 2.6 C11.2 1.9 12.2 2 12.8 2.8' }),
  createElement('path', { className: 'splash', pathLength: 1, d: 'M10.7 16.2 C9.7 15 8.8 13.9 8.5 12.8' }),
  createElement('path', { className: 'splash', pathLength: 1, d: 'M11.2 16.2 C12.3 15 13.2 14.2 13.8 13.2' })))
}

/** The stylesheet, generated once per size so one component can serve any strip. */
function styles(glyphWidth: number, box: number): string {
  const scale = glyphWidth / EFFECT_ART
  return `
[data-dsh-pin-whale] {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
  width: ${glyphWidth}px;
  height: ${box}px;
  color: var(--dsw-alias-state-business-primary);
}
[data-dsh-pin-whale] > .whale {
  display: flex;
  animation: ${NAME}-path ${LOOP};
  will-change: transform, opacity;
  backface-visibility: hidden;
  z-index: 2;
}
[data-dsh-pin-whale] > .whale > svg {
  transform-box: fill-box;
  transform-origin: 52% 72%;
  animation: ${NAME}-pose ${LOOP};
  will-change: transform;
}
[data-dsh-pin-whale] .fx {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
}
[data-dsh-pin-whale] .ripple,
[data-dsh-pin-whale] .spray,
[data-dsh-pin-whale] .splash {
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
}
[data-dsh-pin-whale] .ripple,
[data-dsh-pin-whale] .spray,
[data-dsh-pin-whale] .splash { stroke-dasharray: 1; stroke-dashoffset: 1; }
[data-dsh-pin-whale] .ripple {
  stroke-width: ${0.9 * scale}px;
  transform-box: fill-box;
  transform-origin: center;
  animation: ${NAME}-ripple ${LOOP};
}
[data-dsh-pin-whale] .spray { stroke-width: ${1.05 * scale}px; animation: ${NAME}-spray ${LOOP}; }
[data-dsh-pin-whale] .splash { stroke-width: ${1 * scale}px; animation: ${NAME}-splash ${LOOP}; }
@keyframes ${NAME}-path {
  /* The turn-status original dives to opacity 0 and stays there for a quarter of
     the cycle; at 45% the mark read as a grey smudge rather than a blue whale.
     The floor is 0.85 and the travel is 3px instead of 8px, so the whale is a
     solid blue whale at every point in the cycle and only its position moves. */
  0%, 8% { transform: translate3d(0, ${3 * scale}px, 0); opacity: .85; }
  16% { transform: translate3d(${-0.5 * scale}px, ${1.5 * scale}px, 0); opacity: .92; }
  24% { transform: translate3d(${-1 * scale}px, 0, 0); opacity: 1; }
  32% { transform: translate3d(${-0.5 * scale}px, ${-1 * scale}px, 0); opacity: 1; }
  40% { transform: translate3d(0, ${-1.5 * scale}px, 0); opacity: 1; }
  48% { transform: translate3d(${0.5 * scale}px, ${-1 * scale}px, 0); opacity: 1; }
  56% { transform: translate3d(${1 * scale}px, 0, 0); opacity: 1; }
  64% { transform: translate3d(${0.5 * scale}px, ${1 * scale}px, 0); opacity: 1; }
  72% { transform: translate3d(${-0.5 * scale}px, ${3 * scale}px, 0); opacity: .94; }
  100% { transform: translate3d(0, ${3 * scale}px, 0); opacity: .85; }
}
@keyframes ${NAME}-pose {
  0%, 16% { transform: rotate(0deg); }
  32% { transform: rotate(9deg); }
  40% { transform: rotate(8deg); }
  48% { transform: rotate(3deg); }
  56% { transform: rotate(-5deg); }
  64% { transform: rotate(-18deg); }
  72% { transform: rotate(-25deg); }
  80%, 100% { transform: rotate(0deg); }
}
@keyframes ${NAME}-spray {
  0%, 24% { stroke-dashoffset: 1; opacity: 0; }
  31% { stroke-dashoffset: 0; opacity: .85; }
  40% { stroke-dashoffset: 0; opacity: .7; }
  48% { stroke-dashoffset: -1; opacity: 0; }
  100% { stroke-dashoffset: 1; opacity: 0; }
}
@keyframes ${NAME}-splash {
  0%, 57% { stroke-dashoffset: 1; opacity: 0; }
  64% { stroke-dashoffset: 0; opacity: .75; }
  72% { stroke-dashoffset: -1; opacity: 0; }
  100% { stroke-dashoffset: 1; opacity: 0; }
}
@keyframes ${NAME}-ripple {
  0%, 59% { stroke-dashoffset: 1; transform: scaleX(.2); opacity: 0; }
  65% { stroke-dashoffset: 0; transform: scaleX(.38); opacity: .6; }
  75% { stroke-dashoffset: 0; transform: scaleX(.72); opacity: .45; }
  88% { stroke-dashoffset: 0; transform: scaleX(1); opacity: 0; }
  100% { stroke-dashoffset: 1; transform: scaleX(1); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  [data-dsh-pin-whale] > .whale,
  [data-dsh-pin-whale] > .whale > svg,
  [data-dsh-pin-whale] .ripple,
  [data-dsh-pin-whale] .spray,
  [data-dsh-pin-whale] .splash { animation: none; }
  [data-dsh-pin-whale] > .whale { opacity: 1; }
  [data-dsh-pin-whale] .ripple { stroke-dashoffset: 0; transform: scaleX(.72); opacity: .55; }
  [data-dsh-pin-whale] .spray,
  [data-dsh-pin-whale] .splash { display: none; }
}
`
}

/** Injected once, keyed by size, and shared by every pinned row. */
const injected = new Map<string, HTMLStyleElement>()

/**
 * Install the stylesheet for one box size, or reuse the installed one.
 * @param glyph - the glyph box in px.
 * @param box - the marker strip's square side in px.
 * @returns the injected style element.
 */
function installStyles(glyph: { width: number; height: number }, box: number): HTMLStyleElement {
  const key = `${glyph.width}x${glyph.height}@${box}`
  const existing = injected.get(key)
  if (existing !== undefined) return existing
  const style = document.createElement('style')
  style.dataset.dshPinWhale = key
  style.textContent = styles(glyph.width, box)
  document.head.appendChild(style)
  injected.set(key, style)
  return style
}

/** The marker's root span: the whale, the water, and the pinned tooltip. */
export function WhaleMark() {
  installStyles(GLYPH, BOX)
  const root: CSSProperties = { width: GLYPH.width }
  return createElement('span', { 'data-dsh-pin-whale': '', title: 'Pinned', style: root },
    createElement('span', { className: 'whale' }, createElement(FishLogo, { size: GLYPH.width })),
    createElement(Effects))
}
