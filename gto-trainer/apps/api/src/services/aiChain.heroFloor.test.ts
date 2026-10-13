/**
 * HERO'S CLASS FLOOR, the four modes (HERO_CLASS_FLOOR, 2026-10-14 A/B — docs/2026-10-14-hero-floor-ab.md): pure over a
 * 1326-weight range. abs is the floor that has been live since 2026-09-17 (every unblocked combo of hero's class >= 0.05);
 * rel5 / rel1 lift to a share of his heaviest live combo; none lifts to an epsilon only. Every mode lifts the whole
 * class, never a combo the board blocks, never a weight already above the floor, and is idempotent.
 */
import { describe, expect, it } from "bun:test";
import { HERO_CLASS_FLOOR_ABS, HERO_CLASS_FLOOR_EPS, applyHeroClassFloor, heroClassFloorMode, heroClassFloorOf } from "./aiChain";
import { cardIndex, comboIndex } from "../utils/comboIndex/comboIndex";

const KQs = [comboIndex("Kc", "Qc"), comboIndex("Kd", "Qd"), comboIndex("Kh", "Qh"), comboIndex("Ks", "Qs")];
const hero = comboIndex("Kc", "Qc");
const board = new Set(["Ad", "9s", "6d"].map(cardIndex));
/** a range: a few full-weight combos, hero's class thin, one class combo blocked by the board when asked */
function range(classW: number, top = 1): number[] {
  const r = new Array<number>(1326).fill(0);
  r[comboIndex("As", "Ah")] = top;
  r[comboIndex("Jc", "Tc")] = top * 0.4;
  for (const c of KQs) r[c] = classW;
  return r;
}
const live = (r: number[], b: ReadonlySet<number>) => r.reduce((s, w, i) => (w > 0 ? s + w : s), 0);

describe("heroClassFloorMode", () => {
  it("defaults to abs and refuses anything but the four modes", () => {
    expect(heroClassFloorMode({})).toBe("abs");
    expect(heroClassFloorMode({ HERO_CLASS_FLOOR: " REL5 " })).toBe("rel5");
    expect(heroClassFloorMode({ HERO_CLASS_FLOOR: "rel1" })).toBe("rel1");
    expect(heroClassFloorMode({ HERO_CLASS_FLOOR: "none" })).toBe("none");
    expect(heroClassFloorMode({ HERO_CLASS_FLOOR: "off" })).toBe("abs");
  });
});

describe("heroClassFloorOf", () => {
  it("abs is 0.05 whatever the range; rel is a share of the heaviest live combo; none an epsilon", () => {
    expect(heroClassFloorOf("abs", 1)).toBe(HERO_CLASS_FLOOR_ABS);
    expect(heroClassFloorOf("abs", 0.02)).toBe(HERO_CLASS_FLOOR_ABS);
    expect(heroClassFloorOf("rel5", 1)).toBeCloseTo(0.05, 12);
    expect(heroClassFloorOf("rel5", 0.2)).toBeCloseTo(0.01, 12);
    expect(heroClassFloorOf("rel1", 0.2)).toBeCloseTo(0.002, 12);
    expect(heroClassFloorOf("none", 1)).toBe(HERO_CLASS_FLOOR_EPS);
    expect(heroClassFloorOf("none", 0.02)).toBe(HERO_CLASS_FLOOR_EPS);   // never under the epsilon GTO Wizard keeps
    expect(heroClassFloorOf("none", 0)).toBe(HERO_CLASS_FLOOR_EPS);
  });
});

describe("applyHeroClassFloor", () => {
  it("abs: lifts every unblocked combo of the class to 0.05 and leaves the rest of the range alone", () => {
    const r = range(0.004);
    const rec = applyHeroClassFloor(r, hero, board, "abs");
    for (const c of KQs) expect(r[c]).toBe(0.05);
    expect(r[comboIndex("As", "Ah")]).toBe(1);
    expect(rec).toMatchObject({ mode: "abs", floor: 0.05, maxLive: 1, lifted: 4, comboBefore: 0.004, comboAfter: 0.05 });
    expect(rec.classBefore).toBeCloseTo(0.016, 12);
    expect(rec.classAfter).toBeCloseTo(0.2, 12);
    expect(rec.liveAfter - rec.liveBefore).toBeCloseTo(0.2 - 0.016, 12);
  });
  it("rel5 equals abs on a full-weight range and scales down with a thin one", () => {
    const full = range(0.004); applyHeroClassFloor(full, hero, board, "rel5");
    const abs = range(0.004); applyHeroClassFloor(abs, hero, board, "abs");
    expect(full).toEqual(abs);
    const thin = range(0.0004, 0.2);
    const rec = applyHeroClassFloor(thin, hero, board, "rel5");
    expect(rec.maxLive).toBeCloseTo(0.2, 12);
    expect(rec.floor).toBeCloseTo(0.01, 12);
    for (const c of KQs) expect(thin[c]).toBeCloseTo(0.01, 12);
    const rel1 = range(0.0004, 0.2);
    expect(applyHeroClassFloor(rel1, hero, board, "rel1").floor).toBeCloseTo(0.002, 12);
    expect(rel1[hero]).toBeCloseTo(0.002, 12);
  });
  it("none: an epsilon so hero's combo exists, nothing more", () => {
    const r = range(0);
    const rec = applyHeroClassFloor(r, hero, board, "none");
    for (const c of KQs) expect(r[c]).toBe(HERO_CLASS_FLOOR_EPS);
    expect(rec.lifted).toBe(4);
    expect(rec.comboBefore).toBe(0);
    const kept = range(0.004);
    expect(applyHeroClassFloor(kept, hero, board, "none").lifted).toBe(0);
    expect(kept[hero]).toBe(0.004);
  });
  it("card removal stays absolute: a class combo sharing a card with the board is never lifted, and does not count", () => {
    const b = new Set(["Kd", "9s", "6d"].map(cardIndex));   // Kd on the board blocks KdQd
    const r = range(0);
    const rec = applyHeroClassFloor(r, hero, b, "abs");
    expect(r[comboIndex("Kd", "Qd")]).toBe(0);
    expect(rec.lifted).toBe(3);
    expect(rec.classAfter).toBeCloseTo(0.15, 12);
    // hero's own combo blocked (a corrupt spec): nothing of his is counted
    const r2 = range(0.3);
    const rec2 = applyHeroClassFloor(r2, hero, new Set(["Kc", "9s", "6d"].map(cardIndex)), "abs");
    expect(rec2.comboBefore).toBe(0);
    expect(rec2.comboAfter).toBe(0);
    expect(r2[hero]).toBe(0.3);   // untouched, as before: the sane check (#2) names it
  });
  it("a weight above the floor is kept; a pair's class is its six combos", () => {
    const r = range(0.5);
    const rec = applyHeroClassFloor(r, hero, board, "abs");
    expect(rec.lifted).toBe(0);
    for (const c of KQs) expect(r[c]).toBe(0.5);
    const pair = comboIndex("7c", "7d");
    const p = new Array<number>(1326).fill(0);
    p[comboIndex("As", "Ah")] = 1;
    const recP = applyHeroClassFloor(p, pair, board, "abs");
    expect(recP.lifted).toBe(6);
    expect(recP.classAfter).toBeCloseTo(0.3, 12);
  });
  it("is idempotent in every mode (a resumed street re-applies it)", () => {
    for (const mode of ["abs", "rel5", "rel1", "none"] as const) {
      const r = range(0.0004, 0.2);
      applyHeroClassFloor(r, hero, board, mode);
      const once = r.slice();
      const rec = applyHeroClassFloor(r, hero, board, mode);
      expect(r).toEqual(once);
      expect(rec.lifted).toBe(0);
      expect(live(r, board)).toBeCloseTo(rec.liveAfter, 9);
    }
  });
});
