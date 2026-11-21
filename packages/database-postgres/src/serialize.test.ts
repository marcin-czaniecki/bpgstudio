import { describe, expect, it } from "vitest";
import { MAX_CELL_CHARS, toCell } from "./serialize";

describe("toCell", () => {
  it("passes primitives through and maps null/undefined to null", () => {
    expect(toCell(null)).toBeNull();
    expect(toCell(undefined)).toBeNull();
    expect(toCell("a")).toBe("a");
    expect(toCell(1.5)).toBe(1.5);
    expect(toCell(true)).toBe(true);
  });

  it("keeps non-finite numbers and bigint as strings", () => {
    expect(toCell(Number.NaN)).toBe("NaN");
    expect(toCell(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(toCell(9007199254740993n)).toBe("9007199254740993");
  });

  it("serializes dates, invalid dates, bytea, json and arrays", () => {
    expect(toCell(new Date("2026-01-02T03:04:05Z"))).toBe(
      "2026-01-02T03:04:05.000Z",
    );
    expect(toCell(new Date("nope"))).toBe("Invalid Date");
    expect(toCell(Buffer.from([0, 15, 255]))).toBe("\\x000fff");
    expect(toCell({ a: [1, null] })).toBe('{"a":[1,null]}');
    expect(toCell([1, 2])).toBe("[1,2]");
  });

  it("does not throw on circular structures", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(toCell(loop)).toBe("[unserializable value]");
  });

  it("clips long text and long binary values with a visible mark", () => {
    const text = toCell("x".repeat(MAX_CELL_CHARS + 50)) as string;
    expect(text.startsWith("x".repeat(MAX_CELL_CHARS))).toBe(true);
    expect(text.endsWith("[truncated]")).toBe(true);
    const bin = toCell(Buffer.alloc(MAX_CELL_CHARS)) as string;
    expect(bin.endsWith("[truncated]")).toBe(true);
    expect(bin.length).toBeLessThan(MAX_CELL_CHARS + 20);
  });
});
