import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AppInfoSchema, IPC_CHANNELS, NoPayloadSchema } from "@bpg/contracts";
import { type DatabaseSession, SessionRegistry } from "@bpg/database-core";
import { createPostgresAdapter } from "@bpg/database-postgres";
import { app, BrowserWindow, ipcMain } from "electron";
import { registerConnectionHandlers } from "./ipc/connections";
import {
  createRendererUrlMatcher,
  createTrustedHandler,
  type SenderPolicy,
} from "./ipc/trusted-handler";

let mainWindow: BrowserWindow | null = null;

const sessions = new SessionRegistry<DatabaseSession>({
  // Log only the stable code: never driver text or connection parameters.
  onLost: (session, reason) =>
    console.warn(`Database session ${session.id} lost: ${reason.code}`),
});

const rendererIndex = join(__dirname, "../renderer/index.html");

const senderPolicy: SenderPolicy = {
  expectedSender: () => mainWindow?.webContents ?? null,
  isAllowedUrl: createRendererUrlMatcher({
    devUrl: process.env.ELECTRON_RENDERER_URL,
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

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(rendererIndex);
  }
}

app.whenReady().then(() => {
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

  registerConnectionHandlers(ipcMain, {
    policy: senderPolicy,
    adapter: createPostgresAdapter(),
    registry: sessions,
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
