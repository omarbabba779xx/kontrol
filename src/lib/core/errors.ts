/** A failure caused by the request or by a business rule, not by the server: it carries the HTTP status to answer with. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UserError";
  }
}

/** Chooses the status from the message: missing -> 404, forbidden by a rule -> 403, already done -> 409, otherwise 400. */
export function userError(message: string) {
  const status = /separation of duties/i.test(message)
    ? 403
    : /already|changed while|duplicate/i.test(message)
      ? 409
      : /not found/i.test(message)
        ? 404
        : 400;
  return new UserError(message, status);
}
