// describeError passes these messages through, so none may ever carry a key, request text or a
// provider response body
export class ConfigError extends Error {}
export class StateError extends Error {}
export class RedactionError extends Error {}

export class SpendCapError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpendCapError";
  }
}

export class ServiceError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}
