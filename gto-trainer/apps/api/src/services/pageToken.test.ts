import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { testTempDir } from "../test/tempDir";
import { PAGES, apiAssetFile, closureOf, pageTokenOf, refsOf, tokenOf } from "./pageToken";

/**
 * A page's token covers the page AND what it loads from the API (services/pageToken.ts): a script tag, a stylesheet,
 * a ${GTOW_API}/study/... string, and the modules those scripts import — so an edit to any of them reloads an open tab.
 */
describe("page token", () => {
  const root = testTempDir("page-token-");
  const api = join(root, "api"), stat = join(api, "static");
  mkdirSync(join(stat, "study"), { recursive: true });
  const resolveUrl = (p: string) => apiAssetFile(p, stat, api);
  const page = join(api, "page.html");
  writeFileSync(page, `<link rel="stylesheet" href="/dashboard.css"><script src="/study/a.js"></script>
    <script>const css = \`\${GTOW_API}/study/b.css\`;</script>`);
  writeFileSync(join(api, "dashboard.css"), "body{}");
  writeFileSync(join(stat, "study", "a.js"), `import { x } from "./c.js";\nexport const a = x;`);
  writeFileSync(join(stat, "study", "b.css"), ".b{}");
  writeFileSync(join(stat, "study", "c.js"), `export const x = 1;`);
  const token = () => tokenOf(closureOf(page, resolveUrl));

  test("the closure is the page, its tags and template strings, and the modules they import", () => {
    expect(closureOf(page, resolveUrl).map((f) => basename(f.file)).sort()).toEqual(["a.js", "b.css", "c.js", "dashboard.css", "page.html"]);
  });

  test("the token is stable, and moves when any file in the closure changes", () => {
    const t0 = token();
    expect(t0).toMatch(/^[0-9a-f]{16}$/);
    expect(token()).toBe(t0);
    writeFileSync(join(stat, "study", "c.js"), `export const x = 22;`);   // an import of an import: size
    const t1 = token();
    expect(t1).not.toBe(t0);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(stat, "study", "b.css"), later, later);              // same bytes, new mtime (a checkout)
    expect(token()).not.toBe(t1);
  });

  test("a new reference in the page is picked up when the page changes", () => {
    writeFileSync(join(stat, "study", "d.js"), "1");
    writeFileSync(page, `<script src="/study/a.js"></script><script src="/study/d.js"></script>`);
    expect(closureOf(page, resolveUrl).map((f) => basename(f.file))).toContain("d.js");
  });

  test("only API assets: other origins' scripts, other paths and ../ escapes are not followed", () => {
    const refs = refsOf(page, `<script src="https://cdn.example/x.js"></script><img src="/cards/a.png"><script src="/study/../../secret.js"></script>`, resolveUrl);
    expect(refs).toEqual([]);
  });

  test("an unknown page has no token; the real pages cover what they load", () => {
    expect(pageTokenOf("../../etc/passwd")).toBe("");
    const names = (id: string) => closureOf(PAGES[id]!).map((f) => basename(f.file));
    expect(names("dashboard.html")).toEqual(expect.arrayContaining(["dashboard.html", "dashboard.css", "grid169.js", "grid169.css", "page-reload.js"]));
    // replay-review imports ignition-table.js, which imports table-spec.js
    expect(names("study/replay-review.html")).toEqual(expect.arrayContaining(["ignition-table.js", "table-spec.js", "study.css", "page-reload.js"]));
    // the wrapper's pages load page-reload.js from the API by full URL
    expect(names("wrapper/admin.html")).toContain("page-reload.js");
    expect(names("wrapper/bridge.html")).toContain("page-reload.js");
    for (const id of Object.keys(PAGES)) expect(pageTokenOf(id)).toMatch(/^[0-9a-f]{16}$/);
  });
});
