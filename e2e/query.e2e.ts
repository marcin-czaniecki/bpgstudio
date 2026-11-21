import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Runs SQL from the real CodeMirror editor in the built app. Needs
 * BPG_E2E_PG_URL (loopback only), like the other e2e files.
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

describe.skipIf(!raw)("desktop app: SQL editor (e2e)", () => {
  const pg = parse(raw ?? "postgres://x:y@localhost/z");
  const userData = mkdtempSync(join(tmpdir(), "bpg-e2e-"));
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    app = await _electron.launch({
      // Isolated profile dir: never the developer's data, and no single-instance
      // lock clash with a running dev app.
      args: [
        join(process.cwd(), "apps/desktop"),
        `--user-data-dir=${userData}`,
      ],
      env: { ...process.env, ELECTRON_RENDERER_URL: "" },
    });
    page = await app.firstWindow();
    await page.waitForSelector("form.connection-form");
    await page.getByLabel("Host", { exact: true }).fill(pg.host);
    await page.getByLabel("Port", { exact: true }).fill(pg.port);
    await page.getByLabel("Database", { exact: true }).fill(pg.database);
    await page.getByLabel("User", { exact: true }).fill(pg.user);
    await page.getByLabel("Password", { exact: true }).fill(pg.password);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("Open sessions (1)").waitFor();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(userData, { recursive: true, force: true });
  });

  async function setSql(text: string) {
    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(text);
  }

  it("runs the editor text with Ctrl+Enter and shows a table with NULL", async () => {
    await setSql("select 1 as one, null as n");
    await page.keyboard.press("Control+Enter");
    await page.getByText(/SELECT · 1 row\(s\)/).waitFor();
    await page.getByRole("columnheader", { name: "one" }).waitFor();
    expect(await page.locator("td").first().textContent()).toBe("1");
    await page.locator("em.null-cell").waitFor();
  });

  it("shows the SQLSTATE and position of a syntax error", async () => {
    await setSql("selec 1");
    await page.getByRole("button", { name: /^Run/ }).click();
    const alert = page.getByRole("alert").filter({ hasText: "42601" });
    await alert.waitFor();
    expect(await alert.textContent()).toContain("Position 1");
  });

  it("truncates a big result at maxRows", async () => {
    await setSql("select g from generate_series(1, 5000) g");
    await page.getByRole("button", { name: /^Run/ }).click();
    await page.getByText(/truncated at 1000 rows/).waitFor();
    expect(await page.locator("tbody tr").count()).toBe(1000);
  });

  it("cancels a long query from the UI", async () => {
    await setSql("select pg_sleep(30)");
    await page.getByRole("button", { name: /^Run/ }).click();
    await page.getByText("Running…").waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "QUERY_CANCELLED" })
      .waitFor({ timeout: 10_000 });
    // The session is usable again.
    await setSql("select 2 as two");
    await page.getByRole("button", { name: /^Run/ }).click();
    await page.getByRole("columnheader", { name: "two" }).waitFor();
  });
});
