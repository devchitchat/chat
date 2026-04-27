import { randomBytes, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { scrypt as _scrypt } from 'node:crypto'

const scrypt = promisify(_scrypt)

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url')

export const hashToken = (token) => createHash('sha256').update(token).digest('hex')

export const hashPassword = async (password) => {
  const salt = randomBytes(16).toString('hex')
  const buf = await scrypt(password, salt, 64)
  return `${salt}:${buf.toString('hex')}`
}

export const verifyPassword = async (password, hash) => {
  const [salt, key] = hash.split(':')
  const buf = await scrypt(password, salt, 64)
  return buf.toString('hex') === key
}
