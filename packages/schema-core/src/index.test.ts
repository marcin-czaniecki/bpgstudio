import { describe, expect, it } from "vitest";
import {
  finalizeSnapshot,
  parseSnapshot,
  type SchemaTable,
  type SnapshotDraft,
  SnapshotParseError,
  serializeSnapshot,
} from "./index";

const table = (name: string): SchemaTable => ({
  name,
  columns: [
    {
      name: "id",
      type: "integer",
      notNull: true,
      default: null,
      identity: null,
      generated: null,
    },
  ],
  primaryKey: { name: `${name}_pkey`, columns: ["id"] },
  uniqueConstraints: [],
  foreignKeys: [],
  checks: [],
  indexes: [],
});

const draft = (
  tables: SchemaTable[],
  serverVersion = "17.0",
): SnapshotDraft => ({
  formatVersion: 1,
  engine: "postgres",
  serverVersion,
  scope: { includeSchemas: null, excludeSchemas: [] },
  schemas: [{ name: "public", tables }],
});

describe("schema snapshot", () => {
  it("does not depend on object creation order", async () => {
    const a = await finalizeSnapshot(draft([table("a"), table("b")]));
    const b = await finalizeSnapshot(draft([table("b"), table("a")]));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(serializeSnapshot(a)).toBe(serializeSnapshot(b));
  });

  it("ignores provenance such as the server version", async () => {
    const a = await finalizeSnapshot(draft([table("a")], "16.4"));
    const b = await finalizeSnapshot(draft([table("a")], "17.0"));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("changes when a column changes", async () => {
    const changed = table("a");
    const a = await finalizeSnapshot(draft([table("a")]));
    const b = await finalizeSnapshot(
      draft([
        {
          ...changed,
          columns: [
            ...changed.columns,
            {
              name: "x",
              type: "text",
              notNull: false,
              default: null,
              identity: null,
              generated: null,
            },
          ],
        },
      ]),
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("round-trips through JSON without loss", async () => {
    const snapshot = await finalizeSnapshot(draft([table("a"), table("b")]));
    expect(await parseSnapshot(serializeSnapshot(snapshot))).toEqual(snapshot);
  });

  it("rejects tampered content, bad structure and unknown versions", async () => {
    const snapshot = await finalizeSnapshot(draft([table("a")]));
    const tampered = serializeSnapshot(snapshot).replace('"a"', '"z"');
    await expect(parseSnapshot(tampered)).rejects.toThrow(SnapshotParseError);
    await expect(parseSnapshot("{}")).rejects.toThrow(SnapshotParseError);
    await expect(parseSnapshot("nope")).rejects.toThrow(SnapshotParseError);
    await expect(
      parseSnapshot(JSON.stringify({ ...snapshot, formatVersion: 2 })),
    ).rejects.toThrow(/Unsupported/);
  });
});
