class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

module.exports = { HttpError, asyncRoute };
