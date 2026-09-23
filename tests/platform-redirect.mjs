/** Module-resolution hook backing `tests/platform-stubs.mjs`. */
const REDIRECT = new Map([
  ['react', new URL('./stubs/react.mjs', import.meta.url).href],
  ['react/jsx-runtime', new URL('./stubs/react-jsx-runtime.mjs', import.meta.url).href],
  ['react-dom/client', new URL('./stubs/react-dom-client.mjs', import.meta.url).href],
  ['@deepseek-ai/dsh-client-ui-primitives', new URL('./stubs/ui-primitives.mjs', import.meta.url).href],
])

/**
 * Redirect one platform specifier, deferring everything else to Node.
 * @param specifier - the module specifier as written.
 * @param context - Node's resolution context.
 * @param nextResolve - the default resolver.
 * @returns the resolution result.
 */
export async function resolve(specifier, context, nextResolve) {
  const redirect = REDIRECT.get(specifier)
  if (redirect !== undefined) return { url: redirect, shortCircuit: true, format: 'module' }
  return nextResolve(specifier, context)
}