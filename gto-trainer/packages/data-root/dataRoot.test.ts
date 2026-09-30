import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dataLayout, describeLayout, insideLayout, mainCheckoutOf, splitStores, storePath, type StoreEntry } from "./dataRoot";

/** A fake repo: <t>/main/.git (dir) and a worktree <t>/main/.claude/worktrees/wt whose .git FILE points back. */
function fakeRepo(): { main: string; wt: string; wtCode: string } {
  const t = mkdtempSync(join(tmpdir(), "dataroot-"));
  const main = join(t, "main");
  mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
  writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
  const wt = join(main, ".claude", "worktrees", "wt");
  mkdirSync(join(wt, "gto-trainer", "packages", "data-root"), { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
  return { main, wt, wtCode: join(wt, "gto-trainer", "packages", "data-root") };
}

describe("dataLayout", () => {
  test("a worktree's records go to the MAIN checkout's legacy folders (the hand-973 split can't happen)", () => {
    const { main, wt, wtCode } = fakeRepo();
    const L = dataLayout({}, wtCode);
    expect(L.mode).toBe("main-checkout");
    expect(L.inWorktree).toBe(true);
    expect(resolve(L.codeCheckout)).toBe(resolve(wt));
    expect(resolve(L.mainCheckout)).toBe(resolve(main));
    expect(resolve(L.api)).toBe(resolve(main, "gto-trainer", "apps", "api", "data"));
    expect(resolve(L.wrapper)).toBe(resolve(main, "ignition-study-wrapper", "data"));
    expect(resolve(L.wrapperDebug)).toBe(resolve(main, "ignition-study-wrapper", "debug"));
    expect(describeLayout(L)).toContain("worktree");
  });

  test("the main checkout resolves to itself", () => {
    const { main } = fakeRepo();
    mkdirSync(join(main, "gto-trainer", "apps", "api"), { recursive: true });
    const L = dataLayout({}, join(main, "gto-trainer", "apps", "api"));
    expect(L.inWorktree).toBe(false);
    expect(resolve(L.api)).toBe(resolve(main, "gto-trainer", "apps", "api", "data"));
    expect(resolve(mainCheckoutOf(main))).toBe(resolve(main));
  });

  test("POKER_DATA_DIR puts every record under one root, whichever checkout runs", () => {
    const { wtCode } = fakeRepo();
    const root = join(tmpdir(), "poker-data-x");
    const L = dataLayout({ POKER_DATA_DIR: root, NODE_ENV: "test" }, wtCode);
    expect(L.mode).toBe("env");
    expect(L.api).toBe(join(resolve(root), "api"));
    expect(L.wrapper).toBe(join(resolve(root), "wrapper"));
    expect(L.wrapperDebug).toBe(join(resolve(root), "wrapper-debug"));
  });

  test("under bun test a LIVE POKER_DATA_DIR is ignored: the test root wins (the fake 429 that walled Elite 1)", () => {
    const { wtCode } = fakeRepo();
    const live = join(import.meta.dir, "live-poker-data");   // outside the temp dir, like the real poker-data
    const env: NodeJS.ProcessEnv = { POKER_DATA_DIR: live, NODE_ENV: "test" };
    const L = dataLayout(env, wtCode);
    expect(L.mode).toBe("test");
    expect(L.root.startsWith(resolve(tmpdir()))).toBe(true);
    // outside a test the same env is honoured
    expect(dataLayout({ POKER_DATA_DIR: live }, wtCode).mode).toBe("env");
  });

  test("under bun test the root is one temp dir per run, handed to child processes through the env", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    const a = dataLayout(env);
    expect(a.mode).toBe("test");
    expect(env.POKER_TEST_DATA_DIR).toBe(a.root!);
    expect(dataLayout(env).root).toBe(a.root);           // a child that inherits the env agrees
    expect(a.api.startsWith(resolve(tmpdir()))).toBe(true);
    // and the real process running THIS test is in test mode too: nothing here can reach a live store
    expect(dataLayout().mode).toBe("test");
  });
});

describe("store overrides", () => {
  test("an override is reported by name and flagged when it lands outside the root", () => {
    const { main, wtCode } = fakeRepo();
    const L = dataLayout({}, wtCode);
    const inside = storePath("answers", join(L.api, "answers.sqlite"), "ANSWERS_DB_PATH", { ANSWERS_DB_PATH: join(L.api, "answers.sqlite") });
    const mem = storePath("hand-facts", join(L.api, "hand_facts.sqlite"), "HAND_FACTS_DB_PATH", { HAND_FACTS_DB_PATH: ":memory:" });
    const outside = storePath("solves", join(L.api, "solves.sqlite"), "SOLVES_DB_PATH", { SOLVES_DB_PATH: join(main, "..", "elsewhere", "solves.sqlite") });
    const none = storePath("gtow-requests", join(L.api, "gtow_requests.jsonl"), "GTOW_REQUESTS_PATH", {});
    expect(inside.override).toBe("ANSWERS_DB_PATH");
    expect(mem.path).toBe(":memory:");
    expect(none.override).toBeNull();
    const split = splitStores([inside, mem, outside, none] as StoreEntry[], L);
    expect(split.map((e) => e.store)).toEqual(["solves"]);
  });

  test("a temp file is outside: a live process writing one store to a temp dir is split all the same", () => {
    const { wtCode } = fakeRepo();
    const L = dataLayout({}, wtCode);
    expect(insideLayout(join(tmpdir(), "snap", "answers.sqlite"), L)).toBe(false);
    expect(insideLayout(join(L.wrapper, "hands.db"), L)).toBe(true);
    expect(insideLayout(":memory:", L)).toBe(true);
  });
});
