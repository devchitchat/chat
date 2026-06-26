import { ServiceError } from '../util/errors.js'

export function validateEditPermission(requestingUserId, authorUserId) {
  if (requestingUserId !== authorUserId)
    throw new ServiceError('FORBIDDEN', 'Only the author can edit this message')
}

export function validateEditText(text) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) throw new ServiceError('BAD_REQUEST', 'Message text cannot be empty')
  return trimmed
}

export function assertMessageEditable(deletedAt) {
  if (deletedAt != null) throw new ServiceError('BAD_REQUEST', 'Cannot edit a deleted message')
}
