/** rotationDisagrees (2026-10-05, stress-500 pf_postin-003; review 5): a shared solution's seat NAMES are another
 *  walk's, but its SLOTS (postflop order: OOP, OOP+1, IP) are the tree's — the actor's slot is what is compared. */
import { describe, expect, test } from "bun:test";
import { rotationDisagrees } from "./aiChain";

const P = (...xs: string[]) => xs.map((position, i) => ({ position, is_hero: i === 0 }));
describe("rotationDisagrees", () => {
  test("pf_postin-003: SB/BB/HJ's solution walked as SB/BB/BTN, the IP seat to act — agrees", () => {
    expect(rotationDisagrees(P("HJ", "SB", "BB"), ["BTN", "SB", "BB"])).toBe(false);
  });
  test("a real disagreement through a shared solution's names: it says the OOP seat acts, we have the IP seat", () => {
    expect(rotationDisagrees(P("SB", "BB", "HJ"), ["BTN", "SB", "BB"])).toBe(true);
    expect(rotationDisagrees(P("SB", "BB", "HJ"), ["HJ", "BTN", "SB"])).toBe(true);
  });
  test("our own names: a wrong slot is caught, the right one agrees", () => {
    expect(rotationDisagrees(P("BB", "BTN", "SB"), ["SB", "BB", "BTN"])).toBe(true);
    expect(rotationDisagrees(P("BB", "BTN", "SB"), ["BB", "BTN", "SB"])).toBe(false);
  });
  test("heads-up: by name, BTN/SB aliased through norm", () => {
    const norm = (p: string) => (["BTN", "SB"].includes(p.toUpperCase()) ? "BTN~SB" : p.toUpperCase());
    expect(rotationDisagrees(P("SB", "BB"), ["BTN", "BB"], norm)).toBe(false);
    expect(rotationDisagrees(P("BB", "SB"), ["BTN", "BB"], norm)).toBe(true);
  });
  test("a shorter list: the actor's name decides when it is one of ours; a foreign one says nothing", () => {
    expect(rotationDisagrees([{ position: "BB", is_hero: true }], ["SB", "BB", "BTN"])).toBe(true);
    expect(rotationDisagrees([{ position: "SB", is_hero: true }], ["SB", "BB", "BTN"])).toBe(false);
    expect(rotationDisagrees([{ position: "HJ", is_hero: true }], ["SB", "BB", "BTN"])).toBe(false);
  });
});
