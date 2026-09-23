/** Stand-in for `react/jsx-runtime` (the suite renders nothing). */
export function jsx(type, props) {
  return { type, props }
}

export const jsxs = jsx
export const Fragment = Symbol.for('react.fragment')