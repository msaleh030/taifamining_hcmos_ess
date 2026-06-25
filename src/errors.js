'use strict';
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.body = { error: message, ...(extra || {}) };
  }
}
// AUTH-04: generic failure — never names which factor failed.
const genericAuthError = () => new HttpError(401, 'authentication failed');
module.exports = { HttpError, genericAuthError };
