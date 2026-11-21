import type { BpgBridge } from "@bpg/contracts";

declare global {
  interface Window {
    bpg: BpgBridge;
  }
}
