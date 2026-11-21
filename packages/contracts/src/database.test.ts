import { describe, expect, it } from "vitest";
import {
  CloseSessionRequestSchema,
  ConnectionParamsSchema,
  ConnectionProfileSchema,
  SaveProfileRequestSchema,
  SessionInfoSchema,
} from "./database";

const valid = {
  host: "localhost",
  port: 5432,
  database: "app",
  user: "app",
  password: "secret",
  sslMode: "disable",
} as const;

describe("ConnectionParamsSchema", () => {
  it("accepts valid params and applies the default timeout", () => {
    const parsed = ConnectionParamsSchema.parse(valid);
    expect(parsed.connectTimeoutMs).toBe(10000);
  });

  it("allows an empty password (trust auth) but not an empty host", () => {
    expect(
      ConnectionParamsSchema.safeParse({ ...valid, password: "" }).success,
    ).toBe(true);
    expect(
      ConnectionParamsSchema.safeParse({ ...valid, host: "  " }).success,
    ).toBe(false);
  });

  it.each([0, 65536, 5432.5, -1])("rejects port %s", (port) => {
    expect(ConnectionParamsSchema.safeParse({ ...valid, port }).success).toBe(
      false,
    );
  });

  it("rejects unknown keys, TLS modes without verification and bad timeouts", () => {
    expect(
      ConnectionParamsSchema.safeParse({ ...valid, extra: 1 }).success,
    ).toBe(false);
    expect(
      ConnectionParamsSchema.safeParse({ ...valid, sslMode: "require" })
        .success,
    ).toBe(false);
    expect(
      ConnectionParamsSchema.safeParse({ ...valid, connectTimeoutMs: 999 })
        .success,
    ).toBe(false);
    expect(
      ConnectionParamsSchema.safeParse({ ...valid, connectTimeoutMs: 60001 })
        .success,
    ).toBe(false);
  });

  it("rejects control characters and unix-socket hosts (startup-parameter injection)", () => {
    for (const patch of [
      { user: "app\0replication\0database" },
      { database: "app\0options\0-c x=1" },
      { host: "local\nhost" },
      { host: "/var/run/postgresql" },
      { host: " /tmp" },
    ]) {
      expect(
        ConnectionParamsSchema.safeParse({ ...valid, ...patch }).success,
      ).toBe(false);
    }
  });

  it("rejects non-string and oversized values", () => {
    expect(
      ConnectionParamsSchema.safeParse({ ...valid, password: 123 }).success,
    ).toBe(false);
    expect(
      ConnectionParamsSchema.safeParse({ ...valid, database: "x".repeat(64) })
        .success,
    ).toBe(false);
  });
});

describe("SessionInfoSchema", () => {
  it("has no password field and strips one if present", () => {
    expect(Object.keys(SessionInfoSchema.shape)).not.toContain("password");
    const parsed = SessionInfoSchema.parse({
      id: "7d96633c-0000-4000-8000-000000000000",
      host: "h",
      port: 5432,
      database: "d",
      user: "u",
      sslMode: "disable",
      serverVersion: "17.0",
      openedAt: "2026-11-21T03:00:00.000Z",
      password: "leak",
    });
    expect(JSON.stringify(parsed)).not.toContain("leak");
  });
});

describe("CloseSessionRequestSchema", () => {
  it("requires a uuid and nothing else", () => {
    expect(
      CloseSessionRequestSchema.safeParse({ sessionId: "x" }).success,
    ).toBe(false);
    expect(
      CloseSessionRequestSchema.safeParse({
        sessionId: "7d96633c-0000-4000-8000-000000000000",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe("profile schemas", () => {
  const profile = {
    name: " Local ",
    host: "localhost",
    port: 5432,
    database: "app",
    user: "app",
    sslMode: "disable",
    password: { action: "keep" },
  };

  it("trims the name and rejects unknown keys and bare passwords", () => {
    expect(SaveProfileRequestSchema.parse(profile).name).toBe("Local");
    expect(
      SaveProfileRequestSchema.safeParse({ ...profile, extra: 1 }).success,
    ).toBe(false);
    expect(
      SaveProfileRequestSchema.safeParse({ ...profile, password: "x" }).success,
    ).toBe(false);
  });

  it("the response DTO has no password field", () => {
    expect(Object.keys(ConnectionProfileSchema.shape)).not.toContain(
      "password",
    );
  });
});
