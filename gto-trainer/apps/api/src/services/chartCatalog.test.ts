import { describe, expect, test } from "bun:test";
import { parseHrcId, describeChart } from "./chartCatalog";

/**
 * parseHrcId is the ONE place a chart id's grammar is read, and the Charts picker
 * filters on nothing else. Until 2026-09-20 it knew five grammars and the corpus had
 * eight: 345 of 2,183 charts — the whole 6-max ring grid, every 2ci re-solve, every
 * locked-root chart — parsed to `family: "other"` with no dims, so they rendered as a
 * bare id with em-dashes in every column and no filter could reach them. One case per
 * grammar here; an id shape that is not covered is a chart that disappears from the UI.
 */
describe("parseHrcId", () => {
  test("6-max even: the open size is a chart dimension, the seat is not", () => {
    const e = parseHrcId("ign200_6max_D100_o2_5");
    expect(e.family).toBe("6max");
    expect(e.depth).toBe(100);
    expect(e.open).toBe(2.5);
    expect(e.shape).toBe("even");
    expect(e.shortSeat).toBeUndefined();
    expect(e.stacksBB).toEqual({ UTG: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 });
  });

  test("6-max limp tree keeps 'limp' as the open, not NaN", () => {
    expect(parseHrcId("ign200_6max_D125_olimp").open).toBe("limp");
  });

  test("6-max uneven names the short seat and its stack", () => {
    const e = parseHrcId("ign200_6max_D100_s70_BTN_o2_5");
    expect(e.shape).toBe("short");
    expect(e.shortSeat).toBe("BTN");
    expect(e.shortDepth).toBe(70);
    expect(e.stacksBB!.BTN).toBe(70);
    expect(e.stacksBB!.SB).toBe(100);
  });

  test("6-max patch carries every bespoke stack", () => {
    const e = parseHrcId("ign200_6max_P_BTN150_BB80_o2");
    expect(e.shape).toBe("patch");
    expect(e.stacksBB).toEqual({ UTG: 100, HJ: 100, CO: 100, BTN: 150, SB: 100, BB: 80 });
    expect(e.depth).toBe(150);
    expect(e.open).toBe(2);
  });

  test("3-max asym: every generation is a distinct variant, same shape", () => {
    expect(parseHrcId("ign200_3maxasym_D100_s70_btn").variant).toBe("base");
    expect(parseHrcId("ign200_3maxasym2_D100_s100_eq").variant).toBe("v2");
    expect(parseHrcId("ign200_3maxasym2b_D100_s100_eq").variant).toBe("v2b");
    expect(parseHrcId("ign25_3maxasym2ci_D100_s10_bb").variant).toBe("v2ci");
    expect(parseHrcId("ign200_3maxasym2ci_D100_s100_eq_hrc1").variant).toBe("accept");
    const e = parseHrcId("ign25_3maxasym2ci_D100_s10_bb");
    expect(e.family).toBe("3max-asym");
    expect(e.stake).toBe("NL25");
    expect(e.stacksBB).toEqual({ BTN: 100, SB: 100, BB: 10 });
  });

  test("locked-root charts carry the lock, which is the whole point of them", () => {
    const e = parseHrcId("ign25_3maxlock_D100_s100_eq_BTN2x");
    expect(e.family).toBe("3max-lock");
    expect(e.lock).toEqual({ seat: "BTN", action: "2x open" });
    expect(parseHrcId("ign25_3maxlock_D100_s100_eq_SBlimp").lock).toEqual({ seat: "SB", action: "limp" });
  });

  test("the grammars that already worked still do", () => {
    expect(parseHrcId("hrc_hu_ign200_d50_o2_5_3b12").family).toBe("hu-grid");
    expect(parseHrcId("husng_d20_o2_3bjam").threeBet).toBe("jam");
    expect(parseHrcId("ign200_3max_100_btn2_5_3b12").family).toBe("3max");
  });

  test("a genuinely unknown id is still 'other' rather than a wrong guess", () => {
    expect(parseHrcId("hrc_all_limp_standard").family).toBe("other");
  });
});

describe("describeChart", () => {
  test("reads as a sentence, not an id", () => {
    expect(describeChart({ id: "x", ...parseHrcId("ign200_6max_D100_o2_5") }))
      .toBe("6-max · 100bb even · 2.5x open · Ignition NL200");
    expect(describeChart({ id: "x", ...parseHrcId("ign200_6max_D100_s70_BTN_o2_5") }))
      .toBe("6-max · 100bb, BTN short 70bb · 2.5x open · Ignition NL200");
  });

  test("a lock chart says the lock once, not the open size twice", () => {
    const s = describeChart({ id: "x", ...parseHrcId("ign25_3maxlock_D100_s100_eq_BTN2x") });
    expect(s).toContain("BTN locked to 2x open");
    expect(s.match(/2x open/g)).toHaveLength(1);
  });

  test("an unparsed id falls back to its sidecar label rather than going blank", () => {
    expect(describeChart({ id: "hrc_all_limp_standard", label: "Open-limp from any position", family: "other" }))
      .toBe("Open-limp from any position");
  });
});

/**
 * The sidecars are read once (2026-10-12): a rebuild re-read all ~2,700 of them and froze the API 10-52 s on a machine
 * that was paging. SOLUTIONS_DIR is bound at import, so this runs in its own process against a temp folder.
 */
describe("sidecar reads", () => {
  test("parsed once; new names at once; rewrites at the sweep; unreadable retried; deleted dropped; bodies from the listing", () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const root = mkdtempSync(join(tmpdir(), "catalog-"));
    try {
      const dir = join(root, "charts");
      mkdirSync(dir);
      const script = join(root, "run.ts");
      writeFileSync(script, `
        import { writeFileSync, unlinkSync } from "node:fs";
        import { join } from "node:path";
        const dir = process.env.CHART_SOLUTIONS_DIR!;
        const side = (id: string, label: string) => writeFileSync(join(dir, id + ".meta.json"), JSON.stringify({ id, label }));
        const { getCatalog, sweepSidecars, __expireCatalog } = await import(${JSON.stringify(join(import.meta.dir, "chartCatalog.ts"))});
        const hrc = (force = false) => { if (!force) __expireCatalog(); return getCatalog(force).entries
          .filter((e: any) => e.source === "hrc").map((e: any) => e.id + ":" + e.label + ":" + e.cachedLocally).sort(); };
        const out: Record<string, string[]> = {};
        // a sweep over a folder with no sidecars returns before its first await - it must not latch (2026-10-13 review)
        await sweepSidecars();
        side("ign200_6max_D100_o2_5", "one"); writeFileSync(join(dir, "ign200_6max_D100_o2_5.json.gz"), "x");
        side("ign200_6max_D100_o2", "two");
        writeFileSync(join(dir, "ign200_6max_D125_o2_5.meta.json"), "{ half-writ");
        out.first = hrc();
        side("ign200_6max_D100_o2", "two-rewritten");          // in place: a plain rebuild does not read it again
        side("ign200_6max_D125_o2_5", "fixed");                // was unreadable: read again at the next rebuild
        side("ign200_6max_D125_o2", "three");                  // new name: read at the next rebuild
        out.plain = hrc();
        await sweepSidecars();                                 // the second sweep runs (no latch) and sees the rewrite
        out.swept = hrc();
        unlinkSync(join(dir, "ign200_6max_D125_o2.meta.json"));
        out.deleted = hrc();
        console.log(JSON.stringify(out));
      `);
      const r = Bun.spawnSync([process.execPath, script], { env: { ...process.env, CHART_SOLUTIONS_DIR: dir } });
      expect({ code: r.exitCode, stderr: r.stderr.toString().trim() }).toEqual({ code: 0, stderr: "" });
      const out = JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
      expect(out.first).toEqual(["ign200_6max_D100_o2:two:false", "ign200_6max_D100_o2_5:one:true"]);
      expect(out.plain).toEqual(["ign200_6max_D100_o2:two:false", "ign200_6max_D100_o2_5:one:true",
        "ign200_6max_D125_o2:three:false", "ign200_6max_D125_o2_5:fixed:false"]);
      expect(out.swept).toEqual(["ign200_6max_D100_o2:two-rewritten:false", "ign200_6max_D100_o2_5:one:true",
        "ign200_6max_D125_o2:three:false", "ign200_6max_D125_o2_5:fixed:false"]);
      expect(out.deleted).toEqual(["ign200_6max_D100_o2:two-rewritten:false", "ign200_6max_D100_o2_5:one:true",
        "ign200_6max_D125_o2_5:fixed:false"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
