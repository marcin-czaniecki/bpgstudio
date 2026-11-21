import { describe, expect, it, vi } from "vitest";
import { DatabaseError } from "./errors";
import { SessionRegistry } from "./session-registry";

class FakeSession {
  closeCalls = 0;
  #listener: ((reason: DatabaseError | null) => void) | undefined;

  constructor(
    readonly id: string,
    private readonly behavior: "ok" | "throw" | "hang" = "ok",
  ) {}

  onClosed(listener: (reason: DatabaseError | null) => void): void {
    this.#listener = listener;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.behavior === "throw") throw new Error("close failed");
    if (this.behavior === "hang") return new Promise<void>(() => {});
    this.#listener?.(null);
  }

  drop(reason: DatabaseError): void {
    this.#listener?.(reason);
  }
}

describe("SessionRegistry", () => {
  it("adds, gets and lists sessions", () => {
    const registry = new SessionRegistry<FakeSession>();
    const a = new FakeSession("a");
    registry.add(a);
    expect(registry.get("a")).toBe(a);
    expect(registry.list()).toEqual([a]);
  });

  it("close() removes and closes; unknown id returns false", async () => {
    const registry = new SessionRegistry<FakeSession>();
    const a = new FakeSession("a");
    registry.add(a);
    await expect(registry.close("a")).resolves.toBe(true);
    expect(a.closeCalls).toBe(1);
    expect(registry.list()).toEqual([]);
    await expect(registry.close("a")).resolves.toBe(false);
  });

  it("close() removes the session even when close throws", async () => {
    const registry = new SessionRegistry<FakeSession>();
    registry.add(new FakeSession("a", "throw"));
    await expect(registry.close("a")).rejects.toThrow("close failed");
    expect(registry.get("a")).toBeUndefined();
  });

  it("drops a session the server ended and reports it as lost", () => {
    const onLost = vi.fn();
    const registry = new SessionRegistry<FakeSession>({ onLost });
    const a = new FakeSession("a");
    registry.add(a);
    const reason = new DatabaseError("CONNECTION_LOST", "Connection lost");
    a.drop(reason);
    expect(registry.list()).toEqual([]);
    expect(onLost).toHaveBeenCalledWith(a, reason);
  });

  it("does not report a normal close as lost", async () => {
    const onLost = vi.fn();
    const registry = new SessionRegistry<FakeSession>({ onLost });
    registry.add(new FakeSession("a"));
    await registry.close("a");
    expect(onLost).not.toHaveBeenCalled();
  });

  it("closeAll closes everything even if one session fails", async () => {
    const registry = new SessionRegistry<FakeSession>();
    const ok = new FakeSession("ok");
    const bad = new FakeSession("bad", "throw");
    registry.add(ok);
    registry.add(bad);
    await expect(registry.closeAll(1000)).resolves.toEqual({
      closed: 1,
      failed: 1,
      timedOut: false,
    });
    expect(ok.closeCalls).toBe(1);
    expect(bad.closeCalls).toBe(1);
    expect(registry.list()).toEqual([]);
  });

  it("closeAll returns after the timeout when a session hangs", async () => {
    const registry = new SessionRegistry<FakeSession>();
    registry.add(new FakeSession("hang", "hang"));
    const started = Date.now();
    const result = await registry.closeAll(50);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(registry.list()).toEqual([]);
  });
});
