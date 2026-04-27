import { randomUUIDv7 } from 'bun'

export const newId = (prefix) => `${prefix}_${randomUUIDv7()}`
