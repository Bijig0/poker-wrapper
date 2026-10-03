import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { hrc6maxDb, trustAuditLine } from "./hrc6maxDb";
import { arrivalTrust, nodeTrust, resetNodeTrustForTests, setTrustMap } from "./nodeTrust";

// THE TRUST SCORE IS BAKED WITH THE CHART (2026-10-03, audit finding 6). Before it, a chart missing from
// limp_node_trust.json answered every node unguarded with no log line at all (70 of 1,092 live chart answers).

const dir = mkdtempSync(join(tmpdir(), "nodetrust-"));
const dbPath = join(dir, "bake.sqlite");
const EVEN = "ign200_6max_D100_o2_5";        // scored in the file AND (later) in the bake
const SHORT = "ign200_6max_D100_s20_BB_o2_5"; // in neither: the hole this fixes
const POOL = "ign200_6max_D100_olimp_pool3";  // pool-locked: judged by reach, regret only past 0.3
const env = { db: process.env.HRC6MAX_DB, factory: process.env.FACTORY_DATA_DIR, all: process.env.TRUST_GUARD_ALL };

const STAMP = { [EVEN]: [111, 1000], [SHORT]: [222, 2000], [POOL]: [333, 3000] } as Record<string, [number, number]>;

function bake(withTrust: boolean): void {
  rmSync(dbPath, { force: true });
  const db = new Database(dbPath, { create: true });
  db.exec(`CREATE TABLE nodes (source TEXT, line TEXT, pos TEXT, terminal INTEGER NOT NULL, actions TEXT NOT NULL,
             cells BLOB NOT NULL, pruned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source,line)) WITHOUT ROWID;
           CREATE TABLE trees (source TEXT PRIMARY KEY, nodes INTEGER NOT NULL, built_at INTEGER NOT NULL,
             src_mtime INTEGER NOT NULL, src_size INTEGER NOT NULL);`);
  const blob = deflateSync(Buffer.from("[]"));
  for (const [s, [m, z]] of Object.entries(STAMP)) {
    db.query("INSERT INTO nodes (source, line, pos, terminal, actions, cells) VALUES (?,?,?,?,?,?)").run(s, "", "UTG", 0, "[]", blob);
    db.query("INSERT INTO trees VALUES (?,?,?,?,?)").run(s, 1, 0, m, z);
  }
  if (withTrust) {
    // the tables exactly as analysis/pipeline/solve/build_6max_preflop_db.py creates them
    db.exec(`CREATE TABLE trust (source TEXT NOT NULL, line TEXT NOT NULL, reach REAL, regret REAL NOT NULL,
               PRIMARY KEY (source, line)) WITHOUT ROWID;
             CREATE TABLE trust_trees (source TEXT PRIMARY KEY, nodes INTEGER NOT NULL, starved INTEGER NOT NULL,
               scored_at INTEGER NOT NULL, src_mtime INTEGER NOT NULL, src_size INTEGER NOT NULL);`);
  }
  db.close();
}
function score(source: string, rows: [string, number | null, number][], stamp = STAMP[source]!): void {
  const db = new Database(dbPath);
  for (const [line, reach, regret] of rows) db.query("INSERT OR REPLACE INTO trust VALUES (?,?,?,?)").run(source, line, reach, regret);
  db.query("INSERT OR REPLACE INTO trust_trees VALUES (?,?,?,?,?,?)").run(source, rows.length, 0, 0, stamp[0], stamp[1]);
  db.close();
}

let warns: string[] = [];
let warnSpy: ReturnType<typeof spyOn>;
beforeAll(() => {
  // the old file: it scores EVEN only, and calls R2.5 starved and the root trained
  writeFileSync(join(dir, "limp_node_trust.json"), JSON.stringify({
    [EVEN]: { "": [1, 0.001], "R2.5": [0.15, 0.08], "F-F-F-F-R2.5": [0.00001, 0.002] },
  }));
  process.env.FACTORY_DATA_DIR = dir;
  process.env.HRC6MAX_DB = dbPath;
  process.env.TRUST_GUARD_ALL = "1";
  warnSpy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(" ")); });
});
afterAll(() => {
  warnSpy.mockRestore();
  hrc6maxDb.reload();   // Windows will not unlink a file SQLite still has open
  for (const [k, v] of [["HRC6MAX_DB", env.db], ["FACTORY_DATA_DIR", env.factory], ["TRUST_GUARD_ALL", env.all]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  resetNodeTrustForTests();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { warns = []; resetNodeTrustForTests(); hrc6maxDb.reload(); });

describe("nodeTrust: a bake with NO trust data (before the backfill)", () => {
  beforeEach(() => { hrc6maxDb.reload(); bake(false); hrc6maxDb.reload(); });

  it("judges from the file as before, and says ONCE per chart that the bake has no scores for it", () => {
    expect(nodeTrust(EVEN, "")).toMatchObject({ known: true, starved: false, from: "file" });
    expect(nodeTrust(EVEN, "R2.5")).toMatchObject({ known: true, starved: true, regret: 0.08, from: "file" });
    expect(nodeTrust(EVEN, "F-F-F-F-R2.5").starved).toBe(true);   // reach 1e-5
    expect(warns.filter((w) => w.includes(EVEN))).toHaveLength(1);
    expect(warns[0]).toContain("no trust scores in the bake");
  });

  it("a chart the file does not score answers unguarded — but LOUDLY now, one line per chart per process", () => {
    expect(nodeTrust(SHORT, "R2.5")).toMatchObject({ known: false, starved: false, from: null });
    expect(nodeTrust(SHORT, "R2.5-F")).toMatchObject({ known: false, starved: false });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("UNSCORED CHART ANSWERING UNGUARDED");
    expect(warns[0]).toContain(SHORT);
  });

  it("the audit says every tree is unscored, and the start line says the bake carries no scores", () => {
    const a = hrc6maxDb.trustAudit();
    expect(a).toMatchObject({ tables: false, trees: 3, scored: 0 });
    expect(a.unscored).toHaveLength(3);
    expect(trustAuditLine(a)).toContain("NO trust scores");
  });
});

describe("nodeTrust: a bake that carries trust scores", () => {
  beforeEach(() => {
    hrc6maxDb.reload();
    bake(true);
    score(EVEN, [["", 1, 0.001], ["R2.5", 0.15, 0.002], ["R2.5-F", 0.00005, 0.001], ["R2.5-R9", 0.02, 0.05], ["R2.5-C", null, 0.001]]);
    score(POOL, [["C", 0.04, 0.2], ["C-C", 0.03, 0.45], ["C-C-C", 0.00002, 0.01]]);
    hrc6maxDb.reload();
  });

  it("a scored node is judged by the BAKE, not the file (which still calls R2.5 starved), with no log line", () => {
    expect(nodeTrust(EVEN, "")).toMatchObject({ known: true, starved: false, reach: 1, regret: 0.001, from: "bake" });
    expect(nodeTrust(EVEN, "R2.5")).toMatchObject({ known: true, starved: false, regret: 0.002, from: "bake" });
    expect(nodeTrust(EVEN, "R2.5-C")).toMatchObject({ known: true, starved: false, reach: null });   // reach unknown, regret fine
    expect(warns).toHaveLength(0);
  });

  it("a starved node is refused: low reach, or regret past 0.03", () => {
    const lowReach = nodeTrust(EVEN, "R2.5-F");
    expect(lowReach).toMatchObject({ known: true, starved: true, from: "bake" });
    expect(lowReach.why).toContain("UNTRAINED CHART NODE");
    expect(lowReach.why).toContain("1 in 20,000 hands");
    expect(nodeTrust(EVEN, "R2.5-R9")).toMatchObject({ starved: true, regret: 0.05 });
  });

  it("the pool-tree rule is unchanged: reach, or regret past 0.3", () => {
    expect(nodeTrust(POOL, "C").starved).toBe(false);       // regret 0.2: the pool's leak, not convergence
    expect(nodeTrust(POOL, "C-C").starved).toBe(true);      // 0.45: catastrophic
    expect(nodeTrust(POOL, "C-C-C").starved).toBe(true);    // reach 2e-5
  });

  it("a SCORED chart with no row for the node is REFUSED, with the reason, and logged once", () => {
    const t = nodeTrust(EVEN, "R2.5-R9-C");
    expect(t).toMatchObject({ known: true, starved: true, from: "bake" });
    expect(t.why).toStartWith("NO TRUST SCORE:");
    expect(t.why).toContain("R2.5-R9-C");
    nodeTrust(EVEN, "R2.5-R9-C");
    expect(warns.filter((w) => w.includes("NO TRUST SCORE"))).toHaveLength(1);
  });

  it("a chart the backfill has not reached keeps the file fallback (and its loud line) — no mass refusal mid-backfill", () => {
    const t = nodeTrust(SHORT, "R2.5");
    expect(t).toMatchObject({ known: false, starved: false });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("UNSCORED CHART ANSWERING UNGUARDED");
  });

  it("scores written from ANOTHER body (the tree re-baked by an old bake script) do not count", () => {
    score(SHORT, [["R2.5", 1, 0.001]], [999, 2000]);
    hrc6maxDb.reload();
    expect(hrc6maxDb.trust(SHORT, "R2.5")).toBeUndefined();
    expect(nodeTrust(SHORT, "R2.5").from).toBeNull();
    score(SHORT, [["R2.5", 1, 0.001]]);   // the right stamp: now it counts
    hrc6maxDb.reload();
    expect(nodeTrust(SHORT, "R2.5")).toMatchObject({ known: true, starved: false, from: "bake" });
    expect(nodeTrust(SHORT, "R2.5-F").why).toStartWith("NO TRUST SCORE:");
  });

  it("the audit counts the unscored trees (0 after a full backfill) and names them in the start line", () => {
    const a = hrc6maxDb.trustAudit();
    expect(a).toEqual({ tables: true, trees: 3, scored: 2, unscored: [SHORT] });
    expect(trustAuditLine(a)).toContain("1 of 3 baked charts carry NO current trust scores");
    score(SHORT, [["", 1, 0.001]]);
    hrc6maxDb.reload();
    expect(hrc6maxDb.trustAudit().unscored).toHaveLength(0);
    expect(trustAuditLine()).toContain("all 3 baked charts carry their trust scores");
  });

  it("guardApplies is unchanged: without TRUST_GUARD_ALL only the limp trees are judged", () => {
    delete process.env.TRUST_GUARD_ALL;
    try {
      expect(nodeTrust(EVEN, "R2.5-R9")).toMatchObject({ known: false, starved: false });
      expect(nodeTrust(POOL, "C-C").starved).toBe(true);
    } finally {
      process.env.TRUST_GUARD_ALL = "1";
    }
  });
});

// THE LIMP TREES ARE NEVER ANSWERED UNSCORED (2026-10-02/03, the v2 limp re-solve): where the bake has no scores for an
// olimp chart, the file fallback refuses a chart it does not score and a line it does not hold — the raise charts keep
// "unguarded, loudly" above.
describe("nodeTrust: a limp tree the bake does not score", () => {
  const EQ = "ign200_6max_D100_olimp";
  beforeEach(() => {
    hrc6maxDb.reload(); bake(true); hrc6maxDb.reload();        // POOL baked but not scored; EQ not baked at all
    writeFileSync(join(dir, "limp_node_trust.json"), JSON.stringify({
      [EVEN]: { "": [1, 0.001] },
      [EQ]: { "": [1, 0.0002], "F-C-F": [0.0073, 0.0037], "F-F-C-C": [1e-4, 0.056] },
    }));
    resetNodeTrustForTests();
  });

  it("scored neither in the bake nor in the file: REFUSED, with the reason (not answered unguarded)", () => {
    const t = nodeTrust(POOL, "C-C-C-F-F");
    expect(t).toMatchObject({ known: false, starved: true });
    expect(t.why).toStartWith("UNSCORED CHART:");
    expect(t.why).toContain("neither in the bake nor in limp_node_trust.json");
    expect(nodeTrust("ign200_6max_D100_s50_HJ_olimp_pool3", "C").starved).toBe(true);
    expect(warns.some((w) => w.includes("ANSWERING UNGUARDED"))).toBe(false);
  });

  it("in the file: judged from it; a line it does not hold is REFUSED (unscored), not answered", () => {
    expect(nodeTrust(EQ, "F-C-F")).toMatchObject({ known: true, starved: false, from: "file" });
    expect(nodeTrust(EQ, "F-F-C-C")).toMatchObject({ known: true, starved: true });          // regret 0.056
    const t = nodeTrust(EQ, "F-C-F-F-F-F-R4");
    expect(t).toMatchObject({ starved: true, from: "file" });
    expect(t.why).toStartWith("UNSCORED CHART NODE:");
  });

  it("a raise chart the file does not score still answers unguarded (loudly), as on main", () => {
    expect(nodeTrust(SHORT, "R2.5")).toMatchObject({ known: false, starved: false });
    expect(warns.some((w) => w.includes("UNSCORED CHART ANSWERING UNGUARDED"))).toBe(true);
  });
});

describe("arrivalTrust — every decision node the flop ranges come from (limp trees only)", () => {
  afterAll(() => setTrustMap(null));

  it("the first starved/unscored node on the line refuses; a fully trusted line passes", () => {
    setTrustMap({ [POOL]: { "": [1, 0], "C": [0.036, 0.01], "C-C": [0.004, 0.01], "C-C-C": [3e-4, 0.01], "C-C-C-F": [2.9e-4, 0.01],
      "C-C-C-F-F": [5e-5, 0.02], "C-F": [0.035, 0.01], "C-F-F": [0.034, 0.01], "C-F-F-F": [0.033, 0.01], "C-F-F-F-F": [0.03, 0.01] } });
    const bad = arrivalTrust(POOL, ["", "C", "C-C", "C-C-C", "C-C-C-F", "C-C-C-F-F"]);
    expect(bad?.line).toBe("C-C-C-F-F");
    expect(bad?.why).toContain("UNTRAINED CHART NODE");
    expect(arrivalTrust(POOL, ["", "C", "C-F", "C-F-F", "C-F-F-F", "C-F-F-F-F"])).toBeNull();
    expect(arrivalTrust(POOL, ["", "C", "C-F-C"])?.line).toBe("C-F-C");                      // a node nothing scores
  });

  it("raise charts are never judged here, whatever TRUST_GUARD_ALL says", () => {
    setTrustMap({ [EVEN]: { "F-F-R2.5-R9": [5e-5, 0.08] } });
    expect(arrivalTrust(EVEN, ["", "F", "F-F", "F-F-R2.5", "F-F-R2.5-R9"])).toBeNull();
  });
});
