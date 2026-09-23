/**
 * Node resolution hook: redirect the shell's platform modules to the local
 * stand-ins under `tests/stubs/`.
 *
 * Load-time redirection rather than a bundler alias: the bundler's dependency
 * rules take precedence over aliases, and this keeps the suite runnable from
 * plain `node --test` with no browser-grade module graph.
 */
import { register } from 'node:module'

register(new URL('./platform-redirect.mjs', import.meta.url))