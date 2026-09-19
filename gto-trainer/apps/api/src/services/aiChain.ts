import { gtowApi } from "./gtowApi";
import {
  actionKindOf,
  matchActionLoose,
  wagerLabelForWalk,
} from "../utils/aiChainTokens/aiChainTokens";
import { streetFixedPcts, wagerBb } from "../utils/streetFixedPcts/streetFixedPcts";

/**
 * Per-street AI chain — the live-play version of routes/aiStudy.ts's walk:
 * one custom solution per street, each rooted with EVERY seat's range
 * conditioned on every action already taken (range × the equilibrium
 * frequency of the observed action, combo by combo), pot/stack rolled forward
 * street by street. Off-tree wager sizes never miss: any street containing
 * wagers is solved as a FIXED tree with the observed sizes pinned per raise
 * level, so the tree contains the EXACT line played.
 *
 * This replaces the "root at the current street with flop-entry ranges"
 * shortcut, whose river answers came from ranges that had never seen the
 * flop/turn action (the K9o 40%-pot river donk of 2026-07-30).
 *
 * THREE SEATS (2026-09-19). GTO Wizard AI on Ultra solves 3-player postflop
 * trees, so a three-way flop is walked the same way: the seats act in
 * postflop order (OOP, then "OOP+1", then IP), a fold drops a seat for the
 * rest of the hand, and the street after a fold re-roots a heads-up tree for
 * the two left. The node itself names the seat to act (game.players[].is_hero)
 * and the walk refuses to continue when its own rotation disagrees.
 *
 * Trees and nodes are cached inside gtowApi by content key, so the flop tree
 * solved for hero's flop decision is reused verbatim when the turn and river
 * decisions re-walk the chain — each new decision costs ~one fresh cloud
 * solve.
 */

const STREET = ["FLOP", "TURN", "RIVER"] as const;
const QKEY = ["flopActions", "turnActions", "riverActions"] as const;

/** A seat's role on the flop: "mid" is the OOP+1 seat of a three-way flop. */
export type SeatLabel = "oop" | "mid" | "ip";

export interface AiChainSpec {
  oopPos: string;
  ipPos: string;
  /** 1326-combo weight arrays ENTERING THE FLOP (chart-reconstructed). */
  oopRange: number[];
  ipRange: number[];
  /** THE THIRD SEAT of a three-way flop (2026-09-19): GTO Wizard's "OOP+1", acting between OOP and IP. Present ⇒
   *  every street is a 3-player FIXED tree until someone folds, after which the two left re-root a heads-up tree
   *  as usual. Absent ⇒ the heads-up chain exactly as before. */
  midPos?: string;
  midRange?: number[];
  flopPot: number;
  flopStack: number;
  /** Concatenated short cards for the full observed board ("7cKdAh8c3s"). */
  board: string;
  /** GTOW tokens per street (X/C/F/R<bb>/RAI), up to and including the
   *  CURRENT street; the last street's tokens end at hero's pending node. */
  streets: string[][];
  /** Hero's postflop seat and combo index (null = unknown cards). */
  heroSeat: SeatLabel;
  heroComboIdx: number | null;
  rake?: { pct_of_pot: number; cap_in_chips: number; preflop_rake_type: string | null };
  /** Which preflop layer the flop-entering ranges came from — e.g.
   *  "ign200_3maxasym2ci_D100_s100_eq + exploit hero range (btn_open)". Not
   *  used by the solve; kept so a stored trace says what it assumed. */
  rangeSource?: string;
}

/**
 * The whole walk, recorded as it happens (services/solveStore.ts keeps it):
 * the spec, each street's tree, and every node visited with its full
 * action_solutions and the action taken. Enough to replay the conditioning
 * step by step, and to diff a later re-solve against what answered live.
 */
export interface ChainTraceNode {
  si: number;
  ti: number;
  street: "FLOP" | "TURN" | "RIVER";
  board: string;
  /** action codes walked on this street before this node */
  codes: string[];
  /** index into the street's `players` (0 = first to act) */
  actor: number;
  potNode: number;
  /** committed this street, one entry per seat of the street's `players` */
  invested: number[];
  actions: {
    name: string; code: string; betsize: number | null; position: string | null;
    totalFrequency: number | null; totalEv: number | null;
    strategy: number[]; evs: number[];
  }[];
  /** index into `actions` of the observed action, null at hero's pending node */
  taken: number | null;
  heroNode: boolean;
}
export interface ChainTrace {
  spec: AiChainSpec;
  streets: {
    si: number; street: "FLOP" | "TURN" | "RIVER"; board: string; potIn: number; stackIn: number;
    labels: string[]; fixedLevels: string[] | null; solId: string | null; created: boolean;
    /** wall-clock ms: the cloud solve (ensureCustomSolution) and the node walk on it (since 2026-09-12) */
    solveMs?: number; walkMs?: number;
    /** The street's seats in acting order and their entering ranges, parallel arrays (since 2026-09-19): a
     *  three-way flop lists three, the street after a fold lists the two left. oopIn/ipIn are the first and
     *  last of them, kept for readers of older traces. */
    players?: string[];
    rangesIn?: number[][];
    oopIn: number[]; ipIn: number[];
  }[];
  nodes: ChainTraceNode[];
  result: { ok: boolean; why?: string; potNode?: number; stackStreet?: number; line?: string; solves?: number };
}

const r4 = (xs: number[] | undefined): number[] => (xs ?? []).map((x) => Math.round((x ?? 0) * 10000) / 10000);
const r2 = (x: number): number => Math.round(x * 100) / 100;

export type AiChainResult =
  | {
      ok: true;
      /** GTOW node JSON at hero's pending decision (action_solutions et al). */
      data: any;
      /** Pot in bb at hero's node (street-entering pot + every seat's commit). */
      potNode: number;
      /** Stack behind (bb) entering the current street. */
      stackStreet: number;
      /** Human-readable line actually walked (post-pinning sizes). */
      line: string;
      /** Cloud solves that ran fresh for this call (0 = fully cached). */
      solves: number;
      trace: ChainTrace;
    }
  | { ok: false; why: string; trace?: ChainTrace };

// ---- 1326-combo arithmetic (GTO Wizard's ordering, see utils/comboIndex): card = rank*4 + suit, combo(a<b) = b(b-1)/2 + a
const RANKS_ = "23456789TJQKA", SUITS_ = "cdhs";
const cardIdx = (card: string): number => RANKS_.indexOf(card[0]!.toUpperCase()) * 4 + SUITS_.indexOf(card[1]!.toLowerCase());
const comboCards = (idx: number): [number, number] => {
  let b = 1;
  while ((b + 1) * b / 2 <= idx) b++;
  return [idx - (b * (b - 1)) / 2, b];
};
/** Every combo of the same 169-class as `idx` (same two ranks, same suitedness), including `idx` itself. */
const classCombos = (idx: number): number[] => {
  const [a, b] = comboCards(idx);
  const ra = Math.floor(a / 4), rb = Math.floor(b / 4), suited = a % 4 === b % 4;
  const out: number[] = [];
  for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
    if (ra === rb && s2 <= s1) continue;              // a pair: each unordered suit pair once
    if (ra !== rb && (s1 === s2) !== suited) continue;
    const x = ra * 4 + s1, y = rb * 4 + s2;
    if (x === y) continue;
    const [lo, hi] = x < y ? [x, y] : [y, x];
    out.push((hi * (hi - 1)) / 2 + lo);
  }
  return out;
};

export type ActionKind = "Fold" | "Check" | "Call" | "Bet" | "Raise" | "AllIn";

/**
 * The betting state of one postflop street for N seats in acting order: who acts next, what each has put in,
 * who is still in, and whether the betting has closed. Heads-up this is strict alternation; three-way it is a
 * rotation that a fold shortens, and "outstanding" is the most any seat has put in rather than "the other's".
 * A street is closed once no seat still in owes an action since the last wager (everyone checked, or everyone
 * matched the last bet or left) — or when one seat is left.
 */
export class StreetState {
  /** seat indices still in the hand, acting order */
  live: number[];
  /** committed this street, per seat index */
  inv: number[];
  private p = 0;
  private owed: Set<number>;

  constructor(n: number) {
    this.live = Array.from({ length: n }, (_, i) => i);
    this.inv = new Array(n).fill(0);
    this.owed = new Set(this.live);
  }
  get actor(): number { return this.live[this.p % this.live.length]!; }
  get outstanding(): number { return Math.max(...this.inv); }
  get potIn(): number { return this.inv.reduce((s, x) => s + x, 0); }
  get closed(): boolean { return this.live.length < 2 || !this.live.some((s) => this.owed.has(s)); }

  /** Apply the acting seat's action; wagers give the raise-to size in bb. */
  apply(kind: ActionKind, raiseTo?: number): void {
    const a = this.actor;
    if (kind === "Fold") {
      this.live = this.live.filter((s) => s !== a);
      this.owed.delete(a);
      // the pointer now indexes the next seat (it wraps when the folder was last)
      this.p = this.live.length ? this.p % this.live.length : 0;
      return;
    }
    if (kind === "Check") this.owed.delete(a);
    else if (kind === "Call") { this.inv[a] = this.outstanding; this.owed.delete(a); }
    else {
      const to = raiseTo ?? NaN;
      if (!(to > this.outstanding)) throw new Error(`${kind} to ${to}bb is not over the ${this.outstanding}bb outstanding`);
      this.inv[a] = to;
      this.owed = new Set(this.live.filter((s) => s !== a));   // a wager re-opens everyone else
    }
    this.p = (this.p + 1) % this.live.length;
  }
}

const kindOfLabel = (label: string): ActionKind =>
  label === "Fold" || label === "Check" || label === "Call" ? label
    : label.startsWith("AllIn") ? "AllIn" : label.startsWith("Raise") ? "Raise" : "Bet";

/** Who acts on each engine label of a street, for N seats in acting order — the rotation streetFixedPcts needs. */
export function actorsOf(labels: string[], n: number): number[] {
  const st = new StreetState(n);
  const out: number[] = [];
  for (const l of labels) {
    out.push(st.actor);
    st.apply(kindOfLabel(l), wagerBb(l) ?? undefined);
  }
  return out;
}

export async function solveAiChain(spec: AiChainSpec): Promise<AiChainResult> {
  const trace: ChainTrace = { spec, streets: [], nodes: [], result: { ok: false } };
  const fail = (why: string): AiChainResult => { trace.result = { ok: false, why }; return { ok: false, why, trace }; };
  const cards = spec.board.match(/.{2}/g) ?? [];
  if (cards.length < 3) return fail(`board too short ("${spec.board}")`);
  if (spec.streets.length < 1 || spec.streets.length > 3) {
    return fail(`need 1-3 streets, got ${spec.streets.length}`);
  }
  if (cards.length < 2 + spec.streets.length) {
    return fail("board has fewer cards than streets walked");
  }
  const threeWay = spec.midPos != null && spec.midRange != null;
  if (spec.heroSeat === "mid" && !threeWay) return fail("hero is the middle seat but the spec has no middle seat");

  // Seats in acting order. Folds remove a seat for the rest of the hand.
  type Seat = { pos: string; label: SeatLabel; range: number[] };
  let seats: Seat[] = [
    { pos: spec.oopPos, label: "oop", range: spec.oopRange.slice() },
    ...(threeWay ? [{ pos: spec.midPos!, label: "mid" as const, range: spec.midRange!.slice() }] : []),
    { pos: spec.ipPos, label: "ip", range: spec.ipRange.slice() },
  ];
  const heroPos = seats.find((s) => s.label === spec.heroSeat)!.pos;
  let pot = spec.flopPot;
  let stack = spec.flopStack;
  let solves = 0;
  const walked: string[] = [];

  for (let si = 0; si < spec.streets.length; si++) {
    const streetBoard = cards.slice(0, 3 + si).join("");
    const toks = spec.streets[si]!;
    const isLast = si === spec.streets.length - 1;
    const n = seats.length;
    const heroIdx = seats.findIndex((s) => s.pos === heroPos);
    if (heroIdx < 0) return fail("hero is no longer in the hand — nothing to solve");
    if (n < 2) return fail("only one player left in the hand — no decision to solve");

    // Keep hero's actual combo alive in his own entering range: conditioning
    // multiplies weights by equilibrium frequencies, and a hero who took a
    // low-frequency line earlier would otherwise vanish from his own range —
    // leaving no strategy to read at his node.
    // THE FLOOR COVERS HERO'S WHOLE HAND CLASS, NOT ONE COMBO (2026-09-17). GTO Wizard rejects beliefs that
    // break suit isomorphism on the street's board ("Provided beliefs don't respect suit isomorphism"): lifting
    // 8c7c alone while 8h7h stays at the chart's weight is exactly that when clubs and hearts are interchangeable
    // on Ad9s6d. It surfaced with the 6-max charts, whose 2-4% mixes put hero's class under the floor often
    // (3 of the first 30 postflop spots). Lifting every unblocked combo of the class is suit-symmetric by
    // construction and changes villain's picture of hero by a rounding error.
    if (spec.heroComboIdx != null) {
      const heroArr = seats[heroIdx]!.range;
      const boardIdx = new Set(cards.slice(0, 3 + si).map(cardIdx));
      for (const idx of classCombos(spec.heroComboIdx)) {
        const [a, b] = comboCards(idx);
        if (boardIdx.has(a) || boardIdx.has(b)) continue;   // card removal stays absolute
        heroArr[idx] = Math.max(heroArr[idx] ?? 0, 0.05);
      }
    }

    // Engine labels for this street's tokens (Bet vs Raise by outstanding
    // wager; RAI = all-in to the street-entering stack), and who acts on each.
    let labels: string[];
    let actors: number[];
    try {
      labels = wagerLabelForWalk(toks, stack);
      actors = actorsOf(labels, n);
    } catch (e) {
      return fail(`tokens: ${e instanceof Error ? e.message : e}`);
    }

    // Any wager street is solved FIXED with the observed sizes pinned — live
    // capture sizes are essentially never on the AUTOMATIC grid, and a tree
    // that lacks the size played cannot be walked. (A 3-player tree is FIXED
    // on every street regardless — gtowApi supplies the grid.)
    let fixedLevels: string[] | null = null;
    if (labels.some((l) => /\(/.test(l))) {
      try {
        fixedLevels = streetFixedPcts(labels, pot, actors).pcts;
      } catch (e) {
        return fail(`fixed sizing: ${e instanceof Error ? e.message : e}`);
      }
    }
    const streetRec = {
      si, street: STREET[si]!, board: streetBoard, potIn: pot, stackIn: stack, labels, fixedLevels,
      solId: null as string | null, created: false, solveMs: 0, walkMs: 0,
      players: seats.map((s) => s.pos), rangesIn: seats.map((s) => r4(s.range)),
      oopIn: r4(seats[0]!.range), ipIn: r4(seats[n - 1]!.range),
    };
    trace.streets.push(streetRec);

    const tSolve = Date.now();
    const ens = await gtowApi.ensureCustomSolution({
      board: streetBoard,
      pot,
      stack,
      oopRange: seats[0]!.range,
      ipRange: seats[n - 1]!.range,
      oopPos: seats[0]!.pos,
      ipPos: seats[n - 1]!.pos,
      ...(n === 3 ? { mid: { pos: seats[1]!.pos, range: seats[1]!.range } } : {}),
      startingStreet: STREET[si]!,
      ...(spec.rake ? { rake: spec.rake } : {}),
      ...(fixedLevels ? { fixedLevels: { [STREET[si]!]: fixedLevels } } : {}),
    });
    if (!ens.ok) return fail(`solve: ${ens.error}`);
    if (ens.created) solves++;
    streetRec.solId = String(ens.solId);
    streetRec.created = !!ens.created;
    streetRec.solveMs = Date.now() - tSolve;
    const tWalk = Date.now();

    const st = new StreetState(n);
    const codes: string[] = [];
    let closed = false;

    for (let ti = 0; ti <= labels.length; ti++) {
      const nq = await gtowApi.customNode(ens.solId, {
        [QKEY[si]!]: codes.join("-"),
        board: streetBoard,
      });
      if (!nq.ok) return fail(`node: ${nq.error}`);
      const sols: any[] = nq.data?.action_solutions ?? [];
      if (!sols.length) return fail("empty node mid-walk");
      const actor = st.actor;
      // A three-way node names the seat to act; the rotation here must agree or the ranges being conditioned
      // belong to the wrong seat — refuse rather than answer from a scrambled tree.
      if (threeWay) {
        const said = nq.data?.game?.players?.find?.((p: any) => p?.is_hero)?.position;
        if (said && String(said).toUpperCase() !== seats[actor]!.pos.toUpperCase()) {
          return fail(`seat rotation disagrees with GTO Wizard at ${STREET[si]}#${ti}: we have ${seats[actor]!.pos} to act, the node says ${said}`);
        }
      }
      const nodeRec: ChainTraceNode = {
        si, ti, street: STREET[si]!, board: streetBoard, codes: codes.slice(), actor,
        potNode: r2(pot + st.potIn), invested: st.inv.slice(),
        actions: sols.map((a) => ({
          name: String(a.action?.display_name ?? "?"), code: String(a.action?.code ?? ""),
          betsize: a.action?.betsize != null && a.action.betsize !== "" ? Number(a.action.betsize) : null,
          position: a.action?.position ?? null,
          totalFrequency: a.total_frequency ?? null, totalEv: a.total_ev ?? null,
          strategy: r4(a.strategy), evs: r4(a.evs),
        })),
        taken: null, heroNode: false,
      };
      trace.nodes.push(nodeRec);

      if (ti === labels.length) {
        if (!isLast) break; // street walked through; next street's tree re-roots
        // Hero's pending decision — sanity: it must actually be hero's turn.
        if (actor !== heroIdx) {
          return fail("walked line ends on villain's turn (capture missed an action?)");
        }
        nodeRec.heroNode = true;
        const line = [...walked, `(${STREET[si]!.toLowerCase()} node after ${codes.join("-") || "root"})`].join(" / ");
        const potNode = r2(pot + st.potIn);
        trace.result = { ok: true, potNode, stackStreet: stack, line, solves };
        return { ok: true, data: nq.data, potNode, stackStreet: stack, line, solves, trace };
      }

      const label = labels[ti]!;
      const ai = matchActionLoose(label, sols, stack);
      if (ai < 0) {
        const offered = sols.map((a) => a.action?.display_name ?? "?").join(", ");
        return fail(`"${label}" not walkable at ${STREET[si]}#${ti} (offered: ${offered})`);
      }
      const a = sols[ai]!;
      nodeRec.taken = ai;
      const kind = actionKindOf(a);
      if (kind === "Fold" && actor === heroIdx) return fail("hero folds inside the line before his node (capture corruption?)");

      // Condition the actor's range on the observed action — the step that
      // makes the NEXT street's tree see post-action ranges.
      const strat: number[] = a.strategy ?? [];
      seats[actor]!.range = seats[actor]!.range.map((w, i) => w * (strat[i] ?? 0));

      try {
        const to = Number(a.action?.betsize);
        st.apply(kind, Number.isFinite(to) && to > 0 ? to : undefined);
      } catch (e) {
        return fail(`${STREET[si]}#${ti}: ${e instanceof Error ? e.message : e}`);
      }
      codes.push(String(a.action?.code ?? ""));

      if (st.closed) {
        if (ti !== labels.length - 1) {
          return fail("street closed but more actions follow (capture corruption?)");
        }
        const paid = st.outstanding;
        pot += st.potIn;
        stack -= paid;
        seats = st.live.map((i) => seats[i]!);   // folded seats leave the hand
        walked.push(`${STREET[si]!.toLowerCase()} ${codes.join("-")}`);
        if (seats.length < 2) return fail("everyone else folded — no decision left to solve");
        if (stack <= 0.005) return fail("line is all-in — no pending decision to solve");
        closed = true;
        break;
      }
    }
    streetRec.walkMs = Date.now() - tWalk;
    if (!closed && !isLast) {
      return fail(`street ${STREET[si]} didn't close before the next card (missed action?)`);
    }
  }
  return fail("walk exhausted without reaching hero's node");
}
