import { DatabaseSync } from "node:sqlite";
import type { ProfileRepository, StoredProfile } from "@bpg/database-core";

const SCHEMA_VERSION = 1;

interface ProfileRow {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl_mode: string;
  connect_timeout_ms: number;
  secret_ref: string | null;
  created_at: string;
  updated_at: string;
}

function toSslMode(value: string): "disable" | "verify-full" {
  if (value === "disable" || value === "verify-full") return value;
  // Never silently downgrade TLS for a damaged row.
  throw new Error("Corrupt profile row: unknown TLS mode");
}

function toProfile(row: ProfileRow): StoredProfile {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    database: row.database,
    user: row.user,
    sslMode: toSslMode(row.ssl_mode),
    connectTimeoutMs: row.connect_timeout_ms,
    secretRef: row.secret_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Forward-only migrations keyed by PRAGMA user_version. */
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (row.user_version > SCHEMA_VERSION) {
    throw new Error("Database was created by a newer version of BPG Studio");
  }
  if (row.user_version < 1) {
    db.exec(`
      BEGIN;
      CREATE TABLE connection_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        database TEXT NOT NULL,
        user TEXT NOT NULL,
        ssl_mode TEXT NOT NULL,
        connect_timeout_ms INTEGER NOT NULL,
        secret_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
}

/**
 * Local profile storage. Holds only non-secret data plus an opaque `secret_ref`;
 * passwords live in the SecretStore. Electron-free so it runs under plain Node.
 */
export class SqliteProfileRepository implements ProfileRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      migrate(this.db);
    } catch (error: unknown) {
      this.db.close();
      throw error;
    }
  }

  list(): StoredProfile[] {
    const rows = this.db
      .prepare("SELECT * FROM connection_profiles ORDER BY name COLLATE NOCASE")
      .all() as unknown as ProfileRow[];
    return rows.map(toProfile);
  }

  get(id: string): StoredProfile | null {
    const row = this.db
      .prepare("SELECT * FROM connection_profiles WHERE id = ?")
      .get(id) as unknown as ProfileRow | undefined;
    return row ? toProfile(row) : null;
  }

  upsert(profile: StoredProfile): void {
    this.db
      .prepare(
        `INSERT INTO connection_profiles
           (id, name, host, port, database, user, ssl_mode, connect_timeout_ms,
            secret_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, host = excluded.host, port = excluded.port,
           database = excluded.database, user = excluded.user,
           ssl_mode = excluded.ssl_mode,
           connect_timeout_ms = excluded.connect_timeout_ms,
           secret_ref = excluded.secret_ref, updated_at = excluded.updated_at`,
      )
      .run(
        profile.id,
        profile.name,
        profile.host,
        profile.port,
        profile.database,
        profile.user,
        profile.sslMode,
        profile.connectTimeoutMs,
        profile.secretRef,
        profile.createdAt,
        profile.updatedAt,
      );
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM connection_profiles WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
