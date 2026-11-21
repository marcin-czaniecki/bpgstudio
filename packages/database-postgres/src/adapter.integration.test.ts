import type { ConnectionConfig, DatabaseError } from "@bpg/database-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresAdapter } from "./adapter";

/**
 * Runs against a real, disposable PostgreSQL (see compose.test.yaml). Skipped
 * unless BPG_PG_TEST_URL is set, and refuses non-loopback hosts so it can never
 * touch a real database by accident.
 */
const url = process.env.BPG_PG_TEST_URL;
const LOOPBACK = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "postgres",
]);

function parse(raw: string): ConnectionConfig {
  const u = new URL(raw);
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error(`Refusing non-loopback test host: ${u.hostname}`);
  }
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.slice(1),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    sslMode: "disable",
    connectTimeoutMs: 3000,
  };
}

async function backendCount(admin: Client): Promise<number> {
  const result = await admin.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'BPG Studio'",
  );
  return (result.rows[0] as { n: number }).n;
}

async function waitFor(check: () => Promise<boolean>, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe.skipIf(!url)("PostgreSQL adapter (integration)", () => {
  const base = parse(url ?? "postgres://x:y@localhost/z");
  const adapter = createPostgresAdapter();
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ ...base, connectionTimeoutMillis: 3000 });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
  });

  it("tests a good connection and reports the server version", async () => {
    const result = await adapter.testConnection(base);
    expect(result.serverVersion).toMatch(/^\d+/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps a wrong password to AUTH_FAILED without leaking it", async () => {
    const error = await adapter
      .testConnection({ ...base, password: "definitely-wrong-pw" })
      .catch((e: unknown) => e as DatabaseError);
    expect(error).toMatchObject({ code: "AUTH_FAILED" });
    expect(String((error as Error).message)).not.toContain(
      "definitely-wrong-pw",
    );
  });

  it("does not fall back to PGPASSWORD when the password is empty", async () => {
    process.env.PGPASSWORD = base.password;
    const fresh = createPostgresAdapter(); // scrubs PG* from the environment
    await expect(
      fresh.testConnection({ ...base, password: "" }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("maps a missing database to DATABASE_NOT_FOUND", async () => {
    await expect(
      adapter.testConnection({ ...base, database: "no_such_db_bpg" }),
    ).rejects.toMatchObject({ code: "DATABASE_NOT_FOUND" });
  });

  it("maps a closed port to HOST_UNREACHABLE", async () => {
    await expect(
      adapter.testConnection({ ...base, port: 1 }),
    ).rejects.toMatchObject({ code: "HOST_UNREACHABLE" });
  });

  it("maps a server without TLS to TLS_ERROR when verify-full is required", async () => {
    await expect(
      adapter.testConnection({ ...base, sslMode: "verify-full" }),
    ).rejects.toMatchObject({ code: "TLS_ERROR" });
  });

  it("open -> close leaves no backend behind", async () => {
    const before = await backendCount(admin);
    const session = await adapter.openSession(base);
    expect(await backendCount(admin)).toBe(before + 1);
    await session.close();
    expect(
      await waitFor(async () => (await backendCount(admin)) === before),
    ).toBe(true);
  });

  it("testConnection leaves no backend behind", async () => {
    const before = await backendCount(admin);
    await adapter.testConnection(base);
    expect(
      await waitFor(async () => (await backendCount(admin)) === before),
    ).toBe(true);
  });

  it("survives pg_terminate_backend: reports CONNECTION_LOST, no crash", async () => {
    const session = await adapter.openSession(base);
    const onClosed = vi.fn();
    session.onClosed(onClosed);

    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'BPG Studio' AND pid <> pg_backend_pid()",
    );

    expect(await waitFor(async () => onClosed.mock.calls.length > 0)).toBe(
      true,
    );
    expect(onClosed).toHaveBeenCalledTimes(1);
    const [reason] = onClosed.mock.calls[0] ?? [];
    expect(reason).toMatchObject({ code: "CONNECTION_LOST" });
    await expect(session.close()).resolves.toBeUndefined();
  });
});

describe.skipIf(!url)(
  "PostgreSQL adapter: query execution (integration)",
  () => {
    const base = parse(url ?? "postgres://x:y@localhost/z");
    const adapter = createPostgresAdapter();
    const opts = { maxRows: 1000, timeoutMs: 20000 };

    async function withSession<T>(
      fn: (s: Awaited<ReturnType<typeof adapter.openSession>>) => Promise<T>,
    ): Promise<T> {
      const session = await adapter.openSession(base);
      try {
        return await fn(session);
      } finally {
        await session.close();
      }
    }

    it("truncates at maxRows without loading the whole result", async () => {
      await withSession(async (s) => {
        const out = await s.execute(
          "SELECT g FROM generate_series(1, 5000) g",
          {
            ...opts,
            maxRows: 100,
          },
        );
        expect(out.rows).toHaveLength(100);
        expect(out.truncated).toBe(true);
        expect(out.rows[0]).toEqual([1]);
        // The session is still usable after an early cursor close.
        const next = await s.execute("SELECT 1 AS one", opts);
        expect(next.rows).toEqual([[1]]);
      });
    });

    it("serializes common PostgreSQL types", async () => {
      await withSession(async (s) => {
        const out = await s.execute(
          `SELECT 9007199254740993::int8 AS big, 1.50::numeric AS num,
                '2026-01-02 03:04:05+00'::timestamptz AS ts, decode('01ff', 'hex') AS b,
                '{"a":[1,null]}'::jsonb AS j, ARRAY[1,2,3] AS arr, NULL AS nothing,
                true AS flag, 'é'::text AS txt`,
          opts,
        );
        expect(out.columns.map((c) => c.name)).toEqual([
          "big",
          "num",
          "ts",
          "b",
          "j",
          "arr",
          "nothing",
          "flag",
          "txt",
        ]);
        expect(out.rows[0]).toEqual([
          "9007199254740993",
          "1.50",
          "2026-01-02T03:04:05.000Z",
          "\u005cx01ff",
          '{"a":[1,null]}',
          "[1,2,3]",
          null,
          true,
          "é",
        ]);
      });
    });

    it("keeps duplicate column names (array row mode)", async () => {
      await withSession(async (s) => {
        const out = await s.execute("SELECT 1 AS a, 2 AS a", opts);
        expect(out.columns.map((c) => c.name)).toEqual(["a", "a"]);
        expect(out.rows).toEqual([[1, 2]]);
      });
    });

    it("reports the command and affected rows for statements without a result set", async () => {
      await withSession(async (s) => {
        await s.execute("CREATE TEMP TABLE bpg_tmp (a int)", opts);
        const ins = await s.execute(
          "INSERT INTO bpg_tmp VALUES (1), (2)",
          opts,
        );
        expect(ins).toMatchObject({ command: "INSERT", rowCount: 2, rows: [] });
      });
    });

    it("returns a SQL error with SQLSTATE and position, and stays usable", async () => {
      await withSession(async (s) => {
        const error = await s.execute("SELEC 1", opts).catch((e: unknown) => e);
        expect(error).toMatchObject({
          code: "QUERY_FAILED",
          details: { sqlState: "42601", position: 1 },
        });
        expect((await s.execute("SELECT 2", opts)).rows).toEqual([[2]]);
      });
    });

    it("rejects multiple statements in one run", async () => {
      await withSession(async (s) => {
        await expect(
          s.execute("SELECT 1; SELECT 2", opts),
        ).rejects.toMatchObject({
          code: "QUERY_FAILED",
        });
      });
    });

    it("cancels a long query quickly and stays usable", async () => {
      await withSession(async (s) => {
        const started = Date.now();
        const running = s.execute("SELECT pg_sleep(30)", {
          ...opts,
          timeoutMs: 120000,
        });
        await new Promise((r) => setTimeout(r, 300));
        const assertion = expect(running).rejects.toMatchObject({
          code: "QUERY_CANCELLED",
        });
        expect(await s.cancel()).toBe(true);
        await assertion;
        expect(Date.now() - started).toBeLessThan(5000);
        expect((await s.execute("SELECT 3", opts)).rows).toEqual([[3]]);
      });
    });

    it("times out a long query as QUERY_TIMEOUT", async () => {
      await withSession(async (s) => {
        const started = Date.now();
        await expect(
          s.execute("SELECT pg_sleep(30)", { ...opts, timeoutMs: 1000 }),
        ).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });
        expect(Date.now() - started).toBeLessThan(6000);
      });
    });

    it("a second concurrent statement gets QUERY_IN_PROGRESS", async () => {
      await withSession(async (s) => {
        const first = s.execute("SELECT pg_sleep(1)", opts);
        await expect(s.execute("SELECT 1", opts)).rejects.toMatchObject({
          code: "QUERY_IN_PROGRESS",
        });
        await first;
      });
    });

    it("runs a statement longer than the connect timeout (no query_timeout leak)", async () => {
      const session = await adapter.openSession({
        ...base,
        connectTimeoutMs: 1000,
      });
      try {
        const out = await session.execute(
          "SELECT pg_sleep(1.5), 1 AS one",
          opts,
        );
        expect(out.rows[0]?.[1]).toBe(1);
      } finally {
        await session.close();
      }
    });
  },
);
