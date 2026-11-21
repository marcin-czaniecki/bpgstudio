/**
 * Minimal engine-neutral contracts. No Electron, React, Zod or driver imports.
 * Add capabilities when a real second DB exists.
 */
export interface DatabaseConnectionInfo {
  id: string;
  label: string;
  kind: "postgres";
}

import type { DatabaseError } from "./errors";
import type { QueryOptions, QueryOutcome } from "./query";

export {
  DATABASE_ERROR_CODES,
  DatabaseError,
  type DatabaseErrorCode,
} from "./errors";
export {
  type PasswordInstruction,
  PROFILE_ERROR_CODES,
  ProfileError,
  type ProfileErrorCode,
  type ProfileFields,
  type ProfileRepository,
  ProfileService,
  type ProfileServiceDeps,
  type SecretStore,
  type StoredProfile,
} from "./profiles";
export {
  type CellValue,
  QUERY_ERROR_CODES,
  type QueryColumn,
  QueryError,
  type QueryErrorCode,
  type QueryOptions,
  type QueryOutcome,
  type SqlErrorDetails,
} from "./query";
export { type CloseAllResult, SessionRegistry } from "./session-registry";

export type SslMode = "disable" | "verify-full";

/** Everything an adapter needs to connect. Contains the password: never log it. */
export interface ConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly sslMode: SslMode;
  readonly connectTimeoutMs: number;
}

export interface ConnectionTestOutcome {
  readonly serverVersion: string;
  readonly latencyMs: number;
}

/** Non-secret description of a session. Safe to serialize. */
export interface SessionDetails {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly sslMode: SslMode;
  readonly serverVersion: string;
  readonly openedAt: string;
}

export type RelationKind =
  | "table"
  | "partitioned-table"
  | "view"
  | "materialized-view"
  | "foreign-table";

export interface RelationEntry {
  readonly name: string;
  readonly kind: RelationKind;
}

export interface ColumnInfo {
  readonly name: string;
  /** Type as PostgreSQL formats it, e.g. "character varying(50)". */
  readonly type: string;
  readonly notNull: boolean;
  readonly isPrimaryKey: boolean;
}

export interface Limited<T> {
  readonly items: readonly T[];
  /** True when more existed than the server-side limit allowed. */
  readonly truncated: boolean;
}

export interface DatabaseSession {
  readonly id: string;
  readonly info: SessionDetails;
  /** Idempotent: closing twice, or after the server dropped us, is not an error. */
  close(): Promise<void>;
  /**
   * Called exactly once when the session ends for any reason. `reason` is null
   * for a normal close() and a DatabaseError (e.g. CONNECTION_LOST) otherwise.
   */
  onClosed(listener: (reason: DatabaseError | null) => void): void;
  /**
   * Runs ONE statement and returns at most `options.maxRows` rows. At most one
   * statement runs per session at a time (QUERY_IN_PROGRESS otherwise).
   */
  execute(sql: string, options: QueryOptions): Promise<QueryOutcome>;
  /** Cancels the running statement, if any. Resolves true when a cancel was sent. */
  cancel(): Promise<boolean>;
  /**
   * Catalog reads for the object explorer. They use their own short-lived
   * connection, so they work while a user statement is running (ADR-0005).
   */
  listSchemas(): Promise<Limited<string>>;
  listRelations(schema: string): Promise<Limited<RelationEntry>>;
  describeRelation(
    schema: string,
    name: string,
  ): Promise<readonly ColumnInfo[]>;
}

export interface DatabaseAdapter {
  /** Connects, reads the server version, always disconnects. */
  testConnection(config: ConnectionConfig): Promise<ConnectionTestOutcome>;
  openSession(config: ConnectionConfig): Promise<DatabaseSession>;
}
