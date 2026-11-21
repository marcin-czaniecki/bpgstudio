import { z } from "zod";

/**
 * Connection parameters sent from the renderer exactly once per operation.
 * `.strict()` rejects unknown keys. The password lives only in this request:
 * it is never part of any response DTO (SessionInfo has no password field).
 */
/**
 * pg-protocol writes startup parameters as NUL-terminated strings without
 * escaping, so a NUL (or other control character) in user/database could inject
 * extra startup parameters (e.g. `replication=database`).
 */
const hasNoControlChars = (value: string): boolean =>
  !Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

const safeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(hasNoControlChars, "Control characters are not allowed");

export const ConnectionParamsSchema = z
  .object({
    // A leading "/" would make pg use a unix socket (peer auth, no password).
    host: safeText(253)
      .refine((v) => v.trim().length > 0, "Host is required")
      .refine(
        (v) => !v.trim().startsWith("/"),
        "Unix sockets are not supported",
      )
      .transform((v) => v.trim()),
    port: z.number().int().min(1).max(65535),
    database: safeText(63),
    user: safeText(63),
    password: z.string().max(1024),
    sslMode: z.enum(["disable", "verify-full"]),
    connectTimeoutMs: z.number().int().min(1000).max(60000).default(10000),
  })
  .strict();

export type ConnectionParams = z.output<typeof ConnectionParamsSchema>;
export type ConnectionParamsInput = z.input<typeof ConnectionParamsSchema>;

export const ConnectionTestResultSchema = z.object({
  serverVersion: z.string().min(1),
  latencyMs: z.number().nonnegative(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

/** Public description of an open session. Deliberately has no password. */
export const SessionInfoSchema = z.object({
  id: z.uuid(),
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  user: z.string(),
  sslMode: z.enum(["disable", "verify-full"]),
  serverVersion: z.string(),
  openedAt: z.iso.datetime(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const CloseSessionRequestSchema = z
  .object({ sessionId: z.uuid() })
  .strict();
export type CloseSessionRequest = z.infer<typeof CloseSessionRequestSchema>;

const ProfileFieldsShape = ConnectionParamsSchema.omit({
  password: true,
}).shape;

const ProfileNameSchema = safeText(100)
  .refine((v) => v.trim().length > 0, "Name is required")
  .transform((v) => v.trim());

/**
 * Saved profile as the renderer sees it. There is deliberately no password
 * field: once saved, a secret never crosses IPC again (only `hasSavedPassword`).
 */
export const ConnectionProfileSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  database: z.string(),
  user: z.string(),
  sslMode: z.enum(["disable", "verify-full"]),
  connectTimeoutMs: z.number().int(),
  hasSavedPassword: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

export const PasswordChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
  z
    .object({ action: z.literal("set"), value: z.string().min(1).max(1024) })
    .strict(),
]);
export type PasswordChange = z.infer<typeof PasswordChangeSchema>;

export const SaveProfileRequestSchema = z
  .object({
    id: z.uuid().optional(),
    name: ProfileNameSchema,
    ...ProfileFieldsShape,
    password: PasswordChangeSchema,
  })
  .strict();
export type SaveProfileRequest = z.output<typeof SaveProfileRequestSchema>;
export type SaveProfileRequestInput = z.input<typeof SaveProfileRequestSchema>;

export const ProfileIdRequestSchema = z
  .object({ profileId: z.uuid() })
  .strict();
export type ProfileIdRequest = z.infer<typeof ProfileIdRequestSchema>;

/** `password` is a one-off for profiles without a saved password; never stored. */
export const ProfileConnectRequestSchema = z
  .object({ profileId: z.uuid(), password: z.string().max(1024).optional() })
  .strict();
export type ProfileConnectRequest = z.infer<typeof ProfileConnectRequestSchema>;
