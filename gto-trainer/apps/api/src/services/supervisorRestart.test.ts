// SHARED WITH THE CHART FACTORY (setup/shared-with-factory.json): edit it in poker-wrapper only — the factory takes it with `bun scripts/sync_from_wrapper.ts`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testTempDir } from "../test/tempDir";
import {
  SupervisorWatch, changedKeys, lastRequestPath, localEnvKeyHashes, readStamp, requestPath, stillRefused, supervisorNeed, type SupervisorStamp,
} from "./supervisorRestart";

const ROOT = testTempDir("supervisor-restart-");
let n = 0;
const sha = (file: string) => new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");

/** a supervisor's files, as it read them, and a stamp over them */
function rig(over: Partial<SupervisorStamp> = {}) {
  const dir = join(ROOT, `r${n++}`);
  mkdirSync(join(dir, "config"), { recursive: true });
  const f = { script: join(dir, "study-api.ps1"), env: join(dir, "config", "env.ps1"), local: join(dir, "config", "local.env") };
  writeFileSync(f.script, "# v1\n");
  writeFileSync(f.env, "# env\n");
  writeFileSync(f.local, "A=1\nPORT_OFFSET=0\n");
  const stamp: SupervisorStamp = {
    name: "api", pid: 4242, startedAt: "2026-10-10T10:00:00", envReadAt: null, protocol: 2, task: "t",
    files: { [f.script]: sha(f.script), [f.env]: sha(f.env), [f.local]: sha(f.local) }, reread: [f.env, f.local],
    envKeys: localEnvKeyHashes("A=1\nPORT_OFFSET=0\n"), needsReplace: null, refused: null, adopted: null, ...over,
  };
  return { dir, f, stamp };
}

describe("localEnvKeyHashes (the same rule as config/env.ps1 and supervisor_lib.ps1)", () => {
  test("comments, blanks, quotes; the first line for a key wins; values never appear", () => {
    const h = localEnvKeyHashes([
      "# a comment", "", "A=1  # trailing comment", "B=\"two\"", "EMPTY=", "a=ignored (A came first)", "not a line", "C = 3",
    ].join("\r\n"));
    expect(Object.keys(h)).toEqual(["A", "B", "C"]);
    expect(h.A).toBe(new Bun.CryptoHasher("sha256").update("1").digest("hex").slice(0, 16));
    expect(h.B).toBe(new Bun.CryptoHasher("sha256").update("two").digest("hex").slice(0, 16));
    expect(JSON.stringify(h)).not.toContain("two");
  });
  test("changedKeys: added, removed, changed — case-insensitive like Windows' environment", () => {
    expect(changedKeys({ A: "1", B: "2", C: "3" }, { a: "1", B: "x", D: "4" })).toEqual(["B", "C", "D"]);
  });
});

describe("supervisorNeed", () => {
  test("as read: nothing needed", () => {
    expect(supervisorNeed(rig().stamp)).toBeNull();
  });
  test("only re-read files changed, no port key: env-changed, with the keys", () => {
    const r = rig();
    writeFileSync(r.f.local, "A=2\nPORT_OFFSET=0\nNEW=1\n");
    const need = supervisorNeed(r.stamp)!;
    expect(need.kind).toBe("env-changed");
    expect(need.keys).toEqual(["A", "NEW"]);
    expect(need.why).toContain("(keys: A, NEW) changed");
  });
  test("the script, a port key, or needsReplace: supervisor-changed", () => {
    const a = rig();
    writeFileSync(a.f.script, "# v2\n");
    expect(supervisorNeed(a.stamp)!.kind).toBe("supervisor-changed");
    const b = rig();
    writeFileSync(b.f.local, "A=1\nPORT_OFFSET=10\n");
    expect(supervisorNeed(b.stamp)!.kind).toBe("supervisor-changed");
    const c = rig({ needsReplace: "the port moved (PORT 2000 -> 2010)" });
    const need = supervisorNeed(c.stamp)!;
    expect(need.kind).toBe("supervisor-changed");
    expect(need.why).toContain("port moved");
  });
  test("a file absent when read and still absent is not a change; created later, it is", () => {
    const r = rig();
    const later = join(r.dir, "config", "later.env");
    r.stamp.files[later] = "absent";
    expect(supervisorNeed(r.stamp)).toBeNull();
    writeFileSync(later, "x");
    expect(supervisorNeed(r.stamp)!.files).toEqual([later]);
  });
  test("stillRefused: only while the files are exactly what was refused", () => {
    const r = rig();
    writeFileSync(r.f.script, "function {\n");
    r.stamp.refused = { why: "does not parse", files: { [r.f.script]: sha(r.f.script) } };
    expect(stillRefused(r.stamp)).toBe(true);
    writeFileSync(r.f.script, "# fixed\n");
    expect(stillRefused(r.stamp)).toBe(false);
  });
});

describe("SupervisorWatch", () => {
  function watch(r: ReturnType<typeof rig>, own = true) {
    const jobs = join(r.dir, "jobs");
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, "supervisor-api.json"), "﻿" + JSON.stringify(r.stamp));
    const clock = { now: 1_800_000_000_000 };
    const w = new SupervisorWatch({ name: "api", jobsDir: jobs, now: () => clock.now, ...(own ? { ownPid: () => 4242, alive: (p: number) => p === 4242 } : { alive: () => true }) });
    return { w, jobs, clock };
  }
  test("the stamp reads back (BOM and all)", () => {
    const r = rig();
    const { jobs } = watch(r);
    expect(readStamp("api", jobs)?.reread).toEqual([r.f.env, r.f.local]);
  });
  test("settling -> ready -> request -> cooldown; the request file only for a supervisor-level change", () => {
    const r = rig();
    const { w, jobs, clock } = watch(r);
    expect(w.check().state).toBe("current");
    writeFileSync(r.f.script, "# v2\n");
    expect(w.check().state).toBe("settling");
    clock.now += 21_000;
    const c = w.check();
    expect(c.state).toBe("ready");
    expect(w.request(c, "test")).toBeNull();
    const req = JSON.parse(readFileSync(requestPath("api", jobs), "utf8"));
    expect([req.supervisorPid, req.kind, req.by]).toEqual([4242, "supervisor-changed", "test"]);
    expect(w.pending()?.why).toContain("study-api.ps1 changed");
    expect(w.check().state).toBe("cooldown");
    clock.now += 5 * 60_000;
    expect(w.check().state).toBe("ready");
    // a further edit is a new change: it settles again
    writeFileSync(r.f.script, "# v3\n");
    expect(w.check().state).toBe("settling");
    const env = rig();
    const e = watch(env);
    writeFileSync(env.f.local, "A=2\nPORT_OFFSET=0\n");
    e.w.check(); e.clock.now += 21_000;
    expect(e.w.request(e.w.check(), "test")).toBeNull();
    expect(() => readFileSync(requestPath("api", e.jobs))).toThrow();
    expect(JSON.parse(readFileSync(lastRequestPath("api", e.jobs), "utf8")).kind).toBe("env-changed");
  });
  test("not ours (a dead stamp pid while this process's own supervisor lives), gone, or an old protocol", () => {
    const a = rig({ pid: 999 });
    writeFileSync(a.f.script, "# v2\n");
    expect(watch(a).w.check().state).toBe("unknown");
    const b = rig({ protocol: 0 });
    writeFileSync(b.f.script, "# v2\n");
    expect(watch(b).w.check().state).toBe("old");
    const c = rig();
    const jobs = join(c.dir, "jobs");
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, "supervisor-api.json"), JSON.stringify(c.stamp));
    expect(new SupervisorWatch({ name: "api", jobsDir: jobs, alive: () => false }).check().state).toBe("unknown");
  });

  // 2026-10-10 02:40: the chart server started by the old supervisor (env pid dead), adopted by a new one (stamp pid)
  function adoptRig(o: { envPid: number; live: number[]; over?: Partial<SupervisorStamp>; boot?: (r: ReturnType<typeof rig>) => Partial<SupervisorStamp> }) {
    const r = rig({ pid: 26736, ...o.over });
    const jobs = join(r.dir, "jobs");
    mkdirSync(jobs, { recursive: true });
    const put = (s: SupervisorStamp) => writeFileSync(join(jobs, "supervisor-api.json"), JSON.stringify(s));
    // at this worker's boot the stamp was its starter's (or, without `boot`, already the adopter's)
    put(o.boot ? { ...r.stamp, ...o.boot(r) } : r.stamp);
    const clock = { now: 1_800_000_000_000 };
    const w = new SupervisorWatch({ name: "api", jobsDir: jobs, now: () => clock.now, ownPid: () => o.envPid, alive: (p) => o.live.includes(p), selfPid: 5150 });
    put(r.stamp);
    return { ...r, w, jobs, clock, put };
  }
  test("ADOPTED: the env pid is dead, the stamp's is alive — the stamp's supervisor is this process's", () => {
    const r = adoptRig({ envPid: 11111, live: [26736] });
    let c = r.w.check();
    expect([c.state, c.pid, c.adopted]).toEqual(["current", 26736, true]);
    writeFileSync(r.f.local, "A=2\nPORT_OFFSET=0\n");
    c = r.w.check();
    expect([c.state, c.need?.kind]).toEqual(["settling", "env-changed"]);
    r.clock.now += 21_000;
    c = r.w.check();
    expect(c.state).toBe("ready");
    expect(r.w.request(c, "test")).toBeNull();
    expect(JSON.parse(readFileSync(lastRequestPath("api", r.jobs), "utf8")).supervisorPid).toBe(26736);
    // a supervisor-level change: the request file names the adopter, the pid it checks against its own
    writeFileSync(r.f.script, "# v2\n");
    r.clock.now += 6 * 60_000;
    r.w.check(); r.clock.now += 21_000;
    expect(r.w.request(r.w.check(), "test")).toBeNull();
    expect(JSON.parse(readFileSync(requestPath("api", r.jobs), "utf8")).supervisorPid).toBe(26736);
  });
  test("GONE: the stamp's pid is dead and no live supervisor in the env — reported with what is behind, never ready", () => {
    const r = adoptRig({ envPid: 11111, live: [] });
    expect(r.w.check().state).toBe("gone");
    writeFileSync(r.f.local, "A=2\nPORT_OFFSET=0\n");
    r.w.check(); r.clock.now += 21_000;
    const c = r.w.check();
    expect([c.state, c.pid, c.need?.kind]).toEqual(["gone", 26736, "env-changed"]);
    // the env's supervisor is the stamp's (dead) too: gone
    expect(adoptRig({ envPid: 26736, live: [] }).w.check().state).toBe("gone");
  });
  test("adopted with the stamp current: what the worker's env came from (its starter's stamp at boot) still counts", () => {
    // the starter (pid 11111, now dead) had read local.env A=1; the adopter read A=2 and the disk says A=2
    const r = adoptRig({ envPid: 11111, live: [26736], boot: () => ({ pid: 11111 }) });
    writeFileSync(r.f.local, "A=2\nPORT_OFFSET=0\n");
    r.put({ ...r.stamp, files: { ...r.stamp.files, [r.f.local]: sha(r.f.local) }, envKeys: localEnvKeyHashes("A=2\nPORT_OFFSET=0\n") });
    let c = r.w.check();
    expect([c.state, c.need?.kind, c.need?.keys]).toEqual(["settling", "env-changed", ["A"]]);
    expect(c.need?.why).toContain("between the supervisor that started this worker (pid 11111) and the one that adopted it (pid 26736)");
    r.clock.now += 21_000;
    expect(r.w.check().state).toBe("ready");
    // not adopted (the same supervisor started it, no adopted mark): the boot stamp is not consulted
    const own = adoptRig({ envPid: 26736, live: [26736], boot: (x) => ({ files: { ...x.stamp.files, [x.f.local]: "0".repeat(64) } }) });
    expect(own.w.check().state).toBe("current");
    // its own worker, adopted after its cmd went (the stamp's adopted mark names this pid): the boot stamp counts
    const self = adoptRig({ envPid: 26736, live: [26736], boot: (x) => ({ files: { ...x.stamp.files, [x.f.local]: "0".repeat(64) } }) });
    self.put({ ...self.stamp, adopted: { pid: 5150, at: null } });
    const s = self.w.check();
    expect([s.state, s.adopted, s.need?.why]).toEqual(["settling", true, expect.stringContaining("since supervisor pid 26736 started this worker")]);
  });
});
