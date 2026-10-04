/**
 * Offline legality check of the stress-500 set through the system's own capture gate (no requests): every hero
 * decision's cut must pass unsolvableCapture, preflopCaptureFaults and (postflop, after the rotation repair)
 * captureFaults. Also prints a few hands as hand histories so the scripts can be read against their titles.
 *
 *   bun src/scripts/stress500/check.ts [--data C:/Users/Brady/poker-data-stress500] [--show id,id]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHand } from "../../feed/normalizeHand/normalizeHand";
import { truncateAt, withStartStacks } from "../../utils/archivedHand/archivedHand";
import { preflopCaptureFaults, unsolvableCapture } from "../../services/fastSolve";
import { captureFaults, repairPostflopRotation } from "../../utils/repairPostflopRotation/repairPostflopRotation";
import { handHistoryText } from "./hhText";

const argv = process.argv.slice(2);
const DATA = argv.includes("--data") ? argv[argv.indexOf("--data") + 1]! : "C:/Users/Brady/poker-data-stress500";
const show = argv.includes("--show") ? argv[argv.indexOf("--show") + 1]!.split(",") : [];
const set = JSON.parse(readFileSync(join(DATA, "scenarios.json"), "utf8"));
let ok = 0, bad = 0;
const faults = new Map<string, string[]>();
for (const sc of set.scenarios) {
  const hand = normalizeHand(sc.raw).hand;
  for (let i = 0; i < hand.actions.length; i++) {
    const a = hand.actions[i]!;
    if (!a.hero || /^post/.test(a.type)) continue;
    const cut = withStartStacks(truncateAt(hand, i));
    const h = { ...cut, currentNode: { ...cut.currentNode, toActIsHero: true } };
    const why: string[] = [];
    const u = unsolvableCapture(h);
    if (u) why.push(`unsolvable: ${(u as any).reason}`);
    if (h.street === "preflop") why.push(...preflopCaptureFaults(h));
    else { const rep = repairPostflopRotation(h as any); why.push(...captureFaults((rep as any).hand ?? h)); }
    if (why.length) { bad++; const k = `${sc.id}@${i}`; faults.set(k, why); } else ok++;
  }
}
console.log(`${ok} decisions pass the capture gate, ${bad} do not`);
for (const [k, w] of [...faults].slice(0, 40)) console.log(`  ${k}: ${w.join(" | ").slice(0, 220)}`);
for (const id of show) {
  const sc = set.scenarios.find((s: any) => s.id === id);
  if (!sc) continue;
  console.log(`\n=== ${sc.id} · ${sc.family} · ${sc.title}`);
  console.log(handHistoryText(normalizeHand(sc.raw).hand, sc));
}
