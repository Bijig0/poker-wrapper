import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AutoRestart, liveSessionReason, type AutoRestartOpts } from "./autoRestart";
import { LoadedCode } from "./loadedCode";
import { SupervisorWatch, lastRequestPath, localEnvKeyHashes, requestPath } from "./supervisorRestart";

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

describe("AutoRestart: a degraded runtime (services/runtimeHealth.ts)", () => {
  const SLEPT = { kind: "suspend", recycle: true, why: "the machine slept 14.2 h (woke 19:34)" };
  /** a rig whose runtime answers `deg`, recording what it was told before the exit */
  const degRig = (deg: { kind?: string; recycle: boolean; why: string } | null, over: Partial<AutoRestartOpts> & { dirtyFiles?: string[] | null } = {}) => {
    const recycled: { why: string }[] = [];
    const r = rig({ degraded: () => deg, recycled: (d) => { recycled.push(d); }, ...over });
    return { ...r, recycled };
  };

  test("current code, degraded runtime, no session: exits for its supervisor, after keeping the record", async () => {
    const r = degRig(SLEPT);
    const st = await r.auto.tick();
    expect(st.state).toBe("restarting");
    expect(st.reason).toBe("runtime-degraded");
    expect(st.why).toContain("the machine slept 14.2 h");
    expect(r.s.exits).toBe(1);
    expect(r.recycled).toEqual([SLEPT]);
    expect(r.s.checks).toBe(0);   // nothing on disk changed: no boot check
    expect(r.s.log.some((l) => l.includes("(runtime-degraded)"))).toBe(true);
  });

  test("a live session holds it; it goes when the session ends", async () => {
    const r = degRig(SLEPT);
    r.s.busy = "a poker session is live (session_1)";
    const held = await r.auto.tick();
    expect(held.state).toBe("held");
    expect(held.why).toContain("restart held: a poker session is live");
    expect(r.s.exits).toBe(0);
    expect(r.recycled).toEqual([]);
    r.s.busy = null;
    expect((await r.auto.tick()).state).toBe("restarting");
    expect(r.s.exits).toBe(1);
  });

  test("the loop guard's answer (recycle: false) is reported, never acted on", async () => {
    const r = degRig({ kind: "symptom", recycle: false, why: "a worker was already replaced for this 12 min ago" });
    const st = await r.auto.tick();
    expect(st.state).toBe("held");
    expect(st.reason).toBe("runtime-degraded");
    expect(r.s.exits).toBe(0);
  });

  test("DEGRADED_RESTART=off, AUTO_RESTART=off, no supervisor, just started: reported, never exited", async () => {
    const off = degRig(SLEPT, { env: { DEGRADED_RESTART: "off" } });
    expect(await off.auto.tick()).toMatchObject({ state: "off", reason: "runtime-degraded" });
    expect((await off.auto.tick()).why).toContain("DEGRADED_RESTART=off");
    const autoOff = degRig(SLEPT, { env: { AUTO_RESTART: "off" } });
    expect((await autoOff.auto.tick()).state).toBe("off");
    const unsup = degRig(SLEPT, { supervised: () => false });
    expect((await unsup.auto.tick()).state).toBe("unsupervised");
    const young = degRig(SLEPT);
    (young.code as any).bootAt = young.s.now - 5_000;
    expect((await young.auto.tick()).state).toBe("settling");
    expect(off.s.exits + autoOff.s.exits + unsup.s.exits + young.s.exits).toBe(0);
  });

  test("an uncommitted edit to a loaded file blocks it (the restart would load the edit) and the line says both", async () => {
    const r = degRig(SLEPT, { dirtyFiles: ["a.ts"] });
    r.edit("a.ts");
    const st = await r.auto.tick();
    expect(st.state).toBe("uncommitted");
    expect(st.why).toContain("the machine slept 14.2 h");
    expect(r.s.exits).toBe(0);
  });

  test("a committed change restarts for the change (one restart cures both); healthy = current", async () => {
    const r = degRig(SLEPT);
    r.edit("a.ts");
    expect(await r.auto.tick()).toMatchObject({ state: "restarting", reason: "code-changed" });
    expect(r.recycled).toEqual([]);
    const ok = degRig(null);
    expect((await ok.auto.tick()).state).toBe("current");
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

// ---------------------------------------------------------------------------------------------------------------------
// THE SUPERVISOR'S CONFIG (2026-10-10): the files in this process's supervisor stamp are watched on the same tick.

const SUP_PID = 4242;

/** A rig whose supervisor (pid 4242, protocol 2) read study-api.ps1, config/env.ps1 and config/local.env. */
function supRig(o: {
  stamp?: Record<string, unknown>; env?: NodeJS.ProcessEnv; dirtyFiles?: string[]; others?: boolean;
  /** POKER_SUPERVISOR in this worker's environment (default SUP_PID) and the pids that are alive (default [SUP_PID]) */
  envPid?: number; live?: number[];
} = {}) {
  const live = o.live ?? [SUP_PID];
  const sroot = tree({ "study-api.ps1": "# v1\n", "config/env.ps1": "# env v1\n", "config/local.env": "GTOW_POLL_MS=500\nPORT_OFFSET=0\n" });
  const jobs = join(sroot, "jobs");
  mkdirSync(jobs, { recursive: true });
  const f = { script: join(sroot, "study-api.ps1"), env: join(sroot, "config", "env.ps1"), local: join(sroot, "config", "local.env") };
  const sha = (file: string) => new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
  const writeStamp = (name: string, pid: number, over: Record<string, unknown> = {}) => writeFileSync(join(jobs, `supervisor-${name}.json`), JSON.stringify({
    name, pid, startedAt: "2026-10-10T10:00:00", envReadAt: "2026-10-10T10:00:00", protocol: 2, task: `PokerWrapper ${name} - test`,
    files: { [f.script]: sha(f.script), [f.env]: sha(f.env), [f.local]: sha(f.local) }, reread: [f.env, f.local],
    envKeys: localEnvKeyHashes(readFileSync(f.local, "utf8")), needsReplace: null, refused: null, ...over,
  }));
  writeStamp("api", SUP_PID, o.stamp);
  const codes: number[] = [];
  let r: ReturnType<typeof rig>;
  const supervisor = new SupervisorWatch({ name: "api", jobsDir: jobs, ownPid: () => o.envPid ?? SUP_PID, now: () => r.s.now, alive: (pid) => live.includes(pid) });
  const others = o.others ? [new SupervisorWatch({ name: "gtow", jobsDir: jobs, now: () => r.s.now, alive: (pid) => pid === 777 })] : [];
  r = rig({ supervisor, others, exit: (c: number) => { codes.push(c); }, env: o.env ?? {}, ...(o.dirtyFiles ? { dirtyFiles: o.dirtyFiles } : {}) });
  /** the change is seen, then quiet for the settle time */
  const settle = async () => { await r.auto.tick(); r.s.now += 21_000; return r.auto.tick(); };
  return { ...r, sroot, jobs, f, codes, writeStamp, settle, sha };
}

describe("AutoRestart: the supervisor's config", () => {
  test("nothing changed in the stamp: current, nothing asked", async () => {
    const r = supRig();
    expect((await r.auto.tick()).state).toBe("current");
    expect(r.codes).toEqual([]);
  });

  test("config/local.env changed: env-changed, a plain exit 0 (the supervisor re-reads it), the loop guard noted", async () => {
    const r = supRig();
    writeFileSync(r.f.local, "GTOW_POLL_MS=900\nPORT_OFFSET=0\n");
    const first = await r.auto.tick();
    expect(first.state).toBe("settling");
    expect(first.reason).toBe("env-changed");
    expect(r.codes).toEqual([]);
    r.s.now += 21_000;
    const st = await r.auto.tick();
    expect(st.state).toBe("restarting");
    expect(st.reason).toBe("env-changed");
    expect(st.why).toContain("keys: GTOW_POLL_MS");
    expect(r.codes).toEqual([0]);
    // no request file: an env change is the supervisor's ordinary re-read
    expect(existsSync(requestPath("api", r.jobs))).toBe(false);
    expect(existsSync(lastRequestPath("api", r.jobs))).toBe(true);
  });

  test("its script changed: supervisor-changed, the request file + exit 3", async () => {
    const r = supRig();
    writeFileSync(r.f.script, "# v2\n");
    const st = await r.settle();
    expect(st.state).toBe("restarting");
    expect(st.reason).toBe("supervisor-changed");
    expect(r.codes).toEqual([3]);
    const req = JSON.parse(readFileSync(requestPath("api", r.jobs), "utf8"));
    expect(req.supervisorPid).toBe(SUP_PID);
    expect(req.kind).toBe("supervisor-changed");
    expect(req.why).toContain("study-api.ps1 changed");
  });

  test("a port key in local.env, or a re-read the supervisor refused for the port: supervisor-changed", async () => {
    const a = supRig();
    writeFileSync(a.f.local, "GTOW_POLL_MS=500\nPORT_OFFSET=10\n");
    expect((await a.settle()).reason).toBe("supervisor-changed");
    expect(a.codes).toEqual([3]);

    const b = supRig({ stamp: { needsReplace: "the port moved (PORT 2000 -> 2010) - only a fresh supervisor may serve it" } });
    const st = await b.settle();
    expect(st.reason).toBe("supervisor-changed");
    expect(st.why).toContain("port moved");
    expect(b.codes).toEqual([3]);
  });

  test("a live session holds it; it goes when the session ends", async () => {
    const r = supRig();
    writeFileSync(r.f.local, "GTOW_POLL_MS=900\nPORT_OFFSET=0\n");
    r.s.busy = "a poker session is live (s1) — it restarts when the session ends";
    const held = await r.settle();
    expect(held.state).toBe("held");
    expect(held.reason).toBe("env-changed");
    expect(held.why).toContain("restart held: a poker session is live (s1)");
    expect(r.codes).toEqual([]);
    r.s.busy = null;
    expect((await r.auto.tick()).state).toBe("restarting");
    expect(r.codes).toEqual([0]);
  });

  test("a worker up less than 60 s waits, whatever minUptimeMs says", async () => {
    const r = supRig();
    (r.code as any).bootAt = r.s.now - 10_000;
    writeFileSync(r.f.script, "# v2\n");
    const st = await r.settle();
    expect(st.state).toBe("settling");
    expect(st.why).toContain("only just started");
    expect(r.codes).toEqual([]);
  });

  test("the loop guard: one config restart per supervisor every 5 min", async () => {
    const r = supRig();
    writeFileSync(lastRequestPath("api", r.jobs), JSON.stringify({ at: r.s.now - 60_000 }));
    writeFileSync(r.f.script, "# v2\n");
    const st = await r.settle();
    expect(st.state).toBe("held");
    expect(st.why).toContain("loop guard");
    expect(r.codes).toEqual([]);
    r.s.now += 5 * 60_000;
    expect((await r.auto.tick()).state).toBe("restarting");
    expect(r.codes).toEqual([3]);
  });

  test("AUTO_RESTART=off: reported, never exited", async () => {
    const r = supRig({ env: { AUTO_RESTART: "off" } });
    writeFileSync(r.f.script, "# v2\n");
    const st = await r.settle();
    expect(st.state).toBe("off");
    expect(st.why).toContain("restart the supervisor by hand");
    expect(r.codes).toEqual([]);
  });

  test("a supervisor from before protocol 2 is only reported: it would relaunch straight into the same change", async () => {
    const r = supRig({ stamp: { protocol: undefined } });
    writeFileSync(r.f.local, "GTOW_POLL_MS=900\nPORT_OFFSET=0\n");
    const st = await r.settle();
    expect(st.state).toBe("supervisor-old");
    expect(st.why).toContain("restart it by hand once");
    expect(r.codes).toEqual([]);
  });

  test("a stamp left by a dead supervisor while this process's own (env) supervisor lives is not ours to act on", async () => {
    const r = supRig({ stamp: { pid: 999 } });
    writeFileSync(r.f.script, "# v2\n");
    const st = await r.settle();
    expect(st.state).toBe("current");
    expect(st.watch).toEqual({ pid: SUP_PID, adopted: false, state: "unknown" });
    expect(r.codes).toEqual([]);
  });

  test("ADOPTED (live 2026-10-10 02:40): env pid = the old, dead supervisor, stamp pid = the live adopter, behind on local.env → env-changed, exit 0", async () => {
    // the chart server started at 02:38:20 by the old supervisor (killed by hand), adopted by the new one, pid 26736
    const r = supRig({ envPid: 11111, live: [26736], stamp: { pid: 26736 } });
    expect((await r.auto.tick()).watch).toEqual({ pid: 26736, adopted: true, state: "current" });
    writeFileSync(r.f.local, "GTOW_POLL_MS=900\nPORT_OFFSET=0\n");
    const first = await r.auto.tick();
    expect([first.state, first.reason]).toEqual(["settling", "env-changed"]);
    r.s.now += 21_000;
    const st = await r.auto.tick();
    expect(st.state).toBe("restarting");
    expect(st.reason).toBe("env-changed");
    expect(st.why).toContain("keys: GTOW_POLL_MS");
    expect(r.codes).toEqual([0]);
    // the loop guard names the adopter; no request file for an env change
    expect(JSON.parse(readFileSync(lastRequestPath("api", r.jobs), "utf8")).supervisorPid).toBe(26736);
    expect(existsSync(requestPath("api", r.jobs))).toBe(false);
  });

  test("ADOPTED, its script changed: the request file names the adopter's pid (the one it checks against its own)", async () => {
    const r = supRig({ envPid: 11111, live: [26736], stamp: { pid: 26736 } });
    writeFileSync(r.f.script, "# v2\n");
    expect((await r.settle()).state).toBe("restarting");
    expect(r.codes).toEqual([3]);
    expect(JSON.parse(readFileSync(requestPath("api", r.jobs), "utf8")).supervisorPid).toBe(26736);
  });

  test("a DEAD stamp pid with no live supervisor in the env: reported (supervisor-old), never exited — not for config, not for code", async () => {
    const r = supRig({ envPid: 26736, live: [], stamp: { pid: 26736 } });
    writeFileSync(r.f.local, "GTOW_POLL_MS=900\nPORT_OFFSET=0\n");
    const st = await r.settle();
    expect(st.state).toBe("supervisor-old");
    expect(st.reason).toBe("env-changed");
    expect(st.why).toContain("its supervisor (pid 26736) is not running");
    expect(st.why).toContain('"PokerWrapper api - test"');
    expect(st.watch).toEqual({ pid: 26736, adopted: false, state: "gone" });
    // a committed code change would exit into nothing as well: unsupervised, no exit
    r.edit("a.ts");
    const code = await r.auto.tick();
    expect(code.state).toBe("unsupervised");
    expect(code.why).toContain("is not running");
    expect(r.codes).toEqual([]);
    // the old env pid dead too after an adopter died: the same
    const b = supRig({ envPid: 11111, live: [], stamp: { pid: 26736 } });
    writeFileSync(b.f.script, "# v2\n");
    expect((await b.settle()).state).toBe("supervisor-old");
    expect(b.codes).toEqual([]);
  });

  test("a change the supervisor refused (a file would not parse) is not asked again until the files change", async () => {
    const r = supRig();
    writeFileSync(r.f.script, "function {\n");
    const now = { [r.f.script]: r.sha(r.f.script), [r.f.env]: r.sha(r.f.env), [r.f.local]: r.sha(r.f.local) };
    r.writeStamp("api", SUP_PID, { files: { ...now, [r.f.script]: "0".repeat(64) },
      refused: { why: "a fresh supervisor would not start: study-api.ps1 does not parse", files: now } });
    const st = await r.settle();
    expect(st.state).toBe("boot-check-failed");
    expect(st.why).toContain("does not parse");
    expect(r.codes).toEqual([]);
    writeFileSync(r.f.script, "# fixed\n");
    expect((await r.settle()).state).toBe("restarting");
    expect(r.codes).toEqual([3]);
  });

  test("an uncommitted code edit holds the supervisor's change too (a restart would load the edit)", async () => {
    const r = supRig({ dirtyFiles: ["a.ts"] });
    r.edit("a.ts");
    writeFileSync(r.f.local, "GTOW_POLL_MS=900\nPORT_OFFSET=0\n");
    const st = await r.settle();
    expect(st.state).toBe("uncommitted");
    expect(st.why).toContain("waits as well");
    expect(r.codes).toEqual([]);
  });

  test("a committed code change while the supervisor needs replacing: one exit 3 takes both", async () => {
    const r = supRig();
    writeFileSync(r.f.script, "# v2\n");
    await r.auto.tick();          // the supervisor change is seen
    r.s.now += 21_000;
    r.edit("a.ts");               // a commit lands, quiet for a minute
    const st = await r.auto.tick();
    expect(st.state).toBe("restarting");
    expect(st.reason).toBe("supervisor-changed");
    expect(r.codes).toEqual([3]);
    expect(existsSync(requestPath("api", r.jobs))).toBe(true);
  });

  test("the watchdog (no worker of its own): the API writes its request file and never exits for it", async () => {
    const r = supRig({ others: true });
    r.writeStamp("gtow", 777, { reread: [] });
    writeFileSync(r.f.local, "GTOW_POLL_MS=900\nPORT_OFFSET=0\n");
    r.s.busy = "a poker session is live (s1)";
    await r.auto.tick();
    r.s.now += 21_000;
    let st = await r.auto.tick();
    expect(st.others?.gtow?.state).toBe("held");
    expect(existsSync(requestPath("gtow", r.jobs))).toBe(false);
    r.s.busy = null;
    // the API's own env change goes too (exit 0); the watchdog gets its request file
    st = await r.auto.tick();
    expect(st.others?.gtow?.state).toBe("requested");
    const req = JSON.parse(readFileSync(requestPath("gtow", r.jobs), "utf8"));
    expect(req.supervisorPid).toBe(777);
    expect(req.kind).toBe("supervisor-changed");
    expect(r.codes).toEqual([0]);
  });
});
