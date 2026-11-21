import { z } from "zod";
import type {
  ConnectionParamsInput,
  ConnectionTestResult,
  SessionInfo,
} from "./database";

export { IPC_CHANNELS, type IpcChannel } from "./channels";
export * from "./database";
export {
  IPC_ERROR_CODES,
  type IpcError,
  type IpcErrorCode,
  type IpcResult,
} from "./ipc";

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
  };
}
