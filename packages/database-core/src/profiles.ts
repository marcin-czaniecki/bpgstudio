import type { ConnectionConfig, SslMode } from "./index";

export const PROFILE_ERROR_CODES = [
  "PROFILE_NOT_FOUND",
  "SECRET_STORAGE_UNAVAILABLE",
  "PASSWORD_REQUIRED",
] as const;
export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[number];

/** Fixed, safe message; never contains profile data or secrets. */
export class ProfileError extends Error {
  readonly code: ProfileErrorCode;

  constructor(code: ProfileErrorCode, message: string) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}

/** Non-secret profile data. The password is referenced only via `secretRef`. */
export interface StoredProfile {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly sslMode: SslMode;
  readonly connectTimeoutMs: number;
  readonly secretRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProfileFields = Omit<
  StoredProfile,
  "id" | "secretRef" | "createdAt" | "updatedAt"
>;

export type PasswordInstruction =
  | { readonly action: "keep" }
  | { readonly action: "clear" }
  | { readonly action: "set"; readonly value: string };

export interface ProfileRepository {
  list(): StoredProfile[];
  get(id: string): StoredProfile | null;
  upsert(profile: StoredProfile): void;
  delete(id: string): void;
}

/** Encrypted-at-rest storage for passwords, addressed by opaque reference. */
export interface SecretStore {
  isAvailable(): boolean;
  put(ref: string, plaintext: string): void;
  get(ref: string): string | null;
  delete(ref: string): void;
}

export interface ProfileServiceDeps {
  readonly repository: ProfileRepository;
  readonly secrets: SecretStore;
  readonly newId: () => string;
  readonly now: () => string;
}

export class ProfileService {
  constructor(private readonly deps: ProfileServiceDeps) {}

  list(): StoredProfile[] {
    return this.deps.repository.list();
  }

  save(
    id: string | undefined,
    fields: ProfileFields,
    password: PasswordInstruction,
  ): StoredProfile {
    const { repository, secrets, newId, now } = this.deps;
    const existing = id === undefined ? null : repository.get(id);
    if (id !== undefined && existing === null) {
      throw new ProfileError("PROFILE_NOT_FOUND", "Profile not found");
    }

    // Validate before any write so a failure leaves no partial state.
    if (password.action === "set" && !secrets.isAvailable()) {
      throw new ProfileError(
        "SECRET_STORAGE_UNAVAILABLE",
        "Secure password storage is not available on this system",
      );
    }

    // A saved password must not silently follow a profile to another server or
    // account: if the target changed, the user has to supply the password again.
    if (
      password.action === "keep" &&
      existing !== null &&
      existing.secretRef !== null &&
      (existing.host.toLowerCase() !== fields.host.toLowerCase() ||
        existing.port !== fields.port ||
        existing.user !== fields.user)
    ) {
      throw new ProfileError(
        "PASSWORD_REQUIRED",
        "Host, port or user changed: enter the password again or remove the saved one",
      );
    }

    const previousRef = existing?.secretRef ?? null;
    let secretRef = previousRef;
    if (password.action === "set") {
      secretRef = previousRef ?? newId();
      secrets.put(secretRef, password.value);
    } else if (password.action === "clear") {
      secretRef = null;
    }

    const timestamp = now();
    const profile: StoredProfile = {
      id: existing?.id ?? newId(),
      ...fields,
      secretRef,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    repository.upsert(profile);

    if (password.action === "clear" && previousRef !== null) {
      secrets.delete(previousRef);
    }
    return profile;
  }

  delete(id: string): void {
    const { repository, secrets } = this.deps;
    const existing = repository.get(id);
    if (existing === null) {
      throw new ProfileError("PROFILE_NOT_FOUND", "Profile not found");
    }
    repository.delete(id);
    if (existing.secretRef !== null) secrets.delete(existing.secretRef);
  }

  /** Builds the adapter config; the saved password is read here, in main only. */
  resolveConfig(id: string, oneOffPassword?: string): ConnectionConfig {
    const profile = this.deps.repository.get(id);
    if (profile === null) {
      throw new ProfileError("PROFILE_NOT_FOUND", "Profile not found");
    }
    let password = oneOffPassword ?? "";
    if (profile.secretRef !== null) {
      const saved = this.deps.secrets.get(profile.secretRef);
      if (saved === null) {
        throw new ProfileError(
          "SECRET_STORAGE_UNAVAILABLE",
          "Saved password could not be read; enter it again",
        );
      }
      password = saved;
    }
    return {
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      password,
      sslMode: profile.sslMode,
      connectTimeoutMs: profile.connectTimeoutMs,
    };
  }
}
