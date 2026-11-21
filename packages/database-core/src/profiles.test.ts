import { describe, expect, it } from "vitest";
import {
  ProfileError,
  type ProfileFields,
  type ProfileRepository,
  ProfileService,
  type SecretStore,
  type StoredProfile,
} from "./profiles";

const fields: ProfileFields = {
  name: "Local",
  host: "localhost",
  port: 5432,
  database: "app",
  user: "app",
  sslMode: "disable",
  connectTimeoutMs: 10000,
};

function setup(options: { secretsAvailable?: boolean } = {}) {
  const rows = new Map<string, StoredProfile>();
  const secrets = new Map<string, string>();
  const repository: ProfileRepository = {
    list: () => [...rows.values()],
    get: (id) => rows.get(id) ?? null,
    upsert: (p) => void rows.set(p.id, p),
    delete: (id) => void rows.delete(id),
  };
  const store: SecretStore = {
    isAvailable: () => options.secretsAvailable ?? true,
    put: (ref, value) => void secrets.set(ref, value),
    get: (ref) => secrets.get(ref) ?? null,
    delete: (ref) => void secrets.delete(ref),
  };
  let n = 0;
  const service = new ProfileService({
    repository,
    secrets: store,
    newId: () => `id-${++n}`,
    now: () => "2026-11-21T00:00:00.000Z",
  });
  return { service, rows, secrets };
}

describe("ProfileService", () => {
  it("stores the password as a secret and only a reference in the row", () => {
    const { service, rows, secrets } = setup();
    const saved = service.save(undefined, fields, {
      action: "set",
      value: "pw",
    });
    expect(saved.secretRef).not.toBeNull();
    expect(JSON.stringify([...rows.values()])).not.toContain("pw");
    expect(secrets.get(saved.secretRef ?? "")).toBe("pw");
  });

  it("keep leaves the password, clear removes the secret", () => {
    const { service, secrets } = setup();
    const created = service.save(undefined, fields, {
      action: "set",
      value: "pw",
    });
    const kept = service.save(
      created.id,
      { ...fields, name: "Renamed" },
      {
        action: "keep",
      },
    );
    expect(kept.secretRef).toBe(created.secretRef);
    expect(kept.createdAt).toBe(created.createdAt);
    expect(secrets.size).toBe(1);

    const cleared = service.save(created.id, fields, { action: "clear" });
    expect(cleared.secretRef).toBeNull();
    expect(secrets.size).toBe(0);
  });

  it("keep is refused when host, port or user changed, but allowed for other edits", () => {
    const { service } = setup();
    const p = service.save(undefined, fields, { action: "set", value: "pw" });
    for (const changed of [
      { host: "evil.example" },
      { port: 5433 },
      { user: "other" },
    ]) {
      expect(() =>
        service.save(p.id, { ...fields, ...changed }, { action: "keep" }),
      ).toThrowError(expect.objectContaining({ code: "PASSWORD_REQUIRED" }));
    }
    expect(() =>
      service.save(p.id, { ...fields, database: "other" }, { action: "keep" }),
    ).not.toThrow();
    // Supplying or clearing the password is the way through.
    expect(() =>
      service.save(p.id, { ...fields, host: "new" }, { action: "clear" }),
    ).not.toThrow();
  });

  it("set on an existing profile reuses its reference (no orphaned secret)", () => {
    const { service, secrets } = setup();
    const a = service.save(undefined, fields, { action: "set", value: "one" });
    const b = service.save(a.id, fields, { action: "set", value: "two" });
    expect(b.secretRef).toBe(a.secretRef);
    expect(secrets.size).toBe(1);
    expect(service.resolveConfig(a.id).password).toBe("two");
  });

  it("refuses to save a password when secure storage is unavailable, writing nothing", () => {
    const { service, rows } = setup({ secretsAvailable: false });
    expect(() =>
      service.save(undefined, fields, { action: "set", value: "pw" }),
    ).toThrowError(
      expect.objectContaining({ code: "SECRET_STORAGE_UNAVAILABLE" }),
    );
    expect(rows.size).toBe(0);
    // A profile without a password is still allowed.
    expect(
      service.save(undefined, fields, { action: "keep" }).secretRef,
    ).toBeNull();
  });

  it("delete removes the row and its secret", () => {
    const { service, rows, secrets } = setup();
    const p = service.save(undefined, fields, { action: "set", value: "pw" });
    service.delete(p.id);
    expect(rows.size).toBe(0);
    expect(secrets.size).toBe(0);
  });

  it("resolveConfig prefers the saved password and falls back to a one-off", () => {
    const { service } = setup();
    const withPw = service.save(undefined, fields, {
      action: "set",
      value: "saved",
    });
    expect(service.resolveConfig(withPw.id, "typed").password).toBe("saved");
    const without = service.save(undefined, fields, { action: "keep" });
    expect(service.resolveConfig(without.id, "typed").password).toBe("typed");
    expect(service.resolveConfig(without.id).password).toBe("");
  });

  it("reports an unreadable saved secret instead of connecting with an empty password", () => {
    const { service, secrets } = setup();
    const p = service.save(undefined, fields, { action: "set", value: "pw" });
    secrets.clear();
    expect(() => service.resolveConfig(p.id)).toThrowError(
      expect.objectContaining({ code: "SECRET_STORAGE_UNAVAILABLE" }),
    );
  });

  it("throws PROFILE_NOT_FOUND for unknown ids", () => {
    const { service } = setup();
    for (const call of [
      () => service.save("missing", fields, { action: "keep" }),
      () => service.delete("missing"),
      () => service.resolveConfig("missing"),
    ]) {
      expect(call).toThrowError(ProfileError);
      expect(call).toThrowError(
        expect.objectContaining({ code: "PROFILE_NOT_FOUND" }),
      );
    }
  });
});
