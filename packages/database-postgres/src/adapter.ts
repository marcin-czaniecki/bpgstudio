import { randomUUID } from "node:crypto";
import type {
  ConnectionConfig,
  ConnectionTestOutcome,
  DatabaseAdapter,
  DatabaseError,
  DatabaseSession,
  SessionDetails,
} from "@bpg/database-core";
import { Client } from "pg";
import { databaseError, mapPgError } from "./error-mapping";

/** Minimal client surface the adapter needs; lets tests inject a fake. */
export interface PgClientLike {
  connect(): Promise<void>;
  query(text: string): Promise<Array<Record<string, unknown>>>;
  end(): Promise<void>;
  onError(listener: () => void): void;
  onEnd(listener: () => void): void;
}

export type PgClientFactory = (config: ConnectionConfig) => PgClientLike;

const defaultClientFactory: PgClientFactory = (config) => {
  const client = new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    // verify-full: certificate chain AND hostname are verified, no fallback.
    ssl:
      config.sslMode === "verify-full" ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: config.connectTimeoutMs,
    query_timeout: config.connectTimeoutMs,
    application_name: "BPG Studio",
  });
  return {
    connect: async () => {
      await client.connect();
    },
    query: async (text) => {
      const result = await client.query(text);
      return result.rows as Array<Record<string, unknown>>;
    },
    end: () => client.end(),
    onError: (listener) => {
      client.on("error", listener);
    },
    onEnd: (listener) => {
      client.on("end", listener);
    },
  };
};

async function connectAndReadVersion(
  client: PgClientLike,
): Promise<{ serverVersion: string; latencyMs: number }> {
  const started = performance.now();
  // An 'error' event without a listener crashes the whole main process.
  client.onError(() => {});
  await client.connect();
  const rows = await client.query("SHOW server_version");
  const version = rows[0]?.server_version;
  if (typeof version !== "string" || version.length === 0) {
    throw databaseError("UNKNOWN");
  }
  return {
    serverVersion: version,
    latencyMs: Math.round(performance.now() - started),
  };
}

async function quietEnd(client: PgClientLike): Promise<void> {
  try {
    await client.end();
  } catch {
    // Already closed or never connected: nothing to release.
  }
}

class PostgresSession implements DatabaseSession {
  readonly id = randomUUID();
  readonly info: SessionDetails;
  readonly #client: PgClientLike;
  readonly #listeners: Array<(reason: DatabaseError | null) => void> = [];
  #closing = false;
  #finished = false;
  #reason: DatabaseError | null = null;

  constructor(client: PgClientLike, info: SessionDetails) {
    this.#client = client;
    this.info = info;
    // Server-side drops (restart, pg_terminate_backend, network) surface here.
    client.onError(() => this.#finish(this.#closing ? null : lost()));
    client.onEnd(() => this.#finish(this.#closing ? null : lost()));
  }

  onClosed(listener: (reason: DatabaseError | null) => void): void {
    if (this.#finished) {
      listener(this.#reason);
      return;
    }
    this.#listeners.push(listener);
  }

  async close(): Promise<void> {
    if (this.#closing || this.#finished) return;
    this.#closing = true;
    await quietEnd(this.#client);
    this.#finish(null);
  }

  #finish(reason: DatabaseError | null): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#reason = reason;
    for (const listener of this.#listeners.splice(0)) listener(reason);
  }
}

const lost = (): DatabaseError => databaseError("CONNECTION_LOST");

export function createPostgresAdapter(
  createClient: PgClientFactory = defaultClientFactory,
): DatabaseAdapter {
  return {
    async testConnection(config): Promise<ConnectionTestOutcome> {
      const client = createClient(config);
      try {
        return await connectAndReadVersion(client);
      } catch (error: unknown) {
        throw mapPgError(error);
      } finally {
        await quietEnd(client);
      }
    },

    async openSession(config): Promise<DatabaseSession> {
      const client = createClient(config);
      try {
        const { serverVersion } = await connectAndReadVersion(client);
        return new PostgresSession(client, {
          host: config.host,
          port: config.port,
          database: config.database,
          user: config.user,
          sslMode: config.sslMode,
          serverVersion,
          openedAt: new Date().toISOString(),
        });
      } catch (error: unknown) {
        await quietEnd(client);
        throw mapPgError(error);
      }
    },
  };
}
