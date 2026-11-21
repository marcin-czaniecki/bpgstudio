import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AppInfoSchema, IPC_CHANNELS, NoPayloadSchema } from "@bpg/contracts";
import {
  type DatabaseSession,
  ProfileService,
  SessionRegistry,
} from "@bpg/database-core";
import { createPostgresAdapter } from "@bpg/database-postgres";
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { registerConnectionHandlers } from "./ipc/connections";
import { registerProfileHandlers } from "./ipc/profiles";
import {
  createRendererUrlMatcher,
  createTrustedHandler,
  type SenderPolicy,
} from "./ipc/trusted-handler";
import { SafeStorageSecretStore } from "./storage/safe-storage-secret-store";
import { SqliteProfileRepository } from "./storage/sqlite-profile-repository";

let mainWindow: BrowserWindow | null = null;
let profileRepository: SqliteProfileRepository | null = null;

const sessions = new SessionRegistry<DatabaseSession>({
  // Log only the stable code: never driver text or connection parameters.
  onLost: (session, reason) =>
    console.warn(`Database session ${session.id} lost: ${reason.code}`),
});

const rendererIndex = join(__dirname, "../renderer/index.html");

// A packaged app must never load (or trust) a URL from the environment.
const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

const senderPolicy: SenderPolicy = {
  expectedSender: () => mainWindow?.webContents ?? null,
  isAllowedUrl: createRendererUrlMatcher({
    devUrl,
    rendererFileUrl: pathToFileURL(rendererIndex).href,
  }),
};

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(rendererIndex);
  }
}

// Two instances would race on secrets.json (read-modify-write).
const gotLock = app.requestSingleInstanceLock();
if (gotLock) {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
} else {
  app.quit();
}

app.whenReady().then(() => {
  if (!gotLock) return;
  ipcMain.handle(
    IPC_CHANNELS.appGetInfo,
    createTrustedHandler({
      policy: senderPolicy,
      schema: NoPayloadSchema,
      handle: () =>
        AppInfoSchema.parse({
          name: "BPG Studio",
          version: app.getVersion(),
        }),
    }),
  );

  const adapter = createPostgresAdapter();
  registerConnectionHandlers(ipcMain, {
    policy: senderPolicy,
    adapter,
    registry: sessions,
  });

  const userData = app.getPath("userData");
  profileRepository = new SqliteProfileRepository(
    join(userData, "bpg-studio.db"),
  );
  registerProfileHandlers(ipcMain, {
    policy: senderPolicy,
    adapter,
    registry: sessions,
    service: new ProfileService({
      repository: profileRepository,
      secrets: new SafeStorageSecretStore(
        join(userData, "secrets.json"),
        safeStorage,
      ),
      newId: randomUUID,
      now: () => new Date().toISOString(),
    }),
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Release every database connection before exiting; bounded so quit can't hang.
let shuttingDown = false;
app.on("before-quit", (event) => {
  if (shuttingDown || sessions.list().length === 0) return;
  event.preventDefault();
  shuttingDown = true;
  void sessions.closeAll(3000).finally(() => app.quit());
});

app.on("will-quit", () => {
  profileRepository?.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
