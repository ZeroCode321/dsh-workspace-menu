/**
 * Stand-in for the shell's UI primitives in the unit suite.
 *
 * Reached only by the DOM-rendering paths the suite does not exercise; the real
 * package pulls in shiki, katex, and a markdown pipeline.
 */
export const FishLogo = () => null
export const Menu = () => null
export const Modal = () => null
export const Toast = () => null
export const Button = () => null
export const Input = () => null
export const RiskConfirmation = () => null
export function writeClipboard() {
  return Promise.resolve(true)
}