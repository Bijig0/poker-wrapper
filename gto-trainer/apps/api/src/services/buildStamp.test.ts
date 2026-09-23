import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BuildStamp } from "./buildStamp";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const HOUR_AGO = new Date(Date.now() - 3_600_000);

/** A fake API root whose every file was last written an hour ago. */
function fakeApi(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "buildstamp-"));
  dirs.push(root);
  for (const f of files) {
    const full = join(root, f);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "export {};\n");
    utimesSync(full, HOUR_AGO, HOUR_AGO);
  }
  return root;
}

const edit = (root: string, f: string) => { const now = new Date(); utimesSync(join(root, f), now, now); };

describe("buildStamp", () => {
  test("an edit after the stamp is taken is stale, even when nobody asked before the edit", () => {
    const root = fakeApi(["index.ts", "src/services/a.ts", "src/utils/b/b.ts"]);
    const bs = new BuildStamp(root);
    // 2026-09-24: the first question came AFTER the edit, and a lazy stamp swallowed it
    edit(root, "src/utils/b/b.ts");
    const st = bs.status(true);
    expect(st.stale).toBe(true);
    expect(st.changed).toEqual(["src/utils/b/b.ts"]);
    expect(st.changedCount).toBe(1);
    expect(st.bootStamp).toBe(Math.round(HOUR_AGO.getTime()));
    expect(st.diskStamp).toBeGreaterThan(st.bootStamp + 1000);
  });

  test("nothing edited is not stale, and the boot stamp never moves", () => {
    const root = fakeApi(["index.ts", "src/services/a.ts"]);
    const bs = new BuildStamp(root);
    const first = bs.status(true);
    expect(first.stale).toBe(false);
    expect(first.changed).toEqual([]);
    edit(root, "src/services/a.ts");
    expect(bs.status(true).bootStamp).toBe(first.bootStamp);
  });

  test("data/ is excluded: the API writing answers and the ledger is not a code change", () => {
    const root = fakeApi(["index.ts", "src/services/a.ts", "data/answers.js", "data/jobs/run.ts"]);
    const bs = new BuildStamp(root);
    edit(root, "data/answers.js");
    edit(root, "data/jobs/run.ts");
    const st = bs.status(true);
    expect(st.stale).toBe(false);
    expect(st.changed).toEqual([]);
  });

  test("a file directly under src/ is listed once, not once per WATCH entry", () => {
    const root = fakeApi(["index.ts", "src/top.ts"]);
    const bs = new BuildStamp(root);
    edit(root, "src/top.ts");
    const st = bs.status(true);
    expect(st.changed).toEqual(["src/top.ts"]);
    expect(st.scannedFiles).toBe(2);
  });
});
