const redact = (value) => {
  if (!value || typeof value !== 'object') return value
  const clone = Array.isArray(value) ? [...value] : { ...value }
  for (const key of Object.keys(clone)) {
    if (key.toLowerCase().includes('token') || key.toLowerCase().includes('password')) {
      clone[key] = '[redacted]'
    }
  }
  return clone
}

export const createLogger = () => {
  const write = (level, event, data) => {
    console.log(JSON.stringify({ level, event, ts: Date.now(), data: redact(data) }))
  }
  return {
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data)
  }
}
