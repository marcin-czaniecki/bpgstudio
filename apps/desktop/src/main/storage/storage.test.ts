import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredProfile } from "@bpg/database-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Encryptor,
  SafeStorageSecretStore,
} from "./safe-storage-secret-store";
import { SqliteProfileRepository } from "./sqlite-profile-repository";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bpg-storage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const profile: StoredProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Local",
  host: "localhost",
  port: 5432,
  database: "app",
  user: "app",
  sslMode: "verify-full",
  connectTimeoutMs: 10000,
  secretRef: "ref-1",
  createdAt: "2026-11-21T00:00:00.000Z",
  updatedAt: "2026-11-21T00:00:00.000Z",
};

describe("SqliteProfileRepository", () => {
  it("round-trips, updates, lists by name and deletes", () => {
    const repo = new SqliteProfileRepository(join(dir, "db.sqlite"));
    repo.upsert(profile);
    repo.upsert({ ...profile, id: "2", name: "alpha", secretRef: null });
    expect(repo.get(profile.id)).toEqual(profile);
    expect(repo.list().map((p) => p.name)).toEqual(["alpha", "Local"]);

    repo.upsert({ ...profile, name: "Renamed" });
    expect(repo.get(profile.id)?.name).toBe("Renamed");

    repo.delete(profile.id);
    expect(repo.get(profile.id)).toBeNull();
    repo.close();
  });

  it("persists across reopen and keeps the schema version", () => {
    const path = join(dir, "db.sqlite");
    const first = new SqliteProfileRepository(path);
    first.upsert(profile);
    first.close();

    const second = new SqliteProfileRepository(path);
    expect(second.get(profile.id)).toEqual(profile);
    second.close();

    const raw = new DatabaseSync(path);
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 1,
    });
    raw.close();
  });

  it("refuses a database written by a newer version", () => {
    const path = join(dir, "db.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => new SqliteProfileRepository(path)).toThrow(/newer version/);
  });

  it("never writes a password-like value: the schema has no such column", () => {
    const path = join(dir, "db.sqlite");
    const repo = new SqliteProfileRepository(path);
    repo.close();
    const raw = new DatabaseSync(path);
    const columns = (
      raw.prepare("PRAGMA table_info(connection_profiles)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    raw.close();
    expect(columns).not.toContain("password");
    expect(columns).toContain("secret_ref");
  });
});

const fakeEncryptor = (available = true): Encryptor => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) =>
    Buffer.from(plain.split("").reverse().join(""), "utf8"),
  decryptString: (buf) => buf.toString("utf8").split("").reverse().join(""),
});

describe("SafeStorageSecretStore", () => {
  it("stores ciphertext only and round-trips", () => {
    const path = join(dir, "nested", "secrets.json");
    const store = new SafeStorageSecretStore(path, fakeEncryptor());
    store.put("ref-1", "hunter2-secret");
    expect(store.get("ref-1")).toBe("hunter2-secret");
    expect(readFileSync(path, "utf8")).not.toContain("hunter2-secret");
    expect(store.get("missing")).toBeNull();

    store.delete("ref-1");
    expect(store.get("ref-1")).toBeNull();
  });

  it("reports availability from the encryptor", () => {
    expect(
      new SafeStorageSecretStore(
        join(dir, "s.json"),
        fakeEncryptor(false),
      ).isAvailable(),
    ).toBe(false);
  });

  it("fails loudly on a corrupt file instead of overwriting it", () => {
    const path = join(dir, "secrets.json");
    writeFileSync(path, "{not json");
    const store = new SafeStorageSecretStore(path, fakeEncryptor());
    expect(() => store.put("a", "b")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  it("returns null when decryption fails", () => {
    const path = join(dir, "secrets.json");
    const store = new SafeStorageSecretStore(path, fakeEncryptor());
    store.put("ref", "x");
    const broken: Encryptor = {
      ...fakeEncryptor(),
      decryptString: () => {
        throw new Error("bad key");
      },
    };
    expect(new SafeStorageSecretStore(path, broken).get("ref")).toBeNull();
  });
});
