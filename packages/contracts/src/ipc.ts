/**
 * Transport-level IPC envelope. Type-only plus one constant list, so the
 * preload bundle can import these types without pulling in Zod (ADR-0003).
 */
export const IPC_ERROR_CODES = [
  "FORBIDDEN",
  "INVALID_INPUT",
  "INTERNAL",
  "SESSION_NOT_FOUND",
  "PROFILE_NOT_FOUND",
  "SECRET_STORAGE_UNAVAILABLE",
  "PASSWORD_REQUIRED",
  "QUERY_FAILED",
  "QUERY_CANCELLED",
  "QUERY_TIMEOUT",
  "QUERY_IN_PROGRESS",
  "AUTH_FAILED",
  "HOST_UNREACHABLE",
  "TIMEOUT",
  "DATABASE_NOT_FOUND",
  "TLS_ERROR",
  "CONNECTION_LOST",
  "UNKNOWN",
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

/**
 * Server-reported SQL error details (query errors only). They describe the
 * user's own statement; connection errors never carry details.
 */
export interface IpcErrorDetails {
  readonly sqlState: string;
  /** 1-based character offset into the statement. */
  readonly position?: number;
  readonly detail?: string;
  readonly hint?: string;
}

/** Error as seen by the renderer. Connection errors use fixed messages. */
export interface IpcError {
  readonly code: IpcErrorCode;
  readonly message: string;
  readonly details?: IpcErrorDetails;
}

export type IpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: IpcError };

const BRIDGE_ERROR_PREFIX = "BPG_IPC_ERROR:";

/**
 * contextBridge clones thrown Errors and keeps only name/message, so custom
 * properties (code, details) never reach the renderer. The preload therefore
 * carries the whole IpcError inside the message, and the renderer decodes it.
 */
export function encodeIpcError(error: IpcError): string {
  return `${BRIDGE_ERROR_PREFIX}${JSON.stringify(error)}`;
}

/** Returns the IpcError carried by an error thrown from the preload bridge, if any. */
export function decodeIpcError(cause: unknown): IpcError | null {
  if (!(cause instanceof Error)) return null;
  const at = cause.message.indexOf(BRIDGE_ERROR_PREFIX);
  if (at < 0) return null;
  try {
    const parsed: unknown = JSON.parse(
      cause.message.slice(at + BRIDGE_ERROR_PREFIX.length),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const { code, message, details } = parsed as Record<string, unknown>;
    if (typeof code !== "string" || typeof message !== "string") return null;
    return {
      code: code as IpcErrorCode,
      message,
      ...(typeof details === "object" && details !== null
        ? { details: details as IpcErrorDetails }
        : {}),
    };
  } catch {
    return null;
  }
}
