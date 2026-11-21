import type { ColumnDto, RelationList } from "@bpg/contracts";
import { useCallback, useEffect, useState } from "react";

type Load<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "failed" };

type Relations = RelationList["relations"];

const KIND_LABEL: Record<Relations[number]["kind"], string> = {
  table: "table",
  "partitioned-table": "partitioned",
  view: "view",
  "materialized-view": "mat. view",
  "foreign-table": "foreign",
};

const quote = (name: string) =>
  /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;

interface Props {
  sessionId: string;
  /** Inserts text at the editor cursor. */
  onInsert: (text: string) => void;
}

/** Lazy schema → relation → column tree. Each level loads only when expanded. */
export function ObjectExplorer({ sessionId, onInsert }: Props) {
  const [schemas, setSchemas] = useState<Load<string[]>>({ status: "loading" });
  const [relations, setRelations] = useState<Record<string, Load<Relations>>>(
    {},
  );
  const [columns, setColumns] = useState<Record<string, Load<ColumnDto[]>>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState(false);

  const reload = useCallback(() => {
    setSchemas({ status: "loading" });
    setRelations({});
    setColumns({});
    setOpen(new Set());
    setTruncated(false);
    window.bpg.db
      .listSchemas(sessionId)
      .then((out) => {
        setSchemas({ status: "ready", value: out.schemas });
        setTruncated(out.truncated);
      })
      .catch(() => setSchemas({ status: "failed" }));
  }, [sessionId]);

  useEffect(() => {
    reload();
  }, [reload]);

  function toggle(key: string, load: () => void) {
    const next = new Set(open);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
      load();
    }
    setOpen(next);
  }

  function loadRelations(schema: string) {
    if (relations[schema]?.status === "ready") return;
    setRelations((r) => ({ ...r, [schema]: { status: "loading" } }));
    window.bpg.db
      .listRelations(sessionId, schema)
      .then((out) => {
        setRelations((r) => ({
          ...r,
          [schema]: { status: "ready", value: out.relations },
        }));
        if (out.truncated) setTruncated(true);
      })
      .catch(() =>
        setRelations((r) => ({ ...r, [schema]: { status: "failed" } })),
      );
  }

  function loadColumns(schema: string, name: string) {
    const key = `${schema}.${name}`;
    if (columns[key]?.status === "ready") return;
    setColumns((c) => ({ ...c, [key]: { status: "loading" } }));
    window.bpg.db
      .describeRelation(sessionId, schema, name)
      .then((value) =>
        setColumns((c) => ({ ...c, [key]: { status: "ready", value } })),
      )
      .catch(() => setColumns((c) => ({ ...c, [key]: { status: "failed" } })));
  }

  function renderColumns(cols: Load<ColumnDto[]> | undefined) {
    if (cols?.status === "loading") return <p>Loading…</p>;
    if (cols?.status === "failed") return <p role="alert">Could not load.</p>;
    if (cols?.status !== "ready") return null;
    return (
      <ul>
        {cols.value.map((c) => (
          <li key={c.name}>
            <button type="button" onClick={() => onInsert(quote(c.name))}>
              {c.isPrimaryKey ? "🔑 " : ""}
              {c.name}{" "}
              <small>
                {c.type}
                {c.notNull ? " not null" : ""}
              </small>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  function renderRelations(schema: string, rels: Load<Relations> | undefined) {
    if (rels?.status === "loading") return <p>Loading…</p>;
    if (rels?.status === "failed") return <p role="alert">Could not load.</p>;
    if (rels?.status !== "ready") return null;
    if (rels.value.length === 0) return <p>(empty)</p>;
    return (
      <ul>
        {rels.value.map((rel) => {
          const key = `${schema}.${rel.name}`;
          const relOpen = open.has(key);
          return (
            <li key={key}>
              <button
                type="button"
                aria-expanded={relOpen}
                onClick={() => toggle(key, () => loadColumns(schema, rel.name))}
              >
                {relOpen ? "▾" : "▸"} {rel.name}{" "}
                <small>{KIND_LABEL[rel.kind]}</small>
              </button>
              <button
                type="button"
                title="Insert name into the editor"
                aria-label={`Insert ${rel.name}`}
                onClick={() => onInsert(`${quote(schema)}.${quote(rel.name)}`)}
              >
                +
              </button>
              {relOpen && renderColumns(columns[key])}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="explorer">
      <div className="explorer-head">
        <strong>Objects</strong>
        <button type="button" onClick={reload}>
          Refresh
        </button>
      </div>
      {schemas.status === "loading" && <p role="status">Loading…</p>}
      {schemas.status === "failed" && (
        <p role="alert">Could not load objects.</p>
      )}
      {truncated && <p>List truncated; some objects are not shown.</p>}
      {schemas.status === "ready" && (
        <ul className="explorer-tree">
          {schemas.value.map((schema) => {
            const schemaOpen = open.has(schema);
            return (
              <li key={schema}>
                <button
                  type="button"
                  aria-expanded={schemaOpen}
                  onClick={() => toggle(schema, () => loadRelations(schema))}
                >
                  {schemaOpen ? "▾" : "▸"} {schema}
                </button>
                {schemaOpen && renderRelations(schema, relations[schema])}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
