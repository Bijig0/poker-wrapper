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
import { DAY_MS, isControlWorktreeName, isGateTempName, refusalFor, removeGateTemp, sizeOf, sweepGateTemp } from "./replayGateTemp";

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
});
