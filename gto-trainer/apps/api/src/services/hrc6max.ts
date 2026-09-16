import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";
import { fetchNode, type GetNode, type HrcNode } from "./hrc3max";

/**
 * Chart picker for the 6-max NL200 ring set (ledger proposal `sixmax-nl200`).
 *
 * The 3-max corpus is indexed by (depth, short stack, short seat) alone, because one 3-max tree carries every
 * open size at once. The 6-max set is NOT: a tree is solved with every seat opening ONE size, so a chart is
 * chosen by (depth, short seat, OPEN SIZE) and the limp tree is its own chart again. That is the whole reason
 * this module exists and hrc3max.ts could not simply be reused — see services/strategies.ts, which refuses the
 * 6-max strategy until this file is here.
 *
 *   even stacks   ign200_6max_D<depth>_o<size>            e.g. ign200_6max_D100_o2_5, ..._olimp
 *   one short     ign200_6max_D100_s<short>_<seat>_o<size>
 *
 * Selection is a PREFERENCE LIST, not one id: the set is still being solved, so the caller walks the list and
 * takes the first chart the server actually has. Every fallback carries the note that explains it, which rides
 * to the panel and to the miss queue exactly as the 3-max one does.
 *
 * Tokens need nothing new: buildPreflopTokens (buildSolutionUrl.ts) already walks UTG·HJ·CO·BTN·SB·BB, which is
 * this set's seat order, and walk3max is token-based, so both are reused as they are.
 */

export const SITE_6MAX = "ign200";

/** Solved depth rungs (bb) — the six the grid covers. */
export const RUNGS6 = [30, 50, 75, 100, 125, 150];
/** Open sizes with their own tree, biggest share of the pool's opens first. */
export const OPENS6 = [2.5, 3, 2, 3.5];
/** Short-stack rungs of the uneven set, all at a 100bb table. */
export const SHORTS6 = [30, 50, 70];
export const DEEP6 = 100;
/** Only these two open sizes were solved with a short seat at the table. */
export const UNEVEN_OPENS6 = [2.5, 3];
/** A seat this far below 100bb - the reload line - is "short" rather than noise. */
export const SHORT_GAP = 15;
/** Hero below this has not reloaded yet; the rung then follows his own stack like anyone else's. */
export const HERO_RELOAD_FLOOR = DEEP6 - SHORT_GAP;
/** Past this the 150bb chart is a guess, not a snap. */
export const LADDER_TOP6 = RUNGS6[RUNGS6.length - 1]! + 15;

export const SEATS6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
export type Seat6 = (typeof SEATS6)[number];

const num = (n: number | string) => String(n).replace(".", "_");
const nearest = (xs: number[], v: number) => xs.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

export const snapRung6 = (bb: number): number => nearest(RUNGS6, bb);
export const snapOpen6 = (bb: number): number => nearest(OPENS6, bb);
export const snapShort6 = (bb: number): number => nearest(SHORTS6, bb);

export const evenChartId = (depth: number, open: number | "limp"): string =>
  `${SITE_6MAX}_6max_D${num(depth)}_o${open === "limp" ? "limp" : num(open)}`;
export const unevenChartId = (short: number, seat: Seat6, open: number): string =>
  `${SITE_6MAX}_6max_D${num(DEEP6)}_s${num(short)}_${seat}_o${num(open)}`;

export interface Chart6Choice {
  /** charts to try, best first — the set is still solving, so the caller takes the first one that exists */
  candidates: string[];
  /** the chart the state actually wants (candidates[0]) */
  id: string;
  site: string;
  depth: number;
  /** the short seat's rung, or `depth` when the table is even */
  shortDepth: number;
  shortSeat: Seat6 | "EQ";
  /** the open size this chart's tree uses, or "limp" for the limp tree */
  openSize: number | "limp";
  note: string | null;
  beyondLadder: number | null;
  /** the effective stack the rung was chosen for: hero vs the opponent that matters (null when nothing was readable) */
  effective?: number | null;
  /** that opponent: the raiser hero faces, or the deepest live seat when hero is first in */
  relevant?: Seat6 | null;
}

/** Each seat's stack as DEALT: what is behind plus what it has already put in this hand. */
function dealtByPos(hand: ParsedHand, heroPos: string | null): Partial<Record<Seat6, number>> {
  const out: Partial<Record<Seat6, number>> = {};
  const stacks = hand.stacks ?? {};
  const committed = hand.committed ?? {};
  const put = (pos: string, seatId: number) => {
    const p = pos.toUpperCase() as Seat6;
    if (!SEATS6.includes(p)) return;
    const behind = Number(stacks[seatId]);
    if (!Number.isFinite(behind) || behind < 0) return;
    const inPot = Number(committed[seatId] ?? 0);
    const total = behind + (Number.isFinite(inPot) ? inPot : 0);
    if (total > 0) out[p] = total;
  };
  for (const [seat, pos] of Object.entries(hand.positions ?? {})) put(String(pos), Number(seat));
  if (heroPos && out[heroPos.toUpperCase() as Seat6] == null) put(heroPos, hand.heroSeatId);
  return out;
}

/**
 * The open size this spot is playing under: the FIRST raise in the line, snapped to a solved tree size.
 * No raise yet and a limp already in → the limp tree. No raise and no limp → hero is opening, and the tree
 * he should read is the one whose size he is about to use; 2.5x is the pool's open in 53% of hands and the
 * size the study answers suggest, so that is the default.
 */
export function openFromTokens(tokens: string[]): { open: number | "limp"; observed: number | null } {
  let limped = false;
  for (const t of tokens) {
    const tok = String(t ?? "").trim().toUpperCase();
    if (tok === "C" || tok === "CALL") { limped = true; continue; }
    const m = tok.match(/^R([\d.]+)$/);
    if (m) {
      const bb = Number(m[1]);
      if (!Number.isFinite(bb) || bb <= 0) continue;
      // A LIMP IN FRONT WINS (2026-09-16). A pot that was limped and then raised is an ISO-RAISE, and the only
      // tree that holds one is the limp tree - a raise tree's opening node offers fold or raise and nothing else,
      // so the line died on its very first token ('action "C" not offered'). Reading the raise and ignoring the
      // limp in front of it sent 25 of 357 sampled decisions to a tree that could never answer them.
      return limped ? { open: "limp", observed: bb } : { open: snapOpen6(bb), observed: bb };
    }
  }
  return limped ? { open: "limp", observed: null } : { open: 2.5, observed: null };
}

/**
 * Who is still in the hand when hero acts, and who raised last, replayed from the token walk: the opening orbit is
 * one token per seat in UTG..BB order (a padded "F" for a seat never dealt), later orbits run through the seats
 * still live, in seat order. `after` = live seats that have not acted yet in the current orbit - the players hero
 * has to plan for; anyone else live is already in the pot.
 */
export function replayTokens6(tokens: string[]): { folded: Set<Seat6>; aggressor: Seat6 | null; after: Seat6[] } {
  const folded = new Set<Seat6>();
  let aggressor: Seat6 | null = null;
  const act = (seat: Seat6, tok: string) => {
    const t = tok.trim().toUpperCase();
    if (t === "F") folded.add(seat);
    else if (/^R/.test(t)) aggressor = seat;
  };
  const n = tokens.length;
  for (let i = 0; i < Math.min(n, SEATS6.length); i++) act(SEATS6[i]!, String(tokens[i] ?? "F"));
  let p = 0;
  const nextLive = () => { for (let k = 0; k < SEATS6.length; k++) { const s = SEATS6[(p + k) % SEATS6.length]!; if (!folded.has(s)) { p = (p + k + 1) % SEATS6.length; return s; } } return null; };
  for (let i = SEATS6.length; i < n; i++) { const seat = nextLive(); if (!seat) break; act(seat, String(tokens[i] ?? "F")); }
  const after: Seat6[] = [];
  if (n < SEATS6.length) { for (let i = n + 1; i < SEATS6.length; i++) after.push(SEATS6[i]!); }
  else {
    // still to act = the live seats between hero and the last raiser (who acts again only if re-raised)
    const me = nextLive();
    for (let k = 0; k < SEATS6.length; k++) {
      const s = SEATS6[(p + k) % SEATS6.length]!;
      if (s === me || s === aggressor) break;
      if (!folded.has(s)) after.push(s);
    }
  }
  return { folded, aggressor, after };
}

/**
 * Pick the chart for a 6-handed spot. Returns a preference list: the exact chart first, then the same depth at
 * the nearest solved open size, then the even chart when an uneven one is not (yet) solved, and finally the
 * 100bb 2.5x chart, which is the one tree that is always there.
 *
 * THE RUNG IS THE EFFECTIVE STACK, NOT THE TABLE (2026-09-17). Hero always reloads to 100bb; opponents cannot be
 * made to. So:
 *   - below 100bb the question is only ever "which OPPONENT is short", and only opponents still in the hand
 *     count: a folded 30bb stack changes nothing from here. One live short at a ~100bb table = that seat's
 *     uneven chart; with two, the one that matters (the raiser hero faces, else the first still to act behind
 *     him, else the shortest caller) gets the chart and the other is noted as unmodelled; three or more shorts
 *     against a short opponent = the even chart at the effective stack, the closest thing to a short table we own.
 *   - above 100bb the question is hero AND the opponent he is up against: the raiser when facing a raise, the
 *     deepest live seat when first in. A 150bb hero against a 100bb raiser is a 100bb spot. The old median put a
 *     freshly reloaded hero on the 150bb chart at a deep table - 13.5% of corpus decisions a rung too deep.
 *   - hero under 85bb (not reloaded yet) follows his own stack like anyone else's, and says so.
 */
export function chartFor6max(hand: ParsedHand, heroPos: string | null, tokens: string[] = []): Chart6Choice {
  const byPos = dealtByPos(hand, heroPos);
  const { open, observed } = openFromTokens(tokens);
  const notes: string[] = [];
  if (observed != null && Math.abs(observed - (open as number)) > 0.2) {
    notes.push(`the open was ${observed}bb — answered from the ${open}x tree`);
  }
  const me = (heroPos ?? "").toUpperCase() as Seat6;
  const { folded, aggressor, after } = replayTokens6(tokens);

  // hero's own stack: 100bb when unreadable (he reloads), flagged
  let hero = Number(byPos[me] ?? NaN);
  if (!Number.isFinite(hero) || hero <= 0) { hero = DEEP6; notes.push("hero's stack unreadable — taken as 100bb"); }

  // opponents still in the hand with a readable stack
  const opps = (Object.entries(byPos) as [Seat6, number][]).filter(([p]) => p !== me && !folded.has(p));
  const oppStack = (p: Seat6 | null) => (p ? opps.find(([q]) => q === p)?.[1] ?? null : null);
  const readableAgg = aggressor && !folded.has(aggressor) && oppStack(aggressor) != null ? aggressor : null;
  const deepest = opps.length ? opps.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;
  const relevant: Seat6 | null = readableAgg ?? deepest?.[0] ?? null;
  const relevantStack = relevant ? oppStack(relevant)! : DEEP6;
  if (!relevant) notes.push("no opponent's stack readable — taken as 100bb");
  else if (aggressor && !readableAgg && !folded.has(aggressor)) notes.push(`the ${aggressor}'s stack is unreadable — measured against the ${relevant}`);

  const effective = Math.min(hero, relevantStack);
  const rung = snapRung6(effective);
  const beyondLadder = effective > LADDER_TOP6 ? Math.round(effective) : null;
  if (beyondLadder != null) notes.push(`${beyondLadder}bb effective, past the ${RUNGS6[RUNGS6.length - 1]}bb rung — answered from the ${rung}bb chart`);
  const finish = (id: string, cands: string[], depth: number, shortDepth: number, shortSeat: Seat6 | "EQ", o: number | "limp"): Chart6Choice => ({
    candidates: cands.filter((x, i, a) => a.indexOf(x) === i), id, site: SITE_6MAX, depth, shortDepth, shortSeat,
    openSize: o, note: notes.join(" · ") || null, beyondLadder, effective: Math.round(effective), relevant,
  });
  const evenLadder = (depth: number, o: number | "limp"): string[] => {
    // A LIMPED POT ONLY EVER FALLS BACK TO ANOTHER LIMP CHART (2026-09-16): no raise tree contains a limp. The 125
    // and 150bb limp trees are absent by decision (HRC will not build them), so those states ride this ladder to
    // the 100bb limp chart.
    const cands = [evenChartId(depth, o)];
    const byDist = RUNGS6.slice().sort((a, b) => Math.abs(a - depth) - Math.abs(b - depth));
    if (o === "limp") { for (const d of byDist) cands.push(evenChartId(d, "limp")); }
    else {
      for (const x of [2.5, 3, 2, 3.5]) cands.push(evenChartId(depth, x));
      for (const d of byDist) cands.push(evenChartId(d, o));
    }
    return cands;
  };
  const even = (depth: number) => finish(evenChartId(depth, open), evenLadder(depth, open), depth, depth, "EQ", open);

  // hero has not reloaded: his own stack sets the rung like anyone else's
  if (hero < HERO_RELOAD_FLOOR) {
    notes.push(`hero has ${Math.round(hero)}bb — answered from the even ${rung}bb chart`);
    return even(rung);
  }

  // the shorts that are still in the hand
  const shorts = opps.filter(([, bb]) => bb < DEEP6 - SHORT_GAP);
  if (!shorts.length || open === "limp") {
    if (shorts.length && open === "limp") notes.push(`the uneven set has no limp tree — the even ${rung}bb limp chart answers`);
    return even(rung);
  }

  // which short gets modelled: the raiser hero faces, else the first short still to act behind hero, else the shortest
  const shortSeat = readableAgg && shorts.some(([p]) => p === readableAgg) ? readableAgg
    : (after.find((p) => shorts.some(([q]) => q === p)) ?? shorts.slice().sort((a, b) => a[1] - b[1])[0]![0]);
  const shortBB = oppStack(shortSeat)!;
  const relevantIsShort = relevant === shortSeat || relevantStack < DEEP6 - SHORT_GAP;

  // a deep spot with a short elsewhere at the table: the depth matters more than the bystander
  if (!relevantIsShort && rung > DEEP6) {
    notes.push(`${Math.round(effective)}bb effective vs the ${relevant} — the ${shortSeat}'s ${Math.round(shortBB)}bb is not modelled`);
    return even(rung);
  }
  // a mostly-short table against a short opponent: the even chart at the effective stack is the closest thing we own
  if (shorts.length >= 3 && relevantIsShort) {
    notes.push(`${shorts.length} short stacks and the ${relevant} has ${Math.round(relevantStack)}bb — answered from the even ${rung}bb chart`);
    return even(rung);
  }

  const s = snapShort6(shortBB);
  const o = nearest(UNEVEN_OPENS6, open as number);
  if (o !== open) notes.push(`the uneven set has 2.5x and 3x only — using its ${o}x tree`);
  if (Math.abs(shortBB - s) > 8) notes.push(`the ${shortSeat} has ${Math.round(shortBB)}bb — answered from the ${s}bb short chart`);
  const others = shorts.filter(([p]) => p !== shortSeat);
  if (others.length) notes.push(`${others.map(([p, bb]) => `${p} ${Math.round(bb)}bb`).join(", ")} also short — not modelled`);
  if (hero > DEEP6 + SHORT_GAP) notes.push(`hero has ${Math.round(hero)}bb — the short chart plays him at 100bb`);
  const id = unevenChartId(s, shortSeat, o);
  return finish(id, [id, ...SHORTS6.filter((x) => x !== s).map((x) => unevenChartId(x, shortSeat, o)), evenChartId(DEEP6, open), evenChartId(DEEP6, 2.5)],
    DEEP6, s, shortSeat, o);
}

/**
 * The first candidate the chart server actually has. The set is solved tree by tree, so "the chart this state
 * wants" and "a chart that exists" are different questions until the run finishes; this asks the second one
 * and reports which fallback it landed on.
 */
export async function resolveChart6max(
  choice: Chart6Choice,
  get: (source: string, line: string) => Promise<HrcNode | null | "unreachable"> = fetchNode,
): Promise<{ id: string; root: HrcNode; fellBack: boolean } | "unreachable" | null> {
  let sawServer = false;
  for (const id of choice.candidates) {
    const root = await get(id, "");
    if (root === "unreachable") continue;
    sawServer = true;
    if (root) return { id, root, fellBack: id !== choice.candidates[0] };
  }
  return sawServer ? null : "unreachable";
}

/** A GetNode bound to one resolved chart, for walk3max. */
export const nodeGetter = (id: string): GetNode => (line) => fetchNode(id, line);
