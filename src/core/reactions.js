import { ServiceError } from '../util/errors.js'

export function validateEmoji(emoji) {
  if (typeof emoji !== 'string') throw new ServiceError('BAD_REQUEST', 'emoji must be a string')
  if (!emoji || [...emoji].length > 4) throw new ServiceError('BAD_REQUEST', 'Invalid emoji')
}
