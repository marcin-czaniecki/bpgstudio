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
}

export interface DatabaseAdapter {
  /** Connects, reads the server version, always disconnects. */
  testConnection(config: ConnectionConfig): Promise<ConnectionTestOutcome>;
  openSession(config: ConnectionConfig): Promise<DatabaseSession>;
}
