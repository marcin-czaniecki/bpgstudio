/**
 * IPC channel names.
 *
 * Deliberately free of any runtime dependency (no Zod). The preload bundle is
 * evaluated in the sandboxed renderer process before every window load, so it
 * must stay small and must not pull a validation library across the trust
 * boundary. See ADR-0003.
 */
export const IPC_CHANNELS = {
  appGetInfo: "app:get-info",
  dbTestConnection: "db:test-connection",
  dbOpenSession: "db:open-session",
  dbCloseSession: "db:close-session",
  dbListSessions: "db:list-sessions",
  dbExecuteQuery: "db:execute-query",
  dbCancelQuery: "db:cancel-query",
  dbTestProfile: "db:test-profile",
  dbOpenProfileSession: "db:open-profile-session",
  profilesList: "profiles:list",
  profilesSave: "profiles:save",
  profilesDelete: "profiles:delete",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
