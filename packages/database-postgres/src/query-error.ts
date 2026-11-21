import { QueryError, type SqlErrorDetails } from "@bpg/database-core";
import { mapPgError } from "./error-mapping";

const SQLSTATE = /^[0-9A-Z]{5}$/;

function str(source: object, key: string): string | undefined {
  const value: unknown = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Turns a failure of a running statement into a typed error.
 * - Server-reported SQL errors keep their message/position/detail/hint (they
 *   describe the user's own statement on the user's own session).
 * - Connection-class failures (08xxx, 57P0x) and anything that is not a server
 *   error go through mapPgError and keep its fixed, safe messages.
 */
export function mapQueryError(
  error: unknown,
  cancelledBy: "user" | "timeout" | null,
): Error {
  if (error instanceof QueryError) return error;
  if (typeof error !== "object" || error === null) return mapPgError(error);

  const code = str(error, "code");
  if (code === undefined || !SQLSTATE.test(code) || !("severity" in error)) {
    return mapPgError(error);
  }
  if (code === "57014") {
    return cancelledBy === "timeout"
      ? new QueryError("QUERY_TIMEOUT", "Query timed out and was cancelled")
      : new QueryError("QUERY_CANCELLED", "Query was cancelled");
  }
  if (code.startsWith("08") || code.startsWith("57P")) {
    return mapPgError(error);
  }

  const position = Number(str(error, "position"));
  const detail = str(error, "detail");
  const hint = str(error, "hint");
  const details: SqlErrorDetails = {
    sqlState: code,
    ...(Number.isInteger(position) && position > 0 ? { position } : {}),
    ...(detail ? { detail } : {}),
    ...(hint ? { hint } : {}),
  };
  return new QueryError(
    "QUERY_FAILED",
    str(error, "message") ?? "Query failed",
    details,
  );
}
