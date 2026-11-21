import type { IntrospectOptions } from "@bpg/database-core";
import {
  type ForeignKey,
  finalizeSnapshot,
  type KeyConstraint,
  type ReferentialAction,
  type SchemaColumn,
  type SchemaSnapshot,
  type SchemaTable,
  SNAPSHOT_FORMAT_VERSION,
} from "@bpg/schema-core";
import type { MetadataQuery } from "./metadata";

/** Hard cap per catalog query; beyond it the snapshot would be partial, so we refuse. */
export const MAX_CATALOG_ROWS = 200_000;

const SCHEMAS_SQL = `
SELECT nspname FROM pg_namespace
WHERE nspname NOT IN ('pg_catalog', 'information_schema')
  AND nspname NOT LIKE 'pg\\_toast%'
  AND nspname NOT LIKE 'pg\\_temp\\_%'
ORDER BY nspname`;

const COLUMNS_SQL = `
SELECT n.nspname AS schema, c.relname AS "table", a.attname::text AS name,
       format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
       pg_get_expr(d.adbin, d.adrelid) AS expr,
       a.attidentity::text AS identity, a.attgenerated::text AS generated
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attribute a
  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND n.nspname = ANY ($1::text[])
ORDER BY n.nspname, c.relname, a.attnum
LIMIT ${MAX_CATALOG_ROWS + 1}`;

const CONSTRAINTS_SQL = `
SELECT n.nspname AS schema, c.relname AS "table", con.conname::text AS name,
       con.contype::text AS type,
       con.confupdtype::text AS on_update, con.confdeltype::text AS on_delete,
       con.confmatchtype::text AS match,
       con.condeferrable AS deferrable, con.condeferred AS deferred,
       pg_get_constraintdef(con.oid) AS definition,
       ARRAY(
         SELECT a.attname::text
         FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
         ORDER BY k.ord) AS columns,
       rn.nspname AS ref_schema, rc.relname AS ref_table,
       ARRAY(
         SELECT a.attname::text
         FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
         ORDER BY k.ord) AS ref_columns
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class rc ON rc.oid = con.confrelid
LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE con.contype IN ('p', 'u', 'f', 'c') AND con.conparentid = 0
  AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND n.nspname = ANY ($1::text[])
ORDER BY n.nspname, c.relname, con.conname
LIMIT ${MAX_CATALOG_ROWS + 1}`;

/** Indexes that merely back a PK/UNIQUE/EXCLUDE constraint are modeled by the constraint. */
const INDEXES_SQL = `
SELECT n.nspname AS schema, t.relname AS "table", i.relname::text AS name,
       ix.indisunique AS "unique", am.amname::text AS method,
       pg_get_indexdef(ix.indexrelid) AS definition
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_am am ON am.oid = i.relam
WHERE t.relkind IN ('r', 'p') AND NOT t.relispartition AND NOT i.relispartition
  AND n.nspname = ANY ($1::text[])
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conindid = ix.indexrelid AND c.contype IN ('p', 'u', 'x'))
ORDER BY n.nspname, t.relname, i.relname
LIMIT ${MAX_CATALOG_ROWS + 1}`;

const ACTIONS: Record<string, ReferentialAction> = {
  a: "no-action",
  r: "restrict",
  c: "cascade",
  n: "set-null",
  d: "set-default",
};
const MATCH: Record<string, ForeignKey["match"]> = {
  s: "simple",
  f: "full",
  p: "partial",
};

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

async function capped(
  query: MetadataQuery,
  sql: string,
  schemas: string[],
): Promise<Row[]> {
  const rows = await query(sql, [schemas]);
  if (rows.length > MAX_CATALOG_ROWS) {
    throw new Error("Schema is too large to introspect in one snapshot");
  }
  return rows;
}

/**
 * Reads the catalog into a canonical snapshot. Call inside one read-only,
 * repeatable-read transaction so all four queries see the same state.
 */
export async function introspect(
  query: MetadataQuery,
  serverVersion: string,
  options: IntrospectOptions = {},
): Promise<SchemaSnapshot> {
  const include = options.includeSchemas ?? null;
  const exclude = options.excludeSchemas ?? [];

  const all = (await query(SCHEMAS_SQL)).map((r) => str(r.nspname));
  const schemas = all.filter(
    (name) =>
      name !== "" &&
      (include === null || include.includes(name)) &&
      !exclude.includes(name),
  );

  const [columnRows, constraintRows, indexRows] = [
    await capped(query, COLUMNS_SQL, schemas),
    await capped(query, CONSTRAINTS_SQL, schemas),
    await capped(query, INDEXES_SQL, schemas),
  ];

  const tables = new Map<string, SchemaTable>();
  const key = (schema: string, table: string) => `${schema}\u0000${table}`;

  for (const r of columnRows) {
    const k = key(str(r.schema), str(r.table));
    let table = tables.get(k);
    if (!table) {
      table = {
        name: str(r.table),
        columns: [],
        primaryKey: null,
        uniqueConstraints: [],
        foreignKeys: [],
        checks: [],
        indexes: [],
      };
      tables.set(k, table);
    }
    if (r.name === null || r.name === undefined) continue; // table without columns
    const stored = r.generated === "s";
    const column: SchemaColumn = {
      name: str(r.name),
      type: str(r.type),
      notNull: r.not_null === true,
      default: stored || typeof r.expr !== "string" ? null : r.expr,
      identity:
        r.identity === "a"
          ? "always"
          : r.identity === "d"
            ? "by-default"
            : null,
      generated: stored && typeof r.expr === "string" ? r.expr : null,
    };
    (table.columns as SchemaColumn[]).push(column);
  }

  for (const r of constraintRows) {
    const table = tables.get(key(str(r.schema), str(r.table)));
    if (!table) continue;
    const name = str(r.name);
    const columns = strs(r.columns);
    const type = str(r.type);
    if (type === "p") {
      (table as { primaryKey: KeyConstraint | null }).primaryKey = {
        name,
        columns,
      };
    } else if (type === "u") {
      (table.uniqueConstraints as KeyConstraint[]).push({ name, columns });
    } else if (type === "f") {
      (table.foreignKeys as ForeignKey[]).push({
        name,
        columns,
        referencedSchema: str(r.ref_schema),
        referencedTable: str(r.ref_table),
        referencedColumns: strs(r.ref_columns),
        onUpdate: ACTIONS[str(r.on_update)] ?? "no-action",
        onDelete: ACTIONS[str(r.on_delete)] ?? "no-action",
        match: MATCH[str(r.match)] ?? "simple",
        deferrable: r.deferrable === true,
        initiallyDeferred: r.deferred === true,
      });
    } else if (type === "c") {
      table.checks.push({ name, definition: str(r.definition) });
    }
  }

  for (const r of indexRows) {
    const table = tables.get(key(str(r.schema), str(r.table)));
    table?.indexes.push({
      name: str(r.name),
      unique: r.unique === true,
      method: str(r.method),
      definition: str(r.definition),
    });
  }

  const bySchema = new Map<string, SchemaTable[]>(
    schemas.map((name) => [name, []]),
  );
  for (const [k, table] of tables) {
    bySchema.get(k.slice(0, k.indexOf("\u0000")))?.push(table);
  }

  return await finalizeSnapshot({
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    engine: "postgres",
    serverVersion,
    scope: {
      includeSchemas: include ? [...include] : null,
      excludeSchemas: [...exclude],
    },
    schemas: [...bySchema].map(([name, list]) => ({ name, tables: list })),
  });
}
