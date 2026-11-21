import {
  decodeIpcError,
  type IpcErrorDetails,
  type QueryResult,
  type SessionInfo,
} from "@bpg/contracts";
import { useEffect, useRef, useState } from "react";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";

type Failure = {
  code: string;
  message: string;
  details?: IpcErrorDetails | undefined;
};

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; result: QueryResult }
  | { kind: "failed"; failure: Failure };

function toFailure(cause: unknown): Failure {
  const ipc = decodeIpcError(cause);
  if (ipc)
    return { code: ipc.code, message: ipc.message, details: ipc.details };
  return {
    code: "ERROR",
    message: cause instanceof Error ? cause.message : "Unknown error",
  };
}

function Cell({ value }: { value: string | number | boolean | null }) {
  if (value === null) return <em className="null-cell">NULL</em>;
  return <>{String(value)}</>;
}

export function QueryPanel({ sessions }: { sessions: SessionInfo[] }) {
  const editor = useRef<SqlEditorHandle>(null);
  const [sessionId, setSessionId] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const running = state.kind === "running";
  // Guards against a second Ctrl+Enter before React re-renders.
  const inFlight = useRef(false);

  // Keep the selection valid as sessions open and close.
  useEffect(() => {
    if (!sessions.some((s) => s.id === sessionId)) {
      setSessionId(sessions[0]?.id ?? "");
    }
  }, [sessions, sessionId]);

  async function run() {
    const text = editor.current?.getText() ?? "";
    if (inFlight.current || !sessionId || text.trim() === "") return;
    inFlight.current = true;
    setState({ kind: "running" });
    try {
      const result = await window.bpg.db.executeQuery({
        sessionId,
        sql: text,
      });
      setState({ kind: "done", result });
    } catch (cause: unknown) {
      const failure = toFailure(cause);
      setState({ kind: "failed", failure });
      if (failure.details?.position) {
        editor.current?.focusAt(failure.details.position);
      }
    } finally {
      inFlight.current = false;
    }
  }

  async function cancel() {
    if (!sessionId) return;
    try {
      await window.bpg.db.cancelQuery(sessionId);
    } catch {
      // The running query reports its own outcome.
    }
  }

  return (
    <section className="panel" aria-label="SQL query">
      <h2>SQL query</h2>
      {sessions.length === 0 ? (
        <p>Open a connection to run SQL.</p>
      ) : (
        <div className="query-toolbar">
          <label>
            Session
            <select
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              disabled={running}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.user}@{s.host}:{s.port}/{s.database}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void run()} disabled={running}>
            Run (Ctrl+Enter)
          </button>
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={!running}
          >
            Cancel
          </button>
        </div>
      )}
      <SqlEditor ref={editor} onRun={() => void run()} />

      {state.kind === "running" && <p role="status">Running…</p>}
      {state.kind === "failed" && (
        <div role="alert" className="query-error">
          <p>
            <strong>
              {state.failure.details?.sqlState ?? state.failure.code}
            </strong>
            : {state.failure.message}
          </p>
          {state.failure.details?.position !== undefined && (
            <p>Position {state.failure.details.position}</p>
          )}
          {state.failure.details?.detail && (
            <p>Detail: {state.failure.details.detail}</p>
          )}
          {state.failure.details?.hint && (
            <p>Hint: {state.failure.details.hint}</p>
          )}
        </div>
      )}
      {state.kind === "done" && (
        <>
          <p role="status">
            {state.result.command}
            {state.result.columns.length > 0
              ? ` · ${state.result.rows.length} row(s)`
              : state.result.rowCount !== null
                ? ` · ${state.result.rowCount} row(s) affected`
                : ""}{" "}
            · {state.result.durationMs} ms
            {state.result.truncated
              ? ` · truncated at ${state.result.rows.length} rows`
              : ""}
          </p>
          {state.result.columns.length > 0 && (
            <div className="result-scroll">
              <table className="results">
                <thead>
                  <tr>
                    {state.result.columns.map((column, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: column names may repeat
                      <th key={index}>{column.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.result.rows.map((row, rowIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
                    <tr key={rowIndex}>
                      {row.map((value, cellIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity
                        <td key={cellIndex}>
                          <Cell value={value} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
