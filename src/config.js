/**
 * config.js — shared server-side configuration.
 *
 * BASE_PATH: the URL subpath the app is mounted at (e.g. "/chat").
 * Defaults to "" (root). Trailing slash is stripped automatically.
 *
 * p(path) — path helper: prepends BASE_PATH to any absolute path string.
 * Use it everywhere a literal server-side path is constructed.
 */
export const BASE_PATH = (process.env.BASE_PATH ?? '').replace(/\/$/, '')
export const p = (path) => `${BASE_PATH}${path}`
