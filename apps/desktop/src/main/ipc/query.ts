import {
  CancelQueryRequestSchema,
  type ColumnDto,
  DescribeRelationRequestSchema,
  ExecuteQueryRequestSchema,
  IntrospectSchemaRequestSchema,
  IPC_CHANNELS,
  ListRelationsRequestSchema,
  type QueryResult,
  type RelationList,
  type SchemaHints,
  SchemaHintsRequestSchema,
  type SchemaList,
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

  ipcMain.handle(
    IPC_CHANNELS.dbListSchemas,
    createTrustedHandler({
      policy,
      schema: SchemaHintsRequestSchema,
      handle: ({ sessionId }) =>
        translate(async (): Promise<SchemaList> => {
          const out = await requireSession(sessionId).listSchemas();
          return { schemas: [...out.items], truncated: out.truncated };
        }),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dbListRelations,
    createTrustedHandler({
      policy,
      schema: ListRelationsRequestSchema,
      handle: ({ sessionId, schema }) =>
        translate(async (): Promise<RelationList> => {
          const out = await requireSession(sessionId).listRelations(schema);
          return {
            relations: out.items.map((r) => ({ name: r.name, kind: r.kind })),
            truncated: out.truncated,
          };
        }),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dbDescribeRelation,
    createTrustedHandler({
      policy,
      schema: DescribeRelationRequestSchema,
      handle: ({ sessionId, schema, name }) =>
        translate(async (): Promise<ColumnDto[]> => {
          const columns = await requireSession(sessionId).describeRelation(
            schema,
            name,
          );
          return columns.map((c) => ({
            name: c.name,
            type: c.type,
            notNull: c.notNull,
            isPrimaryKey: c.isPrimaryKey,
          }));
        }),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dbIntrospectSchema,
    createTrustedHandler({
      policy,
      schema: IntrospectSchemaRequestSchema,
      handle: ({ sessionId, includeSchemas, excludeSchemas }) =>
        translate(() =>
          requireSession(sessionId).introspect({
            includeSchemas: includeSchemas ?? null,
            excludeSchemas: excludeSchemas ?? [],
          }),
        ),
    }),
  );
}
