/**
 * theme.js — applies the saved theme on load and wires the <select> picker.
 *
 * Each theme is a separate CSS file in /themes/<name>.css.
 * The <html data-theme> attribute is set so themes can also use attribute selectors.
 * Theme preference is stored via settings-sync getPref/setPref ('theme' key).
 */
import { getPref, setPref } from './settings-sync.js'

const THEMES = ['dark', 'light', 'ocean', 'forest', 'rose']
const BASE_PATH = window.__BASE_PATH__ ?? ''
const stylesheet = document.getElementById('theme-stylesheet')
const picker = document.getElementById('theme-picker')

function applyTheme(name) {
  const theme = THEMES.includes(name) ? name : 'dark'
  document.documentElement.dataset.theme = theme
  if (stylesheet) stylesheet.href = `${BASE_PATH}/themes/${theme}.css`
  if (picker) picker.value = theme
  setPref('theme', theme)
}

// Restore saved theme immediately (before paint)
applyTheme(getPref('theme', 'dark'))

// Wire picker
if (picker) {
  picker.addEventListener('change', e => applyTheme(e.target.value))
}
