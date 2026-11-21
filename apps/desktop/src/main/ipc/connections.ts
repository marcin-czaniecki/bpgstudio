import {
  CloseSessionRequestSchema,
  type ConnectionParams,
  ConnectionParamsSchema,
  IPC_CHANNELS,
  NoPayloadSchema,
  type SessionInfo,
} from "@bpg/contracts";
import {
  type ConnectionConfig,
  type DatabaseAdapter,
  DatabaseError,
  type DatabaseSession,
  ProfileError,
  QueryError,
  type SessionRegistry,
} from "@bpg/database-core";
import {
  createTrustedHandler,
  type IpcEventLike,
  IpcFailure,
  type SenderPolicy,
} from "./trusted-handler";

/** Subset of Electron's ipcMain, so the handlers are testable without Electron. */
export interface IpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcEventLike, ...args: unknown[]) => Promise<unknown>,
  ): void;
}

function toConfig(params: ConnectionParams): ConnectionConfig {
  return {
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.user,
    password: params.password,
    sslMode: params.sslMode,
    connectTimeoutMs: params.connectTimeoutMs,
  };
}

/** Explicit field list: a new internal field can never leak to the renderer. */
export function toSessionInfo(session: DatabaseSession): SessionInfo {
  const { host, port, database, user, sslMode, serverVersion, openedAt } =
    session.info;
  return {
    id: session.id,
    host,
    port,
    database,
    user,
    sslMode,
    serverVersion,
    openedAt,
  };
}

/** Driver-level failures keep their code; the message is already fixed and safe. */
export async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof QueryError) {
      throw new IpcFailure(error.code, error.message, error.details);
    }
    if (error instanceof DatabaseError || error instanceof ProfileError) {
      throw new IpcFailure(error.code, error.message);
    }
    throw error;
  }
}

/**
 * The parameter is named `ipcMain` on purpose: handler-policy.test.ts scans for
 * `ipcMain.handle(` and requires every registration to use createTrustedHandler.
 */
export function registerConnectionHandlers(
  ipcMain: IpcRegistrar,
  deps: {
    policy: SenderPolicy;
    adapter: DatabaseAdapter;
    registry: SessionRegistry<DatabaseSession>;
  },
): void {
  const { policy, adapter, registry } = deps;

  ipcMain.handle(
    IPC_CHANNELS.dbTestConnection,
    createTrustedHandler({
      policy,
      schema: ConnectionParamsSchema,
      handle: (params) =>
        translate(() => adapter.testConnection(toConfig(params))),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dbOpenSession,
    createTrustedHandler({
      policy,
      schema: ConnectionParamsSchema,
      handle: (params) =>
        translate(async () => {
          const session = await adapter.openSession(toConfig(params));
          registry.add(session);
          return toSessionInfo(session);
        }),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dbCloseSession,
    createTrustedHandler({
      policy,
      schema: CloseSessionRequestSchema,
      handle: async ({ sessionId }) => {
        const found = await translate(() => registry.close(sessionId));
        if (!found)
          throw new IpcFailure("SESSION_NOT_FOUND", "Session not found");
      },
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dbListSessions,
    createTrustedHandler({
      policy,
      schema: NoPayloadSchema,
      handle: () => registry.list().map(toSessionInfo),
    }),
  );
}
