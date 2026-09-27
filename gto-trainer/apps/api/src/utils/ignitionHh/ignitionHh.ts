/**
 * Ignition's own hand record (the client's hand-history lookup, fetched live through the wrapper's GET /hh/:id)
 * read into our terms, and checked against what the reader archived for the same hand. Pure: no I/O.
 *
 * Money in the record is dollar strings; amounts follow the same convention as our actions: Raises = the total
 * the bet is raised TO, Calls / All-in = the chips added, Bets = the bet. Seats are the table's own numbers, the
 * same ones the wrapper exports. Villains' hole cards are blank unless shown.
 */
import type { ActionType, ParsedHand, Street } from "../../feed/parsePanelFeed/parsePanelFeed";

export interface IgnAction { seat: number | null; position: string; type: ActionType; amountBb?: number; street: Street; label: string }
/** One line of Ignition's log, in order. `action` is its index in IgnHand.actions when the line is a betting action. */
export interface IgnLine { seat: number | null; position: string; label: string; data: string[]; street: Street; action: number | null }
export interface IgnSeat { seat: number; position: string; hero: boolean; cards: string[]; startBb: number; endBb: number; netBb: number; totalBetBb: number }
export interface IgnHand {
  bbCents: number;
  table: string;
  startTime: string | null;
  board: string[];
  heroCards: string[];
  seats: IgnSeat[];
  /** every line of the record, in order (street markers folded into `street`) */
  log: IgnLine[];
  actions: IgnAction[];
  /** the lines that are not betting actions: dealer, deals, uncalled returns, shows, results, seat changes */
  other: IgnLine[];
  previousHandId: string | null;
  nextHandId: string | null;
}
export type DiffKind = "big-blind" | "seats" | "hero-seat" | "hero-cards" | "board" | "board-extra" | "start-stack" | "end-stack"
  | "action-amount" | "action-extra" | "action-missing";
/** One disagreement. Action diffs carry the index of the action on each side that has it. */
export interface HhDiff { kind: DiffKind; field: string; ours: string; ignition: string; note?: string; oursAt?: number; ignitionAt?: number }

// ------------------------------------------------------------------------------------------------ parse

const TYPE: Record<string, ActionType> = {
  "small blind": "post-sb", "big blind": "post-bb", folds: "fold", checks: "check", calls: "call", bets: "bet", raises: "raise", "all-in": "all-in",
  // A POST-IN (a new player's out-of-turn blind) is filed by the reader as that seat's limp: a call of the posted amount.
  "posts chip": "call",
};
/** "Folds (timeout)" / "(disconnect)" / "(auth)" and "Checks (timeout)" are the plain action; "All-in(raise)" is an
 *  all-in whose amount is the raise-to total. */
const typeOf = (label: string): ActionType | undefined =>
  TYPE[label.toLowerCase().replace(/\s*\((timeout|disconnect|auth)\)$/, "").replace(/^all-in\(.*\)$/, "all-in")];
const isPostIn = (label: string) => label.toLowerCase() === "posts chip";
const STREET_MARK: Record<string, Street> = { FLOP: "flop", TURN: "turn", RIVER: "river" };

const cents = (s: unknown): number => {
  const m = String(s ?? "").replace(/,/g, "").match(/(-?)\$?(-?\d+(?:\.\d+)?)/);
  return m ? Math.round(Number(m[2]) * 100) * (m[1] === "-" ? -1 : 1) : NaN;
};
const posName = (p: unknown) => String(p ?? "").replace(/\[ME\]/i, "").replace(/\s+/g, " ").trim();
const round2 = (x: number) => Math.round(x * 100) / 100;

type Tagged = Omit<IgnLine, "seat" | "action">;

/** The log with each entry tagged by the street it happened on; the FLOP / TURN / RIVER markers themselves drop out. */
const tagStreets = (raw: any[]): Tagged[] =>
  raw.reduce<{ street: Street; lines: Tagged[] }>((acc, a) => {
    const label = String(a?.action ?? "");
    const marker = STREET_MARK[label];
    return marker
      ? { ...acc, street: marker }
      : { ...acc, lines: [...acc.lines, { position: posName(a?.position), label, data: (a?.data ?? []).map(String), street: acc.street }] };
  }, { street: "preflop", lines: [] }).lines;

const readSeat = (bb: (s: unknown) => number) => (p: any): IgnSeat => {
  const [start, end] = String(p?.startEndAmount ?? "").split("/");
  return { seat: Number(p?.seat), position: posName(p?.position), hero: !!p?.isMe, cards: (p?.cards ?? []).filter(Boolean),
    startBb: bb(start), endBb: bb(end), netBb: bb(p?.winLoseAmount), totalBetBb: bb(p?.totalBet) };
};

export function parseIgnitionHh(body: any): IgnHand {
  const bbCents = cents(String(body?.blinds ?? "").split("/")[1]);
  const bb = (s: unknown) => round2(cents(s) / bbCents);
  const seats: IgnSeat[] = (body?.players ?? []).map(readSeat(bb));
  const seatByPos = new Map(seats.map((s) => [s.position.toLowerCase(), s.seat]));
  const lines = tagStreets(body?.action ?? []).map((l) => ({ ...l, seat: seatByPos.get(l.position.toLowerCase()) ?? null }));
  const posters = new Set(lines.filter((l) => isPostIn(l.label)).map((l) => l.seat));
  // a poster's preflop check is the free option of the limp it posted, not a second action
  const actionOf = (l: Omit<IgnLine, "action">): IgnAction | null => {
    const type = typeOf(l.label);
    if (!type || (type === "check" && l.street === "preflop" && posters.has(l.seat))) return null;
    const amt = l.data[0] ? bb(l.data[0]) : NaN;
    return { seat: l.seat, position: l.position, type, ...(Number.isFinite(amt) ? { amountBb: amt } : {}), street: l.street, label: l.label };
  };
  const parsed = lines.map((l) => ({ line: l, action: actionOf(l) }));
  const actions = parsed.flatMap((p) => (p.action ? [p.action] : []));
  const actionLines = parsed.flatMap((p, i) => (p.action ? [i] : []));
  const log: IgnLine[] = parsed.map((p, i) => ({ ...p.line, action: p.action ? actionLines.indexOf(i) : null }));
  return {
    bbCents, table: String(body?.tableName ?? ""), startTime: body?.startTime ?? null,
    board: (body?.communityCards ?? []).filter(Boolean), heroCards: seats.find((s) => s.hero)?.cards ?? [],
    seats, log, actions, other: log.filter((l) => l.action == null),
    previousHandId: body?.previousHandId ?? null, nextHandId: body?.nextHandId ?? null,
  };
}

// ---------------------------------------------------------------------------------------------- compare

/** The archive keeps money to 0.1bb; Ignition's is exact to the cent (0.05bb at $2, 0.04bb at $0.25). */
const near = (a: number, b: number) => Math.abs(a - b) <= 0.06;
const diff = (kind: DiffKind, field: string, ours: string, ignition: string, extra: Partial<HhDiff> = {}): HhDiff =>
  ({ kind, field, ours, ignition, ...extra });
const cardsText = (cs: string[]) => cs.join(" ") || "—";

type Check = (ours: ParsedHand, ign: IgnHand) => HhDiff[];

const checkBigBlind: Check = (o, g) =>
  o.bbCents && o.bbCents !== g.bbCents ? [diff("big-blind", "big blind", `${o.bbCents}¢`, `${g.bbCents}¢`)] : [];

const checkSeats: Check = (o, g) => {
  const ours = [...(o.liveSeats ?? [])].sort((a, b) => a - b).join(",");
  const theirs = g.seats.map((s) => s.seat).sort((a, b) => a - b).join(",");
  return ours === theirs ? [] : [diff("seats", "seats dealt", ours || "—", theirs)];
};

const checkHero: Check = (o, g) => {
  const hero = g.seats.find((s) => s.hero);
  return [
    ...(hero && o.heroSeatId !== hero.seat ? [diff("hero-seat", "hero seat", String(o.heroSeatId), String(hero.seat))] : []),
    ...(g.heroCards.length && o.heroCards.join("") !== g.heroCards.join("")
      ? [diff("hero-cards", "hero cards", cardsText(o.heroCards), cardsText(g.heroCards))] : []),
  ];
};

const checkBoard: Check = (o, g) => {
  if (o.board.join(" ") === g.board.join(" ")) return [];
  const extra = o.board.length > g.board.length && g.board.every((c, i) => o.board[i] === c);
  return [extra
    ? diff("board-extra", "board", cardsText(o.board), cardsText(g.board), { note: "we archived card(s) the hand never dealt (rabbit hunt / stale board?)" })
    : diff("board", "board", cardsText(o.board), cardsText(g.board))];
};

/** Rows archived before 2026-09-24 carry no stacks as dealt: nothing to check, not a miss. */
const checkStartStacks: Check = (o, g) =>
  !o.startStacks ? [] : g.seats.flatMap((s) => {
    const got = o.startStacks![s.seat];
    return got != null && near(got, s.startBb) ? []
      : [diff("start-stack", `seat ${s.seat} start stack`, got == null ? "—" : `${got}bb`, `${s.startBb}bb`)];
  });

/** The archived stack is the last one read: before the pot is pushed (start − total bet) or after it (end) are both right. */
const checkEndStacks: Check = (o, g) =>
  g.seats.flatMap((s) => {
    const got = o.stacks?.[s.seat];
    const beforeAward = round2(s.startBb - s.totalBetBb);
    return got == null || near(got, s.endBb) || near(got, beforeAward) ? []
      : [diff("end-stack", `seat ${s.seat} end stack`, `${got}bb`, `${s.endBb}bb`,
          beforeAward !== s.endBb ? { note: `${beforeAward}bb before the pot was pushed` } : {})];
  });

/** An action on either side, with its index in that side's own list. */
interface Step { at: number; seat: number | null; type: string; amount?: number; street: string; postIn: boolean }

const oursSteps = (o: ParsedHand): Step[] =>
  o.actions.map((a, at) => ({ at, seat: a.seatId, type: a.type, amount: a.amount, street: a.street, postIn: false }));
const ignSteps = (g: IgnHand): Step[] =>
  g.actions.map((a, at) => ({ at, seat: a.seat, type: a.type, amount: a.amountBb, street: a.street, postIn: isPostIn(a.label) }));

/** Ignition logs a post-in right after the blinds; the reader files it at the poster's turn, as a limp (call) or, when
 *  the post covered it, a check. Each post-in is paired with that seat's first preflop call/check and both drop out.
 *  A post-in the hand's `postIns` already folded into the poster's own action — a raise (the post is inside its level)
 *  or a fold (the post stays in the pot as dead money) — has no row of its own on our side: Ignition's drops alone.
 *  (2026-09-26: hands 4920636325 / 4920636586 / 4920638121 / 4920638634 were flagged "post-in missing" while the
 *  archived rows carried every post.) */
const pairPostIns = (ours: Step[], ign: Step[], folded: ReadonlySet<number>): { ours: Step[]; ign: Step[] } => {
  const gone = new Set<Step>();
  for (const g of ign.filter((x) => x.postIn)) {
    const o = ours.find((x) => !gone.has(x) && x.seat === g.seat && x.street === "preflop" && (x.type === "call" || x.type === "check"));
    if (o) { gone.add(g); gone.add(o); }
    else if (g.seat !== null && folded.has(g.seat)) gone.add(g);
  }
  return { ours: ours.filter((o) => !gone.has(o)), ign: ign.filter((g) => !gone.has(g)) };
};

// an all-in is a bet, raise or call that uses every chip — the reader files a shove under any of the four
const MONEY_IN = new Set(["bet", "raise", "call", "all-in"]);
const sameType = (a: string, b: string) => a === b || ((a === "all-in" || b === "all-in") && MONEY_IN.has(a) && MONEY_IN.has(b));
const sameStep = (a: Step, b: Step) => a.seat === b.seat && a.street === b.street && sameType(a.type, b.type);

type Pair = readonly [Step | null, Step | null];

/** Longest-common-subsequence alignment on (seat, street, type): one missed action shows as one row, not a cascade.
 *  T[i][j] = the LCS length of a[i..] and b[j..], built bottom-up as a fold; the walk reads the pairs off it. */
function alignSteps(a: Step[], b: Step[]): Pair[] {
  const T = a.reduceRight<number[][]>((below, x) => {
    const next = below[0]!;
    const row = b.reduceRight<number[]>((right, y, j) => [sameStep(x, y) ? next[j + 1]! + 1 : Math.max(next[j]!, right[0]!), ...right], [0]);
    return [row, ...below];
  }, [new Array<number>(b.length + 1).fill(0)]);
  const walk = (i: number, j: number): Pair[] =>
    i >= a.length && j >= b.length ? []
    : i < a.length && j < b.length && sameStep(a[i]!, b[j]!) ? [[a[i]!, b[j]!], ...walk(i + 1, j + 1)]
    : j >= b.length || (i < a.length && T[i + 1]![j]! >= T[i]![j + 1]!) ? [[a[i]!, null], ...walk(i + 1, j)]
    : [[null, b[j]!], ...walk(i, j + 1)];
  return walk(0, 0);
}

const stepText = (s: Step | null) => (s ? `${s.street} seat ${s.seat ?? "?"} ${s.type}${s.amount != null ? ` ${s.amount}bb` : ""}` : "—");

/** An all-in's amount is the raise-to total on one side and the chips added on the other: only like types compare. */
const pairDiff = ([o, g]: Pair): HhDiff[] =>
  o && g
    ? o.amount != null && g.amount != null && o.type === g.type && !near(o.amount, g.amount)
      ? [diff("action-amount", `action ${o.at + 1} amount`, stepText(o), stepText(g), { oursAt: o.at, ignitionAt: g.at })] : []
    : o ? [diff("action-extra", `action ${o.at + 1} only in ours`, stepText(o), "—", { oursAt: o.at })]
    : [diff("action-missing", `Ignition action ${g!.at + 1} missing from ours`, "—", stepText(g), { ignitionAt: g!.at })];

const checkActions: Check = (o, g) => {
  const { ours, ign } = pairPostIns(oursSteps(o), ignSteps(g), new Set((o.postIns ?? []).map((p) => p.seatId)));
  return alignSteps(ours, ign).flatMap(pairDiff);
};

const CHECKS: Check[] = [checkBigBlind, checkSeats, checkHero, checkBoard, checkStartStacks, checkEndStacks, checkActions];

/** Where our archived hand disagrees with Ignition's record. Empty = the reader got it right. */
export const compareHand = (ours: ParsedHand, ign: IgnHand): HhDiff[] => CHECKS.flatMap((check) => check(ours, ign));

const BOARD_CARDS: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5 };

/** compareHand with both sides cut at hero's last action — the part of the hand every answer was built on. What
 *  happens after hero is done (other seats' later actions, later streets, end stacks) is left out. A recording that
 *  never got to hero is kept whole: everything in it came before hero's missing action. */
export function compareThroughHero(ours: ParsedHand, ign: IgnHand): HhDiff[] {
  const hero = ign.seats.find((s) => s.hero)?.seat;
  const gi = ign.actions.findLastIndex((a) => a.seat === hero);
  const oi = ours.actions.findLastIndex((a) => a.hero);
  const cards = gi < 0 ? 5 : BOARD_CARDS[ign.actions[gi]!.street];
  const cut = gi < 0 ? { ours, ign } : {
    ours: { ...ours, actions: oi < 0 ? ours.actions : ours.actions.slice(0, oi + 1), board: ours.board.slice(0, cards) },
    ign: { ...ign, actions: ign.actions.slice(0, gi + 1), board: ign.board.slice(0, cards) },
  };
  return compareHand(cut.ours, cut.ign).filter((d) => d.kind !== "end-stack");
}
