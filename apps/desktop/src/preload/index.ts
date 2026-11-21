import type { AppInfo, BpgBridge } from "@bpg/contracts";
import { IPC_CHANNELS } from "@bpg/contracts/channels";
import { contextBridge, ipcRenderer } from "electron";

/**
 * Named-capability bridge. Nothing here validates payloads: preload runs on the
 * renderer side of the trust boundary, so a check here would only guard the
 * sandbox against the trusted main process. Every privileged handler in main
 * verifies the sender and validates with Zod at the boundary (ADR-0002,
 * ADR-0003), which is where an untrusted payload actually arrives.
 */
const bpg: BpgBridge = {
  async getAppInfo() {
    const result: unknown = await ipcRenderer.invoke(IPC_CHANNELS.appGetInfo);
    return result as AppInfo;
  },
};

contextBridge.exposeInMainWorld("bpg", bpg);
