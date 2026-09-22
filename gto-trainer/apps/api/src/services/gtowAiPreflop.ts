/**
 * gtowAiPreflop — GTO Wizard AI (Ultra) as the PREFLOP FALLBACK PIECE of the 6-max ring strategy.
 *
 * WHAT IT IS (2026-09-19, Brady: "add the AI fallback for our Ignition 200NL strategy, and name it
 * as one of our pieces"). The Ignition 200NL Ring 6-max Equilibrium strategy answers preflop from
 * our own HRC 6-max charts first — instant, and solved for exactly our rake. Those charts cover
 * 4-6 seats, the size ladder they were solved with, and 30-150bb. Everything outside that used to
 * be a MISS (the miss queue, "table shape outside the 6-max strategy", "line ends on a terminal",
 * off-tree sizes, past the ladder). This piece takes those spots to GTO Wizard's cloud preflop
 * solver, built from the ACTUAL table — the live stacks, the blinds and straddle as posted,
 * Ignition's rake for the number of players dealt, our size menu plus every size actually seen in
 * the line — and reads hero's combo out of the solved node. The answer is logged with
 * source "gtow-ai-preflop" / tier "ai-preflop", so the hand page, the Sources tab and Analytics
 * show exactly which piece answered.
 *
 * WHAT THE API DOES AND DOES NOT DO (probed 2026-09-19, see memory gtow-ai-preflop):
 *   - multiway preflop needs FIXED size menus (AUTOMATIC sizing is refused for 3+ players)
 *   - positions come in fixed sets by player count (2 SB/BB · 3 BTN/SB/BB · 4 CO/BTN/SB/BB ·
 *     5 HJ/CO/BTN/SB/BB · 6 UTG..BB); our earlier seats are relabelled onto that set in order
 *   - limps: max_allowed_limps 2 = ONE non-SB limper + the SB complete; a second limper is not in the tree
 *   - a straddle is just a blind on that player; antes are per player
 *   - a dead small blind cannot be expressed (SB blind 0 is refused) — the hand is approximated with
 *     the 5-seat set and the SB seat holding exactly its blind (a forced all-in blind)
 *   - one tree per table shape (positions + stacks + blinds + sizes); ~2-4 s to solve the root, 1-2 s
 *     per node after that; solutions are cached per shape for the process's life
 *
 * POSTFLOP (2026-09-19): when this piece answered preflop, the postflop chain conditions on THIS tree's
 * ranges — arrivalRangesGtowAi walks the same solved tree and exposes the chart piece's shape (position →
 * class → weight), so fastSolve.solvePostflop6maxStrategy reads one shape whichever piece answered.
 */
import type { ParsedHand, ParsedAction } from "../feed/parsePanelFeed/parsePanelFeed";
import { gtowApi } from "./gtowApi";
import { gtowSessions, type GtowNeed, type GtowSessionId } from "./gtowSessions";
import { comboIndex, toClassWeights, COMBOS } from "../utils/comboIndex/comboIndex";
import { pickWeightedAction, type WeightedPick } from "../utils/pickWeightedAction/pickWeightedAction";
import { rakeCapCents } from "./profiles";

export const GTOW_AI_PREFLOP_SOURCE = "gtow-ai-preflop" as const;
export const GTOW_AI_PREFLOP_TIER = "ai-preflop" as const;

const API_BASE = "https://api.gtowizard.com";
const ORDER = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const API_SETS: Record<number, string[]> = {
  2: ["SB", "BB"], 3: ["BTN", "SB", "BB"], 4: ["CO", "BTN", "SB", "BB"], 5: ["HJ", "CO", "BTN", "SB", "BB"], 6: ORDER,
};
/** Our size menu — the HRC grid's opens, three 3-bets per open, two 4-bets, one 5-bet+; every size the
 *  line actually contains is added on top so the walk lands on the exact node. */
const OPENS = ["2x", "2.2x", "2.5x", "3x", "3.5x"];
const THREE_BETS = ["3.2x", "3.8x", "4.5x"];
const FOUR_BETS = ["2.2x", "2.6x"];
const FIVE_PLUS = ["2.2x"];
const NODE_TIMEOUT_MS = 30_000;
const POLL_MS = 1200;

export interface AiPreflopShape {
  n: number;
  /** our position -> API position, in API order */
  apiOf: Record<string, string>;
  positions: string[];            // API order
  stacks: Record<string, number>; // by API position, starting stack in bb
  sb: number; bb: number;
  straddle: { pos: string; bb: number } | null;
  rakeCapBb: number;
  deadSb: boolean;
  heroApiPos: string | null;
}

export interface AiPreflopResult {
  ok: true;
  actions: { action: string; frequency: number }[];
  decision: WeightedPick | null;
  line: string;
  pos: string | null;
  heroClass: string | null;
  treeKey: string;
  solveSecs: number;
  cached: boolean;
  shape: AiPreflopShape;
  note: string;
}
export type AiPreflopOutcome = AiPreflopResult | { ok: false; reason: string; line?: string };

const round5 = (x: number) => Math.round(x * 2) / 2;
const num = (n: number) => String(Math.round(n * 100) / 100);

/** Hero's position: an override, his blind post, or the positions map. */
export function heroPosOf(hand: ParsedHand, heroPos: string | null): string | null {
  const post = hand.actions.find((a) => a.hero && (a.type === "post-sb" || a.type === "post-bb"));
  return (heroPos ?? hand.positions[hand.heroSeatId] ?? (post ? (post.type === "post-sb" ? "SB" : "BB") : null))?.toUpperCase() ?? null;
}

/** The table as the API must see it. */
export function shapeOf(hand: ParsedHand, heroPos: string | null): AiPreflopShape | { error: string } {
  const hp = heroPosOf(hand, heroPos);
  const seats: { seat: number; pos: string }[] = Object.entries(hand.positions).map(([s, p]) => ({ seat: Number(s), pos: p.toUpperCase() }));
  if (hp && !seats.some((x) => x.seat === hand.heroSeatId)) seats.push({ seat: hand.heroSeatId, pos: hp });
  const byPos = new Map(seats.map((x) => [x.pos, x.seat]));
  let present = [...new Set(seats.map((x) => x.pos))].filter((p) => ORDER.includes(p));
  if (present.length !== seats.length) return { error: `seat labels outside the 6-max set: ${seats.map((x) => x.pos).join(", ")}` };
  // heads-up: the dealer is the small blind
  if (present.length === 2 && present.includes("BTN") && !present.includes("SB")) {
    byPos.set("SB", byPos.get("BTN")!); byPos.delete("BTN"); present = present.map((p) => (p === "BTN" ? "SB" : p));
  }
  // a hand with no small blind (the seat emptied between hands): the API cannot express it —
  // model the missing SB as a seat holding exactly its blind (a forced all-in blind)
  const deadSb = !present.includes("SB") && present.includes("BB") && present.length >= 2;
  const ordered = present.slice().sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const n = ordered.length + (deadSb ? 1 : 0);
  if (n < 2 || n > 6) return { error: `${n} seats: the AI preflop piece covers 2-6` };
  const set = API_SETS[n]!;
  const apiOf: Record<string, string> = {};
  const nonBlinds = ordered.filter((p) => p !== "SB" && p !== "BB");
  const apiNonBlinds = set.filter((p) => p !== "SB" && p !== "BB");
  nonBlinds.forEach((p, i) => { apiOf[p] = apiNonBlinds[i]!; });
  if (ordered.includes("SB")) apiOf.SB = "SB";
  if (ordered.includes("BB")) apiOf.BB = "BB";
  const sbPost = hand.actions.find((a) => a.type === "post-sb");
  const bbPost = hand.actions.find((a) => a.type === "post-bb");
  const sb = sbPost?.amount ?? 0.5, bb = bbPost?.amount ?? 1;
  const stacks: Record<string, number> = {};
  for (const p of ordered) {
    const seat = byPos.get(p)!;
    const cur = hand.stacks?.[seat];
    const committed = hand.committed?.[seat] ?? 0;
    stacks[apiOf[p]!] = Math.min(999, Math.max(1, round5((cur != null ? cur + committed : 100))));
  }
  if (deadSb) stacks.SB = sb;
  const bbCents = hand.bbCents ?? 200;
  const rakeCapBb = Math.round((rakeCapCents(n) / bbCents) * 100) / 100;
  return { n, apiOf, positions: set, stacks, sb, bb, straddle: null, rakeCapBb, deadSb, heroApiPos: hp ? (apiOf[hp] ?? null) : null };
}

/** The line so far as the API walks it: seat order, F / C / X / R<total bb>; also the raise totals by level. */
export function lineOf(hand: ParsedHand, shape: AiPreflopShape): { tokens: string[]; levels: number[] } {
  const tokens: string[] = []; const levels: number[] = [];
  const posOf = (a: ParsedAction) => (a.hero ? heroPosOf(hand, null) : hand.positions[a.seatId]?.toUpperCase()) ?? null;
  // the API's tree acts in its own seat order; a seat that never acted before the line reaches
  // a later seat is a fold it did not show — pad it, exactly as the chart walk does
  const order = shape.positions.slice();                // API order
  const acted = hand.actions.filter((a) => a.street === "preflop" && a.type !== "post-sb" && a.type !== "post-bb");
  let cursor = 0;
  const pendingHero = !hand.ended && hand.currentNode.street === "preflop" && hand.currentNode.toActIsHero;
  const heroApi = shape.heroApiPos;
  for (let round = 0; round < 4 && cursor < acted.length; round++) {
    for (const api of order) {
      if (cursor >= acted.length) break;
      const a = acted[cursor]!;
      const aApi = posOf(a) ? shape.apiOf[posOf(a)!] ?? null : null;
      if (aApi === api || aApi == null) {
        if (a.type === "fold") tokens.push("F");
        else if (a.type === "check") tokens.push("X");
        else if (a.type === "call") tokens.push("C");
        else if (a.type === "raise" || a.type === "bet" || a.type === "all-in") { const t = a.amount ?? 0; levels.push(t); tokens.push(`R${num(t)}`); }
        else tokens.push("C");
        cursor++;
      } else if (round === 0 && api !== heroApi && !tokens.length && api === "SB") {
        // nothing to pad before the first action in the blinds
      } else if (round === 0 && !levels.length && api !== "SB" && api !== "BB" && !(pendingHero && api === heroApi)) {
        tokens.push("F");   // an early seat with no recorded action before a later seat acted: it folded
      }
    }
  }
  return { tokens, levels };
}

/** Size menus. The tree's size is (sizes per level)^levels × seats, and the API refuses a tree past its ceiling
 *  ("TREE_IS_TOO_BIG" — a 3-handed tree with 5 opens × 3 three-bets tripped it). So HERO's seat carries the menu
 *  (his decision is what we read), every other seat carries the size it actually used (or one default), and the
 *  line's own sizes are always present so the walk lands on the exact node. Heads-up trees are small enough for
 *  the full menu on both seats. */
export function menus(levels: number[], n: number) {
  // THREE DECIMALS, not one (2026-09-19). A rounded ratio puts the tree's node a few
  // hundredths of a blind from the size actually played; repairLine now walks onto it
  // either way, but a menu that lands exactly keeps that walk a rare path rather than
  // the normal one — and keeps the strategy read on the size that was really faced.
  const add = (base: string[], v: number | null) => (v && v > 1 ? [...new Set([...base, `${Math.round(v * 1000) / 1000}x`])] : base);
  const l0 = levels[0] ?? null, l1 = levels[1] && levels[0] ? levels[1] / levels[0] : null;
  const l2 = levels[2] && levels[1] ? levels[2] / levels[1] : null, l3 = levels[3] && levels[2] ? levels[3] / levels[2] : null;
  const hero = n <= 2
    ? { opens: add(OPENS, l0), three: add(THREE_BETS, l1), four: add(FOUR_BETS, l2), five: add(FIVE_PLUS, l3) }
    : { opens: add(["2.2x", "2.5x", "3x"], l0), three: add(["3.5x"], l1), four: add(["2.3x"], l2), five: add(FIVE_PLUS, l3) };
  const villain = n <= 2 ? hero
    : { opens: add(["2.5x"], l0), three: add(["3.5x"], l1), four: add(["2.3x"], l2), five: add(FIVE_PLUS, l3) };
  return { hero, villain };
}

function treeBody(shape: AiPreflopShape, m: ReturnType<typeof menus>) {
  const sizes = (position: string) => {
    const s = position === shape.heroApiPos ? m.hero : m.villain;
    // calls of opens and cold-calls of 3-bets+ must be switched on explicitly in FIXED mode (the web app's own
    // defaults: ccVs2b on, ccVs3bPlus off — we want both, a fish's line is anything)
    return { position, type: "FIXED", use_fixed_sizes: true, allow_limp: true, allow_call_opens: true, allow_3betplus_cold_calls: true,
      bet_sizes: s.opens, raise_sizes: s.three, second_raise_sizes: s.four, third_plus_raise_sizes: s.five };
  };
  return {
    starting_street: "PREFLOP", pot: 0, ante: null, ante_distribution_method: "PER_PLAYER",
    max_allowed_limps: shape.n >= 3 ? 2 : null,
    bet_sizes: { allin_threshold: 60, allin_if_less_than: 500, merge_sizes_threshold: 10, max_num_raises: 5,
      street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: shape.positions.map(sizes) }] },
    players: shape.positions.map((p) => ({
      position: p, display_position: p,
      blind: p === "SB" ? shape.sb : p === "BB" ? shape.bb : (shape.straddle?.pos === p ? shape.straddle.bb : null),
      range: null, stack: shape.stacks[p] ?? 100, tournament_instant_bounty: null, tournament_total_bounty: null,
    })),
    tree_operations: [], resolving_policy: null,
    rake: { pct_of_pot: 5, cap_in_chips: shape.rakeCapBb, preflop_rake_type: "no_flop_no_drop" },
    tournament_data: null,
  };
}

export const treeKeyOf = (shape: AiPreflopShape, m: ReturnType<typeof menus>) =>
  JSON.stringify([shape.positions, shape.positions.map((p) => shape.stacks[p]), shape.sb, shape.bb, shape.straddle, shape.rakeCapBb, shape.heroApiPos, m]);

const solutions = new Map<string, Promise<{ solId: string } | { error: string }>>();
const nodes = new Map<string, any>();

/**
 * Which ACCOUNT minted each preflop solution. Same rule as the postflop chain
 * (services/gtowApi.ts): a cloud solve lives on the account that created it, so
 * every poll of it must carry that account's token. Keeping the owner here lets
 * `fetchNode(solId, line)` stay a two-argument call at all seven of its sites.
 */
const owners = new Map<string, GtowSessionId>();

/**
 * Every tree here is PREFLOP, which Brady routes to the Ultra account whatever
 * the table size (2026-09-21) — the Elite account is for heads-up POSTFLOP.
 * A tree with more than two seats is additionally MULTIWAY, which Elite's AI
 * refuses outright (`PREFLOP_MULTIWAY_NOT_ALLOWED`), so that one is a hard
 * filter rather than a preference. The pool is told both.
 */
async function ensureSolution(key: string, body: any, need: GtowNeed = {}): Promise<{ solId: string } | { error: string }> {
  const hit = solutions.get(key);
  if (hit) return hit;
  const p = (async () => {
    // A recorded wall is a guess; when it leaves nothing routable, try the
    // walled sessions anyway rather than refusing the spot (see gtowApi).
    const ids = gtowSessions.route(need);
    const candidates = ids.length ? ids : gtowSessions.routeIgnoringBlocks(need);
    if (!candidates.length) {
      return { error: need.multiway
        ? "no GTO Wizard session can solve a multiway preflop tree (the Ultra account is down or out of allowance)"
        : "no GTO Wizard token (no session attached)" };
    }
    let last = "no GTO Wizard token";
    for (const id of candidates) {
      const token = await gtowSessions.tokenFor(id);
      if (!token) { last = `${id}: no token`; continue; }
      const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const tr = await fetch(`${API_BASE}/v4/custom-solutions/custom-trees/`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (!tr.ok) {
        const b = (await tr.text().catch(() => "")).slice(0, 200);
        gtowSessions.noteFailure(id, tr.status, b, need);
        last = `custom-trees ${tr.status}: ${b}`;
        continue; // a refusal here is this ACCOUNT's, not the tree's — try the next
      }
      const tree = await tr.json();
      const so = await fetch(`${API_BASE}/v4/custom-solutions/`, { method: "POST", headers: H, body: JSON.stringify({ custom_tree_id: tree.id, actions: "", board: "" }), signal: AbortSignal.timeout(20_000) });
      if (!so.ok) {
        const b = (await so.text().catch(() => "")).slice(0, 200);
        gtowSessions.noteFailure(id, so.status, b, need);
        last = `custom-solutions ${so.status}: ${b}`;
        continue;
      }
      const sol = await so.json();
      const solId = String(sol.id);
      owners.set(solId, id);
      if (owners.size > 400) owners.delete(owners.keys().next().value as string);
      gtowSessions.noteSuccess(id, { tree: true });
      return { solId };
    }
    return { error: last };
  })();
  solutions.set(key, p);
  p.then((r) => { if ("error" in r) solutions.delete(key); }).catch(() => solutions.delete(key));
  if (solutions.size > 200) solutions.delete(solutions.keys().next().value as string);
  return p;
}

async function fetchNode(solId: string, line: string): Promise<{ data: any; cached: boolean } | { error: string }> {
  const k = `${solId}|${line}`;
  const hit = nodes.get(k);
  if (hit) return { data: hit, cached: true };
  const t0 = Date.now();
  let last = "the cloud did not return the node in time";
  const owner = owners.get(solId) ?? null;
  while (Date.now() - t0 < NODE_TIMEOUT_MS) {
    const token = owner ? await gtowSessions.tokenFor(owner) : (await gtowSessions.bestToken({ preflop: true }))?.token ?? null;
    if (!token) return { error: `no GTO Wizard token for the session that owns this solve${owner ? ` (${owner})` : ""}` };
    const params = new URLSearchParams({ custom_solution_id: solId, preflop_actions: line, flop_actions: "", turn_actions: "", river_actions: "", board: "" });
    let r: Response;
    try { r = await fetch(`${API_BASE}/v4/solutions/spot-solution/?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) }); }
    catch (e) { last = `poll failed: ${e instanceof Error ? e.message : e}`; await new Promise((res) => setTimeout(res, POLL_MS)); continue; }
    if (r.ok && r.status !== 204) {
      const j = await r.json().catch(() => null);
      if (j?.action_solutions?.length) { nodes.set(k, j); if (nodes.size > 2000) nodes.delete(nodes.keys().next().value as string); return { data: j, cached: false }; }
    } else if (!r.ok && r.status !== 404) {
      const t = await r.text().catch(() => "");
      if (r.status === 400 || r.status === 422) return { error: `${r.status}: ${t.slice(0, 160)}` };
      last = `spot-solution ${r.status}: ${t.slice(0, 120)}`;
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  return { error: last };
}

const heroClass = (cards: string[]): string | null => {
  if (cards.length !== 2) return null;
  const R = "23456789TJQKA";
  const [a, b] = cards.map((c) => c[0]!.toUpperCase());
  const [sa, sb] = cards.map((c) => c[1]!.toLowerCase());
  const hi = R.indexOf(a!) >= R.indexOf(b!) ? a : b, lo = hi === a ? b : a;
  return a === b ? `${a}${b}` : `${hi}${lo}${sa === sb ? "s" : "o"}`;
};

/** An API action into our action label ("Fold", "Call", "Check", "Raise 2.5", "All-in"). The API's action
 *  carries `type` (FOLD / CALL / CHECK / RAISE), `betsize` (the seat's total in bb, a string), `allin`, and
 *  `code` (F / C / X / R<bb> — the same token the walk uses). */
/**
 * Which offered action a line token means, at one node.
 *
 * Tokens are OUR reading of the table ("R14.4"); the tree's actions are ITS OWN grid.
 * A raise matches by nearest size, because the two only ever agree by luck — see
 * repairLine.
 */
export function matchToken(tok: string, sols: any[]): { code: string; betsize: number | null } | null {
  const of = (a: any) => ({
    code: String(a?.action?.code ?? ""),
    type: String(a?.action?.type ?? a?.action?.display_name ?? "").toUpperCase(),
    bb: Number(a?.action?.betsize),
  });
  const all = sols.map(of).filter((a) => a.code);
  const exact = all.find((a) => a.code === tok);
  if (exact) return { code: exact.code, betsize: Number.isFinite(exact.bb) ? exact.bb : null };
  const want = /^R([\d.]+)$/.exec(tok);
  if (want) {
    const target = parseFloat(want[1]!);
    const raises = all.filter((a) => (a.type.startsWith("RAISE") || a.type.startsWith("BET")) && Number.isFinite(a.bb));
    if (!raises.length) return null;
    const best = raises.reduce((b, a) => (Math.abs(a.bb - target) < Math.abs(b.bb - target) ? a : b));
    return { code: best.code, betsize: best.bb };
  }
  const kind = tok === "F" ? "FOLD" : tok === "C" ? "CALL" : tok === "X" ? "CHECK" : null;
  const hit = kind ? all.find((a) => a.type.startsWith(kind)) : null;
  return hit ? { code: hit.code, betsize: null } : null;
}

/**
 * The exact node path for a line the tree would otherwise reject.
 *
 * THE MENU CANNOT GUARANTEE THE NODE (2026-09-19, hand 4919236052). menus() adds every
 * size the line contains, but as a ROUNDED multiplier of the level below it — and the
 * villain's own click is under no obligation to be a round multiple of anything. A 4-bet
 * to 14.4 over a 9.2 three-bet is 1.5652x, which the menu stores as a rounded ratio, so
 * the tree holds a node a few hundredths of a blind away and the walk asks for one that
 * does not exist. GTO Wizard answers NODE_DOES_NOT_EXIST, the 6-max charts had already
 * declined (that is why we are here at all), and the hand gets no answer on any street —
 * twenty-one of them in that hand, because the postflop chain reads its arrival ranges
 * from this same node.
 *
 * So the line is WALKED instead of assumed: each token is matched against the actions
 * the tree actually offers at that point and replaced by the one it means, nearest size
 * for a raise. This is what the postflop chain already does (snapPostflopStreets,
 * matchActionLoose); preflop was the half that trusted its own arithmetic.
 *
 * Every prefix visited is cached by fetchNode, so the probe that pays for the walk is
 * the one that failed — the next tick's re-ask lands on cached nodes and answers at once.
 */
async function repairLine(solId: string, tokens: string[]): Promise<{ line: string; changed: string[] } | { error: string }> {
  const out: string[] = [];
  const changed: string[] = [];
  for (const tok of tokens) {
    const at = out.join("-");
    const node = await fetchNode(solId, at);
    if ("error" in node) return { error: `walking '${at || "root"}': ${node.error}` };
    const sols = (node.data?.action_solutions as any[]) ?? [];
    const pick = matchToken(tok, sols);
    if (!pick) {
      const offered = sols.map((a) => String(a?.action?.code ?? "?")).join(", ");
      return { error: `'${tok}' is not offered at '${at || "root"}' (offered: ${offered})` };
    }
    if (pick.code !== tok) changed.push(`${tok}→${pick.code}`);
    out.push(pick.code);
  }
  return { line: out.join("-"), changed };
}

function labelOf(action: any): string {
  const type = String(action?.type ?? action?.display_name ?? "").toUpperCase();
  const bb = Number(action?.betsize);
  if (action?.allin === true) return "All-in";
  if (type.startsWith("FOLD")) return "Fold";
  if (type.startsWith("CHECK")) return "Check";
  if (type.startsWith("CALL")) return "Call";
  if (type.startsWith("RAISE") || type.startsWith("BET")) return Number.isFinite(bb) && bb > 0 ? `Raise ${Math.round(bb * 100) / 100}` : "Raise";
  return String(action?.code ?? type ?? "?");
}

/**
 * Solve hero's preflop decision with GTO Wizard AI, from the table as it stands.
 * `why` is the reason the charts could not answer — it rides along in the note so the
 * answer trail says both what answered and why the primary piece did not.
 */
export async function solvePreflopGtowAi(hand: ParsedHand, heroPos: string | null, why: string): Promise<AiPreflopOutcome> {
  const t0 = Date.now();
  const shape = shapeOf(hand, heroPos);
  if ("error" in shape) return { ok: false, reason: `GTO Wizard AI preflop: ${shape.error}` };
  const { tokens, levels } = lineOf(hand, shape);
  const line = tokens.join("-");
  const m = menus(levels, shape.n);
  const key = treeKeyOf(shape, m);
  const sol = await ensureSolution(key, treeBody(shape, m), { multiway: shape.n > 2, preflop: true });
  if ("error" in sol) return { ok: false, reason: `GTO Wizard AI preflop: ${sol.error}`, line };
  let node = await fetchNode(sol.solId, line);
  let snapped: string[] = [];
  if ("error" in node && /NODE_DOES_NOT_EXIST/i.test(node.error)) {
    // the tree has this line, just not under the sizes we named — walk it and find out
    const fixed = await repairLine(sol.solId, tokens);
    if ("error" in fixed) {
      return { ok: false, reason: `GTO Wizard AI preflop: node '${line || "root"}' does not exist and the line could not be walked — ${fixed.error}`, line };
    }
    snapped = fixed.changed;
    node = await fetchNode(sol.solId, fixed.line);
    if ("error" in node) {
      return { ok: false, reason: `GTO Wizard AI preflop: node '${fixed.line || "root"}' (walked from '${line}') — ${node.error}`, line };
    }
  }
  if ("error" in node) return { ok: false, reason: `GTO Wizard AI preflop: node '${line || "root"}' — ${node.error}`, line };
  const j = node.data;
  const toAct = j.game?.players?.find((p: any) => p.is_hero)?.position ?? null;
  if (shape.heroApiPos && toAct && toAct !== shape.heroApiPos) {
    return { ok: false, reason: `GTO Wizard AI preflop: the walked line puts ${toAct} on the clock, not hero (${shape.heroApiPos}) — line '${line}' does not match the table`, line };
  }
  const idx = hand.heroCards.length === 2 ? comboIndex(hand.heroCards[0]!, hand.heroCards[1]!) : null;
  if (idx == null) return { ok: false, reason: "GTO Wizard AI preflop: hero's cards are not known", line };
  // the node's per-combo strategy is a 0-1 fraction; our chart mixes are PERCENT (Q8o: {Fold: 99.97}), and
  // the panel text / hand card format them as such — so the fallback speaks percent too
  let actions = (j.action_solutions as any[]).map((a) => ({ action: labelOf(a.action), frequency: Number(a.strategy?.[idx] ?? 0) }));
  const sum = actions.reduce((s, a) => s + a.frequency, 0);
  if (sum <= 1.5) actions = actions.map((a) => ({ ...a, frequency: a.frequency * 100 }));
  actions = actions.filter((a) => a.frequency > 0.05).map((a) => ({ ...a, frequency: Math.round(a.frequency * 100) / 100 }));
  const decision = actions.length ? pickWeightedAction(actions) : null;
  const secs = (Date.now() - t0) / 1000;
  const shapeText = `${shape.n}-handed · ${shape.positions.map((p) => `${p} ${shape.stacks[p]}bb`).join(", ")} · rake 5% cap ${shape.rakeCapBb}bb${shape.deadSb ? " · dead SB approximated" : ""}`;
  return {
    ok: true, actions, decision, line, pos: shape.heroApiPos, heroClass: heroClass(hand.heroCards), treeKey: key,
    solveSecs: secs, cached: node.cached, shape,
    note: `GTO Wizard AI preflop (Ultra) answered because the 6-max charts could not: ${why}. Tree built from the table — ${shapeText}; solved in ${secs.toFixed(1)} s${node.cached ? " (cached)" : ""}.`
      + (snapped.length ? ` Sizes snapped to the tree's own: ${snapped.join(", ")}.` : ""),
  };
}

/** Pre-build the tree + solution for a hand's shape (no node fetched) — called from the poller's tick so
 *  hero's turn only pays the node fetch. Silent on failure. */
export function warmPreflopGtowAi(hand: ParsedHand, heroPos: string | null): void {
  try {
    const shape = shapeOf(hand, heroPos);
    if ("error" in shape) return;
    const { levels } = lineOf(hand, shape);
    const m = menus(levels, shape.n);
    const key = treeKeyOf(shape, m);
    if (solutions.has(key)) return;
    const t0 = Date.now();
    void ensureSolution(key, treeBody(shape, m), { multiway: shape.n > 2, preflop: true }).then((r) => {
      if ("solId" in r) console.log(`[gtow-ai-preflop] warmed ${shape.n}-handed tree in ${Date.now() - t0} ms`);
    });
  } catch { /* a warm-up never fails anything */ }
}

export const gtowAiPreflopStats = () => ({ trees: solutions.size, nodes: nodes.size });

/** The exact request a hand would produce (for tests and the state tester — nothing is sent). */
export function debugTree(hand: ParsedHand, heroPos: string | null): { shape: AiPreflopShape; line: string; body: any } | { error: string } {
  const shape = shapeOf(hand, heroPos);
  if ("error" in shape) return shape;
  const { tokens, levels } = lineOf(hand, shape);
  const m = menus(levels, shape.n);
  return { shape, line: tokens.join("-"), body: treeBody(shape, m) };
}

// ---------------------------------------------------------------------------
// ARRIVAL RANGES FROM THE AI PREFLOP TREE (2026-09-19, Brady: "make the AI
// preflop fallback and the 6-max charts expose the same shape for the AI
// postflop to read"). The postflop chain consumes ReconstructResult — position
// → hand class → weight in [0,1] — however the preflop was answered. The chart
// piece produces it by walking the crawled chart nodes (reconstructFlopRanges);
// this produces the identical shape by walking the SAME custom tree that
// answered preflop: every seat starts at the full 1326, each node multiplies
// the actor's range by its per-combo strategy for the action taken, a fold
// removes the seat. Villain raises condition on the union of the node's raise
// sizes, exactly as the chart walk does (a single-sizer's range is not the
// equilibrium slice that mixes into one size).
// ---------------------------------------------------------------------------

/** POST a tree and return what the API stores for it — every field it accepts, with its own defaults filled
 *  in. The custom-tree schema is not published anywhere, and unknown keys are silently DROPPED rather than
 *  rejected, so guessing field names proves nothing; this is the only way to see the real vocabulary
 *  (scripts/_probeTreeSchema.ts, 2026-09-20). */
export async function debugCreateTree(hand: ParsedHand, heroPos: string | null, patch?: Record<string, unknown>, posPatch?: Record<string, unknown>): Promise<any> {
  const shape = shapeOf(hand, heroPos);
  if ("error" in shape) return { error: shape.error };
  const { levels } = lineOf(hand, shape);
  const body: any = { ...treeBody(shape, menus(levels, shape.n)), ...(patch ?? {}) };
  if (posPatch) {
    for (const st of body.bet_sizes?.street_bet_sizes ?? []) {
      st.position_bet_sizes = st.position_bet_sizes.map((x: any) => ({ ...x, ...posPatch }));
    }
  }
  const token = (await gtowSessions.bestToken({ multiway: shape.n > 2, preflop: true }))?.token ?? null;
  if (!token) return { error: "no GTO Wizard token" };
  const r = await fetch(`${API_BASE}/v4/custom-solutions/custom-trees/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  return { status: r.status, sent: body, got: (() => { try { return JSON.parse(text); } catch { return text; } })() };
}

/** Solve this hand's tree and read ONE node's offered actions./** Solve this hand's tree and read ONE node's offered actions. Exists to probe WHICH MULTIWAY LINES the AI
 *  preflop tree actually contains — "allow_call_opens" turns cold-calling on, but the tree still caps how many
 *  callers a node will offer, and a line past that cap fails mid-walk with nothing saying which node ran out
 *  (scripts/_probe5wayArrival.ts, 2026-09-20). */
export async function debugPreflopNode(hand: ParsedHand, heroPos: string | null, line: string, patch?: Record<string, unknown>, posPatch?: Record<string, unknown>): Promise<
  { ok: true; actor: string | null; actions: { code: string; freq: number | null }[] } | { ok: false; reason: string }
> {
  const shape = shapeOf(hand, heroPos);
  if ("error" in shape) return { ok: false, reason: shape.error };
  const { levels } = lineOf(hand, shape);
  const body: any = { ...treeBody(shape, menus(levels, shape.n)), ...(patch ?? {}) };
  if (posPatch) {
    for (const st of body.bet_sizes?.street_bet_sizes ?? []) {
      st.position_bet_sizes = st.position_bet_sizes.map((x: any) => ({ ...x, ...posPatch }));
    }
  }
  const key = treeKeyOf(shape, menus(levels, shape.n)) +
    (patch ? `|${JSON.stringify(patch)}` : "") + (posPatch ? `|p${JSON.stringify(posPatch)}` : "");
  const sol = await ensureSolution(key, body, { multiway: shape.n > 2, preflop: true });
  if ("error" in sol) return { ok: false, reason: sol.error };
  const n = await fetchNode(sol.solId, line);
  if ("error" in n) return { ok: false, reason: n.error };
  return {
    ok: true,
    actor: n.data?.game?.players?.find((p: any) => p.is_hero)?.position ?? null,
    actions: (n.data?.action_solutions ?? []).map((a: any) => ({ code: String(a.action?.code ?? "?"), freq: a.total_frequency ?? null })),
  };
}

export interface ArrivalRanges {
  ok: true;
  /** which preflop piece produced the ranges */
  piece: "chart6max" | "gtow-ai-preflop";
  /** chart id or the AI tree's description — the answer's rangeSource */
  id: string;
  ranges: Record<string, Record<string, number>>;
  tokens: string[];
  /** the seat order the tokens walk (the API's set for this table size) — for rolling the pot forward */
  seatOrder: readonly string[];
  note: string | null;
}
export type ArrivalOutcome = ArrivalRanges | { ok: false; reason: string };

/**
 * How many players the CALLER can use at the flop.
 *
 * The walk itself is count-agnostic — it conditions every seat's range the same way whatever the table size,
 * and `shapeOf` builds 2-to-6-handed trees — so this is purely the caller saying what its postflop step can
 * consume. GTO Wizard's postflop trees hold three seats, so anything above 3 is a spot whose postflop must be
 * COLLAPSED to three (see aiChain / fastSolve), and the arrival ranges are what the collapse chooses from
 * (2026-09-20).
 *
 * IT HAS NO DEFAULT, deliberately (2026-09-21). It used to default to 3, and that default is exactly how the
 * 4+ way hole survived: `fastSolve` called this without an argument, silently truncated the field to three
 * BEFORE the collapse that exists to handle four and five, and every such flop died with "4 players reach the
 * flop — need 2 to 3". The chart path had been raised to 6 the same day; this one was missed because nothing
 * at the call site named the number. Make every caller say it out loud.
 */
export type SeatCap = 2 | 3 | 4 | 5 | 6;

/** combos per hand class (6 pairs, 4 suited, 12 offsuit) — the denominator of a class weight */
const CLASS_COMBOS: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const c of COMBOS) out[c.cls] = (out[c.cls] ?? 0) + 1;
  return out;
})();

const isRaiseCode = (a: any) => /^R/i.test(String(a?.action?.code ?? "")) && a?.action?.allin !== true;
const codeNum = (c: string) => Number(String(c).replace(/^[A-Z]+/i, ""));

export async function arrivalRangesGtowAi(hand: ParsedHand, heroPos: string | null, maxPlayers: SeatCap): Promise<ArrivalOutcome> {
  const shape = shapeOf(hand, heroPos);
  if ("error" in shape) return { ok: false, reason: `GTO Wizard AI preflop ranges: ${shape.error}` };
  const { tokens, levels } = lineOf(hand, shape);
  const m = menus(levels, shape.n);
  const key = treeKeyOf(shape, m);
  const sol = await ensureSolution(key, treeBody(shape, m), { multiway: shape.n > 2, preflop: true });
  if ("error" in sol) return { ok: false, reason: `GTO Wizard AI preflop ranges: ${sol.error}` };
  return walkArrivalRanges(shape, tokens, (line) => fetchNode(sol.solId, line), maxPlayers);
}

/** The walk itself, pure over a node getter (tests feed synthetic nodes; live feeds the solved tree). */
export async function walkArrivalRanges(
  shape: AiPreflopShape,
  tokens: string[],
  getNode: (line: string) => Promise<{ data: any; cached?: boolean } | { error: string }>,
  maxPlayers: SeatCap
): Promise<ArrivalOutcome> {
  const weights = new Map<string, number[]>(shape.positions.map((p) => [p, new Array(1326).fill(1)]));
  const folded = new Set<string>();
  const heroApi = shape.heroApiPos;
  for (let k = 0; k < tokens.length; k++) {
    const line = tokens.slice(0, k).join("-");
    const node = await getNode(line);
    if ("error" in node) return { ok: false, reason: `GTO Wizard AI preflop ranges: node '${line || "root"}' — ${node.error}` };
    const j = node.data;
    const actor: string | null = j.game?.players?.find((p: any) => p.is_hero)?.position ?? null;
    if (!actor) return { ok: false, reason: `GTO Wizard AI preflop ranges: node '${line || "root"}' names no player to act` };
    const tok = tokens[k]!;
    const sols: any[] = j.action_solutions ?? [];
    let chosen: any[];
    if (tok === "F") chosen = sols.filter((a) => /^F/i.test(String(a.action?.code ?? "")));
    else if (tok === "C") chosen = sols.filter((a) => /^C/i.test(String(a.action?.code ?? "")));
    else if (tok === "X") chosen = sols.filter((a) => /^X/i.test(String(a.action?.code ?? "")));
    else {
      const want = codeNum(tok);
      const exact = sols.filter((a) => isRaiseCode(a) && Math.abs(codeNum(a.action.code) - want) <= 0.06);
      // a villain's raise: the union of the node's raise sizes (the chart walk's rule); hero's: the exact size
      chosen = actor !== heroApi ? sols.filter(isRaiseCode) : exact;
      if (!chosen.length) chosen = sols.filter((a) => a.action?.allin === true);
    }
    if (!chosen.length) return { ok: false, reason: `GTO Wizard AI preflop ranges: token ${tok} is not an action at '${line || "root"}'` };
    const w = weights.get(actor);
    if (!w) return { ok: false, reason: `GTO Wizard AI preflop ranges: node actor ${actor} is not a seat of the tree` };
    for (let i = 0; i < 1326; i++) {
      let f = 0;
      for (const a of chosen) f += Number(a.strategy?.[i] ?? 0);
      w[i] = w[i]! * Math.min(1, f);
    }
    if (tok === "F") folded.add(actor);
  }
  const live = shape.positions.filter((p) => !folded.has(p));
  if (live.length < 2 || live.length > maxPlayers) {
    return { ok: false, reason: `${live.length} players reach the flop — need 2 to ${maxPlayers}` };
  }
  // back to the table's own position names (the API relabels seats onto its fixed sets; heads-up the dealer
  // is the API's SB while the table may call him BTN — the chain's lookup knows that alias, so ONE key per
  // seat here: a second key would read as a third player and send the spot to the 3-way tree)
  const handPosOf: Record<string, string> = {};
  for (const [handPos, apiPos] of Object.entries(shape.apiOf)) handPosOf[apiPos] = handPos;
  const ranges: Record<string, Record<string, number>> = {};
  for (const p of live) {
    // class weight = the fraction of the WHOLE class continuing (a combo at 0 still counts in the
    // denominator — toClassWeights only tallies the nonzero ones), the chart walk's convention
    const cw = toClassWeights(weights.get(p)!);
    const rec: Record<string, number> = {};
    for (const [cls, v] of Object.entries(cw)) if (v.weight > 0) rec[cls] = Math.min(1, v.weight / (CLASS_COMBOS[cls] ?? v.combos));
    if (!Object.keys(rec).length) return { ok: false, reason: `GTO Wizard AI preflop ranges: ${p}'s range is empty after the line` };
    ranges[handPosOf[p] ?? p] = rec;
  }
  const id = `gtow-ai · ${shape.n}-handed · ${shape.positions.map((p) => `${p}:${shape.stacks[p]}`).join("/")}`;
  return {
    ok: true, piece: "gtow-ai-preflop", id, ranges, tokens, seatOrder: shape.positions,
    note: `flop-entering ranges walked from the GTO Wizard AI preflop tree that answered preflop (${shape.n}-handed, ` +
      `${shape.positions.map((p) => `${p} ${shape.stacks[p]}bb`).join(", ")}, rake 5% cap ${shape.rakeCapBb}bb; line ${tokens.join("-") || "root"})` +
      (shape.deadSb ? " · dead SB approximated" : ""),
  };
}
