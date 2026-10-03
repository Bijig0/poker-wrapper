import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { hrc6maxDb, provenanceAuditLine, readChartManifest } from "./hrc6maxDb";
import { factoryManifestFile } from "./repoPaths";

// WHICH SOLVE IS EACH BAKED CHART (2026-10-03, the chart manifest). A chart id names the spot, not the solve: twice a
// rebuild put a round-1 export behind a round-2 chart and nothing could tell. The bake carries a `provenance` row per tree
// (raw + body sha256, written in the tree's transaction); the factory's chart_manifest.json names the export each chart
// must be. The API counts the charts that do not match - and never says 0 when it cannot know.

const dir = mkdtempSync(join(tmpdir(), "provenance-"));
const dbPath = join(dir, "bake.sqlite");
const manPath = join(dir, "chart_manifest.json");
const A = "ign200_6max_D100_o2_5";
const B = "ign200_6max_D150_o2_5";
const env = { db: process.env.HRC6MAX_DB, man: process.env.CHART_MANIFEST, factory: process.env.FACTORY_DATA_DIR };
const STAMP: Record<string, [number, number]> = { [A]: [111, 1000], [B]: [222, 2000] };

function bake(withProvenance: boolean): void {
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
  if (withProvenance) {
    // exactly as analysis/pipeline/solve/chart_manifest.py PROVENANCE_SQL creates it
    db.exec(`CREATE TABLE provenance (source TEXT PRIMARY KEY, raw_sha256 TEXT, body_sha256 TEXT NOT NULL, converter TEXT,
               plan TEXT, refine_min INTEGER, status TEXT NOT NULL, set_at TEXT, src_mtime INTEGER NOT NULL,
               src_size INTEGER NOT NULL, written_at INTEGER NOT NULL)`);
  }
  db.close();
}
function prov(source: string, raw: string, body: string, refine: number, stamp = STAMP[source]!): void {
  const db = new Database(dbPath);
  db.query("INSERT OR REPLACE INTO provenance VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(source, raw, body, "hrc_to_preflop@abc", "grid-6max-nl200-r2", refine, "verified", "2026-10-03", stamp[0], stamp[1], 0);
  db.close();
}
function manifest(charts: Record<string, { raw_sha256: string; body_sha256: string }>): void {
  writeFileSync(manPath, JSON.stringify({ schema: 1, charts }));
}

beforeEach(() => {
  process.env.HRC6MAX_DB = dbPath;
  process.env.CHART_MANIFEST = manPath;
  rmSync(manPath, { force: true });
  hrc6maxDb.reload();
});
afterAll(() => {
  hrc6maxDb.reload();
  for (const [k, v] of [["HRC6MAX_DB", env.db], ["CHART_MANIFEST", env.man], ["FACTORY_DATA_DIR", env.factory]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("chart provenance: the bake against the chart manifest", () => {
  it("an older bake with NO provenance table is inert and says so", () => {
    bake(false);
    manifest({ [A]: { raw_sha256: "r".repeat(64), body_sha256: "b".repeat(64) } });
    const a = hrc6maxDb.provenanceAudit();
    expect(a).toMatchObject({ table: false, trees: 2, withRow: 0, mismatches: null });
    expect(hrc6maxDb.provenance(A)).toBeUndefined();
    expect(provenanceAuditLine(a)).toContain("no provenance in this bake");
  });

  it("every baked chart matching the manifest: 0 mismatches, refine minutes + short raw per chart", () => {
    bake(true);
    prov(A, "a".repeat(64), "1".repeat(64), 240);
    prov(B, "b".repeat(64), "2".repeat(64), 240);
    manifest({ [A]: { raw_sha256: "a".repeat(64), body_sha256: "1".repeat(64) }, [B]: { raw_sha256: "b".repeat(64), body_sha256: "2".repeat(64) } });
    hrc6maxDb.reload();
    const a = hrc6maxDb.provenanceAudit();
    expect(a).toMatchObject({ table: true, trees: 2, withRow: 2, manifest: true, mismatches: 0 });
    expect(a.charts[A]).toEqual({ refineMin: 240, raw: "a".repeat(12), status: "verified" });
    expect(hrc6maxDb.provenance(A)).toMatchObject({ raw: "a".repeat(64), refineMin: 240, plan: "grid-6max-nl200-r2" });
    expect(provenanceAuditLine(a)).toContain("all 2 baked charts match the chart manifest");
  });

  it("a chart baked from another export (the original failure) is counted and named", () => {
    bake(true);
    prov(A, "a".repeat(64), "1".repeat(64), 60);                 // the round-1 export
    prov(B, "b".repeat(64), "2".repeat(64), 240);
    manifest({ [A]: { raw_sha256: "f".repeat(64), body_sha256: "9".repeat(64) }, [B]: { raw_sha256: "b".repeat(64), body_sha256: "2".repeat(64) } });
    hrc6maxDb.reload();
    const a = hrc6maxDb.provenanceAudit();
    expect(a.mismatches).toBe(1);
    expect(a.mismatchIds).toEqual([A]);
    expect(provenanceAuditLine(a)).toContain("1 of 2 baked charts do NOT match the chart manifest (D100_o2_5)");
  });

  it("a baked chart with no row, or one the manifest does not know, is a mismatch", () => {
    bake(true);
    prov(A, "a".repeat(64), "1".repeat(64), 240);
    manifest({ [A]: { raw_sha256: "a".repeat(64), body_sha256: "1".repeat(64) } });
    hrc6maxDb.reload();
    expect(hrc6maxDb.provenanceAudit()).toMatchObject({ withRow: 1, mismatches: 1, mismatchIds: [B] });
  });

  it("a provenance row written for ANOTHER bake of the tree (stale stamp) does not count", () => {
    bake(true);
    prov(A, "a".repeat(64), "1".repeat(64), 240, [999, 1000]);
    prov(B, "b".repeat(64), "2".repeat(64), 240);
    manifest({ [A]: { raw_sha256: "a".repeat(64), body_sha256: "1".repeat(64) }, [B]: { raw_sha256: "b".repeat(64), body_sha256: "2".repeat(64) } });
    hrc6maxDb.reload();
    expect(hrc6maxDb.provenance(A)).toBeUndefined();
    expect(hrc6maxDb.provenanceAudit()).toMatchObject({ withRow: 1, mismatches: 1, mismatchIds: [A] });
  });

  it("the manifest not readable: 'manifest not readable', mismatches UNKNOWN (null) - never 0", () => {
    bake(true);
    prov(A, "a".repeat(64), "1".repeat(64), 240);
    prov(B, "b".repeat(64), "2".repeat(64), 240);
    hrc6maxDb.reload();
    expect(readChartManifest()).toBeNull();
    const a = hrc6maxDb.provenanceAudit();
    expect(a).toMatchObject({ manifest: false, mismatches: null, mismatchIds: [] });
    const line = provenanceAuditLine(a);
    expect(line).toContain("manifest not readable");
    expect(line).not.toContain("0 of");
    writeFileSync(manPath, "{ not json");
    expect(readChartManifest()).toBeNull();
    writeFileSync(manPath, JSON.stringify({ schema: 2, charts: {} }));   // another schema is not read as this one
    expect(readChartManifest()).toBeNull();
  });

  it("no bake on this machine", () => {
    rmSync(dbPath, { force: true });
    hrc6maxDb.reload();
    expect(provenanceAuditLine()).toContain("no 6-max bake on this machine");
  });

  it("the manifest path resolves from the factory checkout like factoryFile (CHART_MANIFEST wins)", () => {
    delete process.env.CHART_MANIFEST;
    process.env.FACTORY_DATA_DIR = join("C:", "f", "gto-trainer", "apps", "api", "data");
    expect(factoryManifestFile().replace(/\\/g, "/")).toEndWith("f/analysis/pipeline/solve/chart_manifest.json");
    process.env.CHART_MANIFEST = manPath;
    expect(factoryManifestFile()).toBe(manPath);
  });
});
