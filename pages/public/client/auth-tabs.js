/**
 * auth-tabs.js — tab switching on the login page (no framework needed).
 */
const tabs = document.querySelectorAll('[role="tab"]')
const panels = document.querySelectorAll('[role="tabpanel"]')

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab
    tabs.forEach(t => t.setAttribute('aria-selected', t.dataset.tab === target ? 'true' : 'false'))
    panels.forEach(p => { p.hidden = p.id !== `panel-${target}` })
  })
})
