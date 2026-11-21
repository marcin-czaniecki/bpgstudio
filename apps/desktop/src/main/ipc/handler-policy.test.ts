import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mainDir = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/**
 * ADR-0003 makes "every privileged handler validates sender and input" a rule.
 * This test turns the convention into a check: ipcMain.handle may only be given
 * a createTrustedHandler(...) result, never a bare function.
 */
describe("IPC handler policy (ADR-0003)", () => {
  it("registers every ipcMain.handle through createTrustedHandler", () => {
    const offenders: string[] = [];
    let registrations = 0;

    for (const file of sourceFiles(mainDir)) {
      // Comments may legitimately mention the pattern; only code counts.
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const match of text.matchAll(
        /ipcMain\.(handle|handleOnce|on)\(\s*([^,]+),\s*([^\n]*)/g,
      )) {
        registrations += 1;
        if (!/createTrustedHandler\(/.test(match[3] ?? "")) {
          offenders.push(`${file}: ${match[0].trim()}`);
        }
      }
    }

    expect(registrations).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
