/**
 * PICKER PROBE — what chartFor6max names for a set of table states, and which of those charts the baked record
 * actually has (resolveChart6max against hrc6maxDb). Run before and after a picker change for a pre/post:
 *   bun src/scripts/pickerProbe.ts            (needs the env: . config/env.ps1 first, for FACTORY_DATA_DIR)
 * Reads nothing live, solves nothing, files no misses (the picker is pure).
 */
import { chartFor6max, resolveChart6max, setPatchSource } from "../services/hrc6max";
import { fetchNode6max } from "../services/hrc6maxDb";

const table = (heroSeat: number, stacks: Partial<Record<number, number>> = {}) => ({
  heroSeatId: heroSeat, committed: {}, actions: [], currentNode: { street: "preflop" },
  positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" } as Record<number, string>,
  stacks: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, ...stacks } as Record<number, number>,
});

// [label, hand, hero, tokens]
const CASES: [string, any, string, string[]][] = [
  ["A8h hand: CO opens, BB 10.6bb (this session)",           table(3, { 6: 10.6, 2: 48.8, 4: 72.6 }), "CO", ["F", "F"]],
  ["CO facing the 10.6bb BB's jam after opening 2.6",        table(3, { 6: 10.6, 2: 48.8, 4: 72.6 }), "CO", ["F", "F", "R2.6", "F", "F", "R10.6"]],
  ["BB facing a 2.5x open, BTN 15bb still behind hero? (BTN opened)", table(6, { 4: 15 }), "BB", ["F", "F", "F", "R2.5", "F"]],
  ["SB facing a 2.2x BTN open, BTN 20bb",                    table(5, { 4: 20 }), "SB", ["F", "F", "F", "R2.2"]],
  ["SB facing a 5x BTN open, BTN 25bb",                      table(5, { 4: 25 }), "SB", ["F", "F", "F", "R5"]],
  ["BB facing a 2x HJ open, HJ 40bb",                        table(6, { 2: 40 }), "BB", ["F", "R2", "F", "F", "F"]],
  ["BB facing a 2x BTN open, BTN 81bb",                      table(6, { 4: 81 }), "BB", ["F", "F", "F", "R2", "F"]],
  ["BB facing a 2.5x BTN open, BTN 89bb",                    table(6, { 4: 89 }), "BB", ["F", "F", "F", "R2.5", "F"]],
  ["UTG first in, BB 30bb (the old grid's own rung)",        table(1, { 6: 30 }), "UTG", []],
  ["two shorts: BB facing HJ 30bb open, BTN 50bb folded",    table(6, { 2: 30, 4: 50 }), "BB", ["F", "R2.5", "F", "F", "F"]],
];

setPatchSource(null);
const rows: string[] = [];
for (const [label, hand, hero, tokens] of CASES) {
  const c = chartFor6max(hand, hero, tokens);
  const r = await resolveChart6max(c, (id, line) => fetchNode6max(id, line));
  const landed = r === "unreachable" ? "record unreachable" : r === null ? "NO candidate in the record" : `${r.id}${r.fellBack ? " (fell back)" : ""}`;
  rows.push([`## ${label}`, `  picks:   ${c.id}`, `  answers: ${landed}`,
             `  next:    ${c.candidates.slice(1, 4).join(" > ")}`,
             `  gaps:    ${(c.approx ?? []).map((a) => `${a.kind} want ${a.want} got ${a.got}`).join("; ") || "none"}`,
             `  note:    ${c.note ?? ""}`].join("\n"));
}
console.log(rows.join("\n\n"));
