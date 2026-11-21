import type { DatabaseError } from "./errors";

/** Structural subset of DatabaseSession; avoids a circular import with index. */
interface RegistrableSession {
  readonly id: string;
  close(): Promise<void>;
  onClosed(listener: (reason: DatabaseError | null) => void): void;
}

export interface CloseAllResult {
  readonly closed: number;
  readonly failed: number;
  readonly timedOut: boolean;
}

/** Tracks open sessions and guarantees they are released. Pure logic. */
export class SessionRegistry<S extends RegistrableSession> {
  readonly #sessions = new Map<string, S>();
  readonly #onLost: ((session: S, reason: DatabaseError) => void) | undefined;

  constructor(options?: {
    /** Called when a session ends abnormally (e.g. the server dropped it). */
    onLost?: (session: S, reason: DatabaseError) => void;
  }) {
    this.#onLost = options?.onLost;
  }

  add(session: S): void {
    this.#sessions.set(session.id, session);
    session.onClosed((reason) => {
      if (this.#sessions.get(session.id) === session) {
        this.#sessions.delete(session.id);
      }
      if (reason !== null) this.#onLost?.(session, reason);
    });
  }

  get(id: string): S | undefined {
    return this.#sessions.get(id);
  }

  list(): S[] {
    return [...this.#sessions.values()];
  }

  /** Returns false when the id is unknown. The session is removed even if close() throws. */
  async close(id: string): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    this.#sessions.delete(id);
    await session.close();
    return true;
  }

  /** Closes every session; one failure does not stop the rest. Bounded by timeoutMs. */
  async closeAll(timeoutMs: number): Promise<CloseAllResult> {
    const sessions = this.list();
    this.#sessions.clear();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const all = Promise.allSettled(sessions.map((s) => s.close()));

    try {
      const outcome = await Promise.race([all, timeout]);
      if (outcome === "timeout") {
        return { closed: 0, failed: sessions.length, timedOut: true };
      }
      const failed = outcome.filter((r) => r.status === "rejected").length;
      return { closed: sessions.length - failed, failed, timedOut: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
