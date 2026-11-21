import type { ConnectionParamsInput, SessionInfo } from "@bpg/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; text: string }
  | { kind: "ok"; text: string }
  | { kind: "error"; text: string };

function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    return typeof code === "string"
      ? `${code}: ${cause.message}`
      : cause.message;
  }
  return "Unknown error";
}

/**
 * The password is read from the DOM only at the moment of an action and is never
 * put into React state, so it is not retained in renderer memory structures.
 */
function readParams(form: HTMLFormElement): ConnectionParamsInput {
  const data = new FormData(form);
  const text = (name: string): string => String(data.get(name) ?? "");
  return {
    host: text("host"),
    port: Number(text("port")),
    database: text("database"),
    user: text("user"),
    password: text("password"),
    sslMode: text("sslMode") === "verify-full" ? "verify-full" : "disable",
  };
}

export function ConnectionPanel() {
  const formRef = useRef<HTMLFormElement>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "busy";

  const refresh = useCallback(async () => {
    try {
      setSessions(await window.bpg.db.listSessions());
    } catch (cause: unknown) {
      setStatus({ kind: "error", text: describeError(cause) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(text: string, action: () => Promise<string>) {
    setStatus({ kind: "busy", text });
    try {
      setStatus({ kind: "ok", text: await action() });
    } catch (cause: unknown) {
      setStatus({ kind: "error", text: describeError(cause) });
    }
    await refresh();
  }

  function onTest() {
    const form = formRef.current;
    if (!form) return;
    void run("Testing connection…", async () => {
      const result = await window.bpg.db.testConnection(readParams(form));
      return `Connection OK: PostgreSQL ${result.serverVersion} (${result.latencyMs} ms)`;
    });
  }

  function onConnect(event: FormEvent) {
    event.preventDefault();
    const form = formRef.current;
    if (!form) return;
    void run("Connecting…", async () => {
      const info = await window.bpg.db.openSession(readParams(form));
      const password = form.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
      return `Session open: ${info.user}@${info.host}:${info.port}/${info.database}`;
    });
  }

  function onDisconnect(sessionId: string) {
    void run("Disconnecting…", async () => {
      await window.bpg.db.closeSession(sessionId);
      return "Session closed";
    });
  }

  return (
    <section className="panel" aria-label="PostgreSQL connection">
      <h2>PostgreSQL connection</h2>
      <form ref={formRef} className="connection-form" onSubmit={onConnect}>
        <label>
          Host
          <input name="host" defaultValue="localhost" required />
        </label>
        <label>
          Port
          <input
            name="port"
            type="number"
            min={1}
            max={65535}
            defaultValue={5432}
            required
          />
        </label>
        <label>
          Database
          <input name="database" defaultValue="postgres" required />
        </label>
        <label>
          User
          <input name="user" defaultValue="postgres" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="off" />
        </label>
        <label>
          TLS
          <select name="sslMode" defaultValue="disable">
            <option value="disable">Disabled</option>
            <option value="verify-full">Verify certificate + host</option>
          </select>
        </label>
        <div className="actions">
          <button type="button" onClick={onTest} disabled={busy}>
            Test
          </button>
          <button type="submit" disabled={busy}>
            Connect
          </button>
        </div>
      </form>

      {status.kind !== "idle" && (
        <p role={status.kind === "error" ? "alert" : "status"}>{status.text}</p>
      )}

      <h3>Open sessions ({sessions.length})</h3>
      {sessions.length === 0 ? (
        <p>No open sessions.</p>
      ) : (
        <ul className="sessions">
          {sessions.map((session) => (
            <li key={session.id}>
              {session.user}@{session.host}:{session.port}/{session.database} ·
              PostgreSQL {session.serverVersion}{" "}
              <button
                type="button"
                onClick={() => onDisconnect(session.id)}
                disabled={busy}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
