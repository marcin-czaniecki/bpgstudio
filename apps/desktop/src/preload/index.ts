import type {
  AppInfo,
  BpgBridge,
  ColumnDto,
  ConnectionProfile,
  ConnectionTestResult,
  QueryResult,
  RelationList,
  SchemaHints,
  SchemaList,
  SessionInfo,
} from "@bpg/contracts";
import { IPC_CHANNELS } from "@bpg/contracts/channels";
import { encodeIpcError, type IpcResult } from "@bpg/contracts/ipc";
import { contextBridge, ipcRenderer } from "electron";

/**
 * Named-capability bridge. Nothing here validates payloads: preload runs on the
 * renderer side of the trust boundary, so a check here would only guard the
 * sandbox against the trusted main process. Every privileged handler in main
 * verifies the sender and validates with Zod at the boundary (ADR-0002,
 * ADR-0003), which is where an untrusted payload actually arrives.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.ok) {
    // Only name/message survive contextBridge, so the error travels in the message.
    throw new Error(encodeIpcError(result.error));
  }
  return result.data;
}

const bpg: BpgBridge = {
  getAppInfo: () => invoke<AppInfo>(IPC_CHANNELS.appGetInfo),
  db: {
    testConnection: (params) =>
      invoke<ConnectionTestResult>(IPC_CHANNELS.dbTestConnection, params),
    openSession: (params) =>
      invoke<SessionInfo>(IPC_CHANNELS.dbOpenSession, params),
    closeSession: (sessionId) =>
      invoke<void>(IPC_CHANNELS.dbCloseSession, { sessionId }),
    listSessions: () => invoke<SessionInfo[]>(IPC_CHANNELS.dbListSessions),
    executeQuery: (request) =>
      invoke<QueryResult>(IPC_CHANNELS.dbExecuteQuery, request),
    cancelQuery: (sessionId) =>
      invoke<boolean>(IPC_CHANNELS.dbCancelQuery, { sessionId }),
    getSchemaHints: (sessionId) =>
      invoke<SchemaHints>(IPC_CHANNELS.dbGetSchemaHints, { sessionId }),
    listSchemas: (sessionId) =>
      invoke<SchemaList>(IPC_CHANNELS.dbListSchemas, { sessionId }),
    listRelations: (sessionId, schema) =>
      invoke<RelationList>(IPC_CHANNELS.dbListRelations, { sessionId, schema }),
    describeRelation: (sessionId, schema, name) =>
      invoke<ColumnDto[]>(IPC_CHANNELS.dbDescribeRelation, {
        sessionId,
        schema,
        name,
      }),
    testProfile: (profileId, password) =>
      invoke<ConnectionTestResult>(IPC_CHANNELS.dbTestProfile, {
        profileId,
        password,
      }),
    openProfileSession: (profileId, password) =>
      invoke<SessionInfo>(IPC_CHANNELS.dbOpenProfileSession, {
        profileId,
        password,
      }),
  },
  profiles: {
    list: () => invoke<ConnectionProfile[]>(IPC_CHANNELS.profilesList),
    save: (request) =>
      invoke<ConnectionProfile>(IPC_CHANNELS.profilesSave, request),
    delete: (profileId) =>
      invoke<void>(IPC_CHANNELS.profilesDelete, { profileId }),
  },
};

contextBridge.exposeInMainWorld("bpg", bpg);
