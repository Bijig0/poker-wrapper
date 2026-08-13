import { Hono } from "hono";
import { gtowApi } from "../services/gtowApi";
import { preflopDb } from "../services/preflopDb";
import { buildRangeArray, rangeCombos } from "../utils/buildRangeArray/buildRangeArray";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import { classWeightsToSpec, reconstructFlopRanges } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import {
  actionKindOf,
  actionLabelOf,
  HU_SEATS,
  labelBetBb,
  matchActionIndex,
  matchActionLoose,
  normCard,
  POSTFLOP_ORDER,
  preflopClosed,
  preflopPotStack,
  splitPostflopTokens,
} from "../utils/aiStudyLine/aiStudyLine";
import { streetFixedPcts } from "../utils/streetFixedPcts/streetFixedPcts";

/**
 * AI-study: postflop study of ANY heads-up preflop line via GTO Wizard's cloud
 * AI solver — the analysis app's "Gto Wizard UI" tab uses this as an extra
 * "config" beside its locally-solved trees. Both flop-entering ranges are
 * reconstructed from the crawled preflop charts, one custom solution is minted
 * per street (nodes within a street are free queries on the same solve), and
 * later streets re-root with both ranges conditioned on every action taken —
 * so raise wars and donk lines work, unlike the single-decision exploit route.
 *
 * POST /api/ai-study
 * {
 *   preflop: "F-F-R2.5-F-C",          // GTOW-grammar line (the crawl's tokens)
 *   board: ["Ts","7h","2d", ...],     // flop + any dealt turn/river cards
 *   tokens: ["Check","Bet(330)", ...] // engine labels, dealt cards inline
 *   custom?: {                        // explicit spot — skips the crawl recon
 *     oopPos, ipPos,                  // display positions ("BB"/"SB", …)
 *     oopClasses, ipClasses,          // class → weight in [0,1] (169-key maps)
 *     pot, stack,                     // bb entering the flop
 *     rake?: { pctOfPot, capBB },     // site rake; omitted → GTOW default
 *   }
 * }
 * `custom` is how non-crawl preflop solutions (the HRC HU exports) get their
 * postflop solved: the caller walked ITS OWN preflop tree for the reaching
 * ranges, so this route only runs the cloud solve + node walk.
 * → { ok, nav: StudyNav, solution: StudyNodeSolution | null, meta }
 * (the study UI's normalized contract — pot/EV in chips = bb × 100)
 */
const app = new Hono();

const GAMETYPE = "Cash6m500zGeneral";
const DEPTH = 100;

const HOLES: readonly string[] = COMBOS.map((c) => c.hand);
const STREET = ["FLOP", "TURN", "RIVER"] as const;
const QKEY = ["flopActions", "turnActions", "riverActions"] as const;

interface NavNode {
  board: string;
  pot: number;
  to_call: number;
  ctx: string;
  terminal: boolean;
  chance: boolean;
  player: number | null;
  actions: string[];
}

const rangeOf = (data: any, seat: "OOP" | "IP"): number[] | undefined =>
  data?.players_info?.find?.((p: any) => p?.player?.relative_postflop_position?.toUpperCase?.() === seat)?.range;

interface CustomSpot {
  oopPos: string;
  ipPos: string;
  oopClasses: Record<string, number>;
  ipClasses: Record<string, number>;
  pot: number;
  stack: number;
  rake?: { pctOfPot: number; capBB: number };
}

app.post("/", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as {
    preflop?: string;
    board?: string[];
    tokens?: string[];
    gametype?: string;
    depth?: number;
    custom?: CustomSpot;
  };
  const gametype = b.gametype ?? GAMETYPE;
  const depth = b.depth ?? DEPTH;

  const pre = (b.preflop ?? "").split("-").map((t) => t.trim()).filter(Boolean);
  if (!pre.length && !b.custom) {
    return c.json({ ok: false, error: "preflop line is required (GTOW tokens, e.g. F-F-R2.5-F-C)." }, 400);
  }
  let board: string[];
  try {
    board = (b.board ?? []).map(normCard);
  } catch (e) {
    return c.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 400);
  }
  if (board.length < 3 || board.length > 5 || new Set(board).size !== board.length) {
    return c.json({ ok: false, error: "board must be 3–5 distinct cards (flop first)." }, 400);
  }
  const tokens = b.tokens ?? [];

  // ---- preflop: flop-entering ranges + pot/stack ----------------------------
  // Either supplied by the caller (`custom` — HRC etc. walked its own tree) or
  // reconstructed from the crawled GTOW charts.
  let oopPos: string, ipPos: string;
  let oop: number[], ip: number[];
  let flopPot: number, flopStack: number;
  let rake: { pct_of_pot: number; cap_in_chips: number; preflop_rake_type: string | null } | undefined;

  if (b.custom) {
    const cu = b.custom;
    if (!cu.oopPos || !cu.ipPos || !cu.oopClasses || !cu.ipClasses || !(cu.pot > 0) || !(cu.stack > 0)) {
      return c.json({ ok: false, error: "custom needs oopPos/ipPos, oopClasses/ipClasses, pot, stack." }, 400);
    }
    oopPos = cu.oopPos;
    ipPos = cu.ipPos;
    oop = buildRangeArray(classWeightsToSpec(cu.oopClasses));
    ip = buildRangeArray(classWeightsToSpec(cu.ipClasses));
    flopPot = cu.pot;
    flopStack = cu.stack;
    if (cu.rake) rake = { pct_of_pot: cu.rake.pctOfPot, cap_in_chips: cu.rake.capBB, preflop_rake_type: null };
  } else {
    if (!preflopDb.available(gametype, depth)) {
      return c.json({ ok: false, error: `preflop charts for ${gametype} @${depth} aren't crawled — can't reconstruct ranges.` }, 503);
    }
    // HU gametypes flip the postflop order: the SB IS the dealer, so the BB
    // acts first (OOP) — the 6-max blind-vs-blind convention (SB OOP) is
    // exactly backwards there. Same for the pot walk: HU lines have no other
    // seats to pad, and the 6-max rotation double-counts the blinds as dead.
    const hu = /^CashHu/i.test(gametype);
    const seatOrder = hu ? HU_SEATS : undefined;
    const postflopOrder = hu ? ["BB", "SB"] : POSTFLOP_ORDER;
    // guard against crawl holes falsely marked terminal (open betting = the
    // last raiser's opponent never responded; ranges would be unconditioned)
    if (!preflopClosed(pre, seatOrder)) {
      return c.json({ ok: false, error: "preflop betting hasn't closed after this line — a response node is missing from the crawl." }, 422);
    }
    const recon = await reconstructFlopRanges(pre, (line) => preflopDb.rawNode(gametype, depth, line));
    if (!recon.ok) return c.json({ ok: false, error: `preflop ranges: ${recon.reason}` }, 422);
    const positions = Object.keys(recon.ranges);
    [oopPos, ipPos] =
      postflopOrder.indexOf(positions[0]!.toUpperCase()) < postflopOrder.indexOf(positions[1]!.toUpperCase())
        ? [positions[0]!, positions[1]!]
        : [positions[1]!, positions[0]!];
    oop = buildRangeArray(classWeightsToSpec(recon.ranges[oopPos]!));
    ip = buildRangeArray(classWeightsToSpec(recon.ranges[ipPos]!));
    ({ pot: flopPot, stack: flopStack } = preflopPotStack(pre, depth, seatOrder));
  }
  if (rangeCombos(oop) <= 0 || rangeCombos(ip) <= 0) {
    return c.json({ ok: false, error: "a reconstructed range is empty — uncrawled subtree?" }, 422);
  }
  if (flopStack <= 0.5) return c.json({ ok: false, error: "the preflop line is (near) all-in — no postflop tree to study." }, 422);

  // ---- postflop walk --------------------------------------------------------
  const { streets, cards: dealt } = splitPostflopTokens(tokens);
  if (dealt.join(",") !== board.slice(3).join(",")) {
    return c.json({ ok: false, error: "board and tokens disagree on the dealt turn/river cards." }, 400);
  }
  if (streets.length > 3) return c.json({ ok: false, error: "too many streets — at most flop, turn, river." }, 400);

  let pot = flopPot;
  let stack = flopStack;
  let solveSecs = 0;
  let solves = 0;
  let root: NavNode | null = null;
  let last: NavNode | null = null;
  let solution: unknown = null;
  let customSolutionId: string | undefined;

  outer: for (let si = 0; si < streets.length; si++) {
    const streetBoard = board.slice(0, si === 0 ? 3 : 3 + si).join("");
    const toks = streets[si]!;
    // Street-start snapshots: an off-tree user size forces a second pass over
    // this street against a re-solved FIXED tree, so everything the walk
    // mutates must rewind to here.
    const oopStart = oop, ipStart = ip, potStart = pot, stackStart = stack;
    let fixedLevels: string[] | null = null;

    passes: for (let pass = 0; pass < 2; pass++) {
    oop = oopStart; ip = ipStart; pot = potStart; stack = stackStart;
    const ens = await gtowApi.ensureCustomSolution({
      board: streetBoard, pot, stack, oopRange: oop, ipRange: ip,
      oopPos, ipPos, startingStreet: STREET[si]!, rake,
      ...(fixedLevels ? { fixedLevels: { [STREET[si]!]: fixedLevels } } : {}),
    });
    if (!ens.ok) return c.json({ ok: false, error: ens.error }, ens.status === 0 ? 503 : 502);
    customSolutionId = ens.solId;

    const inv: [number, number] = [0, 0]; // per-seat chips committed this street (bb)
    const codes: string[] = [];

    for (let ti = 0; ti <= toks.length; ti++) {
      const nq = await gtowApi.customNode(ens.solId, { [QKEY[si]!]: codes.join("-"), board: streetBoard });
      if (!nq.ok) return c.json({ ok: false, error: nq.error }, nq.status === 0 ? 503 : 502);
      solveSecs += nq.solveSecs;
      if (!nq.cached) solves++;
      const j = nq.data;
      const sols: any[] = j.action_solutions ?? [];
      const actor = (codes.length % 2) as 0 | 1; // HU postflop alternates strictly, OOP first
      const toCall = Math.abs(inv[0] - inv[1]);
      const labels = sols.map((a) => actionLabelOf(a, stack));
      const node: NavNode = {
        board: streetBoard,
        pot: Math.round((pot + inv[0] + inv[1]) * 100),
        to_call: Math.round(toCall * 100),
        ctx: "",
        terminal: false,
        chance: false,
        player: actor,
        actions: labels,
      };
      if (si === 0 && ti === 0) root = node;
      last = node;

      if (ti === toks.length) {
        // the token stream ends at this decision node — return its full solution
        if (si !== streets.length - 1) {
          return c.json({ ok: false, error: "a card was dealt before the street's betting closed." }, 400);
        }
        const weights = rangeOf(j, actor === 0 ? "OOP" : "IP") ?? (actor === 0 ? oop : ip);
        solution = {
          holes: HOLES,
          player: actor,
          actions: labels,
          strategy: sols.map((a) => a.strategy ?? []),
          ev: sols.every((a) => Array.isArray(a.evs)) ? sols.map((a) => a.evs.map((v: number) => v * 100)) : null,
          weights,
          pot: node.pot,
          board: streetBoard,
        };
        break outer;
      }

      const tok = toks[ti]!;
      // Pass 0 walks the AUTOMATIC tree and requires exact action labels; a
      // wager the tree doesn't offer (an arbitrary user-typed size) triggers a
      // FIXED re-solve of this street with the line's exact sizes pinned per
      // raise level, and pass 1 re-walks it with a small size tolerance.
      const ai = pass === 0 ? matchActionIndex(tok, sols, stack) : matchActionLoose(tok, sols, stack);
      if (ai < 0) {
        if (pass === 0 && labelBetBb(tok) != null) {
          try {
            fixedLevels = streetFixedPcts(toks, potStart).pcts;
          } catch (e) {
            return c.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 400);
          }
          continue passes;
        }
        const hint = labelBetBb(tok) != null
          ? " (the requested size couldn't be solved — nearest offered: " + labels.filter((l) => labelBetBb(l) != null).join(", ") + ")"
          : "";
        return c.json({ ok: false, error: `"${tok}" isn't an action at this node — valid: ${labels.join(", ") || "(none)"}${hint}` }, 400);
      }
      const a = sols[ai]!;
      const kind = actionKindOf(a);

      // condition the actor's range on the action taken (feeds later streets' trees)
      const strat: number[] = a.strategy ?? [];
      if (actor === 0) oop = oop.map((w, i) => w * (strat[i] ?? 0));
      else ip = ip.map((w, i) => w * (strat[i] ?? 0));

      if (kind === "Fold") {
        if (ti !== toks.length - 1 || si !== streets.length - 1) {
          return c.json({ ok: false, error: "actions continue after a fold." }, 400);
        }
        last = { ...node, terminal: true, player: null, actions: [], to_call: 0 };
        break outer;
      }
      if (kind === "Call") inv[actor] = inv[1 - actor]!;
      // Number(): FIXED-tree solves return betsize as a string — left raw it
      // string-concatenates into the pot arithmetic and NaNs the node.
      else if (kind !== "Check") inv[actor] = Number(a.action?.betsize ?? labelBetBb(tok) ?? inv[1 - actor]!);
      codes.push(String(a.action?.code ?? ""));

      const closed = (kind === "Call" && toCall > 0) || (kind === "Check" && actor === 1);
      if (closed) {
        if (ti !== toks.length - 1) {
          return c.json({ ok: false, error: "the street's betting closed but more actions follow without a card." }, 400);
        }
        const paid = Math.max(inv[0], inv[1]);
        pot += 2 * paid;
        stack -= paid;
        const done = si === 2 || stack <= 0.005; // river closed, or both all-in (runouts not walked)
        last = { board: streetBoard, pot: Math.round(pot * 100), to_call: 0, ctx: "", terminal: done, chance: !done, player: null, actions: [] };
        if (done && si !== streets.length - 1) {
          return c.json({ ok: false, error: "cards dealt after the hand ended." }, 400);
        }
        break passes; // → next street (if a card was dealt)
      }
    }
    } // passes
  }

  return c.json({
    ok: true,
    nav: {
      ok: true,
      root: root!,
      steps: tokens.length ? [last!] : [],
      config: `GTOW AI · ${oopPos} vs ${ipPos}`,
      flop_key: board.slice(0, 3).join(""),
      board_canon: board,
      hero_idx: 1,
    },
    solution,
    meta: {
      engine: "gtow-ai",
      oopPos,
      ipPos,
      flopPot,
      effStack: flopStack,
      solveSecs: Math.round(solveSecs * 10) / 10,
      solves,
      cached: solves === 0,
      customSolutionId,
    },
  });
});

export default app;
