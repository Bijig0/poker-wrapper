/**
 * HERO ABSENT AT HIS NODE → LOUD, AND A PASSIVE PICK (2026-10-08, Brady: "put a warning and a note if this is ever hit
 * so we know something has gone wrong").
 *
 * The chain conditions hero's range on every action he took, and floors his hand class on each street's entry so his
 * combo never vanishes from his own range. Inside a street nothing re-floors it: when his weight at his node falls under
 * HERO_ABSENT_WEIGHT (1e-3) the strategy read for his combo is the solver's untrained noise for a hand the model does
 * not hold. Stress core-bvb-007 (a re-tree that gave him another bet menu: 0.0005) and live answer 13033 (hand
 * 4922572952, Th9s on the turn, 0.000 → ALLIN 48% / CALL 52%, the roll pressed the ALLIN) are the two seen; 5 of ~2,500
 * live postflop walks since 2026-09-21. The re-tree half is fixed at its cause (aiChain retree-consistency); this is the
 * net for whatever else gets there.
 *
 * LOUD, ALWAYS: check #17 FAILS (chainChecks.checkHeroCombo, covered by the path code postflop:hero-absent, verdict
 * "check failed"), the answer's warning opens "HERO ABSENT AT HIS NODE:", the API log gets a `[hero-absent]` line.
 *
 * THE PICK (HERO_ABSENT_PASSIVE=on, unset = on; off = the mix served as read): one action at 90% or more of the mix is
 * taken; otherwise the PASSIVE action — check when offered; call when facing a wager and the call has at least 1% of the
 * mix; else fold — never a bet, raise or all-in from such a mix. The served mix becomes 100% that action (the poller
 * re-rolls the pick from the mix), the mix as read is kept in the note. It runs after the short all-in press
 * (allInPress): a DROPPED all-in is out of the mix before this reads it, so nothing here can bring it back.
 * Register: services/approximations.ts `hero-absent-passive`.
 */
import { HERO_ABSENT_WEIGHT } from "./chainChecks";

export { HERO_ABSENT_WEIGHT };
export const HERO_ABSENT_TAG = "HERO ABSENT AT HIS NODE:";
/** one action at this share of the mix or more is taken as it is */
export const HERO_ABSENT_TAKE = 0.9;
/** a call with at least this share of the mix is the passive answer facing a wager */
export const HERO_ABSENT_CALL_MIN = 0.01;

/** the switch: on unless HERO_ABSENT_PASSIVE=off (read at every decision) */
export const heroAbsentPassiveOn = (env: Record<string, string | undefined> = process.env): boolean =>
  String(env.HERO_ABSENT_PASSIVE ?? "on").trim().toLowerCase() !== "off";

export const isHeroAbsent = (w: number | null | undefined): boolean => w != null && Number.isFinite(w) && w < HERO_ABSENT_WEIGHT;

const kindOf = (label: string): "fold" | "check" | "call" | "wager" => {
  const l = label.trim().toLowerCase();
  if (l.startsWith("fold")) return "fold";
  if (l.startsWith("check")) return "check";
  if (l.startsWith("call")) return "call";
  return "wager";
};

/**
 * THE PASSIVE PICK (pure). `actions` = the served mix (percent or any scale). Returns the action taken, why, and the mix
 * with all of it on that action (the other actions kept at 0). Null when the mix is empty.
 */
export function heroAbsentPick<T extends { action: string; frequency: number }>(actions: T[]):
    { pick: string; why: "dominant" | "check" | "call" | "fold" | "only"; actions: T[] } | null {
  const pos = (x: T) => (x.frequency > 0 ? x.frequency : 0);
  const sum = actions.reduce((t, x) => t + pos(x), 0);
  if (!(sum > 0)) return null;
  const top = actions.reduce((b, x) => (pos(x) > pos(b) ? x : b), actions[0]!);
  let pick: T | undefined;
  let why: "dominant" | "check" | "call" | "fold" | "only";
  if (pos(top) / sum >= HERO_ABSENT_TAKE) { pick = top; why = "dominant"; }
  else {
    const check = actions.find((x) => kindOf(x.action) === "check");
    const call = actions.find((x) => kindOf(x.action) === "call");
    const fold = actions.find((x) => kindOf(x.action) === "fold");
    if (check) { pick = check; why = "check"; }
    else if (call && pos(call) / sum >= HERO_ABSENT_CALL_MIN) { pick = call; why = "call"; }
    else if (fold) { pick = fold; why = "fold"; }
    else { pick = call ?? top; why = "only"; }   // no fold offered and no check: the least aggressive left
  }
  return { pick: pick.action, why, actions: actions.map((x) => ({ ...x, frequency: x === pick ? sum : 0 })) };
}

const pct = (x: number) => `${Math.round(x * 10) / 10}%`;
const wText = (w: number) => (w < 0.001 && w > 0 ? w.toExponential(1) : w.toFixed(3));

/**
 * THE ANSWER'S HALF (pure; fastSolve.solvePostflopViaChainOnce): given the served mix (after the short all-in drop) and
 * hero's weight at his node in every tree it was read from, null when he is present in all of them — else the mix to
 * serve, the warning line, the path reason (failed, postflop:hero-absent) and the API log line.
 */
export function heroAbsentAnswer<T extends { action: string; frequency: number }>(a: {
  actions: T[]; trees: { plan: string | null; w: number | null | undefined }[]; street: string; hand: string; who: string;
  passive?: boolean;
}): { actions: T[]; note: string; reason: { v: "failed"; code: "postflop:hero-absent"; text: string }; log: string; pick: string | null } | null {
  const absent = a.trees.filter((t) => isHeroAbsent(t.w)).map((t) => ({ plan: t.plan, w: Number(t.w) }));
  if (!absent.length) return null;
  const passive = a.passive ?? heroAbsentPassiveOn();
  const read = a.actions.map((x) => ({ action: String(x.action), frequency: x.frequency }));
  const p = passive ? heroAbsentPick(a.actions) : null;
  const did = p ? `picked ${p.pick} (${p.why})` : passive ? "nothing to pick" : "served as read (HERO_ABSENT_PASSIVE=off)";
  return {
    actions: p ? p.actions : a.actions,
    note: heroAbsentNote({ weights: absent, mix: read, pick: p, passive }),
    reason: { v: "failed", code: "postflop:hero-absent", text: `${a.street}: hero's hand ${absent.map((x) => wText(x.w)).join(" / ")} in his range at his node — ${did}` },
    log: `[hero-absent] hand ${a.hand} ${a.street} ${a.who}: weight ${absent.map((x) => `${x.w.toExponential(2)}${x.plan ? ` (${x.plan})` : ""}`).join(", ")} · ` +
      `read ${read.filter((x) => x.frequency > 0).map((x) => `${x.action} ${x.frequency.toFixed(1)}`).join(" / ")} · ${did}`,
    pick: p?.pick ?? null,
  };
}

/** The answer's line (one segment — no " · " inside). `weights` = hero's weight at his node in each tree read. */
export function heroAbsentNote(a: { weights: { plan: string | null; w: number }[]; mix: { action: string; frequency: number }[]; pick: { pick: string; why: string } | null; passive: boolean }): string {
  const sum = a.mix.reduce((t, x) => t + (x.frequency > 0 ? x.frequency : 0), 0) || 1;
  const read = a.mix.filter((x) => x.frequency > 0).map((x) => `${x.action} ${pct((x.frequency / sum) * 100)}`).join(" / ");
  const ws = a.weights.map((x) => `${wText(x.w)}${x.plan ? ` (${x.plan})` : ""}`).join(", ");
  const head = `${HERO_ABSENT_TAG} hero's hand carries weight ${ws} in his own range at this node (under ${HERO_ABSENT_WEIGHT}) — something upstream has gone wrong; the mix read (${read || "empty"}) is noise for a hand the model does not hold`;
  if (!a.passive) return `${head}; served as read (HERO_ABSENT_PASSIVE=off)`;
  if (!a.pick) return `${head}; nothing to pick`;
  const how = a.pick.why === "dominant" ? `its one action at ${HERO_ABSENT_TAKE * 100}%+ is taken`
    : a.pick.why === "check" ? "the passive action is taken: check"
      : a.pick.why === "call" ? `the passive action is taken: call (facing a wager, the call ${HERO_ABSENT_CALL_MIN * 100}%+ of the mix)`
        : a.pick.why === "fold" ? "the passive action is taken: fold (no check, the call under 1% of the mix)" : "the least aggressive action offered is taken";
  return `${head}; ${how} — ${a.pick.pick}${a.pick.why === "dominant" ? "" : ", never a bet / raise / all-in from such a mix"}`;
}
