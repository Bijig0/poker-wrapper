/**
 * THE REDUCED TREE — flop-entering ranges for a preflop line no tree of ours holds (2026-10-01, Brady: "I think this
 * is one of those issues that was just rare and I decided to put off till we faced it"; "I want this as well" — the
 * three-player version).
 *
 * Hand 4921846667: UTG limps, hero over-limps 77 (the limp chart's answer), the CO isolates, the BB and UTG call, hero
 * limp-reraises (the limp chart refused that node as untrained — it is reached 1 in 25,000,000 hands — so the GTO
 * Wizard AI tree answered, on a line FITTED to its one-limper cap: UTG read as folded), UTG calls and leads the flop.
 * The flop takes its ranges from the piece that answered last; that tree has no UTG in the pot; nothing fell back; no
 * answer, a timeout, a sit-out, and Ignition removed hero from the table.
 *
 * Every such spot still has one thing a tree CAN hold: the last raise, and each player who met it. So:
 *
 *   THE RAISER's range is what he held before the raise, narrowed by how the exact tree plays that raise from his seat
 *   (services/gtowAiPreflop raiseFilter — the union of its raise sizes, read on the line fitted for HIS actions).
 *
 *   EACH CALLER's range is what he held before the raise, less the hands that fold to it — read on a heads-up tree of
 *   him and the raiser in which THE RAISE IS A FORCED BET: the raiser posts it as his blind, the caller posts the
 *   chips he already had in as his, everything else in the pot is dead money, and the stacks are the stacks as dealt.
 *   The caller's fold / call / re-raise is then the tree's first decision — trained by construction — at exactly the
 *   price and into exactly the pot he faced. Seated by POSTFLOP order: whoever acts first after the flop is the tree's
 *   BB. Any number of callers: one tree each (earlier callers' chips are dead money in a later caller's tree).
 *
 * WHY THE RAISE IS NOT A DECISION IN THE TREE (measured 2026-10-01 on this hand, the first build of this piece): with
 * the raise offered as an action the solver never takes it — raising into dead money with nobody's bet to answer, it
 * limps 73.2% and jams 26.8%, the raise 0.0% — so the caller's node behind it is as untrained as the chart node this
 * whole thing stands in for: it shoved 22 and every pair there (EV of the shove +10bb for 22 against KK/QQ/JJ/AK),
 * left UTG a "calling" range of 64s and Q2s, and the flop answer for 77 facing a 72% pot lead was CALL 85%. With the
 * raise forced and the caller read as "did not fold", the same decision is FOLD 99.99%.
 *
 * WHY "DID NOT FOLD", NOT "CALLED" (probed, scripts/_probeForcedRaise.ts): at these prices the solver hardly ever
 * just calls — it re-raises all in or folds (call 25% with the raiser in position, 0% out of it). The player at the
 * table called. Which of the continuing hands a real player shoves and which he calls is not something the solver's
 * mix says about him — and one who limped in and flatted the whole way has shown he calls — so his range is every
 * hand that continues.
 *
 * What it does NOT model, said in the answer's note: the folded players' cards; the calls between a player's entry
 * and the last raise (UTG's call of the iso) where no source gives his range there; the other callers when one caller
 * is read (their chips are in his pot, their ranges are not); a limper's range is the pool's, not this player's.
 *
 * This file is the pure half: the plan and the read of a solved tree. The solves, the starting ranges and the wiring
 * are services/gtowAiPreflop.ts (reducedArrivalRanges).
 */
import type { ParsedAction, ParsedHand } from "../../feed/parsePanelFeed/parsePanelFeed";
import { allInCalls } from "../../feed/buildSolutionUrl/buildSolutionUrl";
import { dealtSeats } from "../dealtSeats/dealtSeats";
import { COMBOS, toClassWeights } from "../comboIndex/comboIndex";

/** First to act after the flop first. */
const POSTFLOP = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];
/** A seat with nothing in yet still needs a blind to sit in the tree. */
const MIN_POST = 0.01;

export interface ReducedSeat {
  /** the table's seat id and position name (upper case) */
  seat: number;
  pos: string;
  /** every chip it put in preflop (bb), and what it already had in when the last raise was made */
  putIn: number;
  prior: number;
}
export interface ReducedCaller extends ReducedSeat {
  /** the raiser acts after this caller on the flop: the tree's SB (the button) is the raiser, its BB the caller */
  raiserInPosition: boolean;
  /** the tree's seats and what each posts: the raiser the raise, the caller the chips he already had in */
  tree: { raiser: "SB" | "BB"; caller: "SB" | "BB"; raiserPost: number; callerPost: number };
  /** chips in the pot when he met the raise that neither he nor the raiser put there */
  deadBb: number;
  /** what the call cost him, and the pot he called into (the raise, his chips, the dead money) */
  toCall: number;
  potBefore: number;
}
export interface ReducedPlan {
  ok: true;
  /** every seat that sees the flop, in postflop order (table position names) */
  live: string[];
  raiser: ReducedSeat;
  raiseTo: number;
  /** in the order they sit after the flop */
  callers: ReducedCaller[];
  /** index into hand.actions of the last raise — a seat's earlier actions are what its starting range must cover */
  raiseIndex: number;
  potBb: number;
}

const isRaise = (a: ParsedAction, allInCallSet: Set<ParsedAction>) =>
  a.type === "raise" || a.type === "bet" || (a.type === "all-in" && !allInCallSet.has(a));
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Who met the last raise and at what price — or why the hand has no reduced tree. `heroPos`: hero's position name when
 * the positions map does not carry it.
 */
export function planReducedArrival(hand: ParsedHand, heroPos: string | null): ReducedPlan | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  const seatOf = (a: ParsedAction) => (a.hero ? hand.heroSeatId : a.seatId);
  const dealt = dealtSeats(hand, heroPos);
  const posOf = (seat: number): string | null => {
    const p = seat === hand.heroSeatId ? (heroPos ?? hand.positions?.[seat] ?? dealt.get(seat)) : (hand.positions?.[seat] ?? dealt.get(seat));
    return p ? String(p).toUpperCase() : null;
  };
  const calls = allInCalls(hand.actions);
  let raiseIndex = -1;
  hand.actions.forEach((a, i) => { if (a.street === "preflop" && isRaise(a, calls)) raiseIndex = i; });
  if (raiseIndex < 0) return no("nobody raised preflop — a limped pot has no last raise to reduce to");
  const raise = hand.actions[raiseIndex]!;
  const raiseTo = Number(raise.amount ?? 0);
  if (!(raiseTo > 1)) return no("the last raise carries no size");

  // each seat's chips in the pot after the first `upto` actions: a post / raise / all-in is the seat's total, a call
  // adds (gtowAiPreflop.preflopPutIn)
  const putAt = (upto: number): Map<number, number> => {
    const m = new Map<number, number>();
    for (const a of hand.actions.slice(0, upto)) {
      if (a.street !== "preflop") continue;
      const amt = Number(a.amount ?? 0);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      const s = seatOf(a);
      if (a.type === "call") m.set(s, (m.get(s) ?? 0) + amt);
      else if (a.type === "post-sb" || a.type === "post-bb" || a.type === "raise" || a.type === "bet" || a.type === "all-in") m.set(s, Math.max(m.get(s) ?? 0, amt));
    }
    return m;
  };
  const sum = (m: Map<number, number>) => [...m.values()].reduce((x, y) => x + y, 0);
  const put = putAt(hand.actions.length);
  const prior = putAt(raiseIndex);
  const potBb = sum(put);

  const pre = hand.actions.filter((a) => a.street === "preflop");
  const folded = new Set(pre.filter((a) => a.type === "fold").map(seatOf));
  const liveSeats = [...dealt.keys()].filter((s) => !folded.has(s) && posOf(s) != null && POSTFLOP.includes(posOf(s)!));
  // a seat that never put a chip in and never folded was not in the hand (a label with no action behind a raise)
  const inPot = liveSeats.filter((s) => (put.get(s) ?? 0) > 0);
  const aggSeat = seatOf(raise);
  if (!inPot.includes(aggSeat)) return no("the last raiser is not among the seats that reach the flop");
  if (inPot.length < 2) return no(`${inPot.length} player reaches the flop`);
  const byPostflop = (a: number, b: number) => POSTFLOP.indexOf(posOf(a)!) - POSTFLOP.indexOf(posOf(b)!);
  const live = inPot.slice().sort(byPostflop);
  if (new Set(live.map((s) => posOf(s))).size !== live.length) return no("two live seats carry the same position name");

  const seatRec = (s: number): ReducedSeat => ({ seat: s, pos: posOf(s)!, putIn: r2(put.get(s) ?? 0), prior: r2(prior.get(s) ?? 0) });
  const callers: ReducedCaller[] = live.filter((s) => s !== aggSeat).map((s) => {
    // the pot as HE met the raise: everything in before his own answer to it (an earlier caller's chips included)
    let answerIdx = -1;
    hand.actions.forEach((a, i) => { if (i > raiseIndex && a.street === "preflop" && seatOf(a) === s && answerIdx < 0) answerIdx = i; });
    const before = answerIdx >= 0 ? putAt(answerIdx) : putAt(raiseIndex + 1);
    const mine = before.get(s) ?? 0;
    const potBefore = sum(before);
    const raiserInPosition = byPostflop(aggSeat, s) > 0;
    return {
      ...seatRec(s), prior: r2(mine), raiserInPosition,
      tree: { raiser: raiserInPosition ? "SB" : "BB", caller: raiserInPosition ? "BB" : "SB", raiserPost: r2(raiseTo), callerPost: Math.max(MIN_POST, r2(mine)) },
      deadBb: Math.max(0, r2(potBefore - raiseTo - mine)),
      toCall: r2(Math.max(0, Math.min(raiseTo, put.get(s) ?? raiseTo) - mine)),
      potBefore: r2(potBefore),
    };
  });
  return { ok: true, live: live.map((s) => posOf(s)!), raiser: seatRec(aggSeat), raiseTo: r2(raiseTo), callers, raiseIndex, potBb: r2(potBb) };
}

/** The reduced hand one caller's tree is shaped from (the stacks, the rake): him and the raiser on the heads-up set,
 *  the two posts as its blinds. The raiser stands in as "hero" when hero is neither. */
export function forcedHandOf(hand: ParsedHand, plan: ReducedPlan, c: ReducedCaller): ParsedHand {
  const seatOfTree = (t: "SB" | "BB") => (c.tree.raiser === t ? plan.raiser.seat : c.seat);
  const postOfTree = (t: "SB" | "BB") => (c.tree.raiser === t ? c.tree.raiserPost : c.tree.callerPost);
  const heroSeatId = hand.heroSeatId === c.seat || hand.heroSeatId === plan.raiser.seat ? hand.heroSeatId : plan.raiser.seat;
  const act = (seat: number, type: string, amount: number): ParsedAction =>
    ({ seatId: seat, hero: seat === heroSeatId, type, street: "preflop", amount } as ParsedAction);
  const positions: Record<number, string> = { [seatOfTree("SB")]: "SB", [seatOfTree("BB")]: "BB" };
  const stacks: Record<number, number> = {};
  for (const s of [c.seat, plan.raiser.seat]) { const v = hand.stacks?.[s]; if (v != null) stacks[s] = v; }
  return {
    ...hand, heroSeatId, positions,
    actions: [act(seatOfTree("SB"), "post-sb", postOfTree("SB")), act(seatOfTree("BB"), "post-bb", postOfTree("BB"))],
    liveSeats: [seatOfTree("SB"), seatOfTree("BB")], stacks, committed: { [c.seat]: 0, [plan.raiser.seat]: 0 }, board: [], street: "preflop",
    currentNode: { ...hand.currentNode, street: "preflop", toActIsHero: false },
  } as ParsedHand;
}

/** class → weight (0..1) as the 1,326 per-combo weights a tree's `range` takes; null in → null out (the full range). */
export function classesToCombos(cls: Record<string, number> | null | undefined): number[] | null {
  if (!cls) return null;
  const out = COMBOS.map((c) => { const w = Number(cls[c.cls] ?? 0); return Number.isFinite(w) && w > 0 ? Math.min(1, w) : 0; });
  return out.some((w) => w > 0) ? out : null;
}

/** A range scaled so its heaviest class is 1 — a starting range is a COMPOSITION (the pool limps AQs 25%, 72o 0.5%);
 *  left at its raw size the tree would treat the whole seat as almost never there. */
export function normalised(cls: Record<string, number>): Record<string, number> {
  const max = Math.max(0, ...Object.values(cls).map((w) => (Number.isFinite(w) ? w : 0)));
  if (!(max > 0)) return {};
  const out: Record<string, number> = {};
  for (const [k, w] of Object.entries(cls)) if (w > 0) out[k] = Math.round((w / max) * 1e4) / 1e4;
  return out;
}

/** 1,326 weights scaled so the heaviest is 1; null when nothing is left. */
export function normalisedCombos(w: readonly number[]): number[] | null {
  const max = Math.max(0, ...w);
  return max > 1e-9 ? w.map((x) => Math.round((Math.max(0, x) / max) * 1e4) / 1e4) : null;
}

const CLASS_COMBOS: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const c of COMBOS) out[c.cls] = (out[c.cls] ?? 0) + 1;
  return out;
})();

/** 1,326 weights as class → fraction of the class (the chart walk's shape); classes at zero are left out. */
export function combosToClasses(w: readonly number[]): Record<string, number> {
  const cw = toClassWeights(w);
  const rec: Record<string, number> = {};
  for (const [cls, v] of Object.entries(cw)) if (v.weight > 0) rec[cls] = Math.min(1, v.weight / (CLASS_COMBOS[cls] ?? v.combos));
  return rec;
}

type NodeGet = (line: string) => Promise<{ data: any } | { error: string }>;
const codeOf = (a: any) => String(a?.action?.code ?? "");
const typeOf = (a: any) => String(a?.action?.type ?? a?.action?.display_name ?? "").toUpperCase();
const isFold = (a: any) => /^F/i.test(codeOf(a)) || typeOf(a).startsWith("FOLD");
const isPass = (a: any) => /^[XC]$/i.test(codeOf(a)) || typeOf(a).startsWith("CHECK") || typeOf(a).startsWith("CALL");

export interface CallerRead {
  ok: true;
  /** per combo, the share that does NOT fold to the raise */
  stays: number[];
  /** the node's own totals over the range it was solved with, for the note and the trace (percent) */
  fold: number; call: number; raise: number;
  /** the tree line of the caller's node ("" = the root) */
  line: string;
}

/**
 * Read a caller's answer to the forced raise on his solved tree. The raiser out of position posted the tree's BB: the
 * caller (its SB) acts at the root. The raiser in position posted its SB and acts first — he has only the check
 * (and, when the tree adds one, an all-in we do not walk) — and the caller's node is behind that check.
 */
export async function readCaller(c: ReducedCaller, get: NodeGet): Promise<CallerRead | { ok: false; reason: string }> {
  const no = (reason: string) => ({ ok: false as const, reason: `reduced tree (${c.pos}): ${reason}` });
  const actorOf = (j: any): string | null => j?.game?.players?.find((p: any) => p.is_hero)?.position ?? null;
  let line = "";
  let node = await get(line);
  if ("error" in node) return no(`the root — ${node.error}`);
  if (c.raiserInPosition) {
    if (actorOf(node.data) !== "SB") return no(`the tree has ${actorOf(node.data) ?? "nobody"} first to act, not the raiser's seat`);
    const pass = (node.data?.action_solutions ?? []).find(isPass);
    if (!pass) return no(`the raiser has no check at the root (offered: ${(node.data?.action_solutions ?? []).map(codeOf).join(", ") || "nothing"})`);
    line = codeOf(pass);
    node = await get(line);
    if ("error" in node) return no(`the node behind the raiser's check — ${node.error}`);
  }
  if (actorOf(node.data) !== c.tree.caller) return no(`the tree has ${actorOf(node.data) ?? "nobody"} to act at '${line || "root"}', not the caller's seat (${c.tree.caller})`);
  const sols: any[] = node.data?.action_solutions ?? [];
  const folds = sols.filter(isFold);
  if (!sols.length) return no(`no actions at '${line || "root"}'`);
  const stays = new Array<number>(1326);
  for (let i = 0; i < 1326; i++) {
    let f = 0;
    for (const a of folds) f += Number(a.strategy?.[i] ?? 0);
    stays[i] = Math.min(1, Math.max(0, 1 - f));
  }
  const pct = (pick: (a: any) => boolean) => Math.round(1000 * sols.filter(pick).reduce((x, a) => x + Number(a.total_frequency ?? 0), 0)) / 10;
  return { ok: true, stays, line, fold: pct(isFold), call: pct((a) => !isFold(a) && isPass(a)), raise: pct((a) => !isFold(a) && !isPass(a)) };
}
