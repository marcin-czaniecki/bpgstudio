import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Persistence across restarts. Uses a throwaway --user-data-dir so it never
 * touches the developer's real profiles. Needs BPG_E2E_PG_URL (loopback only).
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

describe.skipIf(!raw)("desktop app: saved profiles (e2e)", () => {
  const pg = parse(raw ?? "postgres://x:y@localhost/z");
  const userData = mkdtempSync(join(tmpdir(), "bpg-e2e-"));
  const launched: ElectronApplication[] = [];

  async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await _electron.launch({
      args: [
        join(process.cwd(), "apps/desktop"),
        `--user-data-dir=${userData}`,
      ],
      env: { ...process.env, ELECTRON_RENDERER_URL: "" },
    });
    launched.push(app);
    const page = await app.firstWindow();
    await page.waitForSelector("form.connection-form");
    return { app, page };
  }

  afterAll(async () => {
    await Promise.all(
      launched.map((app) => app.close().catch(() => undefined)),
    );
    rmSync(userData, { recursive: true, force: true });
  });

  it("saves a profile with its password, and it survives a restart", async () => {
    const first = await launch();
    const { page } = first;
    await page.getByLabel("Name", { exact: true }).fill("E2E local");
    await page.getByLabel("Host", { exact: true }).fill(pg.host);
    await page.getByLabel("Port", { exact: true }).fill(pg.port);
    await page.getByLabel("Database", { exact: true }).fill(pg.database);
    await page.getByLabel("User", { exact: true }).fill(pg.user);
    await page.getByLabel("Password", { exact: true }).fill(pg.password);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved connections (1)").waitFor();
    await page.getByText("password saved").waitFor();
    await first.app.close();

    // The ciphertext file must not contain the plaintext. (The SQLite file is not
    // scanned: the test password may legitimately equal the user name stored there;
    // storage.test.ts asserts the table has no password column.)
    expect(
      readFileSync(join(userData, "secrets.json"), "utf8").includes(
        pg.password,
      ),
    ).toBe(false);

    const second = await launch();
    await second.page.getByText("Saved connections (1)").waitFor();
    await second.page.getByText("E2E local").waitFor();
    // The password field is empty: the saved secret is used by main, not retyped.
    expect(
      await second.page.getByLabel("Password", { exact: true }).inputValue(),
    ).toBe("");
    await second.page
      .getByRole("button", { name: "Connect saved", exact: true })
      .click();
    await second.page.getByText("Session open").waitFor();
    await second.page.getByText("Open sessions (1)").waitFor();
    await second.page
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await second.page.getByText("Open sessions (0)").waitFor();

    await second.page
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await second.page.getByText("Saved connections (0)").waitFor();
  });
});
