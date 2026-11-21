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
