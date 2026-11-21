import { describe, expect, it, vi } from "vitest";
import {
  createRendererUrlMatcher,
  createTrustedHandler,
  type InputSchema,
  type IpcEventLike,
  IpcFailure,
  type SenderPolicy,
} from "./trusted-handler";

const mainFrame = { url: "http://localhost:5173/" };
const webContents = { mainFrame };

const policy: SenderPolicy = {
  expectedSender: () => webContents,
  isAllowedUrl: createRendererUrlMatcher({
    devUrl: "http://localhost:5173",
    rendererFileUrl: "file:///app/out/renderer/index.html",
  }),
};

const goodEvent: IpcEventLike = { sender: webContents, senderFrame: mainFrame };

const textSchema: InputSchema<{ text: string }> = {
  safeParse: (value) =>
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string"
      ? { success: true, data: { text: value.text } }
      : { success: false },
};

function build(handle = vi.fn((input: { text: string }) => input.text)) {
  return {
    handle,
    run: createTrustedHandler({ policy, schema: textSchema, handle }),
  };
}

describe("createTrustedHandler", () => {
  it("runs the handler for a trusted sender with valid input", async () => {
    const { run, handle } = build();
    await expect(run(goodEvent, { text: "ok" })).resolves.toEqual({
      ok: true,
      data: "ok",
    });
    expect(handle).toHaveBeenCalledOnce();
  });

  it("rejects a different webContents", async () => {
    const { run, handle } = build();
    const other = { mainFrame: { url: "http://localhost:5173/" } };
    const result = await run(
      { sender: other, senderFrame: other.mainFrame },
      { text: "x" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects a call from a sub-frame of the trusted window", async () => {
    const { run, handle } = build();
    const iframe = { url: "http://localhost:5173/" };
    const result = await run(
      { sender: webContents, senderFrame: iframe },
      { text: "x" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects a missing sender frame", async () => {
    const { run } = build();
    const result = await run(
      { sender: webContents, senderFrame: null },
      { text: "x" },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("rejects a main frame navigated to a foreign origin", async () => {
    // Same trusted webContents and its main frame, but navigated away.
    const navigated = { url: "https://evil.example/" };
    const navigatedContents = { mainFrame: navigated };
    const handle = vi.fn(() => "never");
    const run = createTrustedHandler({
      policy: { ...policy, expectedSender: () => navigatedContents },
      schema: textSchema,
      handle,
    });
    await expect(
      run({ sender: navigatedContents, senderFrame: navigated }, { text: "x" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(handle).not.toHaveBeenCalled();
  });

  it("fails closed (FORBIDDEN, no raw error) when the sender check throws", async () => {
    const handle = vi.fn(() => "never");
    const run = createTrustedHandler({
      policy: {
        ...policy,
        expectedSender: () => {
          throw new Error("Object has been destroyed");
        },
      },
      schema: textSchema,
      handle,
    });
    await expect(run(goodEvent, { text: "x" })).resolves.toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "IPC sender not authorized" },
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects when no window exists yet", async () => {
    const run = createTrustedHandler({
      policy: { ...policy, expectedSender: () => null },
      schema: textSchema,
      handle: () => "never",
    });
    await expect(run(goodEvent, { text: "x" })).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });

  it("rejects invalid payloads without calling the handler", async () => {
    const { run, handle } = build();
    for (const payload of [undefined, null, 42, {}, { text: 1 }]) {
      await expect(run(goodEvent, payload)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects extra arguments", async () => {
    const { run, handle } = build();
    await expect(run(goodEvent, { text: "x" }, "extra")).resolves.toMatchObject(
      { ok: false, error: { code: "INVALID_INPUT" } },
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it("maps unexpected errors to INTERNAL without leaking the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = createTrustedHandler({
      policy,
      schema: textSchema,
      handle: () => {
        throw new Error("password=hunter2 failed");
      },
    });
    const result = await run(goodEvent, { text: "x" });
    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Internal error" },
    });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(spy.mock.calls.flat().join(" ")).not.toContain("hunter2");
    spy.mockRestore();
  });

  it("passes through IpcFailure with its own safe code and message", async () => {
    const run = createTrustedHandler({
      policy,
      schema: textSchema,
      handle: () => {
        throw new IpcFailure("SESSION_NOT_FOUND", "Session not found");
      },
    });
    await expect(run(goodEvent, { text: "x" })).resolves.toEqual({
      ok: false,
      error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
    });
  });
});

describe("createRendererUrlMatcher", () => {
  const dev = createRendererUrlMatcher({
    devUrl: "http://localhost:5173",
    rendererFileUrl: "file:///app/out/renderer/index.html",
  });
  const packaged = createRendererUrlMatcher({
    devUrl: undefined,
    rendererFileUrl: "file:///app/out/renderer/index.html",
  });

  it("accepts the dev origin only in dev mode", () => {
    expect(dev("http://localhost:5173/")).toBe(true);
    expect(dev("http://localhost:5173/#/x")).toBe(true);
    expect(dev("http://localhost:9999/")).toBe(false);
    expect(dev("file:///app/out/renderer/index.html")).toBe(false);
  });

  it("accepts only the packaged index.html in production", () => {
    expect(packaged("file:///app/out/renderer/index.html")).toBe(true);
    expect(packaged("file:///app/out/renderer/index.html#x")).toBe(true);
    expect(packaged("file:///etc/passwd")).toBe(false);
    expect(packaged("file://evil/app/out/renderer/index.html")).toBe(false);
    expect(packaged("http://localhost:5173/")).toBe(false);
    expect(packaged("not a url")).toBe(false);
  });
});
