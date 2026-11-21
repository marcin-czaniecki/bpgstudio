import { describe, expect, it } from "vitest";
import { AppInfoSchema, IPC_CHANNELS } from "./index";

describe("IPC contract", () => {
  it("provides a stable app info channel", () => {
    expect(IPC_CHANNELS.appGetInfo).toBe("app:get-info");
  });

  it("rejects an unexpected application identity", () => {
    expect(
      AppInfoSchema.safeParse({ name: "Other", version: "1" }).success,
    ).toBe(false);
  });
});
