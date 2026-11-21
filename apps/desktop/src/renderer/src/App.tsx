import type { AppInfo, SessionInfo } from "@bpg/contracts";
import { useEffect, useState } from "react";
import { ConnectionPanel } from "./ConnectionPanel";
import { QueryPanel } from "./QueryPanel";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    let active = true;
    void window.bpg
      .getAppInfo()
      .then((value) => {
        if (active) setInfo(value);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Unknown IPC error",
          );
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="shell">
      <p className="eyebrow">BPG Studio / Foundation</p>
      <h1>BPG Studio</h1>
      <p className="description">
        Bezpieczny szkielet Electron + React. PostgreSQL Core to kolejny etap.
      </p>
      <section className="panel" aria-label="Application status">
        <h2>Desktop bootstrap</h2>
        <p>IPC status: {error ? "error" : info ? "connected" : "connecting"}</p>
        {info && (
          <p>
            App: {info.name} / version: {info.version}
          </p>
        )}
        {error && <p role="alert">IPC error: {error}</p>}
      </section>
      <ConnectionPanel onSessionsChange={setSessions} />
      <QueryPanel sessions={sessions} />
    </main>
  );
}
