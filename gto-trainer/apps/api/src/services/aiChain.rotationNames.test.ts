/** rotationDisagrees (2026-10-05, stress-500 pf_postin-003): a shared solution's seat NAMES are another walk's. */
import { describe, expect, test } from "bun:test";
import { rotationDisagrees } from "./aiChain";

const P = (...xs: string[]) => xs.map((position, i) => ({ position, is_hero: i === 0 }));
describe("rotationDisagrees", () => {
  test("the right rotation under another walk's names: SB/BB/HJ's solution walked as SB/BB/BTN, BTN to act", () => {
    expect(rotationDisagrees(P("HJ", "SB", "BB"), ["BTN", "SB", "BB"])).toBe(false);
  });
  test("a wrong rotation is still caught when the names are ours", () => {
    expect(rotationDisagrees(P("BB", "BTN", "SB"), ["SB", "BB", "BTN"])).toBe(true);
    expect(rotationDisagrees(P("SB", "BTN", "BB"), ["SB", "BB", "BTN"])).toBe(true);
  });
  test("the same names, the same rotation: agrees; heads-up BTN/SB aliasing through norm", () => {
    expect(rotationDisagrees(P("BB", "BTN", "SB"), ["BB", "BTN", "SB"])).toBe(false);
    const norm = (p: string) => (["BTN", "SB"].includes(p.toUpperCase()) ? "BTN~SB" : p.toUpperCase());
    expect(rotationDisagrees(P("SB", "BB"), ["BTN", "BB"], norm)).toBe(false);
  });
  test("a list that is not exactly our seats says nothing: foreign names, our names permuted from another walk", () => {
    expect(rotationDisagrees(P("SB", "BB", "HJ"), ["HJ", "BTN", "SB"])).toBe(false);
    expect(rotationDisagrees([{ position: "HJ", is_hero: true }], ["SB", "BB", "BTN"])).toBe(false);
  });
  test("a shorter list: the actor's name decides when it is one of ours", () => {
    expect(rotationDisagrees([{ position: "BB", is_hero: true }], ["SB", "BB", "BTN"])).toBe(true);
    expect(rotationDisagrees([{ position: "SB", is_hero: true }], ["SB", "BB", "BTN"])).toBe(false);
  });
  test("our exact seats in a list not led by hero: the actor's name decides", () => {
    expect(rotationDisagrees([{ position: "BB", is_hero: false }, { position: "SB", is_hero: true }, { position: "BTN", is_hero: false }], ["SB", "BB", "BTN"])).toBe(false);
    expect(rotationDisagrees([{ position: "SB", is_hero: false }, { position: "BB", is_hero: true }, { position: "BTN", is_hero: false }], ["SB", "BB", "BTN"])).toBe(true);
  });
});
