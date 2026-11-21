export interface QueryOptions {
  /** Rows returned at most; the adapter reads one more to detect truncation. */
  readonly maxRows: number;
  readonly timeoutMs: number;
}

export interface QueryColumn {
  readonly name: string;
  /** PostgreSQL type OID. */
  readonly typeId: number;
}

/** JSON-safe cell. Anything else (dates, bytea, json, ...) is already serialized. */
export type CellValue = string | number | boolean | null;

export interface QueryOutcome {
  readonly command: string;
  /** Rows affected/returned as reported by the server, when known. */
  readonly rowCount: number | null;
  readonly columns: readonly QueryColumn[];
  readonly rows: readonly (readonly CellValue[])[];
  /** True when more rows existed than `maxRows` and the rest were dropped. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** Server-side SQL error details. Describes the user's own statement. */
export interface SqlErrorDetails {
  readonly sqlState: string;
  /** 1-based character offset into the statement, when the server gave one. */
  readonly position?: number;
  readonly detail?: string;
  readonly hint?: string;
}

export const QUERY_ERROR_CODES = [
  "QUERY_FAILED",
  "QUERY_CANCELLED",
  "QUERY_TIMEOUT",
  "QUERY_IN_PROGRESS",
] as const;
export type QueryErrorCode = (typeof QUERY_ERROR_CODES)[number];

export class QueryError extends Error {
  readonly code: QueryErrorCode;
  readonly details: SqlErrorDetails | undefined;

  constructor(
    code: QueryErrorCode,
    message: string,
    details?: SqlErrorDetails,
  ) {
    super(message);
    this.name = "QueryError";
    this.code = code;
    this.details = details;
  }
}
