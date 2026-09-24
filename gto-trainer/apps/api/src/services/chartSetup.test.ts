import { describe, expect, it } from "bun:test";
import { cleanSidecarText, sidecarFacts } from "./chartCatalog";
import { chartSetup } from "./chartSetup";

// What a chart was solved WITH (2026-09-24): the sidecar's own words, the id grammar, the library and AI labels.
describe("sidecarFacts", () => {
  it("a 6-max sidecar: the seat line, the rake with its cap, the size menu", () => {
    const f = sidecarFacts({
      format: "6-max · UTG/HJ/CO/BTN/SB/BB 100/60/100/95/100/100bb · Ignition NL200 6-max (5%, cap 2.0bb NFND) · 2x open · 3-bets 6bb, 7bb, 8.5bb, 10bb · 4-bets 19bb, 23bb, all-in · HRC",
      rake: { pct_of_pot: 5.0, cap_bb: 2.0, nfnd: true },
    });
    expect(f.seatStacks).toEqual([
      { pos: "UTG", stackBb: 100 }, { pos: "HJ", stackBb: 60 }, { pos: "CO", stackBb: 100 },
      { pos: "BTN", stackBb: 95 }, { pos: "SB", stackBb: 100 }, { pos: "BB", stackBb: 100 },
    ]);
    expect(f.rake).toEqual({ pct: 5, capBb: 2, nfnd: true });
    expect(f.sizes).toEqual(["2x open", "3-bets 6bb, 7bb, 8.5bb, 10bb", "4-bets 19bb, 23bb, all-in"]);
    expect(f.anteBb).toBeNull();
  });

  it("reads the rake from the format line when the sidecar has no rake object ('$2 cap = 1.0bb')", () => {
    const f = sidecarFacts({ format: "3-max asym · BTN/SB/BB 100/100/20bb · Ignition NL200 3-max (5%, $2 cap = 1.0bb) · rich sizes · limps on · HRC" });
    expect(f.rake).toEqual({ pct: 5, capBb: 1, nfnd: null });
    expect(f.seatStacks?.map((s) => s.stackBb)).toEqual([100, 100, 20]);
    expect(f.sizes).toEqual(["rich sizes", "limps on"]);
  });

  it("a heads-up sidecar with an ante and the small blind", () => {
    const f = sidecarFacts({
      format: "HU cash · cp200a · 125bb · sb 0.5bb · ante 0.2bb/player · HU cash cp200a (5%, cap 0.9bb, NFND) · limps on · HRC",
      ante_bb: 0.2, rake: { pct_of_pot: 5, cap_bb: 0.9, nfnd: true },
    });
    expect(f.anteBb).toBe(0.2);
    expect(f.sbBb).toBe(0.5);
    expect(f.rake).toEqual({ pct: 5, capBb: 0.9, nfnd: true });
    expect(f.sizes).toEqual(["limps on"]);
  });

  it("repairs the three encodings of the separator the sidecars carry", () => {
    expect(cleanSidecarText("3-max 100bb even Â· rich tree")).toBe("3-max 100bb even · rich tree");
    expect(cleanSidecarText("3-max A� rich tree")).toBe("3-max · rich tree");
    expect(cleanSidecarText("6-max \\u00B7 100bb")).toBe("6-max · 100bb");
  });
});

describe("chartSetup", () => {
  it("a GTO Wizard AI preflop tree: the seats from its label, the cap from the answer's note", () => {
    const s = chartSetup("gtow-ai · 3-handed · BTN:100/SB:103.5/BB:102.5", {
      note: "Tree built from the table — 3-handed · BTN 100bb, SB 103.5bb, BB 102.5bb · rake 5% cap 1bb; solved in 4.7 s.",
    });
    expect(s?.kind).toBe("gtow-ai-preflop");
    expect(s?.seats).toEqual([{ pos: "BTN", stackBb: 100 }, { pos: "SB", stackBb: 103.5 }, { pos: "BB", stackBb: 102.5 }]);
    expect(s?.even).toBe(false);
    expect(s?.rake).toEqual({ pct: 5, capBb: 1, nfnd: true });
  });

  it("the crawled library: GTO Wizard's NL500 structure, the depth from the id or the answer", () => {
    const a = chartSetup("6max Cash6m500zGeneral@100");
    expect(a?.kind).toBe("gtow-library");
    expect(a?.stake).toBe("NL500");
    expect(a?.rake).toEqual({ pct: 5, capBb: 0.6, nfnd: null });
    expect(a?.seats.every((x) => x.stackBb === 100)).toBe(true);
    const b = chartSetup("CashHu500zComplex", { depth: 75 });
    expect(b?.seats).toEqual([{ pos: "SB", stackBb: 75 }, { pos: "BB", stackBb: 75 }]);
  });

  it("an HRC id with no sidecar still says every seat's stack (the id grammar), and nothing it cannot know", () => {
    const s = chartSetup("ign200_6max_P_UTG90_HJ80_BB60_o9");
    expect(s?.kind).toBe("hrc");
    expect(s?.seats.map((x) => `${x.pos}:${x.stackBb}`)).toEqual(["UTG:90", "HJ:80", "CO:100", "BTN:100", "SB:100", "BB:60"]);
    expect(s?.even).toBe(false);
    expect(s?.rake).toBeNull();
    expect(s?.from).toMatch(/chart id alone/);
  });

  it("refuses what is not a preflop chart, and anything shaped like a path", () => {
    expect(chartSetup("MES M2_heroBTN_srp_vs_BB @ Kc7d2h (hero: exploit range)")).toBeNull();
    expect(chartSetup("../../etc/passwd")).toBeNull();
    expect(chartSetup("")).toBeNull();
  });
});
