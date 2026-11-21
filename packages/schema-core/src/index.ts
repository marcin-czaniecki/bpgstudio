/**
 * Canonical schema snapshot (format v1). Engine-neutral model with no database
 * driver, Electron or UI dependencies. Identity is schema + name, never an OID.
 */
import { z } from "zod";

export const SNAPSHOT_FORMAT_VERSION = 1;

const ReferentialAction = z.enum([
  "no-action",
  "restrict",
  "cascade",
  "set-null",
  "set-default",
]);
export type ReferentialAction = z.infer<typeof ReferentialAction>;

const ColumnSchema = z.object({
  name: z.string(),
  /** Type as the server formats it, e.g. "character varying(20)". */
  type: z.string(),
  notNull: z.boolean(),
  /** Default expression text; null for none and for generated columns. */
  default: z.string().nullable(),
  identity: z.enum(["always", "by-default"]).nullable(),
  /** Generation expression of a STORED generated column. */
  generated: z.string().nullable(),
});

const KeyConstraintSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
});

const ForeignKeySchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  referencedSchema: z.string(),
  referencedTable: z.string(),
  referencedColumns: z.array(z.string()),
  onUpdate: ReferentialAction,
  onDelete: ReferentialAction,
  match: z.enum(["simple", "full", "partial"]),
  deferrable: z.boolean(),
  initiallyDeferred: z.boolean(),
});

const CheckSchema = z.object({
  name: z.string(),
  /** Server-normalized definition, e.g. "CHECK ((price > 0))". */
  definition: z.string(),
});

const IndexSchema = z.object({
  name: z.string(),
  unique: z.boolean(),
  method: z.string(),
  /** Server-normalized CREATE INDEX statement; kept verbatim (not parsed). */
  definition: z.string(),
});

const TableSchema = z.object({
  name: z.string(),
  columns: z.array(ColumnSchema),
  primaryKey: KeyConstraintSchema.nullable(),
  uniqueConstraints: z.array(KeyConstraintSchema),
  foreignKeys: z.array(ForeignKeySchema),
  checks: z.array(CheckSchema),
  indexes: z.array(IndexSchema),
});

const SchemaNodeSchema = z.object({
  name: z.string(),
  tables: z.array(TableSchema),
});

const ScopeSchema = z.object({
  includeSchemas: z.array(z.string()).nullable(),
  excludeSchemas: z.array(z.string()),
});

export const SchemaSnapshotSchema = z.object({
  formatVersion: z.literal(SNAPSHOT_FORMAT_VERSION),
  engine: z.literal("postgres"),
  /** Provenance only: not part of the fingerprint, so snapshots compare across versions. */
  serverVersion: z.string(),
  scope: ScopeSchema,
  schemas: z.array(SchemaNodeSchema),
  /** SHA-256 over the semantic content (format, engine, schemas). */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

export type SchemaColumn = z.infer<typeof ColumnSchema>;
export type KeyConstraint = z.infer<typeof KeyConstraintSchema>;
export type ForeignKey = z.infer<typeof ForeignKeySchema>;
export type CheckConstraint = z.infer<typeof CheckSchema>;
export type SchemaIndex = z.infer<typeof IndexSchema>;
export type SchemaTable = z.infer<typeof TableSchema>;
export type SchemaNode = z.infer<typeof SchemaNodeSchema>;
export type SchemaSnapshot = z.infer<typeof SchemaSnapshotSchema>;

/** What an introspector produces; ordering and fingerprint are added by finalizeSnapshot. */
export type SnapshotDraft = Omit<SchemaSnapshot, "fingerprint">;

const byName = <T extends { name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function normalizeTable(table: SchemaTable): SchemaTable {
  return {
    ...table,
    // Column order (attnum) is semantic and kept as given.
    uniqueConstraints: [...table.uniqueConstraints].sort(byName),
    foreignKeys: [...table.foreignKeys].sort(byName),
    checks: [...table.checks].sort(byName),
    indexes: [...table.indexes].sort(byName),
  };
}

/** Sorts everything whose order is not semantic, so equal schemas serialize equally. */
export function normalizeDraft(draft: SnapshotDraft): SnapshotDraft {
  return {
    ...draft,
    scope: {
      includeSchemas: draft.scope.includeSchemas
        ? [...draft.scope.includeSchemas].sort()
        : null,
      excludeSchemas: [...draft.scope.excludeSchemas].sort(),
    },
    schemas: [...draft.schemas].sort(byName).map((schema) => ({
      ...schema,
      tables: [...schema.tables].sort(byName).map(normalizeTable),
    })),
  };
}

/** JSON with object keys sorted, so output never depends on construction order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return v;
  });
}

/** SHA-256 hex through Web Crypto, so this package runs in Node and in a browser alike. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeFingerprint(
  snapshot: Pick<SchemaSnapshot, "formatVersion" | "engine" | "schemas">,
): Promise<string> {
  const semantic = {
    formatVersion: snapshot.formatVersion,
    engine: snapshot.engine,
    schemas: snapshot.schemas,
  };
  return sha256Hex(canonicalJson(semantic));
}

export async function finalizeSnapshot(
  draft: SnapshotDraft,
): Promise<SchemaSnapshot> {
  const normalized = normalizeDraft(draft);
  return { ...normalized, fingerprint: await computeFingerprint(normalized) };
}

export function serializeSnapshot(snapshot: SchemaSnapshot): string {
  return canonicalJson(snapshot);
}

export class SnapshotParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotParseError";
  }
}

/** Validates the shape and rejects content whose fingerprint does not match. */
export async function parseSnapshot(text: string): Promise<SchemaSnapshot> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotParseError("Snapshot is not valid JSON");
  }
  if (
    raw &&
    typeof raw === "object" &&
    "formatVersion" in raw &&
    raw.formatVersion !== SNAPSHOT_FORMAT_VERSION
  ) {
    throw new SnapshotParseError("Unsupported snapshot format version");
  }
  const parsed = SchemaSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SnapshotParseError("Snapshot has an invalid structure");
  }
  if ((await computeFingerprint(parsed.data)) !== parsed.data.fingerprint) {
    throw new SnapshotParseError("Snapshot fingerprint does not match content");
  }
  return parsed.data;
}
