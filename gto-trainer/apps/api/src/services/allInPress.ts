/**
 * THE SHORT ALL-IN, PRESSED AS THE SOLVER PRICED IT (2026-10-07, Brady: "option 1").
 *
 * A 4-/5-way street is solved on three-seat trees (multiwayCollapse ghost / merge, deadMoneyCollapse). Inside a tree a
 * seat's all-in is capped at the deepest OTHER seat in that tree (gtowApi.seatAllIns: nobody there can call more). When
 * a seat left OUT of the tree is deeper and still live at the table, the tree's "ALLIN" is a raise far below hero's
 * stack — and the wrapper executes an ALLIN pick as the client's ALL-IN preset + confirm (apps/wrapper relay.ts
 * actuateAllIn): hero's WHOLE stack, into players the tree never saw. Stress-500 brief_I-004 flop (5-way on 8h9h9c, the
 * 17.5bb SB jams 15, hero BB Ts9s with 97.5 behind, UTG 24.5 / CO 100 / BTN 100 behind him): in the ghost:CO+ghost:BTN
 * tree hero's all-in is 22 (UTG's stack) — the mix said CALL 15 95.56% / ALLIN 22 4.44%, and an ALLIN pick would have
 * shoved 97.5 into two 100bb players the tree had dropped. No live pick has landed on such an all-in yet (shares 0-4%).
 *
 * THE RULE: an answer whose mix holds an ALLIN that is short of hero's whole stack (by more than 0.5bb) while a villain
 * OUTSIDE the tree that carries it is still live with more chips than it, carries a PRESS for that action — a raise to
 * the tree's amount (a street total, what the client's bet field takes) instead of the shove. The amount is read in the
 * TABLE's terms: the tree's all-in betsize less hero's chips in the tree at his node plus hero's chips on the street at
 * the table (a dead-money tree moves the kept seats' earlier chips into its starting pot — brief_I-004's second flop
 * decision: the tree's "ALLIN 82.5" there is 15 + 82.5 = hero's whole 97.5, not a short all-in). Several blended trees:
 * each tree's own all-in, the SMALLEST is pressed (said when they disagree) and "outside" means outside that tree.
 * THE TABLE'S MINIMUM RAISE (Brady 2026-10-07: "only priced actions get executed; rare multiway spots lean
 * conservative"): a tree all-in is a legal raise for any amount (it is the tree seat's all-in); at the table hero is NOT
 * all-in at that size, so it must be at least the street's level plus its last full raise. When the tree's amount is a
 * legal raise it is pressed as it is (kind "raise-to"); when it is under the minimum (brief_I-004: the SB's 15 jam is a
 * full bet, hero's smallest raise is to 30 and the tree's 22 cannot be typed) no size the table allows was priced — the
 * all-in is DROPPED from the served mix (kind "dropped", its share recorded), the rest re-spread and the pick re-rolled
 * (dropShortAllIns — the prunedPicks pattern), note "SHORT ALL-IN DROPPED:". It is never lifted to another size and the
 * plain ALL-IN preset is never pressed for a short tree all-in.
 *
 * ALLIN_SIZE_TO_TREE=off (config/local.env, read at every decision): no press, no drop — the plain all-in (the old
 * behaviour).
 * Register: services/approximations.ts `allin-sized-to-tree`. Wrapper: relay.ts pickReady / actuateSizedAllIn.
 */
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { roundContributions } from "../utils/archivedHand/archivedHand";
import type { PathReason } from "./chainPath";

/** One press instruction on an answer: how the wrapper executes the action it names, when it is the pick — or, kind
 *  "dropped", a short all-in the table cannot take at its size, taken out of the served mix. */
export interface PressEntry {
  /** the answer's action label, as the mix and the pick spell it ("ALLIN 22") */
  action: string;
  kind: "raise-to" | "dropped";
  /** raise-to: the street total to type into the client's bet field (bb) — the tree's amount itself */
  amount?: number;
  /** "raise" facing a wager, "bet" when nothing is in on the street */
  verb: "raise" | "bet";
  /** the tree's all-in as a table street total, before any lift to the table's minimum raise */
  treeAmount: number;
  /** what a shove at the table would put in: hero's whole street total */
  heroAllIn: number;
  /** the table's smallest legal raise-to at hero's node */
  minRaiseTo: number;
  /** dropped: the all-in's share of the served mix (%) before it was taken out */
  share?: number;
  /** the collapse whose tree carries the amount (its plan tag), null = the one tree */
  plan: string | null;
  /** the live villains outside that tree with more chips than the amount (their street totals) */
  outside: { pos: string; chips: number }[];
  /** every blended tree's own all-in, when they disagree */
  trees?: { plan: string | null; to: number }[];
  why: string;
}

/** One solved tree at hero's node: its plan tag, the table seats it holds, and hero's all-in in it as a TABLE street
 *  total (null = the tree offers hero no all-in there). */
export interface TreeAllIn { plan: string | null; seats: string[]; to: number | null; deepest?: { pos: string; chips: number } | null }

/** The street at hero's node, from the hand's own actions: hero's chips, the level, the smallest legal raise-to. */
export interface StreetMoney {
  heroCommitted: number;
  heroBehind: number;
  /** the most anyone has in on the street */
  level: number;
  /** the street's smallest legal raise-to: level + its last FULL raise (an all-in for less does not reopen it), 1bb
   *  minimum bet on an empty street */
  minRaiseTo: number;
  /** live villains (dealt, not folded, not hero) by position: chips behind + chips on the street (null = unknown) */
  villains: { pos: string; chips: number | null; seat: number }[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const fmt = (x: number) => String(r2(x));
const up = (s: string) => s.trim().toUpperCase();
/** an ALL-IN action label ("ALLIN 22", "All-in 22", "ALL IN") */
export const isAllInAction = (label: unknown): boolean => /^all[ -]?in\b/i.test(String(label ?? "").trim());
/** the switch: on unless ALLIN_SIZE_TO_TREE=off (read at every decision) */
export const allInSizeToTreeOn = (env: Record<string, string | undefined> = process.env): boolean =>
  String(env.ALLIN_SIZE_TO_TREE ?? "").trim().toLowerCase() !== "off";

/** The street's money at hero's node (`hand` is the capture up to it; `street` the current street). */
export function streetMoneyAt(hand: ParsedHand, street: string): StreetMoney {
  const seatOf = (a: ParsedHand["actions"][number]) => (a.hero ? hand.heroSeatId : a.seatId);
  const on = roundContributions(hand).get(street) ?? new Map<number, number>();
  // the level and the last full raise, in order: a raise / bet / all-in amount is the seat's street TOTAL, a call adds
  let level = 0, lastInc = 1;
  for (const a of hand.actions) {
    if (a.street !== street) continue;
    if (a.type !== "raise" && a.type !== "bet" && a.type !== "all-in") continue;
    const to = Number(a.amount);
    if (!Number.isFinite(to) || to <= level + 0.005) continue;   // an all-in for no more than the level is a call
    if (to - level >= lastInc - 0.005) lastInc = r2(to - level);
    level = r2(to);
  }
  const folded = new Set(hand.actions.filter((a) => a.type === "fold").map(seatOf));
  const live = hand.liveSeats?.length ? new Set(hand.liveSeats) : null;
  const villains = Object.entries(hand.positions ?? {})
    .map(([k, pos]) => ({ seat: Number(k), pos: String(pos) }))
    .filter((x) => x.seat !== hand.heroSeatId && !folded.has(x.seat) && (!live || live.has(x.seat)))
    .map((x) => {
      const behind = Number(hand.stacks?.[x.seat]);
      return { ...x, chips: Number.isFinite(behind) ? r2(behind + (on.get(x.seat) ?? 0)) : null };
    });
  return {
    heroCommitted: r2(on.get(hand.heroSeatId) ?? 0),
    heroBehind: r2(Number(hand.stacks?.[hand.heroSeatId] ?? NaN)),
    level, minRaiseTo: r2(level + lastInc), villains,
  };
}

/**
 * Hero's all-in in one solved tree, as a TABLE street total: the tree's betsize at hero's node, less hero's chips in the
 * tree there, plus hero's chips on the street at the table (a dead-money tree's preload sits in its starting pot).
 * `node` is hero's node of the walk's trace (aiChain ChainTraceNode); null when it offers no all-in.
 */
export function treeAllInTo(node: { actor: number; invested: number[]; actions: { name: string; betsize: number | null }[] } | null | undefined,
    heroCommitted: number): number | null {
  if (!node) return null;
  const a = node.actions.find((x) => isAllInAction(x.name));
  const bs = Number(a?.betsize);
  if (!a || !Number.isFinite(bs) || bs <= 0) return null;
  const inTree = Number(node.invested?.[node.actor] ?? 0);
  return r2(bs - (Number.isFinite(inTree) ? inTree : 0) + heroCommitted);
}

/**
 * THE DETECTION (pure): the press entries for an answer's mix. `trees` = every tree the served mix was read from (the
 * blended ones; the one tree otherwise), each with hero's all-in in table terms. Empty = press as before (the shove).
 */
export function shortAllInPress(a: {
  actions: { action: string; frequency?: number }[];
  heroPos: string;
  money: StreetMoney;
  trees: TreeAllIn[];
  on?: boolean;
}): PressEntry[] {
  if (a.on === false) return [];
  const labels = a.actions.map((x) => String(x.action)).filter(isAllInAction);
  if (!labels.length) return [];
  const { money } = a;
  if (!Number.isFinite(money.heroBehind)) return [];
  const heroAllIn = r2(money.heroBehind + money.heroCommitted);
  const carried = a.trees.filter((t): t is TreeAllIn & { to: number } => t.to != null && Number.isFinite(t.to));
  if (!carried.length) return [];
  // the smallest all-in of the blended trees is the one pressed; "outside" is outside ITS tree
  const tree = [...carried].sort((x, y) => x.to - y.to)[0]!;
  if (!(tree.to < heroAllIn - 0.5)) return [];
  const inTree = new Set(tree.seats.map(up));
  const outside = money.villains
    .filter((v) => !inTree.has(up(v.pos)) && v.chips != null && v.chips > tree.to + 0.5)
    .map((v) => ({ pos: v.pos, chips: v.chips! }));
  if (!outside.length) return [];
  // THE TABLE'S MINIMUM RAISE: the tree's all-in is legal there at any size; at the table hero is not all-in at it —
  // under the minimum, no size the table allows was priced: dropped from the mix, never lifted
  const minRaiseTo = r2(money.minRaiseTo);
  const legal = tree.to >= minRaiseTo - 0.005;
  const verb: "raise" | "bet" = money.level > 0.005 ? "raise" : "bet";
  const disagree = new Set(carried.map((t) => fmt(t.to))).size > 1;
  const deepest = tree.deepest ? ` (${tree.deepest.pos}'s ${fmt(tree.deepest.chips)}, the deepest seat it holds)` : "";
  const out = outside.map((v) => `${v.pos} (${fmt(v.chips)})`).join(" and ");
  const why = `the tree's all-in is ${fmt(tree.to)}${deepest}${tree.plan ? ` in ${tree.plan}` : ""}; ${out} ` +
    `${outside.length === 1 ? "is" : "are"} outside the tree and deeper — a shove at the table would be ${fmt(heroAllIn)}, ` +
    `which the tree never priced` +
    (legal ? "" : `; the table's smallest ${verb} is to ${fmt(minRaiseTo)} (level ${fmt(money.level)}), so ${fmt(tree.to)} cannot be played there`) +
    (disagree ? `; the blended trees disagree (${carried.map((t) => `${t.plan ?? "tree"} ${fmt(t.to)}`).join(", ")}) — the smallest is pressed` : "");
  const share = (label: string) => {
    const f = Number(a.actions.find((x) => x.action === label)?.frequency);
    return Number.isFinite(f) ? r2(f) : undefined;
  };
  return labels.map((action) => ({
    action, ...(legal ? { kind: "raise-to" as const, amount: tree.to } : { kind: "dropped" as const, share: share(action) }),
    verb, treeAmount: tree.to, heroAllIn, minRaiseTo,
    plan: tree.plan, outside,
    ...(disagree ? { trees: carried.map((t) => ({ plan: t.plan, to: t.to })) } : {}),
    why,
  }));
}

/** The press entry (kind raise-to) for a pick, if the pick is one of the pressed actions. */
export function pressForPick(press: readonly PressEntry[] | null | undefined, pick: string | null | undefined): PressEntry | null {
  if (!press?.length || !pick) return null;
  const p = up(pick).replace(/\s+/g, " ");
  return press.find((x) => x.kind === "raise-to" && up(x.action).replace(/\s+/g, " ") === p) ?? null;
}

/**
 * THE SAFETY NET (pure): every "dropped" entry's action out of the mix, the rest re-spread to the mix's own sum (the
 * prunedPicks pattern); the caller re-rolls on the result. Nothing left with weight (the all-in was the whole mix): the
 * check / call takes it all — a rare multiway spot leans conservative — else the fold. Returns the dropped share (%).
 */
export function dropShortAllIns<T extends { action: string; frequency: number }>(actions: T[], press: readonly PressEntry[]):
    { actions: T[]; dropped: number; toPassive: string | null } {
  const out = new Set(press.filter((e) => e.kind === "dropped").map((e) => up(e.action)));
  if (!out.size) return { actions, dropped: 0, toPassive: null };
  const keep = actions.filter((x) => !out.has(up(x.action)));
  if (!keep.length) return { actions, dropped: 0, toPassive: null };
  const pos = (x: T) => (x.frequency > 0 ? x.frequency : 0);
  const sum = actions.reduce((t, x) => t + pos(x), 0);
  const rest = keep.reduce((t, x) => t + pos(x), 0);
  const dropped = r2(sum - rest);
  if (rest > 1e-9) return { actions: keep.map((x) => ({ ...x, frequency: x.frequency > 0 ? (x.frequency * sum) / rest : x.frequency })), dropped, toPassive: null };
  const passive = keep.find((x) => /^(check|call)\b/i.test(x.action)) ?? keep.find((x) => /^fold\b/i.test(x.action)) ?? keep[0]!;
  return { actions: keep.map((x) => ({ ...x, frequency: x === passive ? sum : 0 })), dropped, toPassive: passive.action };
}

export const DROP_NOTE_TAG = "SHORT ALL-IN DROPPED:";

/** The note an answer with a dropped short all-in carries (always — it changed the mix, whatever the pick). */
export function dropNote(e: PressEntry, toPassive: string | null): string {
  return `${DROP_NOTE_TAG} ${e.action} cannot be played at the table (minimum ${e.verb} ${fmt(e.minRaiseTo)}): dropped from the mix ` +
    `(its share ${fmt(e.share ?? 0)}%) and the pick re-rolled${toPassive ? ` — it was the whole mix, so ${toPassive} takes it` : ""} — ${e.why.replaceAll(" · ", "; ")}`;
}

export const PRESS_NOTE_TAG = "SHOVE SIZED TO THE TREE:";

/** The note that opens an answer whose PICK is a sized all-in (one segment — no " · " inside). */
export function pressNote(e: PressEntry): string {
  return `${PRESS_NOTE_TAG} pressed as a ${e.verb} to ${fmt(e.amount ?? e.treeAmount)}bb, not hero's ${fmt(e.heroAllIn)}bb — ${e.why.replaceAll(" · ", "; ")}`;
}

/** The answer's warning with the press note in front when the pick is a pressed all-in, and without it otherwise (the
 *  poller re-rolls the pick; fastSolve's own pick may have added it). */
export function withPressNote(warning: string | null | undefined, press: readonly PressEntry[] | null | undefined, pick: string | null | undefined): string | null {
  const segs = String(warning ?? "").split(" · ").filter((s) => s && !s.startsWith(PRESS_NOTE_TAG));
  const e = pressForPick(press, pick);
  const out = [...(e ? [pressNote(e)] : []), ...segs].join(" · ");
  return out || null;
}

/** The chain-path reasons an answer carrying press entries gets (by-design: the departure is deliberate), one per kind. */
export function pressReasons(press: readonly PressEntry[], street: string): PathReason[] {
  const out: PathReason[] = [];
  const sized = press.find((e) => e.kind === "raise-to");
  if (sized) out.push({ v: "by-design", code: "postflop:allin-sized-to-tree",
    text: `${street}: if ${sized.action}: ${sized.verb} to ${fmt(sized.amount ?? sized.treeAmount)}, not hero's ${fmt(sized.heroAllIn)}` +
      `${sized.plan ? ` (${sized.plan})` : ""}, ${sized.outside.map((v) => v.pos).join("/")} outside it and deeper` });
  const dropped = press.find((e) => e.kind === "dropped");
  if (dropped) out.push({ v: "by-design", code: "postflop:short-allin-dropped",
    text: `${street}: ${dropped.action} dropped from the mix (share ${fmt(dropped.share ?? 0)}%) — under the table's minimum ${dropped.verb} ` +
      `${fmt(dropped.minRaiseTo)}, hero's whole stack ${fmt(dropped.heroAllIn)}${dropped.plan ? ` (${dropped.plan})` : ""}` });
  return out;
}
