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
}

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
    }
  | { ok: false; why: string };

export async function solveAiChain(spec: AiChainSpec): Promise<AiChainResult> {
  const cards = spec.board.match(/.{2}/g) ?? [];
  if (cards.length < 3) return { ok: false, why: `board too short ("${spec.board}")` };
  if (spec.streets.length < 1 || spec.streets.length > 3) {
    return { ok: false, why: `need 1-3 streets, got ${spec.streets.length}` };
  }
  if (cards.length < 2 + spec.streets.length) {
    return { ok: false, why: "board has fewer cards than streets walked" };
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
      return { ok: false, why: `tokens: ${e instanceof Error ? e.message : e}` };
    }

    // Any wager street is solved FIXED with the observed sizes pinned — live
    // capture sizes are essentially never on the AUTOMATIC grid, and a tree
    // that lacks the size played cannot be walked.
    let fixedLevels: string[] | null = null;
    if (labels.some((l) => /\(/.test(l))) {
      try {
        fixedLevels = streetFixedPcts(labels, pot).pcts;
      } catch (e) {
        return { ok: false, why: `fixed sizing: ${e instanceof Error ? e.message : e}` };
      }
    }

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
    if (!ens.ok) return { ok: false, why: `solve: ${ens.error}` };
    if (ens.created) solves++;

    const inv: [number, number] = [0, 0];
    const codes: string[] = [];
    let closed = false;

    for (let ti = 0; ti <= labels.length; ti++) {
      const nq = await gtowApi.customNode(ens.solId, {
        [QKEY[si]!]: codes.join("-"),
        board: streetBoard,
      });
      if (!nq.ok) return { ok: false, why: `node: ${nq.error}` };
      const sols: any[] = nq.data?.action_solutions ?? [];
      if (!sols.length) return { ok: false, why: "empty node mid-walk" };
      const actor = (codes.length % 2) as 0 | 1; // OOP first, strict alternation

      if (ti === labels.length) {
        if (!isLast) break; // street walked through; next street's tree re-roots
        // Hero's pending decision — sanity: it must actually be hero's turn.
        const heroActor = spec.heroSeat === "oop" ? 0 : 1;
        if (actor !== heroActor) {
          return { ok: false, why: "walked line ends on villain's turn (capture missed an action?)" };
        }
        return {
          ok: true,
          data: nq.data,
          potNode: Math.round((pot + inv[0] + inv[1]) * 100) / 100,
          stackStreet: stack,
          line: [...walked, `(${STREET[si]!.toLowerCase()} node after ${codes.join("-") || "root"})`].join(" / "),
          solves,
        };
      }

      const label = labels[ti]!;
      const ai = matchActionLoose(label, sols, stack);
      if (ai < 0) {
        const offered = sols.map((a) => a.action?.display_name ?? "?").join(", ");
        return { ok: false, why: `"${label}" not walkable at ${STREET[si]}#${ti} (offered: ${offered})` };
      }
      const a = sols[ai]!;
      const kind = actionKindOf(a);

      // Condition the actor's range on the observed action — the step that
      // makes the NEXT street's tree see post-action ranges.
      const strat: number[] = a.strategy ?? [];
      if (actor === 0) oop = oop.map((w, i) => w * (strat[i] ?? 0));
      else ip = ip.map((w, i) => w * (strat[i] ?? 0));

      const toCall = Math.abs(inv[0] - inv[1]);
      if (kind === "Fold") return { ok: false, why: "line contains a fold before hero's node" };
      if (kind === "Call") inv[actor] = inv[1 - actor]!;
      else if (kind !== "Check") inv[actor] = Number(a.action?.betsize ?? inv[1 - actor]!);
      codes.push(String(a.action?.code ?? ""));

      closed = (kind === "Call" && toCall > 0) || (kind === "Check" && actor === 1);
      if (closed) {
        if (ti !== labels.length - 1) {
          return { ok: false, why: "street closed but more actions follow (capture corruption?)" };
        }
        const paid = Math.max(inv[0], inv[1]);
        pot += 2 * paid;
        stack -= paid;
        walked.push(`${STREET[si]!.toLowerCase()} ${codes.join("-")}`);
        if (stack <= 0.005) return { ok: false, why: "line is all-in — no pending decision to solve" };
        break;
      }
    }
    if (!closed && !isLast) {
      return { ok: false, why: `street ${STREET[si]} didn't close before the next card (missed action?)` };
    }
  }
  return { ok: false, why: "walk exhausted without reaching hero's node" };
}
