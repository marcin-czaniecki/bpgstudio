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
