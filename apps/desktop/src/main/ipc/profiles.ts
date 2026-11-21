import {
  type ConnectionProfile,
  IPC_CHANNELS,
  NoPayloadSchema,
  ProfileConnectRequestSchema,
  ProfileIdRequestSchema,
  SaveProfileRequestSchema,
} from "@bpg/contracts";
import type {
  DatabaseAdapter,
  DatabaseSession,
  ProfileService,
  SessionRegistry,
  StoredProfile,
} from "@bpg/database-core";
import { type IpcRegistrar, toSessionInfo, translate } from "./connections";
import { createTrustedHandler, type SenderPolicy } from "./trusted-handler";

/** Explicit field list: `secretRef` never leaves main. */
export function toProfileDto(profile: StoredProfile): ConnectionProfile {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.user,
    sslMode: profile.sslMode,
    connectTimeoutMs: profile.connectTimeoutMs,
    hasSavedPassword: profile.secretRef !== null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

/** Parameter named `ipcMain` so handler-policy.test.ts scans these registrations. */
export function registerProfileHandlers(
  ipcMain: IpcRegistrar,
  deps: {
    policy: SenderPolicy;
    service: ProfileService;
    adapter: DatabaseAdapter;
    registry: SessionRegistry<DatabaseSession>;
  },
): void {
  const { policy, service, adapter, registry } = deps;

  ipcMain.handle(
    IPC_CHANNELS.profilesList,
    createTrustedHandler({
      policy,
      schema: NoPayloadSchema,
      handle: () => service.list().map(toProfileDto),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.profilesSave,
    createTrustedHandler({
      policy,
      schema: SaveProfileRequestSchema,
      handle: (request) =>
        translate(async () => {
          const { id, name, password, ...rest } = request;
          return toProfileDto(service.save(id, { name, ...rest }, password));
        }),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.profilesDelete,
    createTrustedHandler({
      policy,
      schema: ProfileIdRequestSchema,
      handle: ({ profileId }) =>
        translate(async () => {
          service.delete(profileId);
        }),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dbTestProfile,
    createTrustedHandler({
      policy,
      schema: ProfileConnectRequestSchema,
      handle: ({ profileId, password }) =>
        translate(() =>
          adapter.testConnection(service.resolveConfig(profileId, password)),
        ),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.dbOpenProfileSession,
    createTrustedHandler({
      policy,
      schema: ProfileConnectRequestSchema,
      handle: ({ profileId, password }) =>
        translate(async () => {
          const session = await adapter.openSession(
            service.resolveConfig(profileId, password),
          );
          registry.add(session);
          return toSessionInfo(session);
        }),
    }),
  );
}
