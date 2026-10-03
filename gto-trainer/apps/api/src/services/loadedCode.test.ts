import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LoadedCode, bootCheck, gitHead, importGraph, uncommittedOf } from "./loadedCode";

const dirs: string[] = [];
const HOUR_AGO = new Date(Date.now() - 3_600_000);
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A fake checkout: files by relative path. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "loadedcode-"));
  dirs.push(root);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), body);
    // last written an hour ago, as real source is: an edit in the test then always carries a newer time
    utimesSync(join(root, f), HOUR_AGO, HOUR_AGO);
  }
  return root;
}

const APP = {
  "app/index.ts": `import { a } from "./src/a";\nimport type { T } from "./src/typesOnly";\nconst m = await import("./src/lazy");\nexport const x: T = a;\n`,
  "app/src/a.ts": `import { shared } from "../../packages/shared/s";\nimport { Hono } from "hono";\nimport fs from "node:fs";\nexport const a = shared;\n`,
  "app/src/lazy.ts": `export const lazy = 1;\n`,
  "app/src/typesOnly.ts": `export type T = number;\n`,
  "app/src/a.test.ts": `import { a } from "./a";\n`,
  "app/src/scripts/oneOff.ts": `import { a } from "../a";\n`,
  "app/data/out.js": `1;\n`,
  "packages/shared/s.ts": `export const shared = 1;\n`,
};

describe("importGraph", () => {
  test("is the files the entry loads: outside its folder too, dynamic imports too — not tests, scripts, types or packages", () => {
    const root = tree(APP);
    const g = importGraph(join(root, "app/index.ts"));
    expect(g.files.map((f) => f.slice(root.length + 1).replace(/\\/g, "/"))).toEqual([
      "app/index.ts", "app/src/a.ts", "app/src/lazy.ts", "packages/shared/s.ts",
    ]);
    expect(g.errors).toEqual([]);
  });

  test("an import that resolves to nothing is reported, not thrown", () => {
    const root = tree({ "index.ts": `import "./gone";\n` });
    const g = importGraph(join(root, "index.ts"));
    expect(g.files.length).toBe(1);
    expect(g.errors[0]).toContain(`cannot resolve "./gone"`);
  });
});

describe("LoadedCode", () => {
  test("a loaded file with other content is stale, even when nobody asked before the edit", () => {
    const root = tree(APP);
    const code = new LoadedCode({ entry: join(root, "app/index.ts"), root });
    // 2026-09-24: the first question came AFTER the edit, and a lazy stamp swallowed it
    writeFileSync(join(root, "packages/shared/s.ts"), `export const shared = 2;\n`);
    const st = code.status(true);
    expect(st.stale).toBe(true);
    expect(st.changed).toEqual(["packages/shared/s.ts"]);
    expect(st.changedCount).toBe(1);
    expect(st.sig).not.toBe("");
    expect(st.files).toBe(4);
  });

  test("what the server never loads is not a code change: a test, a script, a data file, a types-only module", () => {
    const root = tree(APP);
    const code = new LoadedCode({ entry: join(root, "app/index.ts"), root });
    writeFileSync(join(root, "app/src/a.test.ts"), `// edited\n`);
    writeFileSync(join(root, "app/src/scripts/oneOff.ts"), `// edited\n`);
    writeFileSync(join(root, "app/data/out.js"), `2;\n`);
    writeFileSync(join(root, "app/src/typesOnly.ts"), `export type T = string;\n`);
    expect(code.status(true).stale).toBe(false);
  });

  test("the same bytes written again are not a new version (a checkout that rewrites a file, a save without a change)", () => {
    const root = tree(APP);
    const code = new LoadedCode({ entry: join(root, "app/index.ts"), root });
    const f = join(root, "app/src/a.ts");
    writeFileSync(f, readFileSync(f));
    const later = new Date(Date.now() + 60_000);
    utimesSync(f, later, later);
    expect(code.status(true).stale).toBe(false);
  });

  test("line endings alone are not a change: git rewriting a file as CRLF is the same code", () => {
    const root = tree(APP);
    const code = new LoadedCode({ entry: join(root, "app/index.ts"), root });
    const f = join(root, "app/src/a.ts");
    writeFileSync(f, readFileSync(f, "utf8").replace(/\n/g, "\r\n"));
    expect(code.status(true).stale).toBe(false);
  });

  test("a deleted loaded file is stale; an edit put back is current again", () => {
    const root = tree(APP);
    const code = new LoadedCode({ entry: join(root, "app/index.ts"), root });
    const f = join(root, "app/src/lazy.ts");
    const was = readFileSync(f);
    rmSync(f);
    expect(code.status(true).changed).toEqual(["app/src/lazy.ts"]);
    writeFileSync(f, was);
    expect(code.status(true).stale).toBe(false);
  });

  test("extra files: what the process reads once and keeps is part of the stamp", () => {
    const root = tree({ ...APP, "app/js/snippet.js": "1;\n" });
    const code = new LoadedCode({ entry: join(root, "app/index.ts"), root, extra: [join(root, "app/js")] });
    writeFileSync(join(root, "app/js/snippet.js"), "2;\n");
    expect(code.status(true).changed).toEqual(["app/js/snippet.js"]);
  });

  test("an unforced status inside the throttle is the cached one", () => {
    const root = tree(APP);
    const code = new LoadedCode({ entry: join(root, "app/index.ts"), root });
    expect(code.status().stale).toBe(false);
    writeFileSync(join(root, "app/src/a.ts"), `export const a = 9;\n`);
    expect(code.status().stale).toBe(false);
    expect(code.status(true).stale).toBe(true);
  });
});

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

describe("git", () => {
  test("gitHead reads the commit of a checkout and of a worktree; uncommittedOf names the edited files only", async () => {
    const root = tree(APP);
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const head = git(root, "rev-parse", "HEAD");
    expect(gitHead(root)).toBe(head);

    const code = new LoadedCode({ entry: join(root, "app/index.ts") });
    expect(code.repo).toBe(root);
    expect(code.commit).toBe(head);

    const a = join(root, "app/src/a.ts"), lazy = join(root, "app/src/lazy.ts");
    writeFileSync(a, `export const a = 2;\n`);
    writeFileSync(lazy, `export const lazy = 2;\n`);
    git(root, "commit", "-q", "-m", "two", "--", "app/src/a.ts");
    const dirty = await uncommittedOf(root, code.changedFiles());
    expect([...dirty!]).toEqual([lazy]);
    const st = code.status(true);
    expect(st.commit).toBe(head);
    expect(st.head).toBe(git(root, "rev-parse", "HEAD"));
    expect(st.head).not.toBe(head);

    // a worktree's .git is a file; its branch lives in the shared folder
    const wt = `${root}-wt`;
    dirs.push(wt);
    git(root, "worktree", "add", "-q", "-b", "side", wt);
    expect(gitHead(wt)).toBe(st.head);
    git(root, "pack-refs", "--all");
    expect(gitHead(wt)).toBe(st.head);
    expect(gitHead(root)).toBe(st.head);
    git(root, "worktree", "remove", "--force", wt);
  });

  test("outside a checkout git cannot say what is uncommitted", async () => {
    expect(await uncommittedOf(null, ["x.ts"])).toBeNull();
  });
});

describe("bootCheck", () => {
  test("code that bundles passes; a syntax error, a missing file and a missing export each say why", async () => {
    const ok = tree({ "index.ts": `import { a } from "./a";\nconsole.log(a);\n`, "a.ts": `export const a = 1;\n` });
    expect(await bootCheck(join(ok, "index.ts"))).toBeNull();

    const syntax = tree({ "index.ts": `import { a } from "./a";\nconsole.log(a);\n`, "a.ts": `export const a = ;\n` });
    expect(await bootCheck(join(syntax, "index.ts"))).toContain("a.ts");

    const missing = tree({ "index.ts": `import { a } from "./gone";\nconsole.log(a);\n` });
    expect(await bootCheck(join(missing, "index.ts"))).toContain("gone");

    const noExport = tree({ "index.ts": `import { b } from "./a";\nconsole.log(b);\n`, "a.ts": `export const a = 1;\n` });
    expect(await bootCheck(join(noExport, "index.ts"))).toMatch(/\bb\b/);
  }, 60_000);
});
