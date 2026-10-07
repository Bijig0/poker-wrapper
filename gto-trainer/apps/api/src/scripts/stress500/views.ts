/**
 * STRESS-500 NODE VIEWS (2026-10-05): every seat's range and the actor's strategy at every node of a hand, in the
 * dashboard's own terms (dashboard.html's range looker / exact node: class → weight 0..1, the actor's per-class action
 * shares), computed from what the answers left behind — no extra solve:
 *   - PREFLOP from the hand's preflop pin: the chart it read (reconstructFlopRanges with onStep, as /preflop-path walks
 *     it) or the GTO Wizard AI tree it read, pool-locked trees included (walkArrivalRanges with onStep over the pinned
 *     solution — its nodes were read by the answer, so they come from the cache);
 *   - POSTFLOP from the stored chain traces (solves table): each street's entering ranges conditioned node by node on
 *     the strategy of the action taken (dashboard.ts expandTrace's replay), board-blocked combos left out.
 */
import { COMBOS } from "../../utils/comboIndex/comboIndex";

export const CLASSES: string[] = (() => {
  const R = "AKQJT98765432";
  const out: string[] = [];
  for (let r = 0; r < 13; r++) for (let c = 0; c < 13; c++) out.push(r === c ? R[r]! + R[c]! : r < c ? R[r]! + R[c]! + "s" : R[c]! + R[r]! + "o");
  return out;
})();
const CLASS_INDEX = new Map(CLASSES.map((c, i) => [c, i]));
/** combo index → class index (the grid's order) */
const COMBO_CLASS: number[] = COMBOS.map((c) => CLASS_INDEX.get(c.cls) ?? -1);
const CARD_INDEX = (c: string): number => {
  const r = "23456789TJQKA".indexOf(c[0]!), s = "cdhs".indexOf(c[1]!);
  return r < 0 || s < 0 ? -1 : r * 4 + s;
};
/** combo index → its two card indexes (rank*4+suit, the comboIndex order) */
const COMBO_CARDS: [number, number][] = COMBOS.map((c) => [CARD_INDEX(c.cards[0]!), CARD_INDEX(c.cards[1]!)] as [number, number]);

/** 1,326 weights → 169 class fractions (of the combos the board leaves), rounded to 3 decimals */
export function classOf1326(w: readonly number[], board: string[] = []): number[] {
  const blocked = new Set(board.map(CARD_INDEX).filter((x) => x >= 0));
  const sum = new Array(169).fill(0), n = new Array(169).fill(0);
  for (let i = 0; i < 1326; i++) {
    const k = COMBO_CLASS[i]!;
    if (k < 0) continue;
    const [a, b] = COMBO_CARDS[i]!;
    if (blocked.has(a) || blocked.has(b)) continue;
    n[k]++;
    sum[k] += Math.max(0, Math.min(1, Number(w[i] ?? 0)));
  }
  return sum.map((s, k) => (n[k] ? Math.round((s / n[k]) * 1000) / 1000 : 0));
}
/** the actor's per-class action shares, weighted by his range (1,326 strategies per action) */
export function classStrategy(range: readonly number[], strategies: readonly (readonly number[])[], board: string[] = []): number[][] {
  const blocked = new Set(board.map(CARD_INDEX).filter((x) => x >= 0));
  const tot = new Array(169).fill(0);
  const per = strategies.map(() => new Array(169).fill(0));
  for (let i = 0; i < 1326; i++) {
    const k = COMBO_CLASS[i]!;
    if (k < 0) continue;
    const [a, b] = COMBO_CARDS[i]!;
    if (blocked.has(a) || blocked.has(b)) continue;
    const w = Math.max(0, Number(range[i] ?? 0));
    if (w <= 0) continue;
    tot[k] += w;
    strategies.forEach((s, j) => { per[j]![k] += w * Math.max(0, Number(s[i] ?? 0)); });
  }
  return per.map((col) => col.map((x, k) => (tot[k] > 0 ? Math.round((x / tot[k]) * 1000) / 1000 : 0)));
}
/** class fractions (class → 0..1, missing = 0) → the grid's 169 array */
export function classArray(rec: Record<string, number> | null | undefined): number[] | null {
  if (rec == null) return null;
  return CLASSES.map((c) => Math.round(Math.max(0, Math.min(1, Number(rec[c] ?? 0))) * 1000) / 1000);
}
export const FULL_RANGE: number[] = new Array(169).fill(1);

/** One node of the replay: who acts, every seat's range before it, the actor's strategy, what he took. */
export interface NodeView {
  street: "preflop" | "flop" | "turn" | "river";
  /** the seat to act (table position name) */
  actor: string;
  /** the tree's path before this node */
  line: string;
  /** the actions offered (labels) and, when the node was read, the actor's per-class share of each (169 each) */
  actions: string[];
  strat: number[][] | null;
  /** each action's share of the actor's whole range (0..1) */
  totals: number[] | null;
  /** the label taken here */
  taken: string | null;
  /** every seat still in, range BEFORE this node: table position → 169 class fractions (null = any hand) */
  ranges: Record<string, number[] | null>;
  /** where these numbers come from (chart id / tree id / plan) */
  src: string;
  /** postflop: the pot at the node (bb) and hero's combo mix when hero acts */
  pot?: number;
  heroMix?: { action: string; p: number }[] | null;
  /** PER-COMBO DETAIL (2026-10-07, Brady: "AJhh same as AJcc" in thin nodes), POSTFLOP only, sparse and only where it
   *  is useful: the actor's own combos (entering weight, his split and EV per action) when his range is narrow, thin or
   *  hero's; the other seats' combo weights when theirs is narrow. Absent = class level only (the replayer says so).
   *  Not preflop: GTO Wizard's AI preflop nodes are identical for every combo of a class (300 cached nodes, 184k
   *  class x action checks: strategy and EV differ by exactly 0), so a preflop combo row only repeats its class. */
  cb?: ComboSet | null;
  cbr?: Record<string, ComboSet> | null;
}

// ── per-combo detail ─────────────────────────────────────────────────────────────────────────────────────────────

/** one combo of a range: its index in GTO Wizard's 1,326 order (utils/comboIndex), the hand ("AhJh", higher card
 *  first), the weight 0..1 and — at the actor's node — his share of each action (0..1) and its EV (bb) */
export interface ComboRow { i: number; hand: string; w: number; s?: number[]; ev?: number[] }
/** a seat's kept combos and the weight floor they were cut at (a legal combo absent from rows weighs under it) */
export interface ComboSet { floor: number; rows: ComboRow[] }
/** the actor's combos are kept when his range (board-dead removed) is at most this many combos, or thin, or hero's */
export const CB_ACTOR_MAX = 120;
/** another seat's combos are kept when his range is at most this many combos */
export const CB_OTHER_MAX = 80;
export const CB_THIN = 1.5;
/** a combo below this weight is left out: a small range (under CB_SMALL combos, thin ones included) keeps everything
 *  above the grid's own "in range" floor; a bigger one drops its dust under 1% of a combo (the size budget — the
 *  replayer lists them as "under 1%") */
export const CB_MIN_W = 0.0005;
export const CB_MIN_W_WIDE = 0.01;
export const CB_SMALL = 10;
const blockedOf = (board: string[]): Set<number> => new Set(board.map(CARD_INDEX).filter((x) => x >= 0));
/** combos in a 1,326 range, the board's dead cards removed */
export function liveCombos(w: readonly number[], board: string[] = []): number {
  const blocked = blockedOf(board);
  let n = 0;
  for (let i = 0; i < 1326; i++) {
    const [a, b] = COMBO_CARDS[i]!;
    if (blocked.has(a) || blocked.has(b)) continue;
    n += Math.max(0, Math.min(1, Number(w[i] ?? 0)));
  }
  return n;
}
/** the sparse rows of a 1,326 range (weight > CB_MIN_W, board-dead left out); with strategies / evs, each combo's own */
export function comboRowsOf(w: readonly number[], board: string[] = [], strategies?: readonly (readonly number[])[] | null, evs?: readonly (readonly number[])[] | null, floor = CB_MIN_W): ComboRow[] {
  const blocked = blockedOf(board);
  const out: ComboRow[] = [];
  for (let i = 0; i < 1326; i++) {
    const x = Math.max(0, Math.min(1, Number(w[i] ?? 0)));
    if (!(x > floor)) continue;
    const [a, b] = COMBO_CARDS[i]!;
    if (blocked.has(a) || blocked.has(b)) continue;
    const row: ComboRow = { i, hand: COMBOS[i]!.hand, w: Math.round(x * 10000) / 10000 };
    if (strategies) row.s = strategies.map((s) => Math.round(Math.max(0, Math.min(1, Number(s[i] ?? 0))) * 10000) / 10000);
    if (evs && evs.some((e) => Array.isArray(e) && e.length === 1326)) row.ev = evs.map((e) => Math.round(Number(e?.[i] ?? 0) * 100) / 100);
    out.push(row);
  }
  return out;
}
/**
 * The node's per-combo detail by the size rule: the actor's combos (weight, split, EV) when his entering range is at
 * most CB_ACTOR_MAX combos (a thin one under CB_THIN included) or the node is hero's; every other seat's combo weights when his range is at
 * most CB_OTHER_MAX combos. Nothing kept → nulls (the view stays class level).
 */
export function comboDetail(seats: { pos: string; w: readonly number[] }[], actorPos: string, isHero: boolean, board: string[],
  strategies: readonly (readonly number[])[], evs: readonly (readonly number[])[] | null): { cb: ComboSet | null; cbr: Record<string, ComboSet> | null } {
  let cb: ComboSet | null = null;
  const cbr: Record<string, ComboSet> = {};
  for (const s of seats) {
    const n = liveCombos(s.w, board);
    const floor = n < CB_SMALL ? CB_MIN_W : CB_MIN_W_WIDE;
    if (s.pos === actorPos) {
      if (isHero || n <= CB_ACTOR_MAX) cb = { floor, rows: comboRowsOf(s.w, board, strategies, evs, floor) };
    } else if (n <= CB_OTHER_MAX) cbr[s.pos] = { floor, rows: comboRowsOf(s.w, board, null, null, floor) };
  }
  return { cb, cbr: Object.keys(cbr).length ? cbr : null };
}

// ── preflop ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** reconstructFlopRanges' onStep record (utils/reconstructFlopRanges WalkStep) */
interface ChartStep { line: string; node: { actions: { action: string; token: string | null }[]; cells: { hand: string; actions: Record<string, number> }[] }; pos: string; token: string; rawToken: string; label: string; labels: string[]; rangeIn: Record<string, number> | null; rangeOut: Record<string, number> | null }

export function chartStepsToViews(steps: ChartStep[], seats: string[], chartId: string): NodeView[] {
  const cur: Record<string, number[] | null> = Object.fromEntries(seats.map((p) => [p, null]));
  const gone = new Set<string>();
  const out: NodeView[] = [];
  for (const s of steps) {
    const actions = s.node.actions.map((a) => a.action);
    const strat = actions.map(() => new Array(169).fill(0));
    for (const cell of s.node.cells) {
      const k = CLASS_INDEX.get(cell.hand);
      if (k == null) continue;
      actions.forEach((a, j) => { strat[j]![k] = Math.round((Number(cell.actions[a] ?? 0) / 100) * 1000) / 1000; });
    }
    const actorRange = classArray(s.rangeIn) ?? FULL_RANGE;
    const totals = strat.map((col) => {
      let num = 0, den = 0;
      for (let k = 0; k < 169; k++) { const n = CLASSES[k]!.length === 2 ? 6 : CLASSES[k]!.endsWith("s") ? 4 : 12; num += col[k]! * actorRange[k]! * n; den += actorRange[k]! * n; }
      return den > 0 ? Math.round((num / den) * 1000) / 1000 : 0;
    });
    out.push({
      street: "preflop", actor: s.pos, line: s.line, actions, strat, totals, taken: s.label,
      ranges: Object.fromEntries(Object.entries(cur).filter(([p]) => !gone.has(p))), src: chartId,
    });
    if (s.rangeOut == null) { gone.add(s.pos); delete cur[s.pos]; }
    else cur[s.pos] = classArray(s.rangeOut);
  }
  return out;
}

/** walkArrivalRanges' onStep record (gtowAiPreflop AiWalkStep) */
interface AiStep { line: string; token: string; actor: string; node: any; chosen: any[]; taken: any; before: number[]; after: number[] }

export function aiStepsToViews(steps: AiStep[], apiToTable: Record<string, string>, positions: string[], treeId: string): NodeView[] {
  const cur: Record<string, number[]> = Object.fromEntries(positions.map((p) => [p, new Array(1326).fill(1)]));
  const gone = new Set<string>();
  const out: NodeView[] = [];
  for (const s of steps) {
    const sols: any[] = s.node?.action_solutions ?? [];
    const actions = sols.map((a) => labelOfAi(a.action));
    const strat = classStrategy(s.before, sols.map((a) => a.strategy ?? []));
    const totals = sols.map((a) => Math.round(Number(a.total_frequency ?? 0) * 1000) / 1000);
    const ranges: Record<string, number[] | null> = {};
    for (const p of positions) if (!gone.has(p)) ranges[apiToTable[p] ?? p] = classOf1326(cur[p]!);
    const takenCode = String(s.taken?.action?.code ?? "");
    out.push({
      street: "preflop", actor: apiToTable[s.actor] ?? s.actor, line: s.line, actions, strat, totals,
      taken: takenCode ? labelOfAi(s.taken.action) : s.token, ranges, src: treeId,
    });
    cur[s.actor] = s.after.slice();
    if (s.token === "F") gone.add(s.actor);
  }
  return out;
}
/** a GTO Wizard action as the dashboard names it (gtowAiPreflop.labelOf) */
export function labelOfAi(action: any): string {
  const type = String(action?.type ?? action?.display_name ?? "").toUpperCase();
  const bb = Number(action?.betsize);
  if (action?.allin === true) return "All-in";
  if (type.startsWith("FOLD")) return "Fold";
  if (type.startsWith("CHECK")) return "Check";
  if (type.startsWith("CALL")) return "Call";
  if (type.startsWith("RAISE") || type.startsWith("BET")) return Number.isFinite(bb) && bb > 0 ? `Raise ${Math.round(bb * 100) / 100}` : "Raise";
  return String(action?.code ?? type ?? "?");
}

// ── postflop ─────────────────────────────────────────────────────────────────────────────────────────────────────

const STREET_NAME: Record<string, NodeView["street"]> = { FLOP: "flop", TURN: "turn", RIVER: "river" };

/** a trace node's action with its size: "Bet 8 (33%)", "Raise 18.2", "All-in 94.2", "Check" (the trace's own name is
 *  "BET" for every bet size, so two sizes would read the same) */
export function labelOfTrace(a: any, pot?: number | null): string {
  const name = String(a?.name ?? a?.code ?? "?").toUpperCase();
  const size = Number(a?.betsize);
  const sz = Number.isFinite(size) && size > 0 ? String(Math.round(size * 100) / 100) : "";
  if (name.startsWith("FOLD")) return "Fold";
  if (name.startsWith("CHECK")) return "Check";
  if (name.startsWith("CALL")) return "Call";
  if (name.startsWith("ALLIN") || name.startsWith("ALL-IN") || a?.code === "RAI") return sz ? `All-in ${sz}` : "All-in";
  if (name.startsWith("BET")) return sz ? `Bet ${sz}${pot && pot > 0 ? ` (${Math.round((100 * size) / pot)}%)` : ""}` : "Bet";
  if (name.startsWith("RAISE")) return sz ? `Raise ${sz}` : "Raise";
  return String(a?.code ?? name);
}

/** the seats of a trace street and their entering 1,326 ranges (dashboard.ts traceSeats) */
export function traceSeats(spec: any, st: any): { players: string[]; ranges: number[][] } {
  if (Array.isArray(st?.players) && Array.isArray(st?.rangesIn) && st.rangesIn.length === st.players.length) {
    return { players: st.players.slice(), ranges: st.rangesIn.map((r: number[]) => r.slice()) };
  }
  const players = [spec.oopPos, ...(spec.midPos ? [spec.midPos] : []), spec.ipPos].filter(Boolean);
  const ranges = [st?.oopIn ?? spec.oopRange ?? [], ...(spec.midPos ? [st?.midIn ?? spec.midRange ?? []] : []), st?.ipIn ?? spec.ipRange ?? []];
  return { players, ranges: ranges.map((r: number[]) => (r ?? []).slice()) };
}

/** every node of a stored chain trace as NodeViews (ranges before each node, conditioned on what was taken) */
export function traceToViews(trace: any, src: string): NodeView[] {
  const spec = trace?.spec ?? {};
  const heroIdx: number | null = spec.heroComboIdx ?? null;
  const cur = new Map<number, { players: string[]; ranges: number[][] }>();
  const out: NodeView[] = [];
  for (const n of trace?.nodes ?? []) {
    const st = (trace.streets ?? []).find((x: any) => x.si === n.si);
    if (!cur.has(n.si)) cur.set(n.si, traceSeats(spec, st));
    const r = cur.get(n.si)!;
    const board: string[] = String(n.board ?? st?.board ?? "").match(/../g) ?? [];
    const actorRange = r.ranges[n.actor] ?? [];
    const strategies: number[][] = (n.actions ?? []).map((a: any) => a.strategy ?? []);
    const ranges: Record<string, number[] | null> = {};
    r.players.forEach((p, k) => { ranges[p] = classOf1326(r.ranges[k] ?? [], board); });
    const actorPos = r.players[n.actor] ?? String(n.actor);
    const heroSeat = spec.heroSeat === "oop" ? 0 : spec.heroSeat === "mid" ? 1 : r.players.length - 1;
    const isHero = n.actor === heroSeat;
    const labels = (n.actions ?? []).map((a: any) => labelOfTrace(a, n.potNode));
    out.push({
      street: STREET_NAME[String(n.street)] ?? "flop", actor: actorPos, line: (n.codes ?? []).join("-"),
      actions: labels,
      strat: classStrategy(actorRange, strategies, board),
      totals: (n.actions ?? []).map((a: any) => Math.round(Number(a.totalFrequency ?? 0) * 1000) / 1000),
      taken: n.taken != null ? (labels[n.taken] ?? null) : null,
      ranges, src, pot: n.potNode,
      heroMix: isHero && heroIdx != null ? (n.actions ?? []).map((a: any, j: number) => ({ action: labels[j]!, p: Math.round(Number(a.strategy?.[heroIdx] ?? 0) * 1000) / 10 })) : null,
      ...comboDetail(r.players.map((p, k) => ({ pos: p, w: r.ranges[k] ?? [] })), actorPos, isHero, board, strategies,
        (n.actions ?? []).map((a: any) => a.evs ?? [])),
    });
    if (n.taken != null) {
      const s = strategies[n.taken] ?? [];
      r.ranges[n.actor] = actorRange.map((w, i) => w * (s[i] ?? 0));
    }
  }
  return out;
}

/**
 * The postflop views of a hand BY THE DECISION THEY LEAD TO: every stored trace's own nodes matched to the table's
 * actions; a node shows the trees of the first hero decision at or after it that holds it (a blended multiway answer
 * solves 2-3 collapses per decision — each holds three seats, so together they show every seat), the first of them as
 * the view and the rest as alternatives. A seat no tree holds (ghosted / merged / dead money in all of them) gets none.
 * decisionIndex = the hero action the trace was solved for (solves.decision_key's last element).
 */
export function postflopViewsByDecision(actions: { seatId: number; street: string }[], positions: Record<string | number, string>,
  traces: { id: number; decisionIndex: number | null; trace: any }[]): { views: Record<number, NodeView>; alts: Record<number, NodeView[]> } {
  const per = traces.map((t) => {
    const vs = postflopViews(actions, positions, [{ id: t.id, trace: t.trace }]);
    const covered = Object.keys(vs).map(Number);
    return { id: t.id, d: t.decisionIndex ?? (covered.length ? Math.max(...covered) : -1), vs };
  });
  const views: Record<number, NodeView> = {}, alts: Record<number, NodeView[]> = {};
  for (let i = 0; i < actions.length; i++) {
    if (actions[i]!.street === "preflop") continue;
    const holding = per.filter((p) => p.vs[i]);
    if (!holding.length) continue;
    const ahead = holding.filter((p) => p.d >= i);
    const d = ahead.length ? Math.min(...ahead.map((p) => p.d)) : Math.max(...holding.map((p) => p.d));
    const group = holding.filter((p) => p.d === d).sort((a, b) => a.id - b.id);
    views[i] = group[0]!.vs[i]!;
    if (group.length > 1) alts[i] = group.slice(1).map((p) => p.vs[i]!);
  }
  return { views, alts };
}

/**
 * The postflop views of a hand: per street, the stored trace whose walk covers the most nodes of that street (the
 * latest on a tie — a later street's trace carries the earlier streets' line), its nodes matched to the table's actions
 * in order by seat. A seat the tree left out (ghosted / merged / dead money) gets no view.
 */
export function postflopViews(actions: { seatId: number; street: string }[], positions: Record<string | number, string>,
  traces: { id: number; trace: any }[]): Record<number, NodeView> {
  const views: Record<number, NodeView> = {};
  for (const street of ["flop", "turn", "river"] as const) {
    let best: NodeView[] = [];
    for (const x of traces) {
      const vs = traceToViews(x.trace, `tree #${x.id}${x.trace?.spec?.planTag ? ` · ${x.trace.spec.planTag}` : ""}`).filter((v) => v.street === street);
      if (vs.length >= best.length) best = vs;
    }
    let k = 0;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i]!;
      if (a.street !== street) continue;
      const pos = String(positions[a.seatId] ?? "").toUpperCase();
      let j = k;
      while (j < best.length && String(best[j]!.actor).toUpperCase() !== pos) j++;
      if (j < best.length) { views[i] = best[j]!; k = j + 1; }
    }
  }
  return views;
}
