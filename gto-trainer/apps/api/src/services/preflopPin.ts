import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { buildPreflopTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { reconstructFlopRanges, type RawNode } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { nodeGetter } from "./hrc6max";
import type { GetNode, HrcNode } from "./hrc3max";
import { walkFitted, actorsWithAllins } from "../utils/fitLine/fitLine";
import type { AiPreflopShape } from "./gtowAiPreflop";
import { tmark } from "./answerTrace";

/**
 * THE PREFLOP PIN (2026-09-25, Brady: "the final ranges used are the input — if GTO Wizard AI preflop is used
 * last, its range is used; store it in memory so it chains, without ever needing a re-solve, to the postflop AI").
 *
 * Every preflop answer of a hand records WHICH piece answered it and the exact tree it read hero's node from:
 * the 6-max chart id and the fitted/snapped line, or the GTO Wizard AI solution id and its shape. The last
 * answer of the hand wins. When the hand reaches the flop, the postflop step RESUMES from that pin — same tree,
 * same line, the actions after hero's decision read on top — instead of choosing a piece again from the table's
 * shape, rebuilding a tree from a fresh reading of the line and re-deriving hero's own action from the client's
 * rounded amount. Two live failures on 2026-09-25 were exactly that rebuild: hand 4920397538 rebuilt the AI tree
 * and rejected hero's own 2.6bb open (the 2.5x pick, rounded by a 5c big blind) as "not an action at root";
 * hand 4920396764 walked the chart into a subtree the converter had mislabelled terminal.
 *
 * What the pin holds is deliberately small — ids and lines, not range blobs. The chart's nodes are local SQLite
 * (microseconds a node); the AI tree's nodes are cached in-process per solution and line, and the pin pre-fetches
 * every prefix node the moment it is written, so the flop pays at most the reads for what happened AFTER hero's
 * decision (a fold, a call). It never creates a tree or a solution.
 *
 * A pin is only used while the capture still starts with the line it was written from (the token builders are
 * prefix-stable as the line grows); a repaired or re-ordered capture falls through to the old walk, said in the
 * trace. A hand hero's combo has no weight in the pinned range after his own action is a LOUD refusal, not a
 * silent fallback to another source: by Brady's call that mismatch is a bug in the pieces, to be seen, not hidden.
 */

interface PinBase {
  handKey: string;
  /** the capture's own tokens up to hero's node, as the piece's line builder read them at answer time */
  rawTokens: string[];
  /** the tree's own codes for that prefix (snapped / fitted) */
  codes: string[];
  /** hero's seat in the table's position names */
  heroPos: string;
  /** hand.actions.length when the answer was written — for the trace */
  actionIndex: number;
  at: number;
  /**
   * WHAT HERO WAS TOLD, decision by decision (2026-09-25): every chart answer of the hand so far — hero's node and
   * the mix his class was given there. Carried from pin to pin by setPreflopPin (a later decision's pin holds the
   * earlier ones), so the flop can tell a hand hero played OFF the pick (an action his mix gave 0%) from a hand he
   * played by it — see heroDeviation. The caller passes its own decision only.
   */
  picks?: HeroPick[];
}
export interface HeroPick {
  /** the capture's tokens up to hero's node, and the tree's codes there */
  rawTokens: string[];
  codes: string[];
  /** hero's class and the mix it was given at that node (after pruned branches were dropped), with each action's token */
  heroClass: string | null;
  mix: { action: string; token: string | null; frequency: number }[];
}
export interface ChartPreflopPin extends PinBase {
  piece: "chart6max";
  chartId: string;
  depth: number;
}
export interface AiPreflopPin extends PinBase {
  piece: "gtow-ai-preflop";
  solId: string;
  shape: AiPreflopShape;
  id: string;
  /** a last-resort answer: the tree holds hero and the last aggressor only, the rest folded out as dead money */
  reduced: { droppedPos: string[] } | null;
  /** the background pre-fetch of every prefix node (never awaited by the answer) */
  warm: Promise<void> | null;
}
export type PreflopPin = ChartPreflopPin | AiPreflopPin;

const pins = new Map<string, PreflopPin>();
const MAX_PINS = 300;

export const preflopPinKey = (hand: ParsedHand): string => String(hand.clientHandId ?? hand.handId ?? "");

const isStrictPrefix = (a: string[], b: string[]) => a.length < b.length && a.every((t, i) => b[i] === t);

export function setPreflopPin(pin: PreflopPin): void {
  if (!pin.handKey) return;
  // the earlier decisions' picks ride along; a re-ask of the same decision (the poller probes it every second) or of
  // an earlier one (a replay) replaces what it supersedes — only picks strictly before this node are kept
  const prev = pins.get(pin.handKey);
  const carried = (prev?.picks ?? []).filter((p) => isStrictPrefix(p.rawTokens, pin.rawTokens));
  pin = { ...pin, picks: [...carried, ...(pin.picks ?? [])] } as PreflopPin;
  pins.delete(pin.handKey);            // re-insert so the newest hand is last in eviction order
  pins.set(pin.handKey, pin);
  while (pins.size > MAX_PINS) { const first = pins.keys().next().value; if (first === undefined) break; pins.delete(first); }
  tmark("preflop ranges pinned", `hand ${pin.handKey}: ${pin.piece} ${pin.piece === "chart6max" ? pin.chartId : pin.id} at "${pin.codes.join("-") || "root"}" (${pin.heroPos} to act)`);
}
export const getPreflopPin = (handKey: string): PreflopPin | undefined => pins.get(handKey);
export function forgetPreflopPin(handKey: string): void { pins.delete(handKey); }
export const preflopPinStats = () => ({ pins: pins.size });

/** The pin's prefix against the capture as it stands now: the tokens that come after it, or why it no longer fits. */
export function pinRest(pin: PreflopPin, tokensNow: string[]): { ok: true; rest: string[] } | { ok: false; why: string } {
  const n = pin.rawTokens.length;
  for (let i = 0; i < n; i++) {
    if (tokensNow[i] !== pin.rawTokens[i]) {
      return { ok: false, why: `the capture's line no longer starts with the pinned one (pinned "${pin.rawTokens.join("-") || "root"}", now "${tokensNow.join("-") || "root"}")` };
    }
  }
  if (tokensNow.length <= n) return { ok: false, why: `hero's own action is not in the line yet (pinned "${pin.rawTokens.join("-") || "root"}", now "${tokensNow.join("-") || "root"}")` };
  return { ok: true, rest: tokensNow.slice(n) };
}

export interface ResumedRanges {
  ok: true;
  ranges: Record<string, Record<string, number>>;
  /** the capture's tokens (the pot is rolled from these, sizes as played) */
  tokens: string[];
  /** the tree's codes the ranges were read on */
  codes: string[];
  seatOrder: readonly string[] | undefined;
  id: string;
  note: string;
  /** node reads that were not already cached — the flop's real cost */
  reads: number;
}
export type ResumeOutcome = ResumedRanges | { ok: false; why: string };

/**
 * Resume a CHART pin at the flop: the pinned chart, the pinned prefix, hero's action and everything after it
 * walked on top. The chart's nodes are local, so this is the same walk the answer made plus a few microseconds —
 * no chart is chosen again (the pick is what answered preflop) and no line is fitted again. `get` is injectable
 * for tests; live it is the pinned chart's baked node getter.
 */
export async function resumeChartPreflopRanges(
  pin: ChartPreflopPin,
  hand: ParsedHand,
  heroPos: string | null,
  get: (line: string) => Promise<RawNode | null> = async (line) => { const n = await nodeGetter(pin.chartId)(line); return n === "unreachable" ? null : (n as RawNode | null); },
): Promise<ResumeOutcome> {
  const tokensNow = buildPreflopTokens(hand, heroPos);
  const fit = pinRest(pin, tokensNow);
  if (!fit.ok) return fit;
  let reads = 0;
  const counted = async (l: string) => { reads++; return get(l); };
  // THE SEATS MUST BE THE TABLE'S (2026-09-25, mutation harness `limps`). The walk below is positional: it hands
  // each token to whoever the tree says acts next. That only works while the tree's path and the capture keep the
  // same players in — and a FITTED pin does not: hero's decision was read with a limper folded out of the line
  // (utils/fitLine), and when that limper then calls hero's squeeze (seed 111: flop BB vs UTG) the resume handed
  // UTG's call to the HJ and the flop had no UTG range at all ("reconstructed ranges don't cover both seats").
  // So a fitted pin reads every flop seat's range from a fitted line that KEEPS that seat, on the pinned chart —
  // the rule recon6max applies to an unpinned hand; for hero it is the same fold his pinned decision was read with.
  // And every other resume is checked against the capture: the seats that reach the flop by the capture's own line
  // must be the seats the walk returned ranges for, or the same per-seat read replaces it.
  const want = flopSeatsOf(tokensNow, pin.depth);
  // hero's own range needs only the pinned node and his action there — unless he acted again after it (a later
  // decision no chart answered), when his seat is fitted like the others
  const who = actorsWithAllins(tokensNow, pin.depth);
  const heroAgain = who.some((s, i) => i > pin.rawTokens.length && s === pin.heroPos.toUpperCase());
  const heroPrefix = heroAgain ? undefined : [...pin.codes, tokensNow[pin.rawTokens.length]!];
  const perSeat = async (why: string): Promise<ResumeOutcome> => {
    const per = await fittedRangesBySeat(tokensNow, counted, { heroPos: pin.heroPos, depth: pin.depth, heroPrefix });
    if (!per.ok) return { ok: false, why: `pinned chart ${pin.chartId}: ${why}; ${per.reason}` };
    return {
      ok: true, ranges: per.ranges, tokens: tokensNow, codes: per.heroLine, seatOrder: undefined, id: pin.chartId, reads,
      note: `PREFLOP RANGES FROM THE PIN: the 6-max chart that answered hero's last preflop decision (${pin.chartId}, hero's node at "${pin.codes.join("-") || "root"}") — ` +
        `${why}, so each flop seat's range is read from a fitted line that keeps that seat` +
        (per.borrowed.length ? ` (${per.borrowed.join(", ")})` : "") + `; no chart chosen again`,
    };
  };
  const foldedOut = pin.rawTokens.map((t, i) => (t !== "F" && pin.codes[i] === "F" ? i : -1)).filter((i) => i >= 0);
  if (foldedOut.length || pin.codes.length !== pin.rawTokens.length) {
    return perSeat(`hero's decision was read on a line fitted to the tree (${foldedOut.length || pin.rawTokens.length - pin.codes.length} call(s) folded out)`);
  }
  // the tree's prefix + the rest as played: reconstructFlopRanges snaps each later size to the node's own
  const line = [...pin.codes, ...fit.rest];
  const stepped: string[] = [];   // the tree's own token at every decision read (a snapped size shows as the node's)
  const recon = await reconstructFlopRanges(line, counted,
    { heroPos: pin.heroPos, borrowCaller: true, maxPlayers: 6, onStep: (s) => stepped.push(s.token) });
  if (!recon.ok) {
    // A LINE PAST THE TREE'S CAPS AFTER HERO'S DECISION (2026-09-25, seed 93 [hero-deviates]): a fifth entrant, a third
    // caller — "not in the charts". The pinned walk cannot go on, but the flop is still the table's: each seat is read
    // on a line fitted to keep it, hero on his pinned node (the unpinned walk used to fold the limper hero's decision
    // was read WITH, and read hero's ATo call at a node his decision never saw — weight 0). A terminal before the line
    // ends is left to the caller: that is a branch HRC never wrote (OFF THE CHART, fastSolve).
    const first = `pinned chart ${pin.chartId}: ${recon.reason}`;
    if (/terminal before the line ends/.test(recon.reason)) return { ok: false, why: first };
    const r = await perSeat(`the pinned walk stopped (${recon.reason})`);
    return r.ok ? r : { ok: false, why: `${first}; ${r.why}` };
  }
  const got = Object.keys(recon.ranges).map((p) => p.toUpperCase());
  if (!sameSeats(want, got)) {
    return perSeat(`the tree's path reached the flop with ${got.join("/") || "nobody"} where the table has ${want.join("/")}`);
  }
  const codes = [...stepped, ...line.slice(stepped.length)];
  return {
    ok: true, ranges: recon.ranges, tokens: tokensNow, codes, seatOrder: undefined, id: pin.chartId, reads,
    note: `PREFLOP RANGES FROM THE PIN: the 6-max chart that answered hero's last preflop decision (${pin.chartId}, hero's node at "${pin.codes.join("-") || "root"}") — ` +
      `hero's action and ${fit.rest.length - 1} later action(s) read on the same tree; no chart chosen again` +
      (recon.notes?.length ? ` · ${recon.notes.map((n) => `RANGE SHORTCUT: ${n}`).join(" · ")}` : ""),
  };
}

/**
 * DID HERO PLAY OFF THE PICK? (2026-09-25, Brady's rule: a manual deviation — an action the chart never takes with
 * hero's hand — may fall back to the GTO Wizard AI preflop tree, the way a pruned branch already does; hero's class
 * at zero weight after following the pick stays a loud refusal, a bug in the pieces). For every recorded chart
 * decision whose node the capture still runs through, hero's actual next action is read and matched to the node's
 * tokens (a size snaps to the nearest offered raise, as every walk does; our all-in token to the largest), and its
 * frequency looked up in the mix hero was given. An action the mix gave 0% is a deviation. Returns the first one,
 * or null — null for a hand played by the pick, and for a hand with no recorded picks (nothing to accuse hero of).
 */
export function heroDeviation(picks: HeroPick[] | undefined, tokensNow: string[]):
  { codes: string[]; took: string; action: string | null; heroClass: string | null } | null {
  for (const p of picks ?? []) {
    if (!p.rawTokens.every((t, i) => tokensNow[i] === t)) continue;
    const raw = tokensNow[p.rawTokens.length];
    if (raw == null) continue;
    type Offer = { action: string; token: string; frequency: number };
    const offered = p.mix.filter((m) => m.token != null) as Offer[];
    let hit: Offer | null = offered.find((m) => m.token === raw) ?? null;
    if (!hit && raw !== "F" && raw !== "C" && raw !== "X") {
      const size = (t: string) => { const m = /^R([\d.]+)$/.exec(t); return m ? Number(m[1]) : null; };
      const raises = offered.filter((m) => size(m.token) != null);
      const want = raw === "RAI" ? Infinity : size(raw);
      const dist = (o: Offer) => (want === Infinity ? -size(o.token)! : Math.abs(Math.log(want! / size(o.token)!)));
      if (want != null) for (const o of raises) if (!hit || dist(o) < dist(hit)) hit = o;
    }
    if (!hit || !(hit.frequency > 0)) return { codes: p.codes, took: raw, action: hit?.action ?? null, heroClass: p.heroClass };
  }
  return null;
}

const SEATS6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;

/** The seats that reach the flop by a 6-max token line (positional, all-in aware): every seat whose last token is not a fold. */
export function flopSeatsOf(tokens: string[], depth: number): string[] {
  const who = actorsWithAllins(tokens, depth);
  const last = new Map<string, string>();
  tokens.forEach((t, i) => { const s = who[i]; if (s) last.set(s, t); });
  return SEATS6.filter((s) => last.has(s) && last.get(s) !== "F");
}

const sameSeats = (a: string[], b: string[]): boolean => {
  const x = new Set(a.map((s) => s.toUpperCase())), y = new Set(b.map((s) => s.toUpperCase()));
  return x.size === y.size && [...x].every((s) => y.has(s));
};

/**
 * EVERY FLOP SEAT'S RANGE FROM A LINE THAT KEEPS IT (utils/fitLine). A line the capped tree cannot hold (three
 * limpers, an iso with three callers) is fitted by folding the earliest plain caller; the player a fit folds may
 * well be at the flop, so each seat's range is read from a fitted line that PROTECTS that seat (hero is never
 * folded). The pot and stacks stay the real line's — the caller's business. Shared by the pin resume and the
 * unpinned walk (fastSolve.recon6max). `heroLine` is the fitted line hero's own range was read on.
 */
export async function fittedRangesBySeat(
  tokens: string[],
  get: (line: string) => Promise<RawNode | null>,
  o: {
    heroPos: string | null; depth: number;
    /** hero's own range is read on exactly this line (a pin: the node his last decision was read at + the action he
     *  took there) instead of a fitted one — his range is the product of HIS actions only, so nothing after his last
     *  decision can change it, and a fit of the whole line could fold a limper his decision was read WITH */
    heroPrefix?: string[];
  },
): Promise<{ ok: true; ranges: Record<string, Record<string, number>>; borrowed: string[]; heroLine: string[] } | { ok: false; reason: string }> {
  const getHrc: GetNode = async (l) => (await get(l)) as HrcNode | null;
  const ranges: Record<string, Record<string, number>> = {};
  const borrowed: string[] = [];
  let heroLine: string[] = tokens;
  for (const seat of flopSeatsOf(tokens, o.depth)) {
    if (o.heroPrefix && o.heroPos && seat === o.heroPos.toUpperCase()) {
      const r = await reconstructFlopRanges(o.heroPrefix, get, { heroPos: o.heroPos, borrowCaller: true, maxPlayers: 6, partial: true });
      const mine = r.ok ? Object.entries(r.ranges).find(([k]) => k.toUpperCase() === seat)?.[1] : undefined;
      if (!mine) return { ok: false, reason: `hero's range on the pinned line "${o.heroPrefix.join("-")}": ${r.ok ? "absent" : r.reason}` };
      ranges[seat] = mine;
      heroLine = o.heroPrefix;
      continue;
    }
    const fit = await walkFitted(tokens, getHrc, { heroSeat: o.heroPos, protect: [seat], stack: o.depth, acceptTerminal: true });
    if (!fit.fitted || !fit.fittedLine) return { ok: false, reason: `fitting the line for ${seat}'s range: ${fit.ok ? "no fit" : fit.reason}` };
    // partial: only THIS seat's range is wanted, and the fitted line may leave it alone at the flop (hero squeezes,
    // and the limper who called it is the one the fit folded) — a player count says nothing about one seat's range
    const r = await reconstructFlopRanges(fit.fittedLine, get, { heroPos: o.heroPos ?? undefined, borrowCaller: true, maxPlayers: 6, partial: true });
    const mine = r.ok ? Object.entries(r.ranges).find(([k]) => k.toUpperCase() === seat)?.[1] : undefined;
    if (!mine) return { ok: false, reason: `${seat}'s range on the fitted line "${fit.fittedLine.join("-")}": ${r.ok ? "absent" : r.reason}` };
    ranges[seat] = mine;
    if (fit.folds.length) borrowed.push(`${seat} with ${fit.folds.map((f) => f.seat).join("+")} folded`);
    if (o.heroPos && seat === o.heroPos.toUpperCase()) heroLine = fit.fittedLine;
  }
  return { ok: true, ranges, borrowed, heroLine };
}
