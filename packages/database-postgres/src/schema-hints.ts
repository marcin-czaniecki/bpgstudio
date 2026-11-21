import type { DatabaseSession } from "@bpg/database-core";

export interface TableHint {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly string[];
}

export interface SchemaHintsOutcome {
  readonly tables: readonly TableHint[];
  readonly truncated: boolean;
}

/** One row per column (or per column-less relation); names only, no data. */
const HINTS_SQL = `
SELECT n.nspname, c.relname, a.attname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attribute a
  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp_%'
ORDER BY n.nspname, c.relname, a.attnum`;

const MAX_HINT_ROWS = 10_000;

/** Reads relation and column names visible to the session's role, for autocompletion. */
export async function loadSchemaHints(
  session: DatabaseSession,
): Promise<SchemaHintsOutcome> {
  const outcome = await session.execute(HINTS_SQL, {
    maxRows: MAX_HINT_ROWS,
    timeoutMs: 15_000,
  });
  const tables = new Map<
    string,
    { schema: string; name: string; cols: string[] }
  >();
  for (const [schema, name, column] of outcome.rows) {
    if (typeof schema !== "string" || typeof name !== "string") continue;
    const key = `${schema}\u0000${name}`;
    let table = tables.get(key);
    if (!table) {
      table = { schema, name, cols: [] };
      tables.set(key, table);
    }
    if (typeof column === "string") table.cols.push(column);
  }
  return {
    tables: [...tables.values()].map((t) => ({
      schema: t.schema,
      name: t.name,
      columns: t.cols,
    })),
    truncated: outcome.truncated,
  };
}
