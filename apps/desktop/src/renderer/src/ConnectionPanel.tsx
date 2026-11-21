import type {
  ConnectionParamsInput,
  ConnectionProfile,
  SaveProfileRequestInput,
  SessionInfo,
} from "@bpg/contracts";
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

function readPassword(form: HTMLFormElement): string {
  const field = form.elements.namedItem("password");
  return field instanceof HTMLInputElement ? field.value : "";
}

function readProfile(
  form: HTMLFormElement,
  editing: ConnectionProfile | null,
): SaveProfileRequestInput {
  const { password, ...fields } = readParams(form);
  const data = new FormData(form);
  const clear = data.get("clearPassword") === "on";
  return {
    ...(editing ? { id: editing.id } : {}),
    name: String(data.get("name") ?? ""),
    host: fields.host,
    port: fields.port,
    database: fields.database,
    user: fields.user,
    sslMode: fields.sslMode,
    password:
      password !== ""
        ? { action: "set", value: password }
        : { action: clear ? "clear" : "keep" },
  };
}

export function ConnectionPanel() {
  const formRef = useRef<HTMLFormElement>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "busy";

  const refresh = useCallback(async () => {
    try {
      setSessions(await window.bpg.db.listSessions());
      setProfiles(await window.bpg.profiles.list());
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

  function onSave() {
    const form = formRef.current;
    if (!form) return;
    void run("Saving…", async () => {
      const saved = await window.bpg.profiles.save(readProfile(form, editing));
      setEditing(null);
      return `Saved "${saved.name}"${saved.hasSavedPassword ? " (password stored securely)" : ""}`;
    });
  }

  function onTestProfile(profile: ConnectionProfile) {
    const form = formRef.current;
    const typed = form ? readPassword(form) : "";
    void run("Testing connection…", async () => {
      const result = await window.bpg.db.testProfile(
        profile.id,
        typed || undefined,
      );
      return `Connection OK: PostgreSQL ${result.serverVersion} (${result.latencyMs} ms)`;
    });
  }

  function onConnectProfile(profile: ConnectionProfile) {
    const form = formRef.current;
    const typed = form ? readPassword(form) : "";
    void run("Connecting…", async () => {
      const info = await window.bpg.db.openProfileSession(
        profile.id,
        typed || undefined,
      );
      return `Session open: ${info.user}@${info.host}:${info.port}/${info.database}`;
    });
  }

  function onDeleteProfile(profile: ConnectionProfile) {
    void run("Deleting…", async () => {
      await window.bpg.profiles.delete(profile.id);
      if (editing?.id === profile.id) setEditing(null);
      return `Deleted "${profile.name}"`;
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
      <form
        key={editing?.id ?? "new"}
        ref={formRef}
        className="connection-form"
        onSubmit={onConnect}
      >
        <label>
          Name
          <input name="name" defaultValue={editing?.name ?? ""} />
        </label>
        <label>
          Host
          <input
            name="host"
            defaultValue={editing?.host ?? "localhost"}
            required
          />
        </label>
        <label>
          Port
          <input
            name="port"
            type="number"
            min={1}
            max={65535}
            defaultValue={editing?.port ?? 5432}
            required
          />
        </label>
        <label>
          Database
          <input
            name="database"
            defaultValue={editing?.database ?? "postgres"}
            required
          />
        </label>
        <label>
          User
          <input
            name="user"
            defaultValue={editing?.user ?? "postgres"}
            required
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="off"
            placeholder={editing?.hasSavedPassword ? "(saved)" : ""}
          />
        </label>
        <label>
          TLS
          <select name="sslMode" defaultValue={editing?.sslMode ?? "disable"}>
            <option value="disable">Disabled</option>
            <option value="verify-full">Verify certificate + host</option>
          </select>
        </label>
        {editing?.hasSavedPassword && (
          <label>
            <span>
              <input name="clearPassword" type="checkbox" /> Remove saved
              password
            </span>
          </label>
        )}
        <div className="actions">
          <button type="button" onClick={onTest} disabled={busy}>
            Test
          </button>
          <button type="submit" disabled={busy}>
            Connect
          </button>
          <button type="button" onClick={onSave} disabled={busy}>
            {editing ? "Update" : "Save"}
          </button>
          {editing && (
            <button type="button" onClick={() => setEditing(null)}>
              Cancel edit
            </button>
          )}
        </div>
      </form>

      {status.kind !== "idle" && (
        <p role={status.kind === "error" ? "alert" : "status"}>{status.text}</p>
      )}

      <h3>Saved connections ({profiles.length})</h3>
      {profiles.length === 0 ? (
        <p>No saved connections.</p>
      ) : (
        <ul className="sessions">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <strong>{profile.name}</strong> · {profile.user}@{profile.host}:
              {profile.port}/{profile.database}
              {profile.hasSavedPassword ? " · password saved" : ""}{" "}
              <button
                type="button"
                onClick={() => onTestProfile(profile)}
                disabled={busy}
              >
                Test saved
              </button>{" "}
              <button
                type="button"
                onClick={() => onConnectProfile(profile)}
                disabled={busy}
              >
                Connect saved
              </button>{" "}
              <button type="button" onClick={() => setEditing(profile)}>
                Edit
              </button>{" "}
              <button
                type="button"
                onClick={() => onDeleteProfile(profile)}
                disabled={busy}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
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
