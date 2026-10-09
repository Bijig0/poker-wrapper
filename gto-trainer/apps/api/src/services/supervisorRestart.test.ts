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
    envKeys: localEnvKeyHashes("A=1\nPORT_OFFSET=0\n"), needsReplace: null, refused: null, ...over,
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
    const w = new SupervisorWatch({ name: "api", jobsDir: jobs, now: () => clock.now, ...(own ? { ownPid: () => 4242 } : { alive: () => true }) });
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
  test("not ours (another pid), gone, or an old protocol", () => {
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
});
