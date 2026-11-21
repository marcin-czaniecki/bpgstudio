import type {
  AppInfo,
  BpgBridge,
  ConnectionTestResult,
  SessionInfo,
} from "@bpg/contracts";
import { IPC_CHANNELS } from "@bpg/contracts/channels";
import type { IpcResult } from "@bpg/contracts/ipc";
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
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
    });
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
  },
};

contextBridge.exposeInMainWorld("bpg", bpg);
