export type NexaIMClientErrorOptions = {
  code?: string;
  details?: unknown;
  cause?: unknown;
};

export class NexaIMClientError extends Error {
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, options: NexaIMClientErrorOptions = {}) {
    super(message);
    this.name = "NexaIMClientError";
    this.code = options.code;
    this.details = options.details;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}