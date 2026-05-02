/**
 * router.js — client-side SPA navigation for /channels/* links.
 *
 * Intercepts link clicks, fetches the new page, morphs only .chat-panel
 * (data-* attributes + .messages content), then dispatches chatpanel:navigated
 * so the existing call.js island can re-initialise its chat state without
 * tearing down WebRTC connections.
 */

let inFlight = false

export function initRouter() {
  document.addEventListener('click', handleClick)
  window.addEventListener('popstate', () => navigateTo(location.href, false))
}

function isChannelUrl(href) {
  try {
    const url = new URL(href, location.href)
    return url.origin === location.origin && /^\/channels\//.test(url.pathname)
  } catch { return false }
}

async function handleClick(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const link = e.target.closest('a[href]')
  if (!link || !isChannelUrl(link.href)) return
  e.preventDefault()
  history.pushState({}, '', link.href)
  await navigateTo(link.href, true)
}

async function navigateTo(url, scroll) {
  if (inFlight) return
  inFlight = true
  try {
    const res = await fetch(url, { headers: { Accept: 'text/html' } })
    if (!res.ok) { location.href = url; return }
    const html = await res.text()

    const next = new DOMParser().parseFromString(html, 'text/html')
    const nextPanel = next.querySelector('.chat-panel')
    const currPanel = document.querySelector('.chat-panel')
    if (!nextPanel || !currPanel) { location.href = url; return }

    // 1. Swap data-* attributes so the island can read the new channel's identity
    for (const { name } of [...currPanel.attributes]) {
      if (name.startsWith('data-')) currPanel.removeAttribute(name)
    }
    for (const { name, value } of [...nextPanel.attributes]) {
      if (name.startsWith('data-')) currPanel.setAttribute(name, value)
    }

    // 2. Replace .messages content (seed articles + <template> from new page)
    const currMessages = currPanel.querySelector('#messages')
    const nextMessages = nextPanel.querySelector('#messages')
    if (currMessages && nextMessages) {
      currMessages.innerHTML = nextMessages.innerHTML
    }

    // 3. Notify the existing island — it will leave the old channel and join the new one
    const d = currPanel.dataset
    document.dispatchEvent(new CustomEvent('chatpanel:navigated', {
      detail: {
        channelId: d.id,
        name:      d.name,
        topic:     d.topic ?? '',
        kind:      d.kind ?? 'text',
        seedSeq:   parseInt(d.seedSeq ?? '0', 10),
      }
    }))

    if (scroll && currMessages) currMessages.scrollTop = currMessages.scrollHeight
  } catch {
    location.href = url
  } finally {
    inFlight = false
  }
}
