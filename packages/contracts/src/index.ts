import type { SchemaSnapshot } from "@bpg/schema-core";
import { z } from "zod";
import type {
  ColumnDto,
  ConnectionParamsInput,
  ConnectionProfile,
  ConnectionTestResult,
  ExecuteQueryRequestInput,
  IntrospectSchemaRequestInput,
  QueryResult,
  RelationList,
  SaveProfileRequestInput,
  SchemaHints,
  SchemaList,
  SessionInfo,
} from "./database";

export { IPC_CHANNELS, type IpcChannel } from "./channels";
export * from "./database";
export {
  decodeIpcError,
  encodeIpcError,
  IPC_ERROR_CODES,
  type IpcError,
  type IpcErrorCode,
  type IpcErrorDetails,
  type IpcResult,
} from "./ipc";
export type { SchemaSnapshot };

/** For channels that take no argument: anything but `undefined` is rejected. */
export const NoPayloadSchema = z.undefined();

export const AppInfoSchema = z.object({
  name: z.literal("BPG Studio"),
  version: z.string().min(1),
});

export type AppInfo = z.infer<typeof AppInfoSchema>;

export interface BpgBridge {
  getAppInfo(): Promise<AppInfo>;
  db: {
    testConnection(
      params: ConnectionParamsInput,
    ): Promise<ConnectionTestResult>;
    openSession(params: ConnectionParamsInput): Promise<SessionInfo>;
    closeSession(sessionId: string): Promise<void>;
    listSessions(): Promise<SessionInfo[]>;
    executeQuery(request: ExecuteQueryRequestInput): Promise<QueryResult>;
    /** Resolves true when a cancel was sent to a running statement. */
    cancelQuery(sessionId: string): Promise<boolean>;
    getSchemaHints(sessionId: string): Promise<SchemaHints>;
    introspectSchema(
      sessionId: string,
      options?: Omit<IntrospectSchemaRequestInput, "sessionId">,
    ): Promise<SchemaSnapshot>;
    listSchemas(sessionId: string): Promise<SchemaList>;
    listRelations(sessionId: string, schema: string): Promise<RelationList>;
    describeRelation(
      sessionId: string,
      schema: string,
      name: string,
    ): Promise<ColumnDto[]>;
    testProfile(
      profileId: string,
      password?: string,
    ): Promise<ConnectionTestResult>;
    openProfileSession(
      profileId: string,
      password?: string,
    ): Promise<SessionInfo>;
  };
  profiles: {
    list(): Promise<ConnectionProfile[]>;
    save(request: SaveProfileRequestInput): Promise<ConnectionProfile>;
    delete(profileId: string): Promise<void>;
  };
}
