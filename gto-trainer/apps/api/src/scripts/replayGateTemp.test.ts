/**
 * The replay gate's temp-copy cleanup (scripts/replayGateTemp, 2026-10-09): the run's copies go and its reports stay;
 * the day-old sweep takes the leftovers by name and age, never this run's own dirs, never a stranger's dir; a junction
 * (node_modules linked into a control worktree) is unlinked, its target untouched; the live data root is refused.
 * Everything on scratch dirs under the temp dir.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { claimGateDirs, DAY_MS, gateHolder, type GateHolder, gateRunDirs, gateRunId, isControlWorktreeName, isGateReport, isGateTempName, LOCK_FILE, pidAlive,
  refusalFor, releaseGateDirs, removeGateTemp, sizeOf, sweepGateTemp, workDirRefusal } from "./replayGateTemp";

let roots: string[] = [];
afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots = []; });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "rg-temp-test-")); roots.push(d); return d; };
const file = (p: string, bytes = 10) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "x".repeat(bytes)); };
/** a work dir as a run leaves it: the two copies, a copied config, the report */
const workDir = (root: string, name: string, ageMs = 0) => {
  const d = join(root, name);
  file(join(d, "poker.sqlite"), 5000);
  file(join(d, "gtow-cache.sqlite"), 3000);
  file(join(d, "wrapper", "profiles.json"), 50);
  file(join(d, "replay-gate-session_1.json"), 200);
  if (ageMs) { const t = new Date(Date.now() - ageMs); utimesSync(d, t, t); }
  return d;
};

describe("isGateTempName", () => {
  it("matches the gate's names and the hands' labels, nothing else", () => {
    for (const n of ["replay-gate", "replay-gate-control-0a2bae4", "rg-f1-candidate", "rg-f1-control-0a2bae4", "rgc-candidate", "rgf1-control-abc"]) expect(isGateTempName(n)).toBe(true);
    for (const n of ["rgc-x", "rgf1-x", "rg", "candidate", "control-abc", "replay", "poker-data", "rescore-checks-abc", "rg-temp-test-abc"]) expect(isGateTempName(n)).toBe(false);
    expect(isControlWorktreeName("C:/t/replay-gate-control-0a2bae4")).toBe(true);
    expect(isControlWorktreeName("C:/t/replay-gate-candidate")).toBe(false);
  });
});

describe("removeGateTemp", () => {
  it("removes the copies, keeps the reports, leaves the dir with the reports only", () => {
    const root = scratch();
    const d = workDir(root, "replay-gate");
    file(join(d, "replay-gate-session_1.vs-baseline.json"), 20);
    const r = removeGateTemp(d, { keep: (n) => /\.json$/.test(n) });
    expect(r.error).toBeUndefined();
    expect(r.kept.sort()).toEqual(["replay-gate-session_1.json", "replay-gate-session_1.vs-baseline.json"]);
    expect(r.bytes).toBe(5000 + 3000 + 50);
    expect(readdirSync(d).sort()).toEqual(["replay-gate-session_1.json", "replay-gate-session_1.vs-baseline.json"]);
  });
  it("the run keeps its reports only — not the copied configs (gtow-accounts.json holds the GTO Wizard accounts)", () => {
    const root = scratch();
    const d = workDir(root, "replay-gate-r1-candidate");
    file(join(d, "replay-gate-session_1.vs-baseline.json"), 20);
    file(join(d, "gtow-accounts.json"), 30);
    for (const n of ["replay-gate-session_1.json", "replay-gate-session_1.vs-baseline.json", "replay-gate-2026-10-03T00_00_2026-10-04T00_00.json"]) expect(isGateReport(n)).toBe(true);
    for (const n of ["gtow-accounts.json", "profiles.json", "replay-gate-x.json.copying", "poker.sqlite"]) expect(isGateReport(n)).toBe(false);
    expect(removeGateTemp(d, { keep: isGateReport }).kept.sort()).toEqual(["replay-gate-session_1.json", "replay-gate-session_1.vs-baseline.json"]);
    expect(existsSync(join(d, "gtow-accounts.json"))).toBe(false);
  });
  it("removes the whole dir when nothing is kept, and is quiet about a dir that is not there", () => {
    const root = scratch();
    const d = workDir(root, "rg-x-candidate");
    expect(removeGateTemp(d).bytes).toBe(5000 + 3000 + 50 + 200);
    expect(existsSync(d)).toBe(false);
    expect(removeGateTemp(join(root, "never-made"))).toEqual({ path: join(root, "never-made"), bytes: 0, kept: [] });
  });
  it("a sub-directory named like a report is not kept (only files are)", () => {
    const root = scratch();
    const d = workDir(root, "replay-gate");
    file(join(d, "notes.json", "inner.txt"), 7);
    const r = removeGateTemp(d, { keep: (n) => /\.json$/.test(n) });
    expect(r.kept).toEqual(["replay-gate-session_1.json"]);
    expect(existsSync(join(d, "notes.json"))).toBe(false);
  });
  it("unlinks a junction without following it — the target's files survive", () => {
    const root = scratch();
    const target = join(root, "node_modules_real");
    file(join(target, "pkg", "index.js"), 100);
    const d = join(root, "replay-gate-control-abc1234");
    file(join(d, "poker.sqlite"), 10);
    mkdirSync(join(d, "gto-trainer"), { recursive: true });
    symlinkSync(target, join(d, "gto-trainer", "node_modules"), "junction");
    expect(existsSync(join(d, "gto-trainer", "node_modules", "pkg", "index.js"))).toBe(true);
    expect(sizeOf(d)).toBe(10);                                   // the junction counts nothing
    const r = removeGateTemp(d);
    expect(r.error).toBeUndefined();
    expect(existsSync(d)).toBe(false);
    expect(existsSync(join(target, "pkg", "index.js"))).toBe(true);
  });
  it("refuses the live data root, a dir that contains it, and a filesystem root", () => {
    const root = scratch();
    const live = join(root, "poker-data");
    file(join(live, "poker.sqlite"), 10);
    expect(refusalFor(live, [live])).toMatch(/live data root/);
    expect(refusalFor(root, [live])).toMatch(/live data root/);
    expect(refusalFor(join(root, "replay-gate"), [live])).toBeNull();
    expect(refusalFor("C:/", [live])).toBe("a filesystem root");
    const r = removeGateTemp(root, { protect: [live] });
    expect(r.error).toMatch(/refusing/);
    expect(existsSync(join(live, "poker.sqlite"))).toBe(true);
  });
});

describe("sweepGateTemp", () => {
  it("takes the gate-named dirs older than a day, whole; leaves the young, the kept, the strangers, the files", () => {
    const root = scratch();
    const old1 = workDir(root, "replay-gate", 2 * DAY_MS);
    const old2 = workDir(root, "rg-f1-control-0a2bae4", 3 * DAY_MS);
    const old3 = workDir(root, "rg-f1-candidate", 30 * DAY_MS);
    const young = workDir(root, "rgc-candidate", DAY_MS / 2);
    const mine = workDir(root, "replay-gate-control-abc1234", 5 * DAY_MS);
    const stranger = workDir(root, "someone-else", 5 * DAY_MS);
    file(join(root, "replay-gate-notes.json"), 5);                  // a FILE with the name: not a dir, not swept
    const t = new Date(Date.now() - 5 * DAY_MS); utimesSync(join(root, "replay-gate-notes.json"), t, t);
    const s = sweepGateTemp(root, { keep: [mine] });
    expect(s.removed.map((r) => r.path).sort()).toEqual([old1, old3, old2].sort());
    expect(s.removed.reduce((n, r) => n + r.bytes, 0)).toBe(3 * (5000 + 3000 + 50 + 200));
    expect(s.kept.sort()).toEqual([mine, young].sort());
    expect(s.skipped).toEqual([]);
    for (const d of [old1, old2, old3]) expect(existsSync(d)).toBe(false);      // reports included
    for (const d of [young, mine, stranger, join(root, "replay-gate-notes.json")]) expect(existsSync(d)).toBe(true);
  });
  it("the age is the dir's own mtime: a run that wrote its report today is young", () => {
    const root = scratch();
    const d = workDir(root, "replay-gate", 0);
    expect(sweepGateTemp(root).removed).toEqual([]);
    expect(sweepGateTemp(root, { now: Date.now() + 2 * DAY_MS }).removed.map((r) => r.path)).toEqual([d]);
  });
  it("a root that does not exist sweeps nothing", () => {
    expect(sweepGateTemp(join(scratch(), "nope"))).toEqual({ removed: [], kept: [], skipped: [] });
  });
  it("the per-run names (2026-10-13) age out like the old ones; only the control worktree is pruned from git", () => {
    const root = scratch();
    const d = gateRunDirs({ tmp: root, runId: "20261012-090000-111", commit: "a9638ca" });
    const old = [d.controlWork!, d.candidateWork!, d.controlWorktree!].map((p) => workDir(root, p.split("/").pop()!, 2 * DAY_MS));
    const live = gateRunDirs({ tmp: root, runId: "20261013-135800-222", commit: "a9638ca" });
    const young = [live.controlWork!, live.candidateWork!, live.controlWorktree!].map((p) => workDir(root, p.split("/").pop()!));
    const s = sweepGateTemp(root);
    expect(s.removed.map((r) => r.path).sort()).toEqual(old.sort());
    expect(s.kept.sort()).toEqual(young.sort());
    expect(s.removed.filter((r) => isControlWorktreeName(r.path)).map((r) => r.path)).toEqual([join(root, d.controlWorktree!.split("/").pop()!)]);
  });
});

describe("a run's own dirs (2026-10-13: two gates at once shared them)", () => {
  it("the run id is the local start time and the pid", () => {
    expect(gateRunId(new Date(2026, 9, 13, 13, 58, 7), 4242)).toBe("20261013-135807-4242");
  });
  it("two runs against the same commit share no dir; the control's copies are never the worktree", () => {
    const tmp = "C:/Users/x/AppData/Local/Temp";
    const a = gateRunDirs({ tmp, runId: "20261013-135800-111", commit: "a9638ca" });
    const b = gateRunDirs({ tmp, runId: "20261013-135800-222", commit: "a9638ca" });
    const all = [a, b].flatMap((d) => [d.work, d.controlWorktree!, d.controlWork!, d.candidateWork!]);
    expect(new Set(all).size).toBe(all.length);
    expect(a).toEqual({ work: `${tmp}/replay-gate-20261013-135800-111`, controlWorktree: `${tmp}/replay-gate-control-a9638ca-20261013-135800-111`,
      controlWork: `${tmp}/replay-gate-20261013-135800-111-control-a9638ca`, candidateWork: `${tmp}/replay-gate-20261013-135800-111-candidate` });
    for (const p of all) expect(isGateTempName(p.split("/").pop()!)).toBe(true);           // the sweep still finds them
    expect(all.filter(isControlWorktreeName)).toEqual([a.controlWorktree!, b.controlWorktree!]);
  });
  it("every dir is absolute: a relative --work is the parent's, not each child's (they run in other directories)", () => {
    const d = gateRunDirs({ tmp: "rel-tmp", runId: "r1", work: "rel/replay-gate-x", commit: "abc" });
    const here = process.cwd().replace(/\\/g, "/");
    expect(d.work).toBe(`${here}/rel/replay-gate-x`);
    expect(d.candidateWork).toBe(`${here}/rel/replay-gate-x-candidate`);
    expect(d.controlWorktree).toBe(`${here}/rel-tmp/replay-gate-control-abc-r1`);
  });
  it("an explicit --work is the person's: the copies sit beside it, the worktree still carries the run id", () => {
    const d = gateRunDirs({ tmp: "C:\\T", runId: "r1", work: "C:\\T\\replay-gate-d468ad", commit: "a9638ca" });
    expect(d.work).toBe("C:/T/replay-gate-d468ad");
    expect(d.controlWork).toBe("C:/T/replay-gate-d468ad-control-a9638ca");
    expect(d.candidateWork).toBe("C:/T/replay-gate-d468ad-candidate");
    expect(d.controlWorktree).toBe("C:/T/replay-gate-control-a9638ca-r1");
    expect(gateRunDirs({ tmp: "C:/T", runId: "r1" })).toEqual({ work: "C:/T/replay-gate-r1", controlWorktree: null, controlWork: null, candidateWork: null });
  });
});

describe("workDirRefusal (the cleanup empties a work dir: only the gate's may be one)", () => {
  it("a new dir, an empty one, a gate-named one may be; a dir with other things in it, or a file, may not", () => {
    const root = scratch();
    expect(workDirRefusal(join(root, "never-made"))).toBeNull();
    mkdirSync(join(root, "empty"));
    expect(workDirRefusal(join(root, "empty"))).toBeNull();
    expect(workDirRefusal(workDir(root, "replay-gate-d468ad-candidate"))).toBeNull();
    expect(workDirRefusal(workDir(root, "rgc-candidate"))).toBeNull();
    const checkout = join(root, "apps", "api");
    file(join(checkout, "package.json"));
    file(join(checkout, "src", "index.ts"));
    expect(workDirRefusal(checkout)).toMatch(/exists and is not a replay-gate dir \(package\.json, src\) — the run's cleanup would delete/);
    file(join(root, "replay-gate-file"));
    expect(workDirRefusal(join(root, "replay-gate-file"))).toMatch(/is not a directory/);
  });
  it("a dir an earlier run left (its reports; a --reuse-copy's copies), or one a run holds, may be used again, whatever its name", () => {
    const root = scratch();
    const rerun = join(root, "mywork-candidate");                                          // the cleanup leaves the reports
    file(join(rerun, "replay-gate-S.json")); file(join(rerun, "replay-gate-S.vs-baseline.json"));
    expect(workDirRefusal(rerun)).toBeNull();
    const reuse = join(root, "mycopy");                                                     // --reuse-copy keeps the copies
    for (const f of ["poker.sqlite", "poker.sqlite-wal", "gtow-cache.sqlite", "gtow-accounts.json", "replay-gate-S.json", "wrapper/profiles.json", "api/fx.json"]) file(join(reuse, f));
    expect(workDirRefusal(reuse)).toBeNull();
    const held = join(root, "busy");
    file(join(held, LOCK_FILE)); file(join(held, "poker.sqlite.copying"));
    expect(workDirRefusal(held)).toBeNull();                                               // the claim then names its holder (75)
    const apps = join(root, "apps");                                                        // a report beside real things: not the gate's
    file(join(apps, "replay-gate-S.json")); file(join(apps, "api", "src", "index.ts")); file(join(apps, "wrapper", "package.json"));
    expect(workDirRefusal(apps)).toMatch(/not a replay-gate dir/);
    const live = join(root, "replay-gate-data");                                           // the live data root, gate name or not
    file(join(live, "poker.sqlite"));
    expect(workDirRefusal(live, [live])).toMatch(/live data root/);
    expect(workDirRefusal(root, [live])).toMatch(/live data root/);
  });
});

describe("claimGateDirs", () => {
  const holder = (pid: number, startedMs = Date.now()): GateHolder => ({ pid, started: "2026-10-13 13:58:00", startedMs, cwd: "C:/x", argv: ["replayGate.ts", "--session", "s1"] });
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);
  it("claims fresh dirs (made when missing) and releases them", () => {
    const root = scratch();
    const dirs = [join(root, "replay-gate-r1-control-abc"), join(root, "replay-gate-r1-candidate")];
    expect(claimGateDirs(dirs, holder(111), { alive: alive([111]) })).toBeNull();
    for (const d of dirs) expect(gateHolder(d, { alive: alive([111]) })?.pid).toBe(111);
    releaseGateDirs(dirs, 111);
    for (const d of dirs) { expect(existsSync(d)).toBe(true); expect(existsSync(join(d, LOCK_FILE))).toBe(false); }
  });
  it("refuses a dir another live run holds, naming it — and undoes what it claimed, touching nothing of the holder's", () => {
    const root = scratch();
    const held = workDir(root, "replay-gate-d468ad-candidate");
    expect(claimGateDirs([held], holder(222), { alive: alive([222]) })).toBeNull();
    const mine = join(root, "replay-gate-d468ad-control-abc");                              // claimed first, then undone
    const refusal = claimGateDirs([mine, held], holder(111), { alive: alive([111, 222]) });
    expect(refusal).toMatch(/in use by another replay gate — pid 222, started 2026-10-13 13:58:00, in C:\/x: replayGate\.ts --session s1/);
    expect(refusal).toContain(held);
    expect(existsSync(mine)).toBe(false);
    expect(gateHolder(held, { alive: alive([111, 222]) })?.pid).toBe(222);
    expect(existsSync(join(held, "poker.sqlite"))).toBe(true);
    releaseGateDirs([held], 111);                                                           // not 111's: left alone
    expect(gateHolder(held, { alive: alive([222]) })?.pid).toBe(222);
  });
  it("takes over a stale lock: a dead pid, or one older than a day (a pid reused by another program)", () => {
    const root = scratch();
    const d = join(root, "replay-gate-x");
    expect(claimGateDirs([d], holder(222), { alive: alive([222]) })).toBeNull();
    expect(claimGateDirs([d], holder(111), { alive: alive([111]) })).toBeNull();             // 222 is dead
    expect(gateHolder(d, { alive: alive([111]) })?.pid).toBe(111);
    const e = join(root, "replay-gate-y");
    expect(claimGateDirs([e], holder(222, Date.now() - DAY_MS - 1000), { alive: alive([222]) })).toBeNull();
    expect(claimGateDirs([e], holder(111), { alive: alive([111, 222]) })).toBeNull();
    expect(gateHolder(e, { alive: alive([111, 222]) })?.pid).toBe(111);
  });
  it("the run's cleanup removes the lock with the copies (the reports stay)", () => {
    const root = scratch();
    const d = workDir(root, "replay-gate-r1");
    expect(claimGateDirs([d], holder(process.pid))).toBeNull();
    expect(removeGateTemp(d, { keep: (n) => /\.json$/.test(n) }).kept).toEqual(["replay-gate-session_1.json"]);
    expect(readdirSync(d)).toEqual(["replay-gate-session_1.json"]);
  });
  it("a throw half way (the second dir cannot be made) undoes the first claim; a lock with no argv still names its holder", () => {
    const root = scratch();
    const first = join(root, "replay-gate-r1-control-abc");
    file(join(root, "blocker"));                                                           // a FILE where a dir's parent should be
    expect(() => claimGateDirs([first, join(root, "blocker", "replay-gate-r1-candidate")], holder(111), { alive: alive([111]) })).toThrow();
    expect(existsSync(first)).toBe(false);
    const d = join(root, "replay-gate-y");
    mkdirSync(d);
    writeFileSync(join(d, LOCK_FILE), JSON.stringify({ pid: 222, startedMs: Date.now() }));
    expect(claimGateDirs([d], holder(111), { alive: alive([111, 222]) })).toMatch(/in use by another replay gate — pid 222/);
  });
  it("a claimed dir is touched young, and the sweep leaves a dir a live run holds whatever its age", () => {
    const root = scratch();
    const d = workDir(root, "replay-gate-reused", 3 * DAY_MS);
    expect(claimGateDirs([d], holder(111), { alive: alive([111]) })).toBeNull();
    expect(sweepGateTemp(root, { alive: alive([]) }).removed).toEqual([]);                 // young again (its holder aside)
    const t = new Date(Date.now() - 3 * DAY_MS); utimesSync(d, t, t);                      // a --reuse-copy run adds no entry
    expect(sweepGateTemp(root, { alive: alive([111]) })).toMatchObject({ removed: [], kept: [d] });
    expect(sweepGateTemp(root, { alive: alive([]) }).removed.map((r) => r.path)).toEqual([d]);   // its run died: swept
  });
  it("a lock that cannot be read yet holds (it may be another run's, being read in a moment); a corrupt old one is stale", () => {
    const root = scratch();
    const d = join(root, "replay-gate-u");
    mkdirSync(d);
    writeFileSync(join(d, LOCK_FILE), "{ not json");                                       // young: held (2 s of looking again)
    expect(claimGateDirs([d], holder(111), { alive: alive([111]) })).toMatch(/pid 0, .*a lock that could not be read/s);
    const t = new Date(Date.now() - 60_000); utimesSync(join(d, LOCK_FILE), t, t);         // a minute old: corrupt, taken over
    expect(claimGateDirs([d], holder(111), { alive: alive([111]) })).toBeNull();
    expect(gateHolder(d, { alive: alive([111]) })?.pid).toBe(111);
  }, 30_000);
  it("runs racing onto a dead run's lock: exactly one takes it (the takeover token; 2-12 of 12 did before)", async () => {
    const root = scratch();
    const dir = join(root, "replay-gate-w"), done = join(root, "done");
    mkdirSync(dir);
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;                            // a pid that has just exited
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: dead, startedMs: Date.now(), started: "x", cwd: "x", argv: [] }));
    const racer = join(root, "racer.ts");
    writeFileSync(racer, [
      `import { existsSync } from "node:fs";`,
      `import { claimGateDirs } from ${JSON.stringify(join(import.meta.dir, "replayGateTemp").replace(/\\/g, "/"))};`,
      `const [dir, at, done] = [process.argv[2]!, Number(process.argv[3]), process.argv[4]!];`,
      `while (Date.now() < at) { /* the barrier */ }`,
      `const r = claimGateDirs([dir], { pid: process.pid, started: "s", startedMs: Date.now(), cwd: "c", argv: ["racer"] });`,
      `console.log(r === null ? "CLAIMED" : "REFUSED");`,
      `const t0 = Date.now(); while (!existsSync(done) && Date.now() - t0 < 30000) await Bun.sleep(20);   // alive until all have claimed`,
    ].join("\n"));
    const N = 8, at = Date.now() + 2500;
    const said: string[] = [];
    const runs = Array.from({ length: N }, () => new Promise<void>((res) => {
      const p = spawn(process.execPath, [racer, dir, String(at), done]);
      p.stdout.on("data", (b) => { said.push(String(b).trim()); if (said.length === N) writeFileSync(done, ""); });
      p.on("close", () => res());
    }));
    await Promise.all(runs);
    expect(said.sort()).toEqual(["CLAIMED", ...Array(N - 1).fill("REFUSED")]);
  }, 60_000);
  it("pidAlive: this process is, a pid past the range is not", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(4194300)).toBe(false);
  });
});
