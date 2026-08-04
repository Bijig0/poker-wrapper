/**
 * buildSolutionUrl
 * ----------------
 * GTO Wizard encodes an entire node address in its `/solutions` URL:
 *
 *   preflop_actions=F-F-F-R2.5-F-C   board=Ts7h2d   flop_actions=X-R2   ...
 *
 * so a whole line can be applied with ONE navigation instead of clicking the
 * tree card by card. Action tokens (uniform across every street):
 *
 *   fold  → F      check → X      call → C
 *   bet   → R<bb>  raise → R<bb>  all-in → R<bb>   (sizes are bb amounts)
 *
 * The board is the concatenated cards dealt so far ("Ts7h2d", no separators).
 * Only actions that have HAPPENED are encoded — the pending decision (hero's
 * turn) is left as the active node.
 *
 * This is a best-effort ADDRESS: off-tree sizes may be snapped by the app, so
 * the caller must verify by reading the taken actions back and repair the
 * rare mismatch. Pure and fully unit-testable.
 */

import type { ParsedAction, ParsedHand, Street } from "../parsePanelFeed/parsePanelFeed";

const SHORT = (c: string): string => {
  const m = c.trim().match(/^([2-9TJQKAtjqka])([shdcSHDC])$/);
  return m ? m[1].toUpperCase() + m[2].toLowerCase() : c;
};

/** One preflop/postflop action → its URL token, or null to omit (posts). */
export const actionToken = (a: ParsedAction): string | null => {
  switch (a.type) {
    case "post-sb":
    case "post-bb":
      return null;
    case "fold":
      return "F";
    case "check":
      return "X";
    case "call":
      return "C";
    case "all-in":
      // GTO Wizard's URL token for the tree's all-in action is the literal
      // "RAI", NOT R<bb> — an R<amount> jam line renders an empty page
      // (verified by clicking Allin in-app and reading the URL it writes).
      return "RAI";
    case "bet":
    case "raise": {
      // aggressive actions encode as R<bb>; amount is required to size it
      if (a.amount == null) return "R";
      // trim trailing zeros: 2.50 → 2.5, 2.0 → 2
      const n = Math.round(a.amount * 100) / 100;
      return `R${n}`;
    }
  }
};

const STREETS: readonly Street[] = ["preflop", "flop", "turn", "river"];

const ORDER_6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const ORDER_9 = ["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

/**
 * Preflop tokens must be POSITIONAL: GTO Wizard's tree replays them by seat in
 * a fixed order (UTG→BB), so a seat missing from the hand (empty/never-dealt)
 * would shift every later token onto the wrong seat. The opening orbit emits
 * one token per seat in order — F for any seat that folded or was never dealt.
 * When hero's preflop decision is still PENDING, the walk stops at his seat so
 * his node is left active; later-orbit actions (3-bet responses) append after.
 *
 * `heroPosOverride` matters for late positions (BTN, CO, HJ, …) that never
 * post a blind: without it, hero's own action can't be matched to ANY seat in
 * the walk, so it silently falls through to the trailing "later orbit" append
 * instead — every remaining seat in the main walk (including hero's real one)
 * gets a phantom default fold, corrupting the token count entirely.
 */
export const buildPreflopTokens = (hand: ParsedHand, heroPosOverride?: string | null): string[] =>
  buildPreflopTokensWalk(hand, heroPosOverride ?? null, null);

/**
 * HU-tree variant: a 2-handed table's dealer reads as "BTN" from the vision
 * layer, but the heads-up solution trees seat him as SB (in HU the dealer IS
 * the small blind). Same walk, with the [SB, BB] order and BTN→SB mapping.
 */
export const buildPreflopTokensHu = (hand: ParsedHand, heroPosOverride?: string | null): string[] =>
  buildPreflopTokensWalk(hand, heroPosOverride ?? null, {
    order: ["SB", "BB"],
    normalize: (p) => (p === "BTN" ? "SB" : p),
  });

const buildPreflopTokensWalk = (
  hand: ParsedHand,
  heroPosOverride: string | null,
  hu: { order: string[]; normalize: (p: string) => string } | null
): string[] => {
  const preflop = hand.actions.filter(
    (a) => a.street === "preflop" && a.type !== "post-sb" && a.type !== "post-bb"
  );
  if (!preflop.length) return [];

  const normalize = hu?.normalize ?? ((p: string) => p);
  // hero's own seatId is -1 in row-parsed hands and absent from positions;
  // resolve his position from an explicit override, his blind post (SB/BB),
  // or the positions map.
  const heroPost = hand.actions.find(
    (a) => a.hero && (a.type === "post-sb" || a.type === "post-bb")
  );
  const heroPosRaw =
    heroPosOverride ??
    hand.positions[hand.heroSeatId] ??
    (heroPost ? (heroPost.type === "post-sb" ? "SB" : "BB") : null);
  const heroPos = heroPosRaw ? normalize(heroPosRaw) : null;
  const posOfAction = (a: ParsedAction): string | null => {
    const raw = a.hero ? heroPosRaw : hand.positions[a.seatId] ?? null;
    return raw ? normalize(raw) : null;
  };

  const present = new Set(
    [...Object.values(hand.positions).map(normalize), ...(heroPos ? [heroPos] : [])]
  );
  const order = hu?.order ?? (["UTG1", "UTG2", "LJ"].some((p) => present.has(p)) ? ORDER_9 : ORDER_6);

  // hero's pending preflop seat, if any — the node to leave active
  const node = hand.currentNode;
  const pendingPos =
    !hand.ended && node.toActIsHero && node.street === "preflop" ? heroPos : null;
  const heroActedPreflop = preflop.some((a) => a.hero);

  const tokens: string[] = [];
  let ai = 0; // index into preflop actions (which are in action order)
  for (const pos of order) {
    const next = ai < preflop.length ? preflop[ai] : null;
    const nextPos = next ? posOfAction(next) : undefined;
    // Consume the next action here if it belongs to THIS seat, or if its seat has
    // no position label at all. The opening orbit runs strictly in seat order, so
    // an unlabeled action (a fold-to-the-blinds hand often only tags the live
    // blinds) belongs to the current slot. Without the null case, an unlabeled
    // fold matches no seat and desyncs the whole line into phantom folds +
    // duplicated later-orbit tokens (e.g. ten folds), which no chart contains.
    if (next && (nextPos === pos || nextPos == null)) {
      tokens.push(actionToken(next) ?? "F");
      ai++;
    } else if (pendingPos && pos === pendingPos && !heroActedPreflop) {
      break; // hero's turn here — leave this node active
    } else {
      tokens.push("F"); // this seat folded silently or was never dealt
    }
  }
  // later orbits (3-bet/4-bet responses) — append in action order
  for (; ai < preflop.length; ai++) tokens.push(actionToken(preflop[ai]) ?? "F");
  return tokens;
};

export interface SolutionUrlSpec {
  gametype: string;
  depth: number;
  hand: ParsedHand;
  /** Optional origin; when set, `url` is absolute. `search` is always origin-free. */
  origin?: string;
  /** Hero's position when it can't be inferred from a blind post (e.g. BTN, CO, HJ). */
  heroPos?: string | null;
}

export interface SolutionUrlResult {
  /** Query string after `/solutions?` — navigate with location.origin in-page. */
  search: string;
  /** Absolute URL when `origin` was given (mainly for tests/logging). */
  url: string;
  /** Tokens per street, for read-back verification. */
  tokens: Partial<Record<Street, string[]>>;
  board: string;
  /** history_spot value — the index of hero's pending (active) node. */
  spot: number;
}

/**
 * Build the `/solutions?` search string straight from per-street tokens — the
 * shared tail of buildSolutionUrl, exposed so the off-tree repair loop can
 * rebuild the URL after snapping a size (and build prefix-probe URLs) without
 * re-deriving tokens from the hand. `spot` defaults to the token count
 * (hero's pending node); a probe passes the index of the node to focus.
 */
export const buildSearchFromTokens = (spec: {
  gametype: string;
  depth: number;
  tokens: Partial<Record<Street, string[]>>;
  board: string;
  spot?: number;
}): string => {
  const { tokens } = spec;
  const params = new URLSearchParams({
    gametype: spec.gametype,
    depth: String(spec.depth),
    solution_type: "gwiz",
    gmfs_solution_tab: "ai_sols",
    soltab: "strategy",
  });
  if (tokens.preflop?.length) params.set("preflop_actions", tokens.preflop.join("-"));
  if (spec.board) params.set("board", spec.board);
  if (tokens.flop?.length) params.set("flop_actions", tokens.flop.join("-"));
  if (tokens.turn?.length) params.set("turn_actions", tokens.turn.join("-"));
  if (tokens.river?.length) params.set("river_actions", tokens.river.join("-"));

  // history_spot focuses the node AFTER all taken actions — hero's pending
  // decision. It equals the total number of taken decision spots (the board
  // deal is not a spot). Without it the app defaults focus to spot 0 (UTG).
  const spotCount = STREETS.reduce((n, s) => n + (tokens[s]?.length ?? 0), 0);
  params.set("history_spot", String(spec.spot ?? spotCount));
  return params.toString();
};

/**
 * Per-street tokens + board string for the spot-solution API (see
 * services/gtowApi.ts). Preflop tokens are positional (6-max) or HU-ordered
 * when `hu` is set; postflop tokens are in action order. Only actions already
 * taken appear, so the resulting spot's active node is hero's pending decision.
 */
export const buildSpotSolutionTokens = (
  hand: ParsedHand,
  heroPos?: string | null,
  hu?: boolean
): { preflop: string[]; flop: string[]; turn: string[]; river: string[]; board: string } => {
  const streetToks = (street: Street): string[] =>
    hand.actions
      .filter((a) => a.street === street)
      .map(actionToken)
      .filter((t): t is string => t !== null);
  return {
    preflop: hu ? buildPreflopTokensHu(hand, heroPos) : buildPreflopTokens(hand, heroPos),
    flop: streetToks("flop"),
    turn: streetToks("turn"),
    river: streetToks("river"),
    board: hand.board.map(SHORT).join(""),
  };
};

export const buildSolutionUrl = (spec: SolutionUrlSpec): SolutionUrlResult => {
  const { hand } = spec;
  const tokens: Partial<Record<Street, string[]>> = {};
  for (const street of STREETS) {
    // preflop needs positional alignment; postflop is heads-up action order
    const toks =
      street === "preflop"
        ? buildPreflopTokens(hand, spec.heroPos)
        : hand.actions
            .filter((a) => a.street === street)
            .map(actionToken)
            .filter((t): t is string => t !== null);
    if (toks.length) tokens[street] = toks;
  }

  const board = hand.board.map(SHORT).join("");
  const spotCount = STREETS.reduce((n, s) => n + (tokens[s]?.length ?? 0), 0);
  const search = buildSearchFromTokens({ gametype: spec.gametype, depth: spec.depth, tokens, board });
  return {
    search,
    url: `${(spec.origin ?? "https://app.gtowizard.com").replace(/\/$/, "")}/solutions?${search}`,
    tokens,
    board,
    spot: spotCount,
  };
};
