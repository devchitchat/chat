export class ServiceError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.code = code
    this.details = details
  }
}

const HTTP_STATUS = { FORBIDDEN: 403, NOT_FOUND: 404, BAD_REQUEST: 400, CONFLICT: 409, UNAUTHORIZED: 401 }

/** Map a ServiceError code to an HTTP status code. Defaults to 500. */
export function httpStatus(err) {
  return HTTP_STATUS[err?.code] ?? 500
}
