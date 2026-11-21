import type { ConnectionConfig } from "@bpg/database-core";
import { DatabaseError, QueryError } from "@bpg/database-core";
import { describe, expect, it, vi } from "vitest";
import {
  type CursorResult,
  createPgClientConfig,
  createPostgresAdapter,
  type PgClientLike,
  scrubPgEnvironment,
} from "./adapter";
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
  cursorCalls: Array<{ text: string; maxRows: number }> = [];
  /** Settles the in-flight runCursor; set while a statement is "running". */
  finishCursor: ((outcome: CursorResult | unknown) => void) | undefined;
  cursorImpl:
    | ((text: string, maxRows: number) => Promise<CursorResult>)
    | null = null;

  processId(): number | null {
    return 4242;
  }
  async runCursor(text: string, maxRows: number): Promise<CursorResult> {
    this.cursorCalls.push({ text, maxRows });
    if (this.cursorImpl) return this.cursorImpl(text, maxRows);
    return {
      fields: [{ name: "one", dataTypeID: 23 }],
      rows: [[1]],
      command: "SELECT",
      rowCount: 1,
    };
  }

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
  async query(_text?: string): Promise<Array<Record<string, unknown>>> {
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
    [
      new Error(
        "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string",
      ),
      "AUTH_FAILED",
    ],
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

describe("credential isolation", () => {
  it("passes the password as a function so pg never reads PGPASSWORD/pgpass", () => {
    const options = createPgClientConfig({ ...config, password: "" });
    expect(typeof options.password).toBe("function");
    expect((options.password as () => string)()).toBe("");
  });

  it("removes every PG* variable from the environment", () => {
    const env: NodeJS.ProcessEnv = {
      PGPASSWORD: "dev-secret",
      PGOPTIONS: "-c x=1",
      PGPASSFILE: "/home/dev/.pgpass",
      PATH: "/usr/bin",
    };
    scrubPgEnvironment(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("scrubs the real environment when an adapter is created", () => {
    process.env.PGPASSWORD = "dev-secret";
    createPostgresAdapter(() => new FakeClient());
    expect(process.env.PGPASSWORD).toBeUndefined();
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

describe("session.execute", () => {
  async function open(client: FakeClient, cancelClient?: () => FakeClient) {
    let first = true;
    const adapter = createPostgresAdapter(() => {
      if (first) {
        first = false;
        return client;
      }
      return cancelClient ? cancelClient() : new FakeClient();
    });
    return adapter.openSession(config);
  }

  it("returns serialized rows, columns and the server command", async () => {
    const client = new FakeClient();
    client.cursorImpl = async () => ({
      fields: [
        { name: "id", dataTypeID: 20 },
        { name: "at", dataTypeID: 1184 },
        { name: "blob", dataTypeID: 17 },
        { name: "doc", dataTypeID: 3802 },
        { name: "nothing", dataTypeID: 25 },
      ],
      rows: [
        [
          "9007199254740993",
          new Date("2026-01-02T03:04:05Z"),
          Buffer.from([1, 255]),
          { a: [1] },
          null,
        ],
      ],
      command: "SELECT",
      rowCount: 1,
    });
    const session = await open(client);
    const out = await session.execute("select 1", {
      maxRows: 10,
      timeoutMs: 5000,
    });
    expect(out.columns.map((c) => c.name)).toEqual([
      "id",
      "at",
      "blob",
      "doc",
      "nothing",
    ]);
    expect(out.rows).toEqual([
      [
        "9007199254740993",
        "2026-01-02T03:04:05.000Z",
        "\\x01ff",
        '{"a":[1]}',
        null,
      ],
    ]);
    expect(out.truncated).toBe(false);
    expect(out.command).toBe("SELECT");
  });

  it("reads maxRows + 1 and reports truncation without returning the extra row", async () => {
    const client = new FakeClient();
    client.cursorImpl = async (_t, maxRows) => ({
      fields: [{ name: "n", dataTypeID: 23 }],
      rows: Array.from({ length: maxRows }, (_, i) => [i]),
      command: "SELECT",
      rowCount: null,
    });
    const session = await open(client);
    const out = await session.execute("select n", {
      maxRows: 3,
      timeoutMs: 5000,
    });
    expect(client.cursorCalls[0]?.maxRows).toBe(3);
    // The fake returned exactly maxRows rows (no extra): not truncated.
    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(false);

    client.cursorImpl = async (_t, maxRows) => ({
      fields: [{ name: "n", dataTypeID: 23 }],
      rows: Array.from({ length: maxRows + 1 }, (_, i) => [i]),
      command: "SELECT",
      rowCount: null,
    });
    const cut = await session.execute("select n", {
      maxRows: 3,
      timeoutMs: 5000,
    });
    expect(cut.rows).toHaveLength(3);
    expect(cut.truncated).toBe(true);
  });

  it("uses the server row count for statements that return no rows", async () => {
    const client = new FakeClient();
    client.cursorImpl = async () => ({
      fields: [],
      rows: [],
      command: "UPDATE",
      rowCount: 7,
    });
    const out = await (await open(client)).execute("update t set a = 1", {
      maxRows: 10,
      timeoutMs: 5000,
    });
    expect(out).toMatchObject({
      command: "UPDATE",
      rowCount: 7,
      columns: [],
      rows: [],
    });
  });

  it("refuses a second concurrent statement with QUERY_IN_PROGRESS", async () => {
    const client = new FakeClient();
    let release: (() => void) | undefined;
    client.cursorImpl = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ fields: [], rows: [], command: "SELECT", rowCount: 0 });
      });
    const session = await open(client);
    const first = session.execute("select pg_sleep(1)", {
      maxRows: 1,
      timeoutMs: 5000,
    });
    await expect(
      session.execute("select 2", { maxRows: 1, timeoutMs: 5000 }),
    ).rejects.toMatchObject({
      code: "QUERY_IN_PROGRESS",
    });
    release?.();
    await first;
    // The guard is released afterwards.
    client.cursorImpl = null;
    await expect(
      session.execute("select 3", { maxRows: 1, timeoutMs: 5000 }),
    ).resolves.toBeDefined();
  });

  it("maps a server SQL error and keeps position, detail and hint", async () => {
    const client = new FakeClient();
    client.cursorImpl = async () => {
      throw Object.assign(new Error('syntax error at or near "selec"'), {
        severity: "ERROR",
        code: "42601",
        position: "1",
        detail: "d",
        hint: "h",
      });
    };
    const session = await open(client);
    const error = await session
      .execute("selec 1", { maxRows: 1, timeoutMs: 5000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QueryError);
    expect(error).toMatchObject({
      code: "QUERY_FAILED",
      message: 'syntax error at or near "selec"',
      details: { sqlState: "42601", position: 1, detail: "d", hint: "h" },
    });
  });

  it("maps a connection-class failure to a fixed safe message, not QUERY_FAILED", async () => {
    const client = new FakeClient();
    client.cursorImpl = async () => {
      throw Object.assign(
        new Error(
          "terminating connection due to administrator command at host x",
        ),
        {
          severity: "FATAL",
          code: "57P01",
        },
      );
    };
    const error = await (await open(client))
      .execute("select 1", { maxRows: 1, timeoutMs: 5000 })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "CONNECTION_LOST",
      message: "Connection lost",
    });
  });

  it("cancel() sends pg_cancel_backend for this session's pid from a second connection", async () => {
    const client = new FakeClient();
    const queries: string[] = [];
    const canceller = new FakeClient();
    canceller.query = async (text: string) => {
      queries.push(text);
      return [{ ok: true }];
    };
    let rejectRun: ((e: unknown) => void) | undefined;
    client.cursorImpl = () =>
      new Promise((_, reject) => {
        rejectRun = reject;
      });
    const session = await open(client, () => canceller);
    const running = session.execute("select pg_sleep(60)", {
      maxRows: 1,
      timeoutMs: 600000,
    });
    expect(await session.cancel()).toBe(true);
    expect(queries).toEqual(["SELECT pg_cancel_backend(4242) AS ok"]);
    expect(canceller.endCalls).toBe(1);
    rejectRun?.(
      Object.assign(new Error("canceling statement due to user request"), {
        severity: "ERROR",
        code: "57014",
      }),
    );
    await expect(running).rejects.toMatchObject({ code: "QUERY_CANCELLED" });
  });

  it("cancel() does nothing when no statement is running", async () => {
    const session = await open(new FakeClient());
    expect(await session.cancel()).toBe(false);
  });

  it("a timeout cancels the statement and reports QUERY_TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      const canceller = new FakeClient();
      canceller.query = async () => [{ ok: true }];
      let rejectRun: ((e: unknown) => void) | undefined;
      client.cursorImpl = () =>
        new Promise((_, reject) => {
          rejectRun = reject;
        });
      const session = await open(client, () => canceller);
      const running = session.execute("select pg_sleep(60)", {
        maxRows: 1,
        timeoutMs: 1000,
      });
      const assertion = expect(running).rejects.toMatchObject({
        code: "QUERY_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(1000);
      rejectRun?.(
        Object.assign(new Error("canceling statement due to user request"), {
          severity: "ERROR",
          code: "57014",
        }),
      );
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects execute on a session that was closed", async () => {
    const session = await open(new FakeClient());
    await session.close();
    await expect(
      session.execute("select 1", { maxRows: 1, timeoutMs: 5000 }),
    ).rejects.toMatchObject({
      code: "CONNECTION_LOST",
    });
  });
});
