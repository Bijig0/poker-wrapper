/**
 * STRESS-500 POKER-SENSE CHECKS (2026-10-07, Brady's hand pass over the 243 run hands, ported from lint_stress.py +
 * lint2.py): decision-level flags beyond the harness's own grades, each one a thing a poker player would stop at. They
 * never change a decision's grade — they point a reviewer at it.
 *
 *   hero-hand-absent-script  hero's class holds < 0.02 of itself in HIS OWN range at his postflop node (in every tree
 *                            that answered it — the reference read one tree per street), and an EARLIER
 *                            hero action of the hand is one our served mix gave < 1% (the script played off our pick)
 *   hero-hand-absent-real    the same with every earlier hero action at 1%+ — hero's own 2-28% actions compounding
 *                            (brief_D-003 turn, pf_4b5b-009 flop, pf_shove-005 turn, po_4way-036 river in the 243)
 *   collapses-disagree       2+ trees (collapses / plans) for one decision whose top hero actions are of different KINDS
 *                            (fold / check / call / bet-raise / all-in), each at 60%+
 *   served-minority          ... and the served pick's kind is not the kind a strict majority of the trees pick
 *   fold-strong              hero folds 50%+ facing a bet holding a real two pair (both hole cards pair the board), a
 *                            set, trips (a hole card to a paired board), a straight on a board with no pair and no
 *                            4-flush, or a flush or better; NOT a pocket pair under a paired board, board trips, a
 *                            straight on a paired or 4-flush board
 *   check-monster-river      river, checked to hero, a full house or better checks 90%+
 *   deep-vs-rung             a 6-max chart preflop answer whose chart depth is under the hand's effective stack / 1.35
 *                            (effective = min(hero's start stack, the deepest other dealt stack)) — informational
 */
import { CLASSES } from "./views";

// ── 7-card evaluator (category only — enough to tell a made hand from a draw) ───────────────────────────────────────

const RANK_VALUE: Record<string, number> = Object.fromEntries([..."23456789TJQKA"].map((r, i) => [r, i + 2]));
export const rankOf = (card: string): number => RANK_VALUE[card[0]!.toUpperCase()] ?? 0;
const suitOf = (card: string): string => card[1]!.toLowerCase();

export const CATEGORY = ["high card", "pair", "two pair", "trips", "straight", "flush", "full house", "quads", "straight flush"] as const;
export type CategoryName = (typeof CATEGORY)[number];

/** the top card of the highest five-card run in these ranks (the wheel counts, ace low), null without one */
export function straightHigh(ranks: number[]): number | null {
  const s = new Set(ranks);
  if (s.has(14)) s.add(1);
  for (let hi = 14; hi >= 5; hi--) {
    let ok = true;
    for (let r = hi; r > hi - 5; r--) if (!s.has(r)) { ok = false; break; }
    if (ok) return hi;
  }
  return null;
}

/** the best poker hand category among 5-7 cards ("As", "Td", …): 0 high card … 8 straight flush */
export function evaluate(cards: string[]): { cat: number; name: CategoryName } {
  const ranks = cards.map(rankOf);
  const count = new Map<number, number>();
  for (const r of ranks) count.set(r, (count.get(r) ?? 0) + 1);
  const bySuit = new Map<string, number[]>();
  for (const c of cards) { const s = suitOf(c); bySuit.set(s, [...(bySuit.get(s) ?? []), rankOf(c)]); }
  const flushRanks = [...bySuit.values()].find((rs) => rs.length >= 5) ?? null;
  const groups = [...count.values()].sort((a, b) => b - a);
  const at = (cat: number) => ({ cat, name: CATEGORY[cat]! });
  if (flushRanks && straightHigh(flushRanks) != null) return at(8);
  if (groups[0] === 4) return at(7);
  if (groups[0] === 3 && (groups[1] ?? 0) >= 2) return at(6);
  if (flushRanks) return at(5);
  if (straightHigh(ranks) != null) return at(4);
  if (groups[0] === 3) return at(3);
  if (groups[0] === 2 && groups[1] === 2) return at(2);
  if (groups[0] === 2) return at(1);
  return at(0);
}

/**
 * A made hand hero should almost never fold to one bet, or null (lint2.made): a REAL two pair (both hole cards pair the
 * board — not a pocket pair beside a board pair), a set, trips (a hole card to a paired board — not board trips), a
 * straight on a board with no pair and no 4-flush, a flush or better.
 */
export function strongMade(hole: string[], board: string[]): string | null {
  if (hole.length !== 2 || board.length < 3) return null;
  const hr = hole.map(rankOf);
  const bc = new Map<number, number>();
  for (const c of board) bc.set(rankOf(c), (bc.get(rankOf(c)) ?? 0) + 1);
  const { cat, name } = evaluate([...hole, ...board]);
  if (cat === 2) return hr[0] !== hr[1] && hr.every((r) => bc.has(r)) ? "two pair" : null;
  if (cat === 3) {
    if (hr[0] === hr[1] && bc.has(hr[0]!)) return "set";
    return hr.some((r) => bc.get(r) === 2) ? "trips" : null;
  }
  if (cat === 4) {
    const suits = new Map<string, number>();
    for (const c of board) suits.set(suitOf(c), (suits.get(suitOf(c)) ?? 0) + 1);
    if ([...suits.values()].some((n) => n >= 4) || [...bc.values()].some((n) => n >= 2)) return null;
    return "straight";
  }
  return cat >= 5 ? name : null;
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** the 169-grid class of two hole cards ("AKs", "T9o", "88") */
export function classOf(hole: string[]): string | null {
  if (hole.length !== 2) return null;
  let [a, b] = hole as [string, string];
  if (rankOf(a) < rankOf(b)) [a, b] = [b, a];
  if (a[0]!.toUpperCase() === b[0]!.toUpperCase()) return a[0]!.toUpperCase() + b[0]!.toUpperCase();
  return a[0]!.toUpperCase() + b[0]!.toUpperCase() + (suitOf(a) === suitOf(b) ? "s" : "o");
}

export type ActionKind = "fold" | "check" | "call" | "bet-raise" | "all-in" | "?";
/** an action label's kind: "BET 9.1", "Raise 42", "All-in 94.2", "ALLIN 69.75", "Check" … */
export function actionKind(label: string | null | undefined): ActionKind {
  const l = String(label ?? "").trim().toUpperCase();
  if (l.startsWith("FOLD")) return "fold";
  if (l.startsWith("CHECK")) return "check";
  if (l.startsWith("CALL")) return "call";
  if (/^(ALL|RAI\b)/.test(l)) return "all-in";
  if (l.startsWith("BET") || l.startsWith("RAISE")) return "bet-raise";
  return "?";
}
/** the scripted (table) action type's kind */
const TOOK_KIND: Record<string, ActionKind> = { fold: "fold", check: "check", call: "call", bet: "bet-raise", raise: "bet-raise", "all-in": "all-in" };
const AGGRESSIVE = new Set<ActionKind>(["bet-raise", "all-in"]);

const STREET_CARDS: Record<string, number> = { flop: 3, turn: 4, river: 5 };
const pct = (x: number): string => `${x >= 10 ? Math.round(x) : Math.round(x * 10) / 10}%`;

// ── the checks ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** a stored decision as the run wrote it (hands/<id>.json decisions[]) */
export interface LintDecision {
  index: number; street: string; ok: boolean; toCall?: number | null; pick?: string | null;
  actions?: { action: string; frequency: number }[] | null; took?: { type: string; amount?: number | null } | null;
  source?: string | null; gametype?: string | null;
}
export interface LintHand {
  positions: Record<string, string>; heroSeatId: number | string; heroCards: string[]; board?: string[] | null;
  startStacks?: Record<string, number> | null;
}
/** a node view (views.ts NodeView) — the fields the checks read */
export interface LintView { street: string; actor: string; ranges?: Record<string, number[] | null> | null; src?: string; heroMix?: { action: string; p: number }[] | null }
export interface LintResult {
  /** decision index → its new flags and one plain line per flag */
  flags: Map<number, string[]>;
  notes: Map<number, string[]>;
  /** decision index → every tree's hero mix, for decisions answered by 2+ trees */
  plans: Map<number, { src: string; mix: [string, number][]; top: string; p: number; kind: ActionKind }[]>;
}

/** the served mix as label kind → summed share (percent) */
const kindShares = (d: LintDecision): Map<ActionKind, number> => {
  const m = new Map<ActionKind, number>();
  for (const a of d.actions ?? []) { const k = actionKind(a.action); m.set(k, (m.get(k) ?? 0) + Number(a.frequency ?? 0)); }
  return m;
};

export function lintHand(hand: LintHand, decisions: LintDecision[], views: Record<string, LintView | undefined>,
  alts: Record<string, LintView[] | undefined> = {}): LintResult {
  const flags = new Map<number, string[]>(), notes = new Map<number, string[]>();
  const plans: LintResult["plans"] = new Map();
  const add = (i: number, f: string, note: string): void => {
    flags.set(i, [...(flags.get(i) ?? []), f]);
    notes.set(i, [...(notes.get(i) ?? []), `${f}: ${note}`]);
  };
  const hole = hand.heroCards ?? [];
  const board = hand.board ?? [];
  const heroPos = String(hand.positions[String(hand.heroSeatId)] ?? "").toUpperCase();
  const heroCls = classOf(hole);
  const heroK = heroCls ? CLASSES.indexOf(heroCls) : -1;
  const decs = [...decisions].sort((a, b) => a.index - b.index);
  const byIndex = new Map(decs.map((d) => [d.index, d]));

  // hero's actions the script played off our served mix (< 1% of it)
  const offPick: { i: number; took: string; share: number }[] = [];
  for (const d of decs) {
    const tk = TOOK_KIND[String(d.took?.type ?? "")];
    if (!tk || !(d.actions ?? []).length) continue;
    const ks = kindShares(d);
    const share = AGGRESSIVE.has(tk) ? (ks.get("bet-raise") ?? 0) + (ks.get("all-in") ?? 0) : (ks.get(tk) ?? 0);
    if (share < 1) offPick.push({ i: d.index, took: String(d.took?.type), share });
  }

  for (const d of decs) {
    if (!d.ok) continue;
    const ks = kindShares(d);
    const toCall = Number(d.toCall ?? 0);

    // 1. hero's own hand absent from his own range at his node — in EVERY tree that answered it (a blended answer's
    //    trees hold hero's range differently; one collapse alone thinning it is not the hand being absent)
    if (d.street !== "preflop" && heroK >= 0) {
      const ws = [views[String(d.index)], ...(alts[String(d.index)] ?? [])].flatMap((v) => {
        if (!v || String(v.actor).toUpperCase() !== heroPos) return [];
        const r = Object.entries(v.ranges ?? {}).find(([p]) => p.toUpperCase() === heroPos)?.[1];
        return r ? [Number(r[heroK] ?? 0)] : [];
      });
      if (ws.length && Math.max(...ws) < 0.02) {
        const earlier = offPick.filter((o) => o.i < d.index);
        const w = Math.max(...ws).toFixed(3) + (ws.length > 1 ? ` (the most of ${ws.length} trees)` : "");
        if (earlier.length) add(d.index, "hero-hand-absent-script", `${heroCls} at ${w} of itself in hero's own range — earlier the script played ${earlier.map((o) => `${o.took} (our mix ${pct(o.share)}, step ${o.i})`).join(", ")}`);
        else add(d.index, "hero-hand-absent-real", `${heroCls} at ${w} of itself in hero's own range, every earlier hero action at 1%+ of our mix — his own low-frequency actions compounding`);
      }
    }

    // 2. the trees of a blended answer disagree on hero's action
    if (d.street !== "preflop") {
      const vs = [views[String(d.index)], ...(alts[String(d.index)] ?? [])].filter((v): v is LintView => !!v && !!(v.heroMix ?? []).length);
      if (vs.length >= 2) {
        const ps = vs.map((v) => {
          const top = (v.heroMix ?? []).reduce((a, b) => (b.p > a.p ? b : a));
          return { src: String(v.src ?? ""), mix: (v.heroMix ?? []).filter((x) => x.p >= 0.5).map((x) => [x.action, x.p] as [string, number]), top: top.action, p: top.p, kind: actionKind(top.action) };
        });
        plans.set(d.index, ps);
        const firm = ps.filter((x) => x.p >= 60);
        const kinds = new Map<ActionKind, number>();
        for (const x of firm) kinds.set(x.kind, (kinds.get(x.kind) ?? 0) + 1);
        if (kinds.size >= 2) {
          const said = ps.map((x) => `${x.src.replace(/^tree /, "")}: ${x.top} ${pct(x.p)}`).join(" | ");
          add(d.index, "collapses-disagree", `${said} → served ${d.pick ?? "—"}`);
          const [majK, majN] = [...kinds].sort((a, b) => b[1] - a[1])[0]!;
          const served = actionKind(d.pick);
          if (majN > ps.length / 2 && served !== majK) add(d.index, "served-minority", `served ${d.pick} (${served}) while ${majN} of ${ps.length} trees pick ${majK} at 60%+`);
        }
      }
    }

    // 3-4. made hands postflop
    if (d.street in STREET_CARDS && hole.length === 2 && board.length >= STREET_CARDS[d.street]!) {
      const b = board.slice(0, STREET_CARDS[d.street]);
      const fold = ks.get("fold") ?? 0;
      if (toCall > 0 && fold >= 50) {
        const m = strongMade(hole, b);
        if (m) add(d.index, "fold-strong", `${m} with ${hole.join("")} on ${b.join("")} folds ${pct(fold)} to ${toCall}bb`);
      }
      if (d.street === "river" && toCall <= 0.01) {
        const { cat, name } = evaluate([...hole, ...b]);
        const chk = ks.get("check") ?? 0;
        if (cat >= 6 && chk >= 90) add(d.index, "check-monster-river", `${name} with ${hole.join("")} on ${b.join("")} checks ${pct(chk)}`);
      }
    }

    // 5. a chart answer far shallower than the stacks in play
    if (d.street === "preflop" && d.source === "hrc-6max-preflop") {
      const m = /_D(\d+)/.exec(String(d.gametype ?? ""));
      const ss = hand.startStacks ?? {};
      const heroStack = Number(ss[String(hand.heroSeatId)]);
      const others = Object.keys(hand.positions).filter((s) => s !== String(hand.heroSeatId)).map((s) => Number(ss[s])).filter((x) => Number.isFinite(x) && x > 0);
      if (m && Number.isFinite(heroStack) && heroStack > 0 && others.length) {
        const depth = Number(m[1]);
        const deepest = Math.max(...others);
        const eff = Math.min(heroStack, deepest);
        if (depth < eff / 1.35) add(d.index, "deep-vs-rung", `chart D${depth} (${d.gametype}) for an effective ${Math.round(eff * 10) / 10}bb (hero ${heroStack}, deepest other ${deepest}) — under ${Math.round((eff / 1.35) * 10) / 10}`);
      }
    }
  }
  return { flags, notes, plans };
}

/** the flags this module emits (the replayer's FLAG_INFO carries one sentence each) */
export const LINT_FLAGS = ["hero-hand-absent-script", "hero-hand-absent-real", "collapses-disagree", "served-minority", "fold-strong", "check-monster-river", "deep-vs-rung"] as const;
