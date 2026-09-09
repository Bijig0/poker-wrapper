import { gtowApi } from "./gtowApi";
import {
  actionKindOf,
  matchActionLoose,
  wagerLabelForWalk,
} from "../utils/aiChainTokens/aiChainTokens";
import { streetFixedPcts } from "../utils/streetFixedPcts/streetFixedPcts";

/**
 * Per-street AI chain — the live-play version of routes/aiStudy.ts's walk:
 * one custom solution per street, each rooted with BOTH ranges conditioned on
 * every action already taken (range × the equilibrium frequency of the
 * observed action, combo by combo), pot/stack rolled forward street by
 * street. Off-tree wager sizes never miss: any street containing wagers is
 * solved as a FIXED tree with the observed sizes pinned per raise level, so
 * the tree contains the EXACT line played.
 *
 * This replaces the "root at the current street with flop-entry ranges"
 * shortcut, whose river answers came from ranges that had never seen the
 * flop/turn action (the K9o 40%-pot river donk of 2026-07-30).
 *
 * Trees and nodes are cached inside gtowApi by content key, so the flop tree
 * solved for hero's flop decision is reused verbatim when the turn and river
 * decisions re-walk the chain — each new decision costs ~one fresh cloud
 * solve.
 */

const STREET = ["FLOP", "TURN", "RIVER"] as const;
const QKEY = ["flopActions", "turnActions", "riverActions"] as const;

export interface AiChainSpec {
  oopPos: string;
  ipPos: string;
  /** 1326-combo weight arrays ENTERING THE FLOP (chart-reconstructed). */
  oopRange: number[];
  ipRange: number[];
  flopPot: number;
  flopStack: number;
  /** Concatenated short cards for the full observed board ("7cKdAh8c3s"). */
  board: string;
  /** GTOW tokens per street (X/C/F/R<bb>/RAI), up to and including the
   *  CURRENT street; the last street's tokens end at hero's pending node. */
  streets: string[][];
  /** Hero's postflop seat and combo index (null = unknown cards). */
  heroSeat: "oop" | "ip";
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
  actor: 0 | 1;
  potNode: number;
  invested: [number, number];
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
    oopIn: number[]; ipIn: number[];
  }[];
  nodes: ChainTraceNode[];
  result: { ok: boolean; why?: string; potNode?: number; stackStreet?: number; line?: string; solves?: number };
}

const r4 = (xs: number[] | undefined): number[] => (xs ?? []).map((x) => Math.round((x ?? 0) * 10000) / 10000);

export type AiChainResult =
  | {
      ok: true;
      /** GTOW node JSON at hero's pending decision (action_solutions et al). */
      data: any;
      /** Pot in bb at hero's node (street-entering pot + both commits). */
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

  let oop = spec.oopRange.slice();
  let ip = spec.ipRange.slice();
  let pot = spec.flopPot;
  let stack = spec.flopStack;
  let solves = 0;
  const walked: string[] = [];

  for (let si = 0; si < spec.streets.length; si++) {
    const streetBoard = cards.slice(0, 3 + si).join("");
    const toks = spec.streets[si]!;
    const isLast = si === spec.streets.length - 1;

    // Keep hero's actual combo alive in his own entering range: conditioning
    // multiplies weights by equilibrium frequencies, and a hero who took a
    // low-frequency line earlier would otherwise vanish from his own range —
    // leaving no strategy to read at his node.
    if (spec.heroComboIdx != null) {
      const heroArr = spec.heroSeat === "oop" ? oop : ip;
      heroArr[spec.heroComboIdx] = Math.max(heroArr[spec.heroComboIdx] ?? 0, 0.05);
    }

    // Engine labels for this street's tokens (Bet vs Raise by outstanding
    // wager; RAI = all-in to the street-entering stack).
    let labels: string[];
    try {
      labels = wagerLabelForWalk(toks, stack);
    } catch (e) {
      return fail(`tokens: ${e instanceof Error ? e.message : e}`);
    }

    // Any wager street is solved FIXED with the observed sizes pinned — live
    // capture sizes are essentially never on the AUTOMATIC grid, and a tree
    // that lacks the size played cannot be walked.
    let fixedLevels: string[] | null = null;
    if (labels.some((l) => /\(/.test(l))) {
      try {
        fixedLevels = streetFixedPcts(labels, pot).pcts;
      } catch (e) {
        return fail(`fixed sizing: ${e instanceof Error ? e.message : e}`);
      }
    }
    const streetRec = {
      si, street: STREET[si]!, board: streetBoard, potIn: pot, stackIn: stack, labels, fixedLevels,
      solId: null as string | null, created: false, oopIn: r4(oop), ipIn: r4(ip),
    };
    trace.streets.push(streetRec);

    const ens = await gtowApi.ensureCustomSolution({
      board: streetBoard,
      pot,
      stack,
      oopRange: oop,
      ipRange: ip,
      oopPos: spec.oopPos,
      ipPos: spec.ipPos,
      startingStreet: STREET[si]!,
      ...(spec.rake ? { rake: spec.rake } : {}),
      ...(fixedLevels ? { fixedLevels: { [STREET[si]!]: fixedLevels } } : {}),
    });
    if (!ens.ok) return fail(`solve: ${ens.error}`);
    if (ens.created) solves++;
    streetRec.solId = String(ens.solId);
    streetRec.created = !!ens.created;

    const inv: [number, number] = [0, 0];
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
      const actor = (codes.length % 2) as 0 | 1; // OOP first, strict alternation
      const nodeRec: ChainTraceNode = {
        si, ti, street: STREET[si]!, board: streetBoard, codes: codes.slice(), actor,
        potNode: Math.round((pot + inv[0] + inv[1]) * 100) / 100, invested: [inv[0], inv[1]],
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
        const heroActor = spec.heroSeat === "oop" ? 0 : 1;
        if (actor !== heroActor) {
          return fail("walked line ends on villain's turn (capture missed an action?)");
        }
        nodeRec.heroNode = true;
        const line = [...walked, `(${STREET[si]!.toLowerCase()} node after ${codes.join("-") || "root"})`].join(" / ");
        const potNode = Math.round((pot + inv[0] + inv[1]) * 100) / 100;
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

      // Condition the actor's range on the observed action — the step that
      // makes the NEXT street's tree see post-action ranges.
      const strat: number[] = a.strategy ?? [];
      if (actor === 0) oop = oop.map((w, i) => w * (strat[i] ?? 0));
      else ip = ip.map((w, i) => w * (strat[i] ?? 0));

      const toCall = Math.abs(inv[0] - inv[1]);
      if (kind === "Fold") return fail("line contains a fold before hero's node");
      if (kind === "Call") inv[actor] = inv[1 - actor]!;
      else if (kind !== "Check") inv[actor] = Number(a.action?.betsize ?? inv[1 - actor]!);
      codes.push(String(a.action?.code ?? ""));

      closed = (kind === "Call" && toCall > 0) || (kind === "Check" && actor === 1);
      if (closed) {
        if (ti !== labels.length - 1) {
          return fail("street closed but more actions follow (capture corruption?)");
        }
        const paid = Math.max(inv[0], inv[1]);
        pot += 2 * paid;
        stack -= paid;
        walked.push(`${STREET[si]!.toLowerCase()} ${codes.join("-")}`);
        if (stack <= 0.005) return fail("line is all-in — no pending decision to solve");
        break;
      }
    }
    if (!closed && !isLast) {
      return fail(`street ${STREET[si]} didn't close before the next card (missed action?)`);
    }
  }
  return fail("walk exhausted without reaching hero's node");
}
