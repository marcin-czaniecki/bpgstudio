import type {
  ColumnInfo,
  Limited,
  RelationEntry,
  RelationKind,
} from "@bpg/database-core";

export type MetadataQuery = (
  sql: string,
  values?: readonly unknown[],
) => Promise<Array<Record<string, unknown>>>;

export const MAX_SCHEMAS = 1000;
export const MAX_RELATIONS = 5000;

const SCHEMAS_SQL = `
SELECT nspname FROM pg_namespace
WHERE nspname NOT IN ('pg_catalog', 'information_schema')
  AND nspname NOT LIKE 'pg_toast%'
  AND nspname NOT LIKE 'pg_temp_%'
ORDER BY nspname
LIMIT ${MAX_SCHEMAS + 1}`;

const RELATIONS_SQL = `
SELECT c.relname, c.relkind::text AS relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND NOT c.relispartition
ORDER BY c.relname
LIMIT ${MAX_RELATIONS + 1}`;

const COLUMNS_SQL = `
SELECT a.attname,
       format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull,
       EXISTS (
         SELECT 1 FROM pg_index i
         WHERE i.indrelid = a.attrelid AND i.indisprimary
           AND a.attnum = ANY (i.indkey)
       ) AS is_pk
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum
LIMIT 1700`;

const KINDS: Record<string, RelationKind> = {
  r: "table",
  p: "partitioned-table",
  v: "view",
  m: "materialized-view",
  f: "foreign-table",
};

function limit<T>(items: T[], max: number): Limited<T> {
  return items.length > max
    ? { items: items.slice(0, max), truncated: true }
    : { items, truncated: false };
}

export async function listSchemas(
  query: MetadataQuery,
): Promise<Limited<string>> {
  const rows = await query(SCHEMAS_SQL);
  return limit(
    rows.flatMap((r) => (typeof r.nspname === "string" ? [r.nspname] : [])),
    MAX_SCHEMAS,
  );
}

export async function listRelations(
  query: MetadataQuery,
  schema: string,
): Promise<Limited<RelationEntry>> {
  const rows = await query(RELATIONS_SQL, [schema]);
  const items: RelationEntry[] = [];
  for (const r of rows) {
    const kind = typeof r.relkind === "string" ? KINDS[r.relkind] : undefined;
    if (typeof r.relname === "string" && kind) {
      items.push({ name: r.relname, kind });
    }
  }
  return limit(items, MAX_RELATIONS);
}

export async function describeRelation(
  query: MetadataQuery,
  schema: string,
  name: string,
): Promise<ColumnInfo[]> {
  const rows = await query(COLUMNS_SQL, [schema, name]);
  const columns: ColumnInfo[] = [];
  for (const r of rows) {
    if (typeof r.attname !== "string" || typeof r.type !== "string") continue;
    columns.push({
      name: r.attname,
      type: r.type,
      notNull: r.attnotnull === true,
      isPrimaryKey: r.is_pk === true,
    });
  }
  return columns;
}
