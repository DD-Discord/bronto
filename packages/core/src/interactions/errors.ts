/** A problem the user caused or can fix; its message is shown to them privately instead of a generic failure. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export function isUserError(error: unknown): error is UserError {
  return error instanceof UserError;
}
