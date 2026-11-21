import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SecretStore } from "@bpg/database-core";

/** Structural subset of Electron's safeStorage, so this is testable without Electron. */
export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only. basic_text / unknown mean a publicly known key: not real encryption. */
  getSelectedStorageBackend?(): string;
}

/**
 * Passwords encrypted with the OS secret facility (DPAPI on Windows), stored as
 * `ref -> base64 ciphertext`. There is no plaintext fallback: when encryption is
 * unavailable, `put` is never reached (ProfileService checks isAvailable first).
 */
export class SafeStorageSecretStore implements SecretStore {
  constructor(
    private readonly path: string,
    private readonly encryptor: Encryptor,
    private readonly platform: string = process.platform,
  ) {}

  isAvailable(): boolean {
    if (!this.encryptor.isEncryptionAvailable()) return false;
    if (this.platform === "linux") {
      const backend = this.encryptor.getSelectedStorageBackend?.() ?? "unknown";
      return backend !== "basic_text" && backend !== "unknown";
    }
    return true;
  }

  put(ref: string, plaintext: string): void {
    const entries = this.read();
    entries[ref] = this.encryptor.encryptString(plaintext).toString("base64");
    this.write(entries);
  }

  get(ref: string): string | null {
    const value = this.read()[ref];
    if (value === undefined) return null;
    try {
      return this.encryptor.decryptString(Buffer.from(value, "base64"));
    } catch {
      return null;
    }
  }

  delete(ref: string): void {
    const entries = this.read();
    if (!(ref in entries)) return;
    delete entries[ref];
    this.write(entries);
  }

  private read(): Record<string, string> {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    // A corrupt file must fail loudly: silently starting empty would let the
    // next write erase every other saved secret.
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Secret store is corrupt");
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }

  private write(entries: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
