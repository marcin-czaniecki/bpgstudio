import { randomUUID } from "node:crypto";
import {
  type ConnectionConfig,
  type ConnectionTestOutcome,
  type DatabaseAdapter,
  type DatabaseError,
  type DatabaseSession,
  QueryError,
  type QueryOptions,
  type QueryOutcome,
  type SessionDetails,
} from "@bpg/database-core";
import { Client, type ClientConfig } from "pg";
import Cursor from "pg-cursor";
import { databaseError, mapPgError } from "./error-mapping";
import { mapQueryError } from "./query-error";
import { toCell } from "./serialize";

/** Minimal client surface the adapter needs; lets tests inject a fake. */
export interface PgClientLike {
  connect(): Promise<void>;
  query(text: string): Promise<Array<Record<string, unknown>>>;
  end(): Promise<void>;
  onError(listener: () => void): void;
  onEnd(listener: () => void): void;
  /** Backend process id, known after connect. Used to cancel a running statement. */
  processId(): number | null;
  /** Runs one statement through a cursor, reading at most maxRows + 1 rows. */
  runCursor(text: string, maxRows: number): Promise<CursorResult>;
}

export interface CursorResult {
  readonly fields: ReadonlyArray<{ name: string; dataTypeID: number }>;
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
  readonly command: string;
  readonly rowCount: number | null;
}

export type PgClientFactory = (config: ConnectionConfig) => PgClientLike;

/**
 * pg falls back to PGPASSWORD / PGOPTIONS / pgpass when a value is falsy (an
 * empty password included), which would let a renderer-chosen host receive the
 * developer's own secrets. Remove every PG* variable and pass the password as a
 * function, which makes pg skip env and pgpass entirely.
 */
export function scrubPgEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith("PG")) delete env[key];
  }
}

export function createPgClientConfig(config: ConnectionConfig): ClientConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: () => config.password,
    // verify-full: certificate chain AND hostname are verified, no fallback.
    ssl:
      config.sslMode === "verify-full" ? { rejectUnauthorized: true } : false,
    // No query_timeout here: it would also kill long user statements. The
    // handshake query is bounded separately (connectAndReadVersion).
    connectionTimeoutMillis: config.connectTimeoutMs,
    application_name: "BPG Studio",
  };
}

const defaultClientFactory: PgClientFactory = (config) => {
  const client = new Client(createPgClientConfig(config));
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
    processId: () => {
      const pid = (client as Client & { processID?: number | null }).processID;
      return typeof pid === "number" ? pid : null;
    },
    runCursor: async (text, maxRows) => {
      const cursor = client.query(
        new Cursor<unknown[]>(text, undefined, { rowMode: "array" }),
      );
      try {
        const { rows, result } = await new Promise<{
          rows: unknown[][];
          result: {
            fields?: Array<{ name: string; dataTypeID: number }>;
            command?: string | null;
            rowCount?: number | null;
          };
        }>((resolve, reject) => {
          cursor.read(maxRows + 1, (error, batch, outcome) => {
            if (error) reject(error);
            else resolve({ rows: batch, result: outcome });
          });
        });
        return {
          fields: result.fields ?? [],
          rows,
          command: result.command ?? "",
          rowCount:
            typeof result.rowCount === "number" ? result.rowCount : null,
        };
      } finally {
        await cursor.close().catch(() => undefined);
      }
    },
  };
};

async function connectAndReadVersion(
  client: PgClientLike,
  timeoutMs: number,
): Promise<{ serverVersion: string; latencyMs: number }> {
  const started = performance.now();
  // An 'error' event without a listener crashes the whole main process.
  client.onError(() => {});
  await client.connect();
  let timer: NodeJS.Timeout | undefined;
  const rows = await Promise.race([
    client.query("SHOW server_version"),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(databaseError("TIMEOUT")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
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
  readonly #cancelBackend: (pid: number) => Promise<boolean>;
  #closing = false;
  #finished = false;
  #reason: DatabaseError | null = null;
  #running = false;
  #cancelledBy: "user" | "timeout" | null = null;

  constructor(
    client: PgClientLike,
    info: SessionDetails,
    cancelBackend: (pid: number) => Promise<boolean>,
  ) {
    this.#client = client;
    this.info = info;
    this.#cancelBackend = cancelBackend;
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

  async execute(sql: string, options: QueryOptions): Promise<QueryOutcome> {
    if (this.#finished || this.#closing) throw lost();
    if (this.#running) {
      throw new QueryError(
        "QUERY_IN_PROGRESS",
        "A query is already running on this session",
      );
    }
    this.#running = true;
    this.#cancelledBy = null;
    const started = performance.now();
    const timer = setTimeout(() => {
      void this.#cancel("timeout");
    }, options.timeoutMs);
    try {
      const result = await this.#client.runCursor(sql, options.maxRows);
      const truncated = result.rows.length > options.maxRows;
      const kept = truncated
        ? result.rows.slice(0, options.maxRows)
        : result.rows;
      return {
        command: result.command,
        rowCount: result.fields.length > 0 ? kept.length : result.rowCount,
        columns: result.fields.map((f) => ({
          name: f.name,
          typeId: f.dataTypeID,
        })),
        rows: kept.map((row) => row.map(toCell)),
        truncated,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error: unknown) {
      throw mapQueryError(error, this.#cancelledBy);
    } finally {
      clearTimeout(timer);
      this.#running = false;
    }
  }

  cancel(): Promise<boolean> {
    return this.#cancel("user");
  }

  async #cancel(by: "user" | "timeout"): Promise<boolean> {
    if (!this.#running || this.#finished) return false;
    const pid = this.#client.processId();
    if (pid === null) return false;
    this.#cancelledBy ??= by;
    try {
      return await this.#cancelBackend(pid);
    } catch {
      return false;
    }
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

/** Sends pg_cancel_backend from a short-lived second connection. */
async function cancelBackend(
  createClient: PgClientFactory,
  config: ConnectionConfig,
  pid: number,
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const client = createClient(config);
  client.onError(() => {});
  try {
    await client.connect();
    const rows = await client.query(`SELECT pg_cancel_backend(${pid}) AS ok`);
    return rows[0]?.ok === true;
  } finally {
    await quietEnd(client);
  }
}

export function createPostgresAdapter(
  createClient: PgClientFactory = defaultClientFactory,
): DatabaseAdapter {
  scrubPgEnvironment();
  return {
    async testConnection(config): Promise<ConnectionTestOutcome> {
      const client = createClient(config);
      try {
        return await connectAndReadVersion(client, config.connectTimeoutMs);
      } catch (error: unknown) {
        throw mapPgError(error);
      } finally {
        await quietEnd(client);
      }
    },

    async openSession(config): Promise<DatabaseSession> {
      const client = createClient(config);
      try {
        const { serverVersion } = await connectAndReadVersion(
          client,
          config.connectTimeoutMs,
        );
        return new PostgresSession(
          client,
          {
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
            sslMode: config.sslMode,
            serverVersion,
            openedAt: new Date().toISOString(),
          },
          // The config (with the password) stays in this closure, in main only.
          (pid) => cancelBackend(createClient, config, pid),
        );
      } catch (error: unknown) {
        await quietEnd(client);
        throw mapPgError(error);
      }
    },
  };
}
