import { IPC_CHANNELS } from "@bpg/contracts";
import {
  type ConnectionConfig,
  type DatabaseAdapter,
  type DatabaseSession,
  type ProfileRepository,
  ProfileService,
  type SecretStore,
  SessionRegistry,
  type StoredProfile,
} from "@bpg/database-core";
import { describe, expect, it, vi } from "vitest";
import type { IpcRegistrar } from "./connections";
import { registerProfileHandlers } from "./profiles";
import type { IpcEventLike, SenderPolicy } from "./trusted-handler";

const frame = { url: "http://localhost:5173/" };
const webContents = { mainFrame: frame };
const trusted: IpcEventLike = { sender: webContents, senderFrame: frame };
const policy: SenderPolicy = {
  expectedSender: () => webContents,
  isAllowedUrl: (url) => url.startsWith("http://localhost:5173"),
};

const PASSWORD = "hunter2-very-secret";
const base = {
  name: "Local",
  host: "localhost",
  port: 5432,
  database: "app",
  user: "app",
  sslMode: "disable",
};

type Handler = (event: IpcEventLike, ...args: unknown[]) => Promise<unknown>;

function setup() {
  const handlers = new Map<string, Handler>();
  const ipc: IpcRegistrar = { handle: (c, l) => void handlers.set(c, l) };
  const rows = new Map<string, StoredProfile>();
  const secrets = new Map<string, string>();
  const repository: ProfileRepository = {
    list: () => [...rows.values()],
    get: (id) => rows.get(id) ?? null,
    upsert: (p) => void rows.set(p.id, p),
    delete: (id) => void rows.delete(id),
  };
  const store: SecretStore = {
    isAvailable: () => true,
    put: (r, v) => void secrets.set(r, v),
    get: (r) => secrets.get(r) ?? null,
    delete: (r) => void secrets.delete(r),
  };
  let n = 0;
  const service = new ProfileService({
    repository,
    secrets: store,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    now: () => "2026-11-21T00:00:00.000Z",
  });
  const session: DatabaseSession = {
    id: "7d96633c-0000-4000-8000-000000000001",
    info: {
      host: "localhost",
      port: 5432,
      database: "app",
      user: "app",
      sslMode: "disable",
      serverVersion: "17.2",
      openedAt: "2026-11-21T03:00:00.000Z",
    },
    onClosed: () => undefined,
    close: async () => undefined,
  };
  const testConnection = vi.fn(async (_c: ConnectionConfig) => ({
    serverVersion: "17.2",
    latencyMs: 3,
  }));
  const openSession = vi.fn(async (_c: ConnectionConfig) => session);
  const adapter: DatabaseAdapter = { testConnection, openSession };
  registerProfileHandlers(ipc, {
    policy,
    service,
    adapter,
    registry: new SessionRegistry<DatabaseSession>(),
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(trusted, ...args);
  };
  return { handlers, call, openSession, testConnection, rows, secrets };
}

describe("profile IPC handlers", () => {
  it("registers exactly the five profile channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.profilesList,
        IPC_CHANNELS.profilesSave,
        IPC_CHANNELS.profilesDelete,
        IPC_CHANNELS.dbTestProfile,
        IPC_CHANNELS.dbOpenProfileSession,
      ].sort(),
    );
  });

  it("refuses an untrusted sender", async () => {
    const { handlers } = setup();
    const other = { mainFrame: { url: "http://localhost:5173/" } };
    const result = await handlers.get(IPC_CHANNELS.profilesList)?.({
      sender: other,
      senderFrame: other.mainFrame,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("saves a profile; responses never contain the password or secretRef", async () => {
    const { call } = setup();
    const result = (await call(IPC_CHANNELS.profilesSave, {
      ...base,
      password: { action: "set", value: PASSWORD },
    })) as { ok: true; data: Record<string, unknown> };
    expect(result.ok).toBe(true);
    expect(result.data.hasSavedPassword).toBe(true);
    const serialized = JSON.stringify(await call(IPC_CHANNELS.profilesList));
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("secretRef");
  });

  it("connects by id using the stored password without it crossing IPC", async () => {
    const { call, openSession } = setup();
    const saved = (await call(IPC_CHANNELS.profilesSave, {
      ...base,
      password: { action: "set", value: PASSWORD },
    })) as { data: { id: string } };
    const opened = await call(IPC_CHANNELS.dbOpenProfileSession, {
      profileId: saved.data.id,
    });
    expect(opened).toMatchObject({ ok: true });
    expect(openSession).toHaveBeenCalledWith(
      expect.objectContaining({ password: PASSWORD, host: "localhost" }),
    );
    expect(JSON.stringify(opened)).not.toContain(PASSWORD);
  });

  it("maps an unknown profile to PROFILE_NOT_FOUND", async () => {
    const { call, testConnection } = setup();
    const result = await call(IPC_CHANNELS.dbTestProfile, {
      profileId: "00000000-0000-4000-8000-0000000000ff",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PROFILE_NOT_FOUND" },
    });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown key", { ...base, password: { action: "keep" }, extra: 1 }],
    ["missing password change", { ...base }],
    ["bad action", { ...base, password: { action: "delete" } }],
    ["empty set value", { ...base, password: { action: "set", value: "" } }],
    ["blank name", { ...base, name: "  ", password: { action: "keep" } }],
    ["raw password field", { ...base, password: "plain" }],
  ])("rejects save with %s", async (_n, payload) => {
    const { call, rows } = setup();
    const result = await call(IPC_CHANNELS.profilesSave, payload);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(rows.size).toBe(0);
  });

  it("delete removes the profile and its secret", async () => {
    const { call, rows, secrets } = setup();
    const saved = (await call(IPC_CHANNELS.profilesSave, {
      ...base,
      password: { action: "set", value: PASSWORD },
    })) as { data: { id: string } };
    expect(secrets.size).toBe(1);
    await call(IPC_CHANNELS.profilesDelete, { profileId: saved.data.id });
    expect(rows.size).toBe(0);
    expect(secrets.size).toBe(0);
  });
});
