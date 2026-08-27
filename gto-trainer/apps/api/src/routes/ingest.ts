import { Hono } from "hono";
import {
  renderPanelRows,
  type PanelRow,
  type ParsedHand,
} from "../feed/parsePanelFeed/parsePanelFeed";
import { handToSpot, type SpotOptions } from "../feed/handToSpot/handToSpot";
import { buildSolutionUrl, buildSearchFromTokens, buildPreflopTokens, buildPreflopTokensHu } from "../feed/buildSolutionUrl/buildSolutionUrl";
import type { Street } from "../feed/parsePanelFeed/parsePanelFeed";
import { snapToken } from "../utils/snapToken/snapToken";
import { parseHandClass } from "../utils/parseHandClass/parseHandClass";
import { preflopDb } from "../services/preflopDb";
import { gtowCdp, isRecoverableBlocker, SOLUTION_SETS } from "../services/gtowCdp";
import { navLock } from "../services/navLock";
import { resolveHand, DEFAULT_LIVE_URL as SHARED_LIVE_URL } from "../feed/resolveHand/resolveHand";

/**
 * Feed ingestion: turn a hand — the live one from assistive-play's /state, a
 * panel-feed rows payload, the same lines pasted as plain text, or a
 * Hand-shaped JSON object entered directly — into a GTO Wizard node and
 * (optionally) drive the app there via the existing setupSpot → setCards →
 * respondToBet navigation.
 */
const app = new Hono();

// Re-exported from the shared hand resolver so existing importers (studyPoller)
// keep working after the parsing logic moved there.
export const DEFAULT_LIVE_URL = SHARED_LIVE_URL;

interface IngestBody {
  /** Panel-feed rows, either the envelope { ok, rows } or the bare array. */
  rows?: PanelRow[] | { ok?: boolean; rows: PanelRow[] };
  /** Manual hand history: the same lines as plain text, one per line. */
  text?: string;
  /** A Hand-shaped JSON object (the /state shape), entered directly. */
  hand?: unknown;
  /** Pull the structured Hand straight from the assistive-play server. */
  live?: boolean | { url?: string; table?: string };
  /** Also navigate GTO Wizard to the node (default: parse only). */
  navigate?: boolean;
  setId?: string;
  depth?: number;
  heroPos?: string;
}

/**
 * Connection status of the vision pipeline itself: is assistive-play running,
 * and does it currently see an Ignition table window? Mirrors /state's own
 * `connected` flag — the same signal the panel feed keys off.
 */
app.get("/live-status", async (c) => {
  const url = (c.req.query("url") ?? DEFAULT_LIVE_URL).replace(/\/$/, "");
  try {
    const res = await fetch(`${url}/state`, { signal: AbortSignal.timeout(1500) });
    const state = (await res.json()) as {
      connected?: boolean;
      mode?: string;
      description?: string;
      tables?: unknown[];
      hand?: unknown;
      snapshot?: { status?: string; seats?: { hero?: boolean; sittingOut?: boolean }[] };
    };
    const status = state.snapshot?.status ?? null;
    return c.json({
      ok: true,
      reachable: true,
      connected: !!state.connected,
      mode: state.mode ?? null,
      tables: Array.isArray(state.tables) ? state.tables.length : 0,
      description: state.description ?? null,
      handInProgress: state.hand != null,
      // the pipeline's own table status — "sitting-out" = hero seated but not
      // dealt in (the Wait-for-BB / Post-to-join pills)
      status,
      heroSittingOut:
        // hero's own seat badge only — table-level status fires for ANY sitter
        !!state.snapshot?.seats?.find((s) => s.hero)?.sittingOut,
    });
  } catch {
    return c.json({
      ok: true,
      reachable: false,
      connected: false,
      mode: null,
      tables: 0,
      description: null,
      handInProgress: false,
      status: null,
      heroSittingOut: false,
    });
  }
});

app.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as IngestBody;
  const set = SOLUTION_SETS.find((s) => s.id === (body.setId ?? "6max"));
  const opts: SpotOptions = {
    setId: body.setId,
    depth: body.depth,
    heroPos: body.heroPos,
    // snap stack-derived depths to what the chosen library actually has
    availableDepths: set?.depths,
  };

  // --- 1) resolve a hand from one of the four sources ------------------------
  // (shared with /fast-solver — see feed/resolveHand)
  const resolved = await resolveHand(body);
  if (!resolved.ok) return c.json({ ok: false, error: resolved.error }, resolved.status as 400 | 409 | 502);
  const { hand, source, warnings, tableStatus, heroSittingOut, studyAnswersOn, studyMode } = resolved;

  if (!hand) {
    return c.json(
      {
        ok: false,
        error: heroSittingOut
          ? "Hero is sitting out (wait-for-BB / post pill showing) — no turns until he's dealt in."
          : "No hand in the feed (waiting for the next deal).",
        tableStatus,
        heroSittingOut,
        // The study poller keys its idle/active branch on this — omitting it
        // here made "between hands" indistinguishable from "toggle off", so
        // the poller never refreshed its GTO Wizard health flag while idle.
        studyAnswersOn,
        studyMode,
        warnings,
      },
      422
    );
  }

  // --- 2) map the hand onto the node-navigation contract ---------------------
  // A sitting-out hero (wait-for-BB / post pills) has no decisions to solve,
  // whatever a lingering hand object says.
  const outcome = heroSittingOut
    ? {
        ok: false as const,
        reason: "Hero is sitting out — waiting for the big blind or to post; no turns until he's dealt in.",
      }
    : handToSpot(hand, opts);

  // Hero's journey summary — the research subject's position, whether he's
  // still in the hand, and his actions so far.
  const heroPost = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
  const heroPos =
    body.heroPos ??
    hand.positions[hand.heroSeatId] ??
    (heroPost ? (heroPost.type === "post-sb" ? "SB" : "BB") : null);
  const heroFolded = hand.actions.some((a) => a.hero && a.type === "fold");

  const base = {
    ok: true as const,
    source,
    warnings,
    tableStatus,
    studyAnswersOn,
    studyMode,
    // round-trip proof surfaced to the caller: the hand re-rendered as rows
    rerendered: renderPanelRows(hand),
    hero: {
      pos: heroPos,
      cards: hand.heroCards,
      folded: heroFolded,
      sittingOut: heroSittingOut,
      actions: hand.actions.filter((a) => a.hero),
      // a sitting-out hero can't have a live turn, whatever the stale hand says
      toAct: !heroSittingOut && !hand.ended && hand.currentNode.toActIsHero,
    },
    hand: {
      heroCards: hand.heroCards,
      board: hand.board,
      street: hand.street,
      positions: hand.positions,
      actions: hand.actions,
      ended: hand.ended,
      node: hand.currentNode,
      result: hand.result ?? null,
    },
  };

  const spot = outcome.ok ? outcome.spot : null;
  const notes = outcome.ok ? outcome.notes : [];

  // Hero must be to act on some street for a navigable answer.
  const heroTurn = !heroSittingOut && !hand.ended && hand.currentNode.toActIsHero;

  // --- 3) optionally drive GTO Wizard there ----------------------------------
  if (!body.navigate) {
    return c.json({ ...base, spot, notes, deferred: outcome.ok ? undefined : outcome.reason, navigation: null });
  }
  if (!heroTurn) {
    return c.json({ ...base, spot, notes, deferred: outcome.ok ? undefined : outcome.reason, navigation: null });
  }
  // Preflop first tries the LOCAL crawled DB — a ~0ms lookup with off-tree
  // sizes snapped against the tree's real sizes, no GTO Wizard involved.
  // Any miss (uncrawled node, unknown set/depth) falls through to live
  // navigation exactly as before.
  if (hand.currentNode.street === "preflop") {
    const local = localPreflopNavigation(hand, heroPos, body);
    if (local) {
      return c.json({ ...base, spot, notes, deferred: outcome.ok ? undefined : outcome.reason, navigation: local });
    }
  }
  const navigation = await navLock.run(() => navigateViaUrl(hand, heroPos, body));
  return c.json({ ...base, spot, notes, deferred: outcome.ok ? undefined : outcome.reason, navigation });
});

/**
 * URL-FIRST navigation — the whole line encoded in one /solutions URL and
 * verified by read-back. Replaces the click-walk (setupSpot / openPreflopLine
 * / setCards / replayHeroChecks / respondToBet): GTO Wizard's own line-loader
 * applies every action deterministically, hero's pending node is left active,
 * and the answer is read there. Works identically for preflop and postflop.
 */
/** GTO Wizard's off-tree overlay — a property of the SPOT, not a global block:
 *  navigating to a different (or repaired) line clears it. */
const isNoSolutionOverlay = (b: { blocked: boolean; message?: string }): boolean =>
  b.blocked && /no solution for this spot/i.test(b.message ?? "");

/**
 * Sizes actually offered at a tree node, discovered by prefix-probing and
 * remembered per (gametype, depth, line-prefix). Populated as off-tree hands
 * are repaired, so a repeated spot shape (villain opening odd sizes from the
 * same position) snaps on the first navigation with no extra probe.
 */
const nodeLabelCache = new Map<string, string[]>();

/** Depth: explicit > min(hero, live villains) stack snapped to a library depth. */
const resolveDepth = (body: IngestBody, hand: ParsedHand, depths: number[]): number => {
  if (body.depth) return body.depth;
  const stacks = hand.stacks ?? {};
  const heroStack = stacks[hand.heroSeatId];
  const candidates =
    heroStack != null && heroStack > 0
      ? [heroStack]
      : Object.values(stacks).filter((s) => Number.isFinite(s) && s > 0);
  const eff = candidates.length ? Math.min(...candidates) : 100;
  return depths.reduce((a, b) => (Math.abs(b - eff) < Math.abs(a - eff) ? b : a));
};

/**
 * Preflop answer from the LOCAL crawled DB (services/preflopDb) — the whole
 * point of the crawl: hero's strategy in ~0ms with no GTO Wizard traffic.
 *
 * Set routing: an explicit body.setId wins; otherwise a 2-handed table maps
 * to the true heads-up tree (dealer BTN→SB) and everything else to 6max.
 * Returns null on ANY miss — uncrawled node, unknown set, position mismatch —
 * so the caller falls back to live navigation with identical semantics.
 */
function localPreflopNavigation(hand: ParsedHand, heroPos: string | null, body: IngestBody) {
  const present = new Set([...Object.values(hand.positions), ...(heroPos ? [heroPos] : [])]);
  const setId = body.setId ?? (present.size <= 2 ? "hu" : "6max");
  const set = SOLUTION_SETS.find((s) => s.id === setId);
  if (!set) return null;
  const isHuSet = set.seats.length === 2;
  const depth = resolveDepth(body, hand, set.depths?.length ? set.depths : [100]);
  if (!preflopDb.available(set.gametype, depth)) return null;

  const tokens = isHuSet ? buildPreflopTokensHu(hand, heroPos) : buildPreflopTokens(hand, heroPos);
  const heroCards = hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c));
  let heroClass: string | null = null;
  if (heroCards.length === 2) {
    try { heroClass = parseHandClass(heroCards.join("")); } catch { heroClass = null; }
  }

  const ans = preflopDb.answer(set.gametype, depth, tokens, heroClass);
  if (!ans.ok) return null;

  // the node's seat must be hero's (HU trees seat the dealer as SB)
  const heroPosMapped = heroPos && isHuSet && heroPos === "BTN" ? "SB" : heroPos;
  if (heroPosMapped && !ans.pos.toUpperCase().startsWith(heroPosMapped.toUpperCase())) return null;

  return {
    ok: true as const,
    source: "local" as const,
    setId,
    depth,
    street: "preflop",
    line: ans.line,
    activeNode: { pos: ans.pos },
    approx: ans.repaired.length > 0 || undefined,
    repaired: ans.repaired.length ? ans.repaired : undefined,
    // hand-not-in-range is a fact about the hand, not solver health — flag it
    // so the poller's wedge detector ignores the missing decision
    offTree: ans.notInRange || undefined,
    response: {
      ok: true as const,
      hand: heroClass,
      actions: ans.actions,
      decision: ans.decision,
      notInRange: ans.notInRange,
    },
  };
}

const STREET_ORDER: readonly Street[] = ["preflop", "flop", "turn", "river"];
interface FlatToken { street: Street; tok: string }
const flattenTokens = (tokens: Partial<Record<Street, string[]>>): FlatToken[] =>
  STREET_ORDER.flatMap((s) => (tokens[s] ?? []).map((tok) => ({ street: s, tok })));
const unflattenTokens = (flat: FlatToken[]): Partial<Record<Street, string[]>> => {
  const out: Partial<Record<Street, string[]>> = {};
  for (const f of flat) (out[f.street] ??= []).push(f.tok);
  return out;
};

async function navigateViaUrl(hand: ParsedHand, heroPos: string | null, body: IngestBody) {
  if (!(await gtowCdp.isConnected())) {
    return { ok: false, error: "GTO Wizard not connected." };
  }
  const blocker = await gtowCdp.studyBlocker().catch(() => ({ blocked: false as const }));
  if (blocker.blocked && !isRecoverableBlocker(blocker) && !isNoSolutionOverlay(blocker)) {
    // Only the daily browsing-limit overlay (code "429") is actually transient —
    // other messages won't clear on their own. A leftover "no solution for
    // this spot" overlay from the PREVIOUS hand is the exception: navigating
    // the new line replaces the page, so it must never poison later hands.
    const resets = "code" in blocker && blocker.code === "429" ? " Navigation resumes when the limit resets." : "";
    return {
      ok: false,
      blocked: true,
      error: `GTO Wizard is unavailable: ${("message" in blocker && blocker.message) || "usage limit reached"} — the parsed node above is ready.${resets}`,
    };
  }

  const setId = body.setId ?? "6max";
  const set = SOLUTION_SETS.find((s) => s.id === setId);
  if (!set) return { ok: false, error: `Unknown solution set: ${setId}` };
  const depth = resolveDepth(body, hand, set.depths?.length ? set.depths : [100]);

  const built = buildSolutionUrl({ gametype: set.gametype, depth, hand, heroPos });

  // ---- Off-tree repair loop ----
  // Try the exact line first (free, usually lands). When GTO Wizard reports
  // "no solution for this spot", the line contains an off-tree size:
  //   postflop → try the app's own ⚡ Fast Mode solve (seconds) if offered;
  //   otherwise → prefix-probe the first unverified aggressive action to
  //   discover the node's REAL sizes, snap ours to the closest (log-space,
  //   see snapToken), and renavigate. Discovered sizes are cached so a
  //   repeated spot shape repairs with no extra navigation.
  let flat = flattenTokens(built.tokens);
  const isAggressive = (tok: string) => /^R\d/.test(tok);
  const cacheKeyAt = (k: number) =>
    `${set.gametype}|${depth}|` + flat.slice(0, k).map((f) => f.street[0] + f.tok).join("-");
  const boardForStreet = (s: Street) =>
    s === "preflop" ? "" : built.board.slice(0, { flop: 6, turn: 8, river: 10 }[s as "flop" | "turn" | "river"] ?? 10);
  const repaired: { street: Street; from: number; to: number }[] = [];

  // cache pre-pass: snap any size whose node we've already discovered
  for (let k = 0; k < flat.length; k++) {
    if (!isAggressive(flat[k]!.tok)) continue;
    const cached = nodeLabelCache.get(cacheKeyAt(k));
    if (!cached) continue;
    const s = snapToken(flat[k]!.tok, cached);
    if (s.snapped) {
      flat[k] = { ...flat[k]!, tok: s.token };
      repaired.push({ street: flat[k]!.street, from: s.from!, to: s.to! });
    }
  }

  let navsLeft = 6; // hard budget: full navigations + probes, ~3-4s each
  const navigateFull = async () => {
    navsLeft--;
    return gtowCdp.gotoNodeUrl(
      buildSearchFromTokens({ gametype: set.gametype, depth, tokens: unflattenTokens(flat), board: built.board })
    );
  };

  let nav = await navigateFull();
  if (!nav.ok && !nav.blocked && navsLeft > 0) {
    // flaky right after the app's own error overlays — one fresh retry
    nav = await navigateFull();
  }

  let fastSolved = false;
  const probedIdx = new Set<number>();
  while (!(nav.ok && nav.active.pos) && navsLeft > 0) {
    const over = await gtowCdp.studyBlocker().catch(() => ({ blocked: false as const }));
    const offTree = isNoSolutionOverlay(over) || (nav.ok && !nav.active.pos);
    if (!offTree) {
      return { ok: false, blocked: nav.blocked, step: "gotoNodeUrl", error: nav.error ?? "Line didn't load.", intended: built.tokens };
    }

    // postflop: the app's own fast solve, when the overlay offers one
    if (hand.currentNode.street !== "preflop" && (await gtowCdp.tryFastSolveOverlay())) {
      const state = await gtowCdp.readNodeState();
      if (state.active.pos) {
        nav = { ok: true, taken: state.taken, active: state.active };
        fastSolved = true;
        break;
      }
    }

    // discover the real sizes at the first unverified aggressive action
    const k = flat.findIndex((f, i) => isAggressive(f.tok) && !probedIdx.has(i));
    if (k < 0) {
      return {
        ok: false, offTree: true, repaired: repaired.length ? repaired : undefined, intended: built.tokens,
        error: "Spot is off-tree and every aggressive size already matches the library — this line has no solution (e.g. a multiway or limped pot the tree doesn't cover).",
      };
    }
    probedIdx.add(k);
    navsLeft--;
    const probe = await gtowCdp.gotoNodeUrl(
      buildSearchFromTokens({
        gametype: set.gametype, depth,
        tokens: unflattenTokens(flat.slice(0, k)),
        board: boardForStreet(flat[k]!.street),
        spot: k,
      })
    );
    if (!probe.ok || !probe.active.labels.length) {
      return {
        ok: false, offTree: true, repaired: repaired.length ? repaired : undefined, intended: built.tokens,
        error: `Off-tree, and probing the ${flat[k]!.street} node's real sizes failed${probe.error ? `: ${probe.error}` : "."}`,
      };
    }
    nodeLabelCache.set(cacheKeyAt(k), probe.active.labels);
    const s = snapToken(flat[k]!.tok, probe.active.labels);
    if (s.snapped) {
      flat[k] = { ...flat[k]!, tok: s.token };
      repaired.push({ street: flat[k]!.street, from: s.from!, to: s.to! });
      if (navsLeft > 0) nav = await navigateFull();
    }
    // no snap → this action was already on-tree; loop probes the next one
  }
  if (!(nav.ok && nav.active.pos)) {
    return {
      ok: false, offTree: true, repaired: repaired.length ? repaired : undefined, intended: built.tokens,
      error: "Line is off-tree and couldn't be repaired within the navigation budget.",
    };
  }

  // verify hero's own node is the active one (position match)
  if (heroPos && nav.active.pos && nav.active.pos !== heroPos) {
    return {
      ok: false,
      step: "verify",
      error: `Landed on ${nav.active.pos}'s node, expected hero (${heroPos}). Intended line: ${JSON.stringify(built.tokens)}; got: ${nav.taken.map((t) => `${t.pos} ${t.label}`).join(", ")}.`,
      intended: built.tokens,
      taken: nav.taken,
    };
  }

  // read hero's strategy at the (now active) node — class grid preflop, exact
  // combo postflop; decideCombo routes by street.
  const heroCards = hand.heroCards.filter((c) => /^[2-9TJQKA][shdc]$/.test(c));
  const heroHand = heroCards.length === 2 ? heroCards.join("") : null;
  const response = heroHand ? await gtowCdp.decideCombo(heroHand) : null;

  // did every REQUESTED aggressive size land on-tree, or did the app snap
  // one? compare against the final (repaired) tokens per street, by index.
  const finalTokens = unflattenTokens(flat);
  const perStreetIdx: Record<string, number> = {};
  const snapped = nav.taken.some((t) => {
    const i = perStreetIdx[t.street] ?? 0;
    perStreetIdx[t.street] = i + 1;
    const intended = (finalTokens[t.street as never] as string[] | undefined)?.[i];
    if (!intended?.startsWith("R") || intended === "RAI") return false;
    const wantSize = intended.slice(1);
    const gotSize = t.label.match(/[\d.]+/)?.[0];
    return gotSize != null && gotSize !== wantSize;
  });

  await gtowCdp.syncStacksFilter(depth).catch(() => {});
  return {
    ok: true,
    depth,
    street: hand.currentNode.street,
    line: nav.taken.map((t) => `${t.pos} ${t.label}`),
    activeNode: nav.active,
    sizeSnapped: snapped,
    // the answer came from a translated line or a fresh fast solve, not the
    // exact sizes played — the panel marks it approximate
    approx: snapped || repaired.length > 0 || fastSolved || undefined,
    repaired: repaired.length ? repaired : undefined,
    fastSolved: fastSolved || undefined,
    response,
  };
}

export default app;
