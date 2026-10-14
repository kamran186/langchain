export class RequestError extends Error {
  constructor(message, statusCode = 422) {
    super(message);
    this.name = "RequestError";
    this.statusCode = statusCode;
  }
}
