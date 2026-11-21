export const DATABASE_ERROR_CODES = [
  "AUTH_FAILED",
  "HOST_UNREACHABLE",
  "TIMEOUT",
  "DATABASE_NOT_FOUND",
  "TLS_ERROR",
  "CONNECTION_LOST",
  "UNKNOWN",
] as const;

export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODES)[number];

/**
 * Adapter failure with a stable code. `message` is always a fixed, safe string
 * chosen by the adapter; it must never echo driver text, host data or secrets.
 */
export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;

  constructor(code: DatabaseErrorCode, message: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}
