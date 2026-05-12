export const ROLES = ['admin', 'user', 'guest', 'bot']

export const isAdmin = (roles = []) => roles.includes('admin')
export const isGuest = (roles = []) => roles.includes('guest')
export const isBot   = (roles = []) => roles.includes('bot')
