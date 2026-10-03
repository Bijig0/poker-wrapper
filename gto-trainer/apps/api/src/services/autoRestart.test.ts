import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AutoRestart, liveSessionReason, type AutoRestartOpts } from "./autoRestart";
import { LoadedCode } from "./loadedCode";

const dirs: string[] = [];
const HOUR_AGO = new Date(Date.now() - 3_600_000);
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "autorestart-"));
  dirs.push(root);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), body);
    // last written an hour ago, as real source is: an edit in the test then always carries a newer time
    utimesSync(join(root, f), HOUR_AGO, HOUR_AGO);
  }
  return root;
}

const T0 = 1_800_000_000_000;

/** A service whose loaded files a.ts and b.ts can be edited, with every outside question answered by the test. */
function rig(over: Partial<AutoRestartOpts> & { dirtyFiles?: string[] | null } = {}) {
  const root = tree({ "index.ts": `import { a } from "./a";\nimport { b } from "./b";\n`, "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
  const code = new LoadedCode({ entry: join(root, "index.ts"), root });
  const { dirtyFiles, ...opts } = over;
  const s = {
    now: T0 + 3_600_000, exits: 0, checks: 0, busy: null as string | null, checkErr: null as string | null,
    dirty: (dirtyFiles === undefined ? [] : dirtyFiles) as string[] | null, log: [] as string[],
  };
  const auto = new AutoRestart({
    code, name: "test",
    supervised: () => true,
    busy: async () => s.busy,
    exit: () => { s.exits++; },
    check: async () => { s.checks++; return s.checkErr; },
    dirty: async () => (s.dirty === null ? null : new Set(s.dirty.map((f) => join(root, f)))),
    log: (l) => s.log.push(l),
    now: () => s.now,
    env: {},
    ...opts,
  });
  /** edit a loaded file; its modification time is `agoMs` before the rig's clock */
  const edit = (f: string, agoMs = 60_000) => {
    writeFileSync(join(root, f), `export const ${f[0]} = ${Math.random()};\n`);
    const at = new Date(s.now - agoMs);
    utimesSync(join(root, f), at, at);
  };
  // the process "started" an hour before the rig's clock
  (code as any).bootAt = T0;
  return { root, code, auto, s, edit };
}

describe("AutoRestart", () => {
  test("nothing changed: current, and nothing is asked", async () => {
    const r = rig();
    expect((await r.auto.tick()).state).toBe("current");
    expect(r.s.exits).toBe(0);
    expect(r.s.checks).toBe(0);
  });

  test("a committed change, quiet, no session, code builds: the process exits for its supervisor", async () => {
    const r = rig();
    r.edit("a.ts");
    const st = await r.auto.tick();
    expect(st.state).toBe("restarting");
    expect(r.s.exits).toBe(1);
    expect(r.s.checks).toBe(1);
    // a second tick while the exit is pending does not exit twice
    await r.auto.tick();
    expect(r.s.exits).toBe(1);
  });

  test("an edit nobody committed never restarts anything: it is reported with the file's name", async () => {
    const r = rig({ dirtyFiles: ["a.ts"] });
    r.edit("a.ts");
    const st = await r.auto.tick();
    expect(st.state).toBe("uncommitted");
    expect(st.why).toContain("a.ts");
    expect(st.uncommitted).toEqual(["a.ts"]);
    expect(r.s.exits).toBe(0);
    expect(r.s.checks).toBe(0);
  });

  test("a commit lands beside somebody's uncommitted edit: the commit still deploys, and the edit is named", async () => {
    const r = rig({ dirtyFiles: ["b.ts"] });
    r.edit("a.ts");
    r.edit("b.ts");
    const st = await r.auto.tick();
    expect(st.state).toBe("restarting");
    expect(st.uncommitted).toEqual(["b.ts"]);
    expect(st.why).toContain("1 committed file(s) changed (a.ts)");
  });

  test("a change seconds old waits until it is quiet, then goes", async () => {
    const r = rig();
    r.edit("a.ts", 5_000);
    expect((await r.auto.tick()).state).toBe("settling");
    expect(r.s.exits).toBe(0);
    r.s.now += 30_000;
    expect((await r.auto.tick()).state).toBe("restarting");
  });

  test("a live session holds the restart; it goes when the session ends", async () => {
    const r = rig();
    r.edit("a.ts");
    r.s.busy = "a poker session is live (session_1)";
    const held = await r.auto.tick();
    expect(held.state).toBe("held");
    expect(held.why).toContain("a poker session is live");
    expect(r.s.exits).toBe(0);
    expect(r.s.checks).toBe(0);   // nothing is bundled next to a live session
    r.s.busy = null;
    expect((await r.auto.tick()).state).toBe("restarting");
    expect(r.s.exits).toBe(1);
  });

  test("code that does not build is never restarted into: the old process keeps serving and says why, once per change", async () => {
    const r = rig();
    r.edit("a.ts");
    r.s.checkErr = "a.ts:1 Unexpected ;";
    const st = await r.auto.tick();
    expect(st.state).toBe("boot-check-failed");
    expect(st.why).toContain("Unexpected ;");
    await r.auto.tick();
    await r.auto.tick();
    expect(r.s.checks).toBe(1);
    expect(r.s.exits).toBe(0);
    // the fix lands: a new change set is checked again
    r.s.checkErr = null;
    r.edit("a.ts", 50_000);
    expect((await r.auto.tick()).state).toBe("restarting");
    expect(r.s.checks).toBe(2);
  });

  test("no supervisor, or AUTO_RESTART=off: reported, never exited", async () => {
    const a = rig({ supervised: () => false });
    a.edit("a.ts");
    expect((await a.auto.tick()).state).toBe("unsupervised");
    expect(a.s.exits).toBe(0);
    const b = rig({ env: { AUTO_RESTART: "off" } });
    b.edit("a.ts");
    expect((await b.auto.tick()).state).toBe("off");
    expect(b.s.exits).toBe(0);
  });

  test("git cannot say what is committed: a commit that moved since boot counts, a still one does not", async () => {
    const still = rig({ dirtyFiles: null });
    (still.code as any).commit = still.code.status(true).head;
    still.edit("a.ts");
    expect((await still.auto.tick()).state).toBe("uncommitted");
    const moved = rig({ dirtyFiles: null });
    (moved.code as any).commit = "0".repeat(40);
    moved.edit("a.ts");
    expect((await moved.auto.tick()).state).toBe("restarting");
  });

  test("a process that only just started waits before it restarts again", async () => {
    const r = rig();
    (r.code as any).bootAt = r.s.now - 5_000;
    r.edit("a.ts");
    expect((await r.auto.tick()).state).toBe("settling");
    expect(r.s.exits).toBe(0);
  });

  test("the log says each state once, not every tick", async () => {
    const r = rig();
    r.edit("a.ts");
    r.s.busy = "a poker session is live (s)";
    await r.auto.tick(); await r.auto.tick(); await r.auto.tick();
    expect(r.s.log.filter((l) => l.includes("held")).length).toBe(1);
  });
});

describe("liveSessionReason", () => {
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const fail = (e: unknown) => (async () => { throw e; }) as unknown as typeof fetch;

  test("no wrapper running = no session", async () => {
    expect(await liveSessionReason({}, fail(Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })))).toBeNull();
  });
  test("a wrapper with no session declared = no session", async () => {
    expect(await liveSessionReason({}, reply({ ok: true, current: null }))).toBeNull();
  });
  test("a declared session holds, and names it", async () => {
    expect(await liveSessionReason({}, reply({ ok: true, current: { id: "session_20261003_111447" } }))).toContain("session_20261003_111447");
  });
  test("a wrapper that does not answer is an unknown, and unknown holds", async () => {
    expect(await liveSessionReason({}, fail(Object.assign(new Error("timed out"), { name: "TimeoutError" })))).toContain("not answering");
    expect(await liveSessionReason({}, reply({}, 500))).toContain("500");
  });
  test("the panel port follows PORT_OFFSET", async () => {
    let asked = "";
    const f = (async (u: string) => { asked = u; return new Response(JSON.stringify({ current: null })); }) as unknown as typeof fetch;
    await liveSessionReason({ PORT_OFFSET: "50" }, f);
    expect(asked).toContain(":7750/session");
  });
});
