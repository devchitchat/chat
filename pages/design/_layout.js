export async function data(req) {
  const base     = req.basePath ?? ''
  const url      = new URL(req.url)
  const pathname = url.pathname.replace(base, '').replace(/\/$/, '') || '/'

  return {
    base,
    activeOverview:   pathname === '/design',
    activePrinciples: pathname === '/design/principles',
    activeTokens:     pathname === '/design/tokens',
    activeComponents: pathname === '/design/components',
    activeMobile:     pathname === '/design/mobile',
  }
}
