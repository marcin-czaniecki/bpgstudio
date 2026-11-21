import type { ConnectionConfig } from "@bpg/database-core";
import { DatabaseError } from "@bpg/database-core";
import { describe, expect, it, vi } from "vitest";
import { createPostgresAdapter, type PgClientLike } from "./adapter";
import { mapPgError } from "./error-mapping";

const config: ConnectionConfig = {
  host: "db.internal",
  port: 5432,
  database: "app",
  user: "app",
  password: "hunter2",
  sslMode: "disable",
  connectTimeoutMs: 1000,
};

class FakeClient implements PgClientLike {
  endCalls = 0;
  errorListeners: Array<() => void> = [];
  endListeners: Array<() => void> = [];

  constructor(
    private readonly options: {
      connectError?: unknown;
      version?: unknown;
      endThrows?: boolean;
    } = {},
  ) {}

  async connect(): Promise<void> {
    if (this.options.connectError !== undefined)
      throw this.options.connectError;
  }
  async query(): Promise<Array<Record<string, unknown>>> {
    return [
      {
        server_version:
          "version" in this.options ? this.options.version : "17.2",
      },
    ];
  }
  async end(): Promise<void> {
    this.endCalls += 1;
    if (this.options.endThrows) throw new Error("already ended");
    for (const l of this.endListeners) l();
  }
  onError(listener: () => void): void {
    this.errorListeners.push(listener);
  }
  onEnd(listener: () => void): void {
    this.endListeners.push(listener);
  }
  /** Simulates pg_terminate_backend: error + end, without our end() call. */
  serverDrops(): void {
    for (const l of this.errorListeners) l();
    for (const l of this.endListeners) l();
  }
}

describe("mapPgError", () => {
  it.each([
    [{ code: "28P01" }, "AUTH_FAILED"],
    [{ code: "28000" }, "AUTH_FAILED"],
    [{ code: "3D000" }, "DATABASE_NOT_FOUND"],
    [{ code: "57P01" }, "CONNECTION_LOST"],
    [{ code: "08006" }, "CONNECTION_LOST"],
    [{ code: "ECONNREFUSED" }, "HOST_UNREACHABLE"],
    [{ code: "ENOTFOUND" }, "HOST_UNREACHABLE"],
    [{ code: "ETIMEDOUT" }, "TIMEOUT"],
    [new Error("timeout expired"), "TIMEOUT"],
    [new Error("Connection terminated due to connection timeout"), "TIMEOUT"],
    [new Error("Connection terminated unexpectedly"), "CONNECTION_LOST"],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "TLS_ERROR"],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "TLS_ERROR"],
    [new Error("The server does not support SSL connections"), "TLS_ERROR"],
    [new Error("something odd"), "UNKNOWN"],
    ["not an error", "UNKNOWN"],
    [null, "UNKNOWN"],
  ])("maps %j to %s", (input, expected) => {
    expect(mapPgError(input).code).toBe(expected);
  });

  it("never forwards driver text", () => {
    const mapped = mapPgError({
      code: "28P01",
      message: 'password authentication failed for user "app" hunter2',
    });
    expect(mapped.message).toBe("Authentication failed");
    expect(mapped.message).not.toContain("hunter2");
  });

  it("passes a DatabaseError through unchanged", () => {
    const error = new DatabaseError("TIMEOUT", "Connection timed out");
    expect(mapPgError(error)).toBe(error);
  });
});

describe("testConnection", () => {
  it("returns the server version and always disconnects", async () => {
    const client = new FakeClient();
    const adapter = createPostgresAdapter(() => client);
    const result = await adapter.testConnection(config);
    expect(result.serverVersion).toBe("17.2");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(client.endCalls).toBe(1);
  });

  it("maps a connect failure, disconnects and leaks no secret", async () => {
    const client = new FakeClient({
      connectError: Object.assign(new Error("password hunter2 rejected"), {
        code: "28P01",
      }),
    });
    const adapter = createPostgresAdapter(() => client);
    const error = await adapter.testConnection(config).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toBe("AUTH_FAILED");
    expect(JSON.stringify(error)).not.toContain("hunter2");
    expect((error as DatabaseError).message).not.toContain("hunter2");
    expect(client.endCalls).toBe(1);
  });

  it("rejects an unreadable version as UNKNOWN", async () => {
    const adapter = createPostgresAdapter(
      () => new FakeClient({ version: 17 }),
    );
    await expect(adapter.testConnection(config)).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  it("does not throw if end() fails", async () => {
    const adapter = createPostgresAdapter(
      () => new FakeClient({ endThrows: true }),
    );
    await expect(adapter.testConnection(config)).resolves.toBeDefined();
  });
});

describe("openSession", () => {
  it("opens a session without the password in its info", async () => {
    const adapter = createPostgresAdapter(() => new FakeClient());
    const session = await adapter.openSession(config);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.info.serverVersion).toBe("17.2");
    expect(JSON.stringify(session)).not.toContain("hunter2");
    await session.close();
  });

  it("close is idempotent and reports a normal close (null reason)", async () => {
    const client = new FakeClient();
    const adapter = createPostgresAdapter(() => client);
    const session = await adapter.openSession(config);
    const listener = vi.fn();
    session.onClosed(listener);
    await session.close();
    await session.close();
    expect(client.endCalls).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it("survives a server-side drop and reports CONNECTION_LOST once", async () => {
    const client = new FakeClient();
    const adapter = createPostgresAdapter(() => client);
    const session = await adapter.openSession(config);
    const listener = vi.fn();
    session.onClosed(listener);

    expect(() => client.serverDrops()).not.toThrow();

    expect(listener).toHaveBeenCalledTimes(1);
    const reason = listener.mock.calls[0]?.[0] as DatabaseError;
    expect(reason.code).toBe("CONNECTION_LOST");
    await expect(session.close()).resolves.toBeUndefined();
    expect(client.endCalls).toBe(0);
  });

  it("notifies late listeners of an already-ended session", async () => {
    const client = new FakeClient();
    const session = await createPostgresAdapter(() => client).openSession(
      config,
    );
    client.serverDrops();
    const late = vi.fn();
    session.onClosed(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("releases the client when opening fails", async () => {
    const client = new FakeClient({ connectError: { code: "3D000" } });
    const adapter = createPostgresAdapter(() => client);
    await expect(adapter.openSession(config)).rejects.toMatchObject({
      code: "DATABASE_NOT_FOUND",
    });
    expect(client.endCalls).toBe(1);
  });
});
