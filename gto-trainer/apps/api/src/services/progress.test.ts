import { describe, expect, test } from "bun:test";
import { parseBoxOutput, hrcSnapshot, type BoxSnap } from "./progress";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fresh = (boards: [string, string][]): BoxSnap => ({ name: "mesfleet-t-1", ip: "1.2.3.4", index: 1, reachable: false, total: boards.length, done: 0, boards: boards.map(([family, board]) => ({ family, board, state: "pending" })), current: null, load: "", mem: "", lastLines: [], allDone: false });

// what the ssh one-liner returns from a box mid-batch: file list · batch.log tail · loadavg · solver processes · mem
const MID = [
  "M2_heroBTN_srp_vs_BB_6h6d2s.driver.json", "M2_heroBTN_srp_vs_BB_6h6d2s.driver.log", "M2_heroBTN_srp_vs_BB_6h6d2s.eq.json", "M2_heroBTN_srp_vs_BB_6h6d2s.exploit.json", "M2_heroBTN_srp_vs_BB_6h6d2s.exploit.log", "M2_heroBTN_srp_vs_BB_6h6d2s.locked.json",
  "M2_heroBTN_srp_vs_BB_7c5c4h.driver.json", "M2_heroBTN_srp_vs_BB_7c5c4h.driver.log", "M2_heroBTN_srp_vs_BB_7c5c4h.eq.json", "M2_heroBTN_srp_vs_BB_7c5c4h.exploit.json", "M2_heroBTN_srp_vs_BB_7c5c4h.exploit.log",
  "batch.log",
  "@@",
  "M2_heroBTN_srp_vs_BB: 4 boards · menu=33/50/75 · villain=0",
  "[1/4] 6h6d2s  eq   612s + lock   388s",
  "@@",
  "9.87 12.10 11.02 17/412 31337",
  "@@",
  "   1234 ../../solve/compare/target/release/exploitsolve runs/M2_heroBTN_srp_vs_BB_7c5c4h.exploit.json",
  "@@",
  "21500/31900",
].join("\n");

describe("parseBoxOutput", () => {
  test("mid-batch: done / locking / pending, the live process names the board and the phase", () => {
    const s = parseBoxOutput(fresh([["M2_heroBTN_srp_vs_BB", "6h6d2s"], ["M2_heroBTN_srp_vs_BB", "7c5c4h"], ["M2_heroBTN_srp_vs_BB", "8h6s3h"], ["M1_heroSB_bvb_cbet", "6h6d2s"]]), MID);
    expect(s.reachable).toBe(true);
    expect(s.boards.map((b) => b.state)).toEqual(["done", "locking", "pending", "pending"]);
    expect(s.done).toBe(1);
    expect(s.current).toEqual({ family: "M2_heroBTN_srp_vs_BB", board: "7c5c4h", phase: "locking the pool's frequencies", elapsedS: 1234 });
    expect(s.load).toBe("9.87 12.10 11.02");
    expect(s.mem).toBe("21500/31900 MB");
    expect(s.allDone).toBe(false);
    expect(s.lastLines.at(-1)).toContain("[1/4] 6h6d2s");
  });
  test("no local shard spec: the board list is inferred from the box's files", () => {
    const s = parseBoxOutput(fresh([]), MID);
    expect(s.total).toBe(2);
    expect(s.boards.map((b) => `${b.board}:${b.state}`)).toEqual(["6h6d2s:done", "7c5c4h:locking"]);
  });
  test("ALL_DONE and a failed board", () => {
    const out = ["M1_heroSB_bvb_cbet_Ah9c3d.driver.log", "M1_heroSB_bvb_cbet_AsKd7c.locked.json", "batch.log", "@@", "[1/2] Ah9c3d  DRIVER FAILED — see M1_heroSB_bvb_cbet_Ah9c3d.driver.log", "[2/2] AsKd7c  eq 500s + lock 300s", "done 1, failed 1, of 2", "ALL_DONE", "@@", "0.10 0.20 0.30 1/200 999", "@@", "", "@@", "1000/31900"].join("\n");
    const s = parseBoxOutput(fresh([["M1_heroSB_bvb_cbet", "Ah9c3d"], ["M1_heroSB_bvb_cbet", "AsKd7c"]]), out);
    expect(s.allDone).toBe(true);
    expect(s.boards.map((b) => b.state)).toEqual(["failed", "done"]);
    expect(s.current).toBeNull();
  });
  test("a box that is up but not launched", () => {
    const s = parseBoxOutput(fresh([]), "NO_RUNS\n");
    expect(s.reachable).toBe(true); expect(s.noRuns).toBe(true);
  });
});

describe("hrcSnapshot", () => {
  test("done_if present wins over the state file; the running row is the current one", () => {
    const root = mkdtempSync(join(tmpdir(), "hrcq-"));
    mkdirSync(join(root, "solves", "x"), { recursive: true });
    writeFileSync(join(root, "solves", "x", "a.charts.json"), "{}");
    writeFileSync(join(root, "solves", "x", "queue.json"), JSON.stringify({ jobs: [{ id: "a", done_if: "solves/x/a.charts.json" }, { id: "b", done_if: "solves/x/b.charts.json" }, { id: "c", done_if: "solves/x/c.charts.json" }] }));
    writeFileSync(join(root, "solves", "x", "queue.state.json"), JSON.stringify({ a: { status: "failed", note: "rc=1" }, b: { status: "running", note: "", at: "2026-09-08 11:00:00" } }));
    writeFileSync(join(root, "solves", "x", "runner.log"), "line1\nline2\n");
    const h = hrcSnapshot(join(root, "solves", "x", "queue.json"), root);
    expect(h.exists).toBe(true);
    expect(h.rows.map((r) => r.status)).toEqual(["done", "running", "pending"]);
    expect(h.done).toBe(1); expect(h.total).toBe(3);
    expect(h.current?.id).toBe("b");
    expect(h.runnerLog).toEqual(["line1", "line2"]);
    const filtered = hrcSnapshot(join(root, "solves", "x", "queue.json"), root, (id) => id !== "a");
    expect(filtered.total).toBe(2);
  });
  test("no queue yet", () => { expect(hrcSnapshot("C:/nowhere/queue.json", "C:/nowhere").exists).toBe(false); });
});
