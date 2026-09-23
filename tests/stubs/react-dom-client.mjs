/** Stand-in for `react-dom/client`: no rendering happens in the unit suite. */
export function createRoot() {
  return { render() {}, unmount() {} }
}