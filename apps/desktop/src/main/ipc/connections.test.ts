import { IPC_CHANNELS } from "@bpg/contracts";
import {
  type ConnectionConfig,
  type DatabaseAdapter,
  DatabaseError,
  type DatabaseSession,
  SessionRegistry,
} from "@bpg/database-core";
import { describe, expect, it, vi } from "vitest";
import { type IpcRegistrar, registerConnectionHandlers } from "./connections";
import type { IpcEventLike, SenderPolicy } from "./trusted-handler";

const frame = { url: "http://localhost:5173/" };
const webContents = { mainFrame: frame };
const trusted: IpcEventLike = { sender: webContents, senderFrame: frame };
const policy: SenderPolicy = {
  expectedSender: () => webContents,
  isAllowedUrl: (url) => url.startsWith("http://localhost:5173"),
};

const PASSWORD = "hunter2-very-secret";
const params = {
  host: "localhost",
  port: 5432,
  database: "app",
  user: "app",
  password: PASSWORD,
  sslMode: "disable",
};

function fakeSession(id: string): DatabaseSession & { closed: number } {
  let listener: ((r: DatabaseError | null) => void) | undefined;
  const session = {
    id,
    closed: 0,
    info: {
      host: "localhost",
      port: 5432,
      database: "app",
      user: "app",
      sslMode: "disable" as const,
      serverVersion: "17.2",
      openedAt: "2026-11-21T03:00:00.000Z",
    },
    execute: async () => {
      throw new Error("not used");
    },
    cancel: async () => false,
    listSchemas: async () => ({ items: [], truncated: false }),
    listRelations: async () => ({ items: [], truncated: false }),
    describeRelation: async () => [],
    onClosed: (l: (r: DatabaseError | null) => void) => {
      listener = l;
    },
    close: async () => {
      session.closed += 1;
      listener?.(null);
    },
  };
  return session;
}

type Handler = (event: IpcEventLike, ...args: unknown[]) => Promise<unknown>;

function setup(adapter?: Partial<DatabaseAdapter>) {
  const handlers = new Map<string, Handler>();
  const ipc: IpcRegistrar = { handle: (c, l) => void handlers.set(c, l) };
  const registry = new SessionRegistry<DatabaseSession>();
  const testConnection = vi.fn(async (_c: ConnectionConfig) => ({
    serverVersion: "17.2",
    latencyMs: 3,
  }));
  const openSession = vi.fn(async (_c: ConnectionConfig) =>
    fakeSession("7d96633c-0000-4000-8000-000000000001"),
  );
  const fake: DatabaseAdapter = {
    testConnection,
    openSession,
    ...adapter,
  };
  registerConnectionHandlers(ipc, { policy, adapter: fake, registry });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(trusted, ...args);
  };
  return { handlers, registry, call, testConnection, openSession };
}

describe("db IPC handlers", () => {
  it("registers exactly the four db channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.dbCloseSession,
        IPC_CHANNELS.dbListSessions,
        IPC_CHANNELS.dbOpenSession,
        IPC_CHANNELS.dbTestConnection,
      ].sort(),
    );
  });

  it("refuses an untrusted sender before touching the adapter", async () => {
    const { handlers, testConnection } = setup();
    const other = { mainFrame: { url: "http://localhost:5173/" } };
    const result = await handlers.get(IPC_CHANNELS.dbTestConnection)?.(
      { sender: other, senderFrame: other.mainFrame },
      params,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("test-connection passes config to the adapter and returns the outcome", async () => {
    const { call, testConnection } = setup();
    const result = await call(IPC_CHANNELS.dbTestConnection, params);
    expect(result).toEqual({
      ok: true,
      data: { serverVersion: "17.2", latencyMs: 3 },
    });
    expect(testConnection).toHaveBeenCalledWith({
      ...params,
      connectTimeoutMs: 10000,
    });
  });

  it.each([
    ["missing password", { ...params, password: undefined }],
    ["bad port", { ...params, port: 70000 }],
    ["unknown key", { ...params, extra: true }],
    ["unsafe TLS mode", { ...params, sslMode: "require" }],
    ["not an object", "postgres://u:p@h/db"],
  ])("rejects %s without calling the adapter", async (_name, payload) => {
    const { call, testConnection, openSession } = setup();
    for (const channel of [
      IPC_CHANNELS.dbTestConnection,
      IPC_CHANNELS.dbOpenSession,
    ]) {
      await expect(call(channel, payload)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
    expect(testConnection).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
  });

  it("open-session registers the session and never returns the password", async () => {
    const { call, registry } = setup();
    const opened = await call(IPC_CHANNELS.dbOpenSession, params);
    expect(opened).toMatchObject({ ok: true, data: { host: "localhost" } });
    expect(JSON.stringify(opened)).not.toContain(PASSWORD);
    expect(registry.list()).toHaveLength(1);

    const listed = await call(IPC_CHANNELS.dbListSessions);
    expect(JSON.stringify(listed)).not.toContain(PASSWORD);
    expect(listed).toMatchObject({
      ok: true,
      data: [{ id: expect.any(String) }],
    });
  });

  it("list-sessions rejects an unexpected argument", async () => {
    const { call } = setup();
    await expect(
      call(IPC_CHANNELS.dbListSessions, params),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("close-session closes and removes; unknown or malformed id fails", async () => {
    const { call, registry } = setup();
    await call(IPC_CHANNELS.dbOpenSession, params);
    const id = "7d96633c-0000-4000-8000-000000000001";

    await expect(
      call(IPC_CHANNELS.dbCloseSession, { sessionId: id }),
    ).resolves.toEqual({ ok: true, data: undefined });
    expect(registry.list()).toEqual([]);

    await expect(
      call(IPC_CHANNELS.dbCloseSession, { sessionId: id }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "SESSION_NOT_FOUND" },
    });
    await expect(
      call(IPC_CHANNELS.dbCloseSession, { sessionId: "nope" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("maps adapter DatabaseErrors to their code and fixed message", async () => {
    const { call, registry } = setup({
      testConnection: async () => {
        throw new DatabaseError("AUTH_FAILED", "Authentication failed");
      },
      openSession: async () => {
        throw new DatabaseError("HOST_UNREACHABLE", "Server unreachable");
      },
    });
    const test = await call(IPC_CHANNELS.dbTestConnection, params);
    expect(test).toEqual({
      ok: false,
      error: { code: "AUTH_FAILED", message: "Authentication failed" },
    });
    const open = await call(IPC_CHANNELS.dbOpenSession, params);
    expect(open).toMatchObject({
      ok: false,
      error: { code: "HOST_UNREACHABLE" },
    });
    expect(registry.list()).toEqual([]);
    expect(JSON.stringify([test, open])).not.toContain(PASSWORD);
  });

  it("does not leak the password when an unexpected error mentions it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = setup({
      testConnection: async () => {
        throw new Error(`boom with ${PASSWORD}`);
      },
    });
    const result = await call(IPC_CHANNELS.dbTestConnection, params);
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(spy.mock.calls.flat().join(" ")).not.toContain(PASSWORD);
    spy.mockRestore();
  });
});
