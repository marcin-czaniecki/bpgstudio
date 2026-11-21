/** Minimal stable contracts. Add capabilities when a real second DB exists. */
export interface DatabaseConnectionInfo {
  id: string;
  label: string;
  kind: "postgres";
}

export interface DatabaseSession {
  readonly id: string;
  close(): Promise<void>;
}
