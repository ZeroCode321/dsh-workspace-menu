/**
 * Stand-in for `react` in the unit suite.
 *
 * The suite covers decision logic, not rendering, so only the shapes the
 * non-DOM modules reach for need to exist. A local module keeps React and its
 * dependency tree out of a logic-only artifact.
 */
export function createElement(type, props, ...children) {
  return { type, props, children }
}

export const Fragment = Symbol.for('react.fragment')

export function useCallback(fn) {
  return fn
}

export function useEffect() {}

export function useState(initial) {
  return [initial, () => undefined]
}