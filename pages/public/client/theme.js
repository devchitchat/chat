/**
 * theme.js — applies the saved theme on load and wires the <select> picker.
 *
 * Each theme is a separate CSS file in /themes/<name>.css.
 * The <html data-theme> attribute is set so themes can also use attribute selectors.
 */
const THEMES = ['dark', 'light', 'ocean', 'forest', 'rose']
const STORAGE_KEY = 'devchitchat_theme'
const stylesheet = document.getElementById('theme-stylesheet')
const picker = document.getElementById('theme-picker')

function applyTheme(name) {
  const theme = THEMES.includes(name) ? name : 'dark'
  document.documentElement.dataset.theme = theme
  if (stylesheet) stylesheet.href = `/themes/${theme}.css`
  if (picker) picker.value = theme
  localStorage.setItem(STORAGE_KEY, theme)
}

// Restore saved theme immediately (before paint)
applyTheme(localStorage.getItem(STORAGE_KEY) ?? 'dark')

// Wire picker
if (picker) {
  picker.addEventListener('change', (e) => applyTheme(e.target.value))
}
