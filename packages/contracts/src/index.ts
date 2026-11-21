import { z } from "zod";

export { IPC_CHANNELS, type IpcChannel } from "./channels";

export const AppInfoSchema = z.object({
  name: z.literal("BPG Studio"),
  version: z.string().min(1),
});

export type AppInfo = z.infer<typeof AppInfoSchema>;

export interface BpgBridge {
  getAppInfo(): Promise<AppInfo>;
}
