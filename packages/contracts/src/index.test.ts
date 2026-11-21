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

describe("bridge error encoding", () => {
  it("round-trips code, message and details through an Error message", async () => {
    const { decodeIpcError, encodeIpcError } = await import("./ipc");
    const error = {
      code: "QUERY_FAILED" as const,
      message: 'syntax error at or near "x"',
      details: { sqlState: "42601", position: 7, hint: "h" },
    };
    expect(decodeIpcError(new Error(encodeIpcError(error)))).toEqual(error);
    expect(
      decodeIpcError(
        new Error(encodeIpcError({ code: "INTERNAL", message: "m" })),
      ),
    ).toEqual({ code: "INTERNAL", message: "m" });
  });

  it("returns null for ordinary or malformed errors", async () => {
    const { decodeIpcError } = await import("./ipc");
    expect(decodeIpcError(new Error("boom"))).toBeNull();
    expect(decodeIpcError(new Error("BPG_IPC_ERROR:{not json"))).toBeNull();
    expect(decodeIpcError(new Error('BPG_IPC_ERROR:{"code":1}'))).toBeNull();
    expect(decodeIpcError("string")).toBeNull();
  });
});
