import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Drives the BUILT desktop app (run `pnpm build` first). Needs a disposable
 * PostgreSQL on loopback: set BPG_E2E_PG_URL, e.g.
 *   postgres://bpg:bpg_test_only@127.0.0.1:55432/bpg_test
 * Skipped when unset; refuses non-loopback hosts.
 */
const raw = process.env.BPG_E2E_PG_URL;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parse(value: string) {
  const u = new URL(value);
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error(`Refusing non-loopback e2e host: ${u.hostname}`);
  }
  return {
    host: u.hostname,
    port: u.port || "5432",
    database: u.pathname.slice(1),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

describe.skipIf(!raw)("desktop app: connection flow (e2e)", () => {
  const pg = parse(raw ?? "postgres://x:y@localhost/z");
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    app = await _electron.launch({
      args: [join(process.cwd(), "apps/desktop")],
      env: { ...process.env, ELECTRON_RENDERER_URL: "" },
    });
    page = await app.firstWindow();
    await page.waitForSelector("form.connection-form");
  });

  afterAll(async () => {
    await app?.close();
  });

  async function fill(password: string) {
    await page.getByLabel("Host", { exact: true }).fill(pg.host);
    await page.getByLabel("Port", { exact: true }).fill(pg.port);
    await page.getByLabel("Database", { exact: true }).fill(pg.database);
    await page.getByLabel("User", { exact: true }).fill(pg.user);
    await page.getByLabel("Password", { exact: true }).fill(password);
  }

  it("rejects a wrong password with an error", async () => {
    await fill("definitely-wrong");
    await page.getByRole("button", { name: "Test", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toMatch(/\w+/);
  });

  it("tests, connects and disconnects against the database", async () => {
    await fill(pg.password);

    await page.getByRole("button", { name: "Test", exact: true }).click();
    await page.getByText("Connection OK").waitFor();

    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("Session open").waitFor();
    await page.getByText("Open sessions (1)").waitFor();
    // The password field is cleared after a successful connect.
    expect(
      await page.getByLabel("Password", { exact: true }).inputValue(),
    ).toBe("");

    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.getByText("Session closed").waitFor();
    await page.getByText("Open sessions (0)").waitFor();
  });
});
