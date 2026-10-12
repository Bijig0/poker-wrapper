import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * setup/shared-with-factory.json — the files the chart factory runs as copies of this repo's (2026-10-13).
 *
 * A copy is only safe to take whole if it needs nothing else from this repo: one import of a product-only module and
 * the factory's sync would bring a file that does not start there. So every listed file may import node: / bun:
 * modules and other listed files only, and says at its top that it is shared (an editor sees it before changing it).
 */
const REPO = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const manifest = JSON.parse(readFileSync(join(REPO, "setup", "shared-with-factory.json"), "utf8")) as { files: string[] };
const listed = new Set(manifest.files);

/** The module specifiers of a file's top-level import / export-from statements (not the fixture text inside tests). */
function importsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms)) out.push(m[1]!);
  for (const m of text.matchAll(/^import\s+"([^"]+)"/gm)) out.push(m[1]!);
  return out;
}

describe("setup/shared-with-factory.json", () => {
  test("lists files that exist", () => {
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const f of manifest.files) expect(existsSync(join(REPO, f)), f).toBe(true);
  });

  test("every shared file needs nothing outside the list", () => {
    const bad: string[] = [];
    for (const f of manifest.files) {
      for (const spec of importsOf(readFileSync(join(REPO, f), "utf8"))) {
        if (spec.startsWith("node:") || spec.startsWith("bun:")) continue;
        const target = relative(REPO, resolve(dirname(join(REPO, f)), spec)).replace(/\\/g, "/");
        if (!spec.startsWith(".") || !(listed.has(`${target}.ts`) || listed.has(target))) bad.push(`${f} imports "${spec}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("every shared file says so at its top", () => {
    const unmarked = manifest.files.filter((f) => !readFileSync(join(REPO, f), "utf8").split(/\r?\n/, 3).some((l) => l.includes("SHARED WITH THE CHART FACTORY")));
    expect(unmarked).toEqual([]);
  });
});
