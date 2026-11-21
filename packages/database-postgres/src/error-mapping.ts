import { DatabaseError, type DatabaseErrorCode } from "@bpg/database-core";

/** Fixed, safe messages. Driver text is never forwarded (it can echo host data). */
const MESSAGES: Record<DatabaseErrorCode, string> = {
  AUTH_FAILED: "Authentication failed",
  HOST_UNREACHABLE: "Server unreachable",
  TIMEOUT: "Connection timed out",
  DATABASE_NOT_FOUND: "Database not found",
  TLS_ERROR: "TLS/SSL error",
  CONNECTION_LOST: "Connection lost",
  UNKNOWN: "Connection failed",
};

const TLS_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "HOSTNAME_MISMATCH",
]);

const NETWORK_UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

export function databaseError(code: DatabaseErrorCode): DatabaseError {
  return new DatabaseError(code, MESSAGES[code]);
}

function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value: unknown = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Maps any driver/network failure to a DatabaseError with a fixed safe message. */
export function mapPgError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;

  const code = readString(error, "code");
  const message = readString(error, "message")?.toLowerCase() ?? "";

  // SQLSTATE (5 chars) first: the server told us exactly what happened.
  if (code === "28P01" || code === "28000") return databaseError("AUTH_FAILED");
  if (code === "3D000") return databaseError("DATABASE_NOT_FOUND");
  if (code?.startsWith("57P") || code?.startsWith("08")) {
    return databaseError("CONNECTION_LOST");
  }

  if (
    code !== undefined &&
    (TLS_CODES.has(code) ||
      code.startsWith("ERR_TLS") ||
      code.startsWith("ERR_SSL"))
  ) {
    return databaseError("TLS_ERROR");
  }
  if (/\b(ssl|tls)\b|certificate/.test(message)) {
    return databaseError("TLS_ERROR");
  }

  if (code !== undefined && NETWORK_UNREACHABLE.has(code)) {
    return databaseError("HOST_UNREACHABLE");
  }
  if (code === "ETIMEDOUT" || /timeout|timed out/.test(message)) {
    return databaseError("TIMEOUT");
  }
  if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    /terminated unexpectedly|connection terminated/.test(message)
  ) {
    return databaseError("CONNECTION_LOST");
  }

  return databaseError("UNKNOWN");
}
