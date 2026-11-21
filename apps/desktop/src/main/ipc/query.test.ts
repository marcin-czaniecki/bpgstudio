import { IPC_CHANNELS } from "@bpg/contracts";
import {
  type DatabaseSession,
  QueryError,
  type QueryOptions,
  type QueryOutcome,
  SessionRegistry,
} from "@bpg/database-core";
import { describe, expect, it, vi } from "vitest";
import type { IpcRegistrar } from "./connections";
import { registerQueryHandlers } from "./query";
import type { IpcEventLike, SenderPolicy } from "./trusted-handler";

const frame = { url: "http://localhost:5173/" };
const webContents = { mainFrame: frame };
const trusted: IpcEventLike = { sender: webContents, senderFrame: frame };
const policy: SenderPolicy = {
  expectedSender: () => webContents,
  isAllowedUrl: (url) => url.startsWith("http://localhost:5173"),
};

const SESSION_ID = "7d96633c-0000-4000-8000-000000000001";
type Handler = (event: IpcEventLike, ...args: unknown[]) => Promise<unknown>;

const outcome: QueryOutcome = {
  command: "SELECT",
  rowCount: 1,
  columns: [{ name: "one", typeId: 23 }],
  rows: [[1]],
  truncated: false,
  durationMs: 2,
};

function setup(execute?: DatabaseSession["execute"]) {
  const handlers = new Map<string, Handler>();
  const ipc: IpcRegistrar = { handle: (c, l) => void handlers.set(c, l) };
  const registry = new SessionRegistry<DatabaseSession>();
  const run = vi.fn(
    execute ?? (async (_sql: string, _o: QueryOptions) => outcome),
  );
  const cancel = vi.fn(async () => true);
  registry.add({
    id: SESSION_ID,
    info: {
      host: "localhost",
      port: 5432,
      database: "app",
      user: "app",
      sslMode: "disable",
      serverVersion: "17",
      openedAt: "2026-11-21T00:00:00.000Z",
    },
    execute: run,
    cancel,
    onClosed: () => undefined,
    close: async () => undefined,
  });
  registerQueryHandlers(ipc, { policy, registry });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(trusted, ...args);
  };
  return { handlers, call, run, cancel };
}

describe("query IPC handlers", () => {
  it("registers exactly the query channels", () => {
    expect([...setup().handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.dbExecuteQuery,
        IPC_CHANNELS.dbCancelQuery,
        IPC_CHANNELS.dbGetSchemaHints,
      ].sort(),
    );
  });

  it("refuses an untrusted sender before touching the session", async () => {
    const { handlers, run } = setup();
    const other = { mainFrame: { url: "http://localhost:5173/" } };
    const result = await handlers.get(IPC_CHANNELS.dbExecuteQuery)?.(
      { sender: other, senderFrame: other.mainFrame },
      { sessionId: SESSION_ID, sql: "select 1" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(run).not.toHaveBeenCalled();
  });

  it("applies default limits and returns the result", async () => {
    const { call, run } = setup();
    const result = await call(IPC_CHANNELS.dbExecuteQuery, {
      sessionId: SESSION_ID,
      sql: "select 1",
    });
    expect(result).toEqual({ ok: true, data: outcome });
    expect(run).toHaveBeenCalledWith("select 1", {
      maxRows: 1000,
      timeoutMs: 60000,
    });
  });

  it.each([
    ["unknown key", { sessionId: SESSION_ID, sql: "select 1", extra: 1 }],
    ["blank sql", { sessionId: SESSION_ID, sql: "   " }],
    ["NUL in sql", { sessionId: SESSION_ID, sql: "select\u0000 1" }],
    ["oversized sql", { sessionId: SESSION_ID, sql: "x".repeat(1_000_001) }],
    ["bad session id", { sessionId: "nope", sql: "select 1" }],
    ["maxRows too large", { sessionId: SESSION_ID, sql: "s", maxRows: 10001 }],
    ["timeout too small", { sessionId: SESSION_ID, sql: "s", timeoutMs: 10 }],
    ["not an object", "select 1"],
  ])("rejects %s without running anything", async (_n, payload) => {
    const { call, run } = setup();
    expect(await call(IPC_CHANNELS.dbExecuteQuery, payload)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns SESSION_NOT_FOUND for an unknown session", async () => {
    const { call, run } = setup();
    const result = await call(IPC_CHANNELS.dbExecuteQuery, {
      sessionId: "7d96633c-0000-4000-8000-0000000000ff",
      sql: "select 1",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SESSION_NOT_FOUND" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("passes SQL error details through to the renderer", async () => {
    const { call } = setup(async () => {
      throw new QueryError("QUERY_FAILED", 'syntax error at or near "selec"', {
        sqlState: "42601",
        position: 1,
        hint: "h",
      });
    });
    expect(
      await call(IPC_CHANNELS.dbExecuteQuery, {
        sessionId: SESSION_ID,
        sql: "selec 1",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "QUERY_FAILED",
        message: 'syntax error at or near "selec"',
        details: { sqlState: "42601", position: 1, hint: "h" },
      },
    });
  });

  it("does not leak unexpected error text", async () => {
    const { call } = setup(async () => {
      throw new Error("secret host db.internal");
    });
    const result = await call(IPC_CHANNELS.dbExecuteQuery, {
      sessionId: SESSION_ID,
      sql: "select 1",
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Internal error" },
    });
  });

  it("cancel resolves with whether a cancel was sent", async () => {
    const { call, cancel } = setup();
    expect(
      await call(IPC_CHANNELS.dbCancelQuery, { sessionId: SESSION_ID }),
    ).toEqual({ ok: true, data: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      await call(IPC_CHANNELS.dbCancelQuery, { sessionId: "nope" }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});
