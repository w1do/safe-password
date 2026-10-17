export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'RATE_LIMITED'
  | 'PROJECT_NOT_FOUND'
  | 'CREDENTIAL_NOT_FOUND'
  | 'PROJECT_EXISTS'
  | 'CREDENTIAL_EXISTS'
  | 'CSRF_REJECTED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  RATE_LIMITED: 429,
  PROJECT_NOT_FOUND: 404,
  CREDENTIAL_NOT_FOUND: 404,
  PROJECT_EXISTS: 409,
  CREDENTIAL_EXISTS: 409,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};

export class VaultError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'VaultError';
    this.status = STATUS[code];
  }
}
