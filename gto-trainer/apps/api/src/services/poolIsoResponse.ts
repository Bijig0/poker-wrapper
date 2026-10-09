/**
 * THE LIMPER'S REPLY TO HERO'S ISO, LOCKED WITH HIS LIMP (2026-10-09, the methodology review's item 3: "lock the
 * villain's whole line in one POST"; memory range-methodology-review / limpcall-range-normalisation). The pool-locked
 * limper (gtowAiPreflop.solvePreflopPoolLocked) has his LIMP node locked to the pool's limp range, but his reply to
 * hero's iso stays the solver's: a short UTG locked to limp_first_short_le60 then calls the iso with 0.13 combos on the
 * locked tree (the audit's limp-caller gap), and hero's iso decision is priced against a limper who almost never calls.
 * P(call | he limped, hand) is exactly a node strategy, so it is locked at his reply node in the SAME POST as the limp
 * (multiple locks per POST work — the pool-lock study did it), at GROUP level (8 hand groups; 29-135 Ignition
 * limp-callers per cell is too few for per-class rates):
 *   - LIMP_LOCKS=v4 with the group product (the default): the Ignition limp-call group rates (poolLimpCallGroups.v4.json,
 *     1,627 limpers' replies, the cell limpCallGroupKey names);
 *   - otherwise: the call table's limpcall cell, averaged over each group's combos, × the Ignition calibration's group
 *     multipliers where that cell is active (poolLimpCallCalibration.json), capped at 1.
 * The rest of each hand spreads over fold / raise in the solver's own proportions (poolLimpLockOf).
 *
 * THE SWITCH, HERO_ISO_RESPONSE_LOCK in the environment, read at every decision: off (unset) | on. OFF BY DEFAULT: it
 * changes hero's iso answers against every pool-locked limper and costs a few node reads on the parent tree (hero's
 * node, the folds between, his reply) inside the lock's 12 s box; to be measured (hero's view study) before it is on.
 * Pure apart from the tables.
 */
import { HAND_GROUPS, handGroup } from "./poolTrigger";
import { limpCallCalibration, limpCallCalibrationKey, limpCallGroupKey, limpCallGroupRates, poolCallKey, poolCallRange } from "./poolCalls";
import type { Seat6 } from "./hrc6max";
import { COMBOS } from "../utils/comboIndex/comboIndex";

export const heroIsoResponseLockOn = (): boolean => /^(on|1|true|yes)$/i.test(String(process.env.HERO_ISO_RESPONSE_LOCK ?? "off").trim());

const classCombos = (c: string): number => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
const CLASSES = [...new Set(COMBOS.map((c) => c.cls))];

/** The limper's call-given-limp rate by hand group, and where it came from (for the note). null = no rate for him. */
export function isoResponseRates(a: { pos: Seat6; stack: number; limpersInPot: number }): { groups: Record<string, number>; source: string } | null {
  const gk = limpCallGroupKey("limpcall", a.stack, a.limpersInPot);
  if (gk) {
    const g = limpCallGroupRates(gk);
    if (g) return { groups: { ...g }, source: `Ignition limp-call group rates ${gk}` };
  }
  const k = poolCallKey({ pos: a.pos, line: "limpcall", opener: null, before: a.limpersInPot, openTo: 0, complete: false }, a.stack);
  if (!k || k.table !== "call") return null;
  const r = poolCallRange(k);
  if (!r) return null;
  // over every class of the deck (a class the cell omits calls 0)
  const sum: Record<string, number> = {}, n: Record<string, number> = {};
  for (const c of CLASSES) {
    const g = handGroup(c);
    sum[g] = (sum[g] ?? 0) + Math.max(0, Number(r.weights[c] ?? 0)) * classCombos(c);
    n[g] = (n[g] ?? 0) + classCombos(c);
  }
  const calKey = limpCallCalibrationKey("limpcall", a.stack, a.limpersInPot);
  const cal = calKey ? limpCallCalibration(calKey) : null;
  const groups: Record<string, number> = {};
  for (const g of HAND_GROUPS) groups[g] = Math.min(1, (n[g] ? sum[g]! / n[g]! : 0) * (cal?.[g] ?? 1));
  return { groups, source: `${k.key} by hand group${calKey && cal ? ` × Ignition calibration ${calKey}` : ""}` };
}
