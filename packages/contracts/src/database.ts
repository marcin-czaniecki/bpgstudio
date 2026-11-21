import { z } from "zod";

/**
 * Connection parameters sent from the renderer exactly once per operation.
 * `.strict()` rejects unknown keys. The password lives only in this request:
 * it is never part of any response DTO (SessionInfo has no password field).
 */
export const ConnectionParamsSchema = z
  .object({
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1).max(63),
    user: z.string().min(1).max(63),
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
