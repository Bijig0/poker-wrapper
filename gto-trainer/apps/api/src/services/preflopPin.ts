import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { buildPreflopTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { reconstructFlopRanges, type RawNode } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { nodeGetter } from "./hrc6max";
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

export function setPreflopPin(pin: PreflopPin): void {
  if (!pin.handKey) return;
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
  // the tree's prefix + the rest as played: reconstructFlopRanges snaps each later size to the node's own
  const line = [...pin.codes, ...fit.rest];
  let reads = 0;
  const stepped: string[] = [];   // the tree's own token at every decision read (a snapped size shows as the node's)
  const recon = await reconstructFlopRanges(line, async (l) => { reads++; return get(l); },
    { heroPos: pin.heroPos, borrowCaller: true, maxPlayers: 6, onStep: (s) => stepped.push(s.token) });
  if (!recon.ok) return { ok: false, why: `pinned chart ${pin.chartId}: ${recon.reason}` };
  const codes = [...stepped, ...line.slice(stepped.length)];
  return {
    ok: true, ranges: recon.ranges, tokens: tokensNow, codes, seatOrder: undefined, id: pin.chartId, reads,
    note: `PREFLOP RANGES FROM THE PIN: the 6-max chart that answered hero's last preflop decision (${pin.chartId}, hero's node at "${pin.codes.join("-") || "root"}") — ` +
      `hero's action and ${fit.rest.length - 1} later action(s) read on the same tree; no chart chosen again` +
      (recon.notes?.length ? ` · ${recon.notes.map((n) => `RANGE SHORTCUT: ${n}`).join(" · ")}` : ""),
  };
}
