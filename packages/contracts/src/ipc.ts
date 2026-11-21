/**
 * Transport-level IPC envelope. Type-only plus one constant list, so the
 * preload bundle can import these types without pulling in Zod (ADR-0003).
 */
export const IPC_ERROR_CODES = [
  "FORBIDDEN",
  "INVALID_INPUT",
  "INTERNAL",
  "SESSION_NOT_FOUND",
  "AUTH_FAILED",
  "HOST_UNREACHABLE",
  "TIMEOUT",
  "DATABASE_NOT_FOUND",
  "TLS_ERROR",
  "CONNECTION_LOST",
  "UNKNOWN",
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

/** Error as seen by the renderer. `message` never contains payload data. */
export interface IpcError {
  readonly code: IpcErrorCode;
  readonly message: string;
}

export type IpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: IpcError };
