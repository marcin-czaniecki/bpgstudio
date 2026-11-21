import {
  CancelQueryRequestSchema,
  ExecuteQueryRequestSchema,
  IPC_CHANNELS,
  type QueryResult,
  type SchemaHints,
  SchemaHintsRequestSchema,
} from "@bpg/contracts";
import type { DatabaseSession, SessionRegistry } from "@bpg/database-core";
import { loadSchemaHints } from "@bpg/database-postgres";
import { type IpcRegistrar, translate } from "./connections";
import {
  createTrustedHandler,
  IpcFailure,
  type SenderPolicy,
} from "./trusted-handler";

/**
 * Parameter named `ipcMain` so handler-policy.test.ts scans these registrations.
 * SQL text, results and SQL error text are never logged here.
 */
export function registerQueryHandlers(
  ipcMain: IpcRegistrar,
  deps: {
    policy: SenderPolicy;
    registry: SessionRegistry<DatabaseSession>;
  },
): void {
  const { policy, registry } = deps;

  const requireSession = (id: string): DatabaseSession => {
    const session = registry.get(id);
    if (!session)
      throw new IpcFailure("SESSION_NOT_FOUND", "Session not found");
    return session;
  };

  ipcMain.handle(
    IPC_CHANNELS.dbExecuteQuery,
    createTrustedHandler({
      policy,
      schema: ExecuteQueryRequestSchema,
      handle: ({ sessionId, sql, maxRows, timeoutMs }) =>
        translate(async (): Promise<QueryResult> => {
          const outcome = await requireSession(sessionId).execute(sql, {
            maxRows,
            timeoutMs,
          });
          // Explicit mapping: the wire type is independent of the core type.
          return {
            command: outcome.command,
            rowCount: outcome.rowCount,
            columns: outcome.columns.map((c) => ({
              name: c.name,
              typeId: c.typeId,
            })),
            rows: outcome.rows.map((row) => [...row]),
            truncated: outcome.truncated,
            durationMs: outcome.durationMs,
          };
        }),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dbCancelQuery,
    createTrustedHandler({
      policy,
      schema: CancelQueryRequestSchema,
      handle: ({ sessionId }) =>
        translate(() => requireSession(sessionId).cancel()),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dbGetSchemaHints,
    createTrustedHandler({
      policy,
      schema: SchemaHintsRequestSchema,
      handle: ({ sessionId }) =>
        translate(async (): Promise<SchemaHints> => {
          const hints = await loadSchemaHints(requireSession(sessionId));
          return {
            tables: hints.tables.map((t) => ({
              schema: t.schema,
              name: t.name,
              columns: [...t.columns],
            })),
            truncated: hints.truncated,
          };
        }),
    }),
  );
}
