import type { ArrivalPath, PathReason, RangeCheck } from "./chainPath";
import { pctOf, type OffTreeLine } from "./offTree";

/**
 * THE CHAIN'S INVARIANTS, CHECKED ON EVERY ANSWER (2026-09-27, Brady's "checker coverage list"). The postflop chain —
 * one GTO Wizard custom tree per street, each street's input ranges = the previous street's output ranges — has
 * seventeen things that must hold for an answer to be the answer to the spot at the table. Some were already guarded
 * (a seat rotation GTO Wizard disagrees with stops the walk; a card dealt twice is refused at the gate; an all-zero
 * mix is refused), some were measured without a bound (wager-size snaps were a note), and some were not looked at at
 * all (does the pot the tree was solved at add up to the table's; is the rake the same on every street). This module
 * is the one place they are defined — the catalogue below is also the Coverage page's text, so the page IS the spec —
 * and every check is a pure function over data the chain already has in hand:
 *
 *   aiChain (per street, at the end of the street's walk)    #2 #3 #4 #6 #9 #10 #11 #12 #14(node) #17
 *   fastSolve (per street, against the capture)              #1 #5 #7 #8
 *   fastSolve (per decision, on the answer)                  #12(clock) #14 #15 #16 #17(preflop)
 *
 * Each check yields `{ id, status, text }` per street: pass ✓, fail ✗, flag ⚑ (#3 only — a villain mistake line is
 * worth seeing, never a verdict), na — (not evaluated: nothing to check, or the data is missing; the text says which).
 * They travel on the answer's DecisionPath (`checks`, per street), and a FAIL becomes a reason on the path with the
 * verdict "failed" — so the hand's verdict, the panel's banner and the session's Technical tab all see it — unless an
 * existing reason already says the same thing (`covered`: the range hand-off, a re-created tree, a node read twice,
 * a rebuilt arrival, a refusal), which keeps one cause from being counted twice.
 *
 * Tolerances are named here, and the timing ones can be set per process (CHECK_SOLVE_MEDIAN_X, CHECK_ACTION_CLOCK_MS).
 */

export type CheckStatus = "pass" | "fail" | "flag" | "na";
export type CheckStreet = "preflop" | "flop" | "turn" | "river";
export const CHECK_STREETS: readonly CheckStreet[] = ["preflop", "flop", "turn", "river"];

export interface CheckResult {
  /** 1..17 — the catalogue's id */
  id: number;
  status: CheckStatus;
  /** one line a person reads: what was compared, and on a fail what differed */
  text: string;
  /** a FAIL an existing reason on the path already reports (its code): shown, but not a second reason */
  covered?: string;
  /** #5 only: the POT the tree was solved at is not the table's (entering the street or at hero's node) — the seatbelt
   *  re-solves on it (fastSolve, 2026-10-03); a stack-only failure does not set it */
  potOff?: true;
}
export type PathChecks = Partial<Record<CheckStreet, CheckResult[]>>;

/**
 * A CHECK NEVER COSTS AN ANSWER (2026-09-27). The checks run inline on the live answer path — the walk and fastSolve's
 * assembly — so a check that throws (a node shape nobody expected, a field missing on an old capture) must not take the
 * answer with it. It reads as "not checked", with the error, and everything else goes on.
 */
export function guardCheck(id: number, fn: () => CheckResult): CheckResult {
  try { return fn(); } catch (e) { return { id, status: "na", text: `the check errored: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }; }
}
/** guardCheck for a function that returns several results (or a whole block): an error is one "na" line */
export function guardChecks<T>(id: number, fn: () => T, fallback: T): T {
  try { return fn(); } catch (e) {
    console.warn(`[checks] check #${id} errored — the answer goes on without it: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

export interface CheckDef {
  id: number;
  group: "inputs" | "process" | "output";
  name: string;
  /** the correct behaviour, in words — the owner's spec */
  spec: string;
  /** built = every part is checked on live answers; partial = some of it; to build = not checked yet */
  build: "built" | "partial" | "to build";
  /** how it is checked, and what is not (yet) */
  how: string;
}

/** The seventeen, as the owner wrote them (2026-09-27). The Coverage page renders this table as the spec. */
export const CHECKS: readonly CheckDef[] = [
  { id: 1, group: "inputs", name: "Ranges handed on",
    spec: "Each street starts from exactly the previous street's output ranges; the flop from the ranges of the preflop chart/pin that answered hero's preflop.",
    build: "built",
    how: "Turn/river: the ranges a street starts from are fingerprinted and compared with what the previous street's solve handed on (the hand-off check). Flop: the arrival must come from the preflop pin (or the strategy's own chart), and the flop's recorded input fingerprint must equal the ranges the tree request was built from." },
  { id: 2, group: "inputs", name: "Ranges sane",
    spec: "Every seat non-empty, no negative weights, villain holds no board/hero cards, hero's own combo present in hero's range.",
    build: "built",
    how: "On each street's entering ranges (after hero's class floor): every weight a finite number ≥ 0; every seat keeps weight once the board's cards are removed; every villain keeps a hand that shares no card with hero's; hero's exact combo has weight and is not on the board. Board-card combos inside a range are removed by the solver's own card removal, so what is checked is that something is LEFT after it." },
  { id: 3, group: "inputs", name: "Villain mistake lines",
    spec: "Villain action under 1% of his range at the node, no hand above 2%: flagged + logged.",
    build: "built",
    how: "A flag (⚑), never a verdict. GTO Wizard's custom solves are QRE (quantal response equilibrium, since 2025-04-16), so these low frequencies are not solver noise: they are the modelled mistake distribution, and the range after the action is QRE's model of who makes the mistake, not the pool's. Logged with villain's shown hand for a pool range later (/api/dashboard/off-tree)." },
  { id: 4, group: "inputs", name: "Seats right",
    spec: "OOP by position, GTO Wizard's node agrees on who acts, warm-up seating = live seating.",
    build: "built",
    how: "The street's seats must be in postflop order by position (heads-up the big blind acts first). GTO Wizard's node names the seat to act at every node and the walk refuses to continue on a disagreement — an answer that exists passed it at every node read. The warm-up's tree for the street must seat the same players in the same order." },
  { id: 5, group: "inputs", name: "Pot and stack add up",
    spec: "Pot entering each street = previous pot + chips put in, and matches the capture's pot within a tolerance; stack = effective stack of players still in.",
    build: "built",
    how: "The tree's pot entering each street, and the pot at hero's node, against the capture's own money (every seat's chips per street from the betting line, plus antes and dead posts; a bet past what any other seat can put in counts only what can be matched, on both sides): within 0.5bb or 5%. The tree's stack against hero vs the deepest villain still in, from the stacks as dealt less the chips of the earlier streets: within 0.5bb or 3% (a collapse plan's tree may be shallower, never deeper); and since 2026-10-03 each seat's own stack sent against the table's. A POT that disagrees is a seatbelt, not only a flag: the decision is solved again from the table's state, and refused if the pot still disagrees." },
  { id: 6, group: "inputs", name: "Line matches the table",
    spec: "Walked actions = captured actions in order; each bet size within a set tolerance of what was bet.",
    build: "built",
    how: "Every captured action of the street is walked, in order, as the same kind (check / call / fold / wager); each wager's size on the tree is within 0.5bb or 10% of the size bet at the table — an all-in too, since 2026-10-03 (it carries the table's amount; before, it was the tree's own stack and \"all-in = all-in\" was all that was compared). Before 2026-09-27 a snapped size was a note only." },
  { id: 7, group: "inputs", name: "Rake and stake right",
    spec: "Rake and stake right AND identical on every street of the hand.",
    build: "built",
    how: "The rake the tree request carried (percent and cap) against the site's rake for this stake and table (Ignition 6-max: 5%, cap by players dealt; CoinPoker HU: 5%, 0.9bb), and against every other tree of the hand. A strategy that sets no rake is not checked (GTO Wizard's default applies)." },
  { id: 8, group: "inputs", name: "Board right",
    spec: "Cards = capture, no duplicates, count matches the street.",
    build: "built",
    how: "The street's board as walked against the capture's board, three/four/five cards, no card twice with hero's. The capture gate refuses a card dealt twice or a board that is not a street before any solve — surfaced here on the refusal." },
  { id: 9, group: "process", name: "No unnecessary trees",
    spec: "One default tree per street + one only for a pinned off-tree villain size (or a 429 re-route); anything else fails.",
    build: "built",
    how: "From the hand's tree ledger (every tree the chain asked for, by street, plan and origin): one size-free tree per street; trees with pinned sizes and 429 re-routes are allowed; a size-free tree created again for the same street (a different key: ranges, pot or stack drifted) fails, as does a tree re-created for a resumed street (tree:recreated)." },
  { id: 10, group: "process", name: "No node fetched twice",
    spec: "No node fetched twice in a hand.",
    build: "built",
    how: "Every node fetched from GTO Wizard is remembered per hand; a second fetch of the same node is node:read-twice." },
  { id: 11, group: "process", name: "Warm-up tree = live tree",
    spec: "Warm-up tree = live tree unless a villain size had to be pinned.",
    build: "built",
    how: "The street warm-up (fired when the card lands) records its tree in the hand's tree ledger; the live walk of that street must use the same tree, unless the street's wagers pinned sizes into a tree of their own." },
  { id: 12, group: "process", name: "Solve time bounded",
    spec: "Per-street solve time bounded (≤ 3× that street's rolling median) and the whole answer inside the table's action clock (Ignition ~15 s).",
    build: "built",
    how: "Each street walked on a decision (tree + walk wall-clock) against the rolling median of the last 50 of that street (new trees and cached trees apart), once 10 are in; CHECK_SOLVE_MEDIAN_X sets the multiple. A live answer's whole time against CHECK_ACTION_CLOCK_MS (15 s). Warm-ups and replays are not against the clock." },
  { id: 13, group: "process", name: "Replay determinism",
    spec: "Same capture ⇒ same trees and mix (a script/nightly job).",
    build: "built",
    how: "Once a day, when no answer has been computed for 10 minutes, every live postflop decision of the last 2 days is replayed in a process of its own (scripts/replayDeterminism.ts) against a GTO Wizard that answers only from that decision's recorded trace — its trees, its nodes, and the cache state the live walk saw (a size-free tree it reused). The replay must ask for the same trees (pot, stack, board, sizes, rake; range weights within the trace's 4-decimal rounding), walk the same line on every street and reach the same hero node. No GTO Wizard quota. POST /api/dashboard/coverage/replay starts one now." },
  { id: 14, group: "output", name: "Answer at hero's node, legal actions",
    spec: "Answer is at hero's node and its actions ⊆ the table's offered buttons.",
    build: "built",
    how: "Hero's node: the walk's rotation and GTO Wizard's node both name hero. When the answer is solved, it is checked against the amount to call (no CHECK facing a bet, no FOLD/CALL with nothing to call, no raise when calling puts hero all in). When auto-execute presses it, the wrapper's relay records the action strip's labels on the very read it pressed from (the hand's autoExec), and every action the answer offers must be one of those buttons (a shove the table offers only as a CALL counts). Answers never pressed keep the first half only." },
  { id: 15, group: "output", name: "Mix valid",
    spec: "Sums ~100%, not all zero.",
    build: "built",
    how: "The served mix sums to 100% ± 1 over its actions and is not all zero. The zero-mix guard refuses an all-zero mix before it is served — surfaced here on the refusal." },
  { id: 16, group: "output", name: "Not stale",
    spec: "The answer's decision key = the live decision.",
    build: "built",
    how: "The answer carries the decision key it was solved for (street, board, cards, amount to call, actions so far) and its street must be the capture's. When auto-execute presses it, the relay records the spot the table showed just before the click (street and actions so far, counted like the key) in the hand's autoExec: a press on a spot that had moved on is stale. The relay's pickReady already refuses a moved spot, so this catches the gap between that check and the click (the random delay, a shove's multi-press)." },
  { id: 17, group: "output", name: "Strategy is for hero's combo",
    spec: "Hero's combo has weight at the node.",
    build: "built",
    how: "Postflop: hero's exact combo carries weight in his conditioned range at his node (the class floor keeps it alive on every street's entry). Preflop: the chart's range holds hero's class at the node." },
];
export const CHECK_NAME: Record<number, string> = Object.fromEntries(CHECKS.map((c) => [c.id, c.name]));

// ── tolerances ──────────────────────────────────────────────────────────────────────────────────────────────────
const envNum = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
export const TOL = {
  /** #5 pot: within max(0.5bb, 5%) */
  potBb: 0.5, potPct: 0.05,
  /** #5 stack: within max(0.5bb, 3%) */
  stackBb: 0.5, stackPct: 0.03,
  /** #6 wager size: within max(0.5bb, 10%) of the size bet */
  sizeBb: 0.5, sizePct: 0.1,
  /** #15 the mix sums to 100 ± this */
  mixPct: 1,
  /** #12 samples before the rolling median is trusted, and how many are kept; a street is never "slow" by less than
   *  a second over its median (a cache read is milliseconds, and three times nothing is still nothing) */
  solveMinSamples: 10, solveWindow: 50, solveMinOverMs: 1000,
};
/** #12 the multiple of the street's rolling median a solve may take (CHECK_SOLVE_MEDIAN_X, default 3) */
export const solveMedianX = (): number => envNum("CHECK_SOLVE_MEDIAN_X", 3);
/** #12 the table's action clock (CHECK_ACTION_CLOCK_MS, default Ignition's ~15 s) */
export const actionClockMs = (): number => envNum("CHECK_ACTION_CLOCK_MS", 15_000);

const r2 = (x: number): number => Math.round(x * 100) / 100;
const within = (a: number, b: number, bb: number, pct: number): boolean => Math.abs(a - b) <= Math.max(bb, pct * Math.max(Math.abs(a), Math.abs(b)));
const pass = (id: number, text: string): CheckResult => ({ id, status: "pass", text });
const fail = (id: number, text: string, covered?: string | null): CheckResult => ({ id, status: "fail", text, ...(covered ? { covered } : {}) });
const na = (id: number, text: string): CheckResult => ({ id, status: "na", text });
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

// ── folding results together ────────────────────────────────────────────────────────────────────────────────────
export const STATUS_RANK: Record<CheckStatus, number> = { na: 0, pass: 1, flag: 2, fail: 3 };

/** One result per id: the worst status wins; its texts are kept (a collapse plan's, a decision's own part). */
export function mergeChecks(xs: CheckResult[]): CheckResult[] {
  const by = new Map<number, CheckResult[]>();
  for (const x of xs) by.set(x.id, [...(by.get(x.id) ?? []), x]);
  const out: CheckResult[] = [];
  for (const [id, list] of by) {
    const top = Math.max(...list.map((x) => STATUS_RANK[x.status]));
    const worst = list.filter((x) => STATUS_RANK[x.status] === top);
    // a pass that adds a fact to another pass is kept (the street's part and the decision's part of #12, #14, #17)
    const texts = [...new Set((top <= STATUS_RANK.pass ? list.filter((x) => x.status !== "na" || top === 0) : worst).map((x) => x.text))];
    const covered = worst.every((x) => x.covered) ? worst[0]!.covered : undefined;
    const potOff = worst.some((x) => x.potOff);
    out.push({ id, status: worst[0]!.status, text: texts.join(" · "), ...(covered ? { covered } : {}), ...(potOff ? { potOff: true as const } : {}) });
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * CHECKS #14 / #16 AT THE PRESS (2026-09-27): what the wrapper's relay saw on the read it pressed from (the hand's
 * autoExec — apps/wrapper/src/autoLog.ts). Evaluated when a hand is read (the press comes after the answer was logged),
 * and merged into the answer's own #14 / #16 on its street, worst status winning.
 */
export function pressChecks(a: {
  buttons: string[] | null | undefined; atPress: string | null | undefined; stale: boolean | null | undefined;
  answerKey: string; actions: { action: string; frequency: number }[];
}): CheckResult[] {
  const out: CheckResult[] = [];
  if (a.buttons?.length) {
    const offered = new Set(a.buttons.map(answerKind));
    const live = a.actions.filter((x) => x.frequency > 0.001);   // percent: a 1e-6 residue is not an action the answer offers
    const need = [...new Set(live.map((x) => answerKind(x.action)))];
    const asCall = !offered.has("wager") && offered.has("call");  // the client offers a shove as a CALL when it is hero's stack
    const missing = need.filter((k) => !offered.has(k) && !(k === "wager" && asCall));
    out.push(missing.length
      ? fail(14, `at the press: the answer offers ${missing.map((k) => k.toUpperCase()).join(", ")}; the table's buttons were ${a.buttons.join(" / ")}`)
      : pass(14, `at the press: ${live.map((x) => x.action).join(" / ") || "the pick"} ⊆ the table's buttons (${a.buttons.join(" / ")})${need.includes("wager") && asCall ? " — the shove offered as a CALL" : ""}`));
  }
  if (a.stale === true) out.push(fail(16, `at the press the table showed ${a.atPress}, not the spot the answer was solved for (${a.answerKey})`));
  else if (a.stale === false) out.push(pass(16, `at the press the table still showed the answer's spot (${a.atPress})`));
  return out;
}

/** A logged answer's path with its press-time results merged onto its street (the path JSON as stored, or null). */
export function withPressChecks(path: string | null, street: string, xs: CheckResult[]): string | null {
  if (!path || !xs.length || !(CHECK_STREETS as readonly string[]).includes(street)) return path;
  try {
    const p = JSON.parse(path) as { checks?: PathChecks };
    p.checks = addChecks(p.checks ?? {}, street as CheckStreet, xs);
    return JSON.stringify(p);
  } catch { return path; }
}

/** An archived hand's autoExec decision that pressed this answer: same street, same action count (decisionKey[4]). */
export function pressedAnswerPath(row: { path: string | null; decision_key: string | null; decision_json?: string | null },
  autoExec: unknown): string | null {
  if (!row.path || !row.decision_key || !Array.isArray(autoExec)) return row.path;
  let street: string | null = null, acts: number | null = null;
  try {
    const k = JSON.parse(row.decision_key);
    if (Array.isArray(k)) { street = typeof k[0] === "string" ? k[0] : null; acts = Number.isFinite(Number(k[4])) ? Number(k[4]) : null; }
  } catch { return row.path; }
  if (street == null || acts == null) return row.path;
  const d = (autoExec as Record<string, unknown>[]).find((x) => x && x.street === street && x.keyActs === acts && (Array.isArray(x.buttons) || typeof x.stale === "boolean"));
  if (!d) return row.path;
  let actions: { action: string; frequency: number }[] = [];
  try { const j = JSON.parse(row.decision_json ?? "[]"); if (Array.isArray(j)) actions = j.map((x: any) => ({ action: String(x.action ?? ""), frequency: Number(x.frequency) || 0 })); } catch { /* none */ }
  const results = guardChecks(14, () => pressChecks({
    buttons: Array.isArray(d.buttons) ? (d.buttons as unknown[]).map(String) : null, atPress: typeof d.atPress === "string" ? d.atPress : null,
    stale: typeof d.stale === "boolean" ? d.stale : null, answerKey: `${street}|${acts}`, actions,
  }), [] as CheckResult[]);
  return withPressChecks(row.path, street, results);
}

/** Add a street's results to a path's checks (a collapse plan's are prefixed with the plan). */
export function addChecks(into: PathChecks, street: CheckStreet, xs: CheckResult[], plan?: string | null): PathChecks {
  if (!xs.length) return into;
  const tagged = plan ? xs.map((x) => ({ ...x, text: `${plan}: ${x.text}` })) : xs;
  into[street] = mergeChecks([...(into[street] ?? []), ...tagged]);
  return into;
}

/** The codes a failed check is grouped by (the Technical tab's reasons table). */
export const checkCode = (id: number): string =>
  `check:${id}-${(CHECK_NAME[id] ?? "check").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;

/** Every failed check that no other reason reports, as a reason with the verdict "failed". */
export function checkReasons(checks: PathChecks | null | undefined): PathReason[] {
  const out: PathReason[] = [];
  if (!checks) return out;
  for (const st of CHECK_STREETS) {
    for (const c of checks[st] ?? []) {
      if (c.status !== "fail" || c.covered) continue;
      out.push({ v: "failed", code: checkCode(c.id), text: `${st}: ${CHECK_NAME[c.id] ?? `check ${c.id}`} — ${c.text}`.slice(0, 300) });
    }
  }
  return out;
}

/** The process checks of a street reused from the hand's memo describe the decision that walked it (history). */
export function asWalkedEarlier(c: CheckResult): CheckResult {
  if (c.id < 9 || c.id > 12) return c;
  return { ...c, text: `when walked: ${c.text}`, ...(c.status === "fail" ? { covered: c.covered ?? "earlier-decision" } : {}) };
}

// ── 1326-combo arithmetic (GTO Wizard's order: card = rank*4 + suit "cdhs", combo(a<b) = b(b-1)/2 + a) ───────────────
const RANKS = "23456789TJQKA", SUITS = "cdhs";
export const cardIndex = (card: string): number => {
  const r = RANKS.indexOf(card[0]!.toUpperCase()), s = SUITS.indexOf(card[1]!.toLowerCase());
  return r < 0 || s < 0 ? -1 : r * 4 + s;
};
const COMBO_CARDS: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let b = 1; b < 52; b++) for (let a = 0; a < b; a++) out[(b * (b - 1)) / 2 + a] = [a, b];
  return out;
})();
export const comboCardsOf = (idx: number): [number, number] | null => COMBO_CARDS[idx] ?? null;
const cardName = (i: number): string => `${RANKS[Math.floor(i / 4)]}${SUITS[i % 4]}`;
export const comboName = (idx: number | null | undefined): string | null => {
  const cc = idx == null ? null : comboCardsOf(idx);
  return cc ? `${cardName(cc[1])}${cardName(cc[0])}` : null;
};

// ── #1 ranges handed on ─────────────────────────────────────────────────────────────────────────────────────────
/** Turn and river: the hand-off check the chain already records (chainPath.RangeCheck). */
export function checkHandoff(c: RangeCheck | null | undefined): CheckResult {
  if (!c) return na(1, "no hand-off check recorded (a walk from before 2026-09-26)");
  if (c.ok === true) return pass(1, c.why);
  if (c.ok === false) return fail(1, c.why, "check:range-handoff");
  return na(1, c.why);
}

const fpShort = (fp: string | null | undefined): string => (fp ? `#${fp.slice(0, 6)}` : "—");

/** The flop: its ranges come from the preflop piece that answered hero's preflop, and it started from exactly them. */
export function checkFlopArrival(a: { arrival?: ArrivalPath | null; started?: string | null; expected?: string | null }): CheckResult {
  const ar = a.arrival;
  if (!ar) return na(1, "no record of where the flop ranges came from");
  const fp = a.started && a.expected
    ? a.started === a.expected ? ` — fingerprint ${fpShort(a.started)} verified` : null
    : "";
  if (fp === null) {
    return fail(1, `the flop started from ranges ${fpShort(a.started)}, but the tree request was built from ${fpShort(a.expected)} — the flop did not start from these preflop ranges`);
  }
  const src = (how: string, producer: string, why?: string | null): string =>
    how === "pin" ? `from the preflop pin (${producer}) — the tree hero's preflop answers were read on`
      : how === "designed" ? `from the strategy's own preflop source (${producer})`
        : how === "by-design" ? `by design: ${why ?? producer}`
          : `rebuilt: ${why ?? producer}`;
  if (ar.how === "rebuilt") return fail(1, `flop ranges ${src("rebuilt", ar.producer, ar.why)}`, ar.code ?? `arrival:${ar.producer}`);
  if (ar.how === "hit") {
    const f = ar.first;
    if (f?.how === "rebuilt") return fail(1, `flop ranges from this hand's memo, first ${src("rebuilt", f.producer, f.why)} (reported when first computed)`, f.code ?? "arrival:first-rebuilt");
    return pass(1, `flop ranges from this hand's memo, first computed ${f ? src(f.how, f.producer, f.why) : `by ${ar.producer}`}${fp}`);
  }
  return pass(1, `flop ranges ${src(ar.how, ar.producer, ar.why)}${fp}`);
}

// ── #2 ranges sane ──────────────────────────────────────────────────────────────────────────────────────────────
export function checkRangesSane(a: {
  seats: { pos: string; range: number[] }[]; heroIdx: number; heroCombo: number | null;
  /** hero's combo weight before the class floor (null when not known: a resumed street) */
  heroBefore?: number | null;
  /** the street's board, short cards ("As") */
  board: string[];
}): CheckResult {
  const boardIdx = new Set(a.board.map(cardIndex).filter((x) => x >= 0));
  const hero = a.heroCombo != null ? comboCardsOf(a.heroCombo) : null;
  const problems: string[] = [];
  const sizes: string[] = [];
  a.seats.forEach((s, i) => {
    let bad = 0, live = 0, liveVsHero = 0;
    for (let c = 0; c < s.range.length; c++) {
      const w = s.range[c];
      if (w == null || !Number.isFinite(w) || w < 0) { bad++; continue; }
      if (!(w > 0)) continue;
      const cc = COMBO_CARDS[c];
      if (!cc || boardIdx.has(cc[0]) || boardIdx.has(cc[1])) continue;
      live += w;
      if (!hero || (cc[0] !== hero[0] && cc[0] !== hero[1] && cc[1] !== hero[0] && cc[1] !== hero[1])) liveVsHero += w;
    }
    if (bad) problems.push(`${s.pos}: ${bad} weight${bad === 1 ? "" : "s"} negative or not a number`);
    if (!(live > 0)) problems.push(`${s.pos}'s range is empty once the board's cards are removed`);
    else if (i !== a.heroIdx && hero && !(liveVsHero > 0)) problems.push(`${s.pos} holds no hand that shares no card with hero's`);
    sizes.push(`${s.pos} ${r2(live)}`);
  });
  let heroTxt = "";
  if (a.heroCombo != null && hero) {
    const name = comboName(a.heroCombo);
    const w = a.seats[a.heroIdx]?.range[a.heroCombo] ?? 0;
    if (boardIdx.has(hero[0]) || boardIdx.has(hero[1])) problems.push(`hero's ${name} shares a card with the board ${a.board.join("")}`);
    else if (!(w > 0)) problems.push(`hero's ${name} has no weight in his own range`);
    heroTxt = `; hero's ${name} ${w.toFixed(3)}${a.heroBefore != null && a.heroBefore < w - 1e-9 ? ` (floored from ${a.heroBefore.toFixed(3)})` : ""}`;
  }
  if (problems.length) return fail(2, problems.join("; "));
  return pass(2, `every seat holds weight once the board's cards are removed (${sizes.join(", ")} combos); no negative weight${heroTxt}`);
}

// ── #3 villain mistake lines ────────────────────────────────────────────────────────────────────────────────────
export function checkMistakeLines(lines: OffTreeLine[], villainActions: number): CheckResult {
  if (lines.length) {
    return { id: 3, status: "flag", text: lines.map((l) =>
      `${l.seat} ${l.action}${l.betsize != null ? ` ${l.betsize}` : ""}: ${pctOf(l.nodeFreq)} of his range, no hand above ${pctOf(l.maxHand)}` +
      `${l.evGapBb != null ? `, costs him ${l.evGapBb.toFixed(2)}bb` : ""}`).join("; ") +
      " — a villain mistake line: GTO Wizard's QRE models it as a mistake, so the range after it is QRE's, not the pool's" };
  }
  if (!villainActions) return na(3, "no villain action walked on this street");
  return pass(3, `${villainActions} villain action${villainActions === 1 ? "" : "s"}, none under 1% of his range at the node`);
}

// ── #4 seats right ──────────────────────────────────────────────────────────────────────────────────────────────
/** Postflop acting order by position: blinds first, the button last; heads-up the big blind acts first. */
const POSTFLOP_ORDER = ["SB", "BB", "UTG", "UTG+1", "UTG+2", "LJ", "MP", "HJ", "CO", "BTN"];
export function expectedOrder(players: string[]): string[] | null {
  const up = players.map((p) => p.toUpperCase());
  if (up.length === 2 && up.includes("BB") && (up.includes("SB") || up.includes("BTN"))) {
    return up[0] === "BB" ? players.slice() : [players[1]!, players[0]!];
  }
  if (up.some((p) => !POSTFLOP_ORDER.includes(p))) return null;       // a label outside the order (a merged seat): not checked
  return players.slice().sort((a, b) => POSTFLOP_ORDER.indexOf(a.toUpperCase()) - POSTFLOP_ORDER.indexOf(b.toUpperCase()));
}
export function checkSeats(a: { players: string[]; agreed: number; unnamed: number; warmSeats?: string[] | null; origin?: string | null }): CheckResult {
  const want = expectedOrder(a.players);
  if (want && want.join("/") !== a.players.join("/")) {
    return fail(4, `the tree seats ${a.players.join(" → ")} in acting order; by position it is ${want.join(" → ")} (out of position first)`);
  }
  if (a.warmSeats && a.origin !== "warm" && a.warmSeats.join("/").toUpperCase() !== a.players.join("/").toUpperCase()) {
    return fail(4, `the warm-up seated ${a.warmSeats.join(" → ")}, this walk ${a.players.join(" → ")}`);
  }
  const order = want ? "in postflop order by position" : "(a merged seat: order by position not checked)";
  const node = a.agreed ? `GTO Wizard named the same seat to act at ${a.agreed} node${a.agreed === 1 ? "" : "s"} read${a.unnamed ? ` (${a.unnamed} unnamed)` : ""}`
    : a.unnamed ? `${a.unnamed} node${a.unnamed === 1 ? "" : "s"} read without a named seat` : "no node read on this decision (resumed)";
  const warm = a.origin === "warm" ? "this is the warm-up" : a.warmSeats ? "the warm-up seated the same" : "no warm-up tree for this street";
  return pass(4, `${a.players.join(" → ")} ${order}; ${node}; ${warm}`);
}

// ── #5 pot and stack add up ─────────────────────────────────────────────────────────────────────────────────────
export function checkPotStack(a: {
  street: string;
  potIn: number; capturePot: number | null;
  stackIn: number; captureStack: number | null;
  /** hero's node on the decision street: the pot there, and the capture's */
  potNode?: number | null; captureNodePot?: number | null;
  /** a collapse plan / last resort: the tree may be shallower than the field, never deeper */
  plan?: string | null;
  /** a last resort re-rooted on this street carries this street's dead chips in its entering pot */
  skipPotIn?: boolean;
  /** EACH SEAT'S STACK as the tree was sent it against the table's (2026-10-03): position, tree, table */
  seatStacks?: { pos: string; tree: number; table: number }[];
}): CheckResult {
  const bad: string[] = [], ok: string[] = [];
  let potOff = false;
  if (a.capturePot == null) ok.push("the capture's pot unknown");
  else if (a.skipPotIn) ok.push(`pot entering not compared (${a.plan ?? "re-rooted"}: this street's dead chips are in it)`);
  else if (!within(a.potIn, a.capturePot, TOL.potBb, TOL.potPct)) { potOff = true; bad.push(`pot entering the ${a.street} ${r2(a.potIn)}bb, the capture's ${r2(a.capturePot)}bb (Δ ${r2(a.potIn - a.capturePot)}bb)`); }
  else ok.push(`pot ${r2(a.potIn)}bb = capture ${r2(a.capturePot)}bb`);
  if (a.potNode != null) {
    if (a.captureNodePot == null) ok.push("the capture's pot at hero's node unknown");
    else if (!within(a.potNode, a.captureNodePot, TOL.potBb, TOL.potPct)) { potOff = true; bad.push(`pot at hero's node ${r2(a.potNode)}bb, the capture's ${r2(a.captureNodePot)}bb (Δ ${r2(a.potNode - a.captureNodePot)}bb)`); }
    else ok.push(`${r2(a.potNode)}bb at hero's node`);
  }
  if (a.seatStacks?.length) {
    const off = a.seatStacks.filter((x) => !within(x.tree, x.table, TOL.stackBb, TOL.stackPct));
    if (off.length) bad.push(`seat stacks sent ${off.map((x) => `${x.pos} ${r2(x.tree)}bb (table ${r2(x.table)}bb)`).join(", ")}`);
    else ok.push(`each seat's own stack (${a.seatStacks.map((x) => `${x.pos} ${r2(x.tree)}`).join(" / ")}) = the table's`);
  }
  if (a.captureStack == null) ok.push("the stacks as dealt unknown");
  else if (a.plan) {
    const cap = a.captureStack + Math.max(TOL.stackBb, TOL.stackPct * a.captureStack);
    if (a.stackIn > cap) bad.push(`stack ${r2(a.stackIn)}bb is deeper than the field's effective ${r2(a.captureStack)}bb`);
    else ok.push(`stack ${r2(a.stackIn)}bb ≤ the field's effective ${r2(a.captureStack)}bb (${a.plan})`);
  } else if (!within(a.stackIn, a.captureStack, TOL.stackBb, TOL.stackPct)) {
    bad.push(`stack ${r2(a.stackIn)}bb, the effective stack of the players still in is ${r2(a.captureStack)}bb (Δ ${r2(a.stackIn - a.captureStack)}bb)`);
  } else ok.push(`stack ${r2(a.stackIn)}bb = effective ${r2(a.captureStack)}bb`);
  if (bad.length) return { ...fail(5, bad.join("; ")), ...(potOff ? { potOff: true as const } : {}) };
  if (a.capturePot == null && a.captureStack == null) return na(5, ok.join("; "));
  return pass(5, ok.join("; "));
}

// ── #6 line matches the table ───────────────────────────────────────────────────────────────────────────────────
type Kind = "check" | "call" | "fold" | "wager";
const kindOfLabel = (l: string): Kind => (l === "Check" ? "check" : l === "Call" ? "call" : l === "Fold" ? "fold" : "wager");
const kindOfName = (n: string): Kind => {
  const u = n.toLowerCase();
  return u.startsWith("check") ? "check" : u.startsWith("call") ? "call" : u.startsWith("fold") ? "fold" : "wager";
};
const labelBb = (l: string): number | null => { const m = l.match(/^(?:Bet|Raise|AllIn)\((\d+(?:\.\d+)?)\)$/); return m ? Number(m[1]) / 100 : null; };
export function checkLine(a: {
  /** the street's actions as captured, as the walk's labels (Check / Call / Fold / Bet(330) / Raise(900) / AllIn(9750)) */
  captured: string[];
  /** the action walked at each of them: GTO Wizard's name and size (null = not walked) */
  walked: ({ name: string; betsize: number | null } | null)[];
}): CheckResult {
  if (!a.captured.length) return pass(6, "no action before hero's node on this street");
  const bad: string[] = [], sizes: string[] = [];
  if (a.walked.length !== a.captured.length || a.walked.some((w) => !w)) {
    return fail(6, `walked ${a.walked.filter(Boolean).length} of the ${a.captured.length} captured actions`);
  }
  a.captured.forEach((c, i) => {
    const w = a.walked[i]!;
    const ck = kindOfLabel(c), wk = kindOfName(w.name);
    if (ck !== wk) { bad.push(`#${i + 1}: captured ${c}, walked ${w.name}`); return; }
    if (ck !== "wager") return;
    const want = labelBb(c), got = w.betsize;
    // an all-in carries the table's amount since 2026-10-03 (it was the tree's own stack, so "all-in = all-in" was all
    // there was to say): both sizes are compared like any wager's — a 28bb shove walked as a 97.8 all-in is a fail
    if (want == null || got == null) { sizes.push(`${c} → ${w.name}`); return; }
    const diff = Math.abs(got - want);
    if (diff > Math.max(TOL.sizeBb, TOL.sizePct * want)) {
      bad.push(`#${i + 1}: ${r2(want)}bb bet at the table, walked as the tree's ${w.name.toUpperCase()} ${r2(got)}bb (Δ ${r2(diff)}bb, ${Math.round((100 * diff) / want)}%) — over the bound (0.5bb / 10%)`);
    } else sizes.push(diff > 0.005 ? `${r2(want)} → ${r2(got)}` : `${r2(want)}`);
  });
  if (bad.length) return fail(6, bad.join("; "));
  return pass(6, `${a.captured.length} action${a.captured.length === 1 ? "" : "s"} walked as captured, in order${sizes.length ? `; sizes ${sizes.join(", ")}bb` : ""}`);
}

// ── #7 rake and stake ───────────────────────────────────────────────────────────────────────────────────────────
export interface RakeSpec { pct_of_pot: number; cap_in_chips: number }
const sameRake = (x: RakeSpec | null | undefined, y: RakeSpec | null | undefined): boolean =>
  !!x && !!y && Math.abs(Number(x.pct_of_pot) - Number(y.pct_of_pot)) < 1e-6 && Math.abs(Number(x.cap_in_chips) - Number(y.cap_in_chips)) < 1e-6;
const rakeTxt = (x: RakeSpec | null | undefined): string => (x ? `${x.pct_of_pot}% cap ${r2(Number(x.cap_in_chips))}bb` : "none recorded");
export function checkRake(a: {
  rake: RakeSpec | null | undefined;
  /** the site's rake for this stake and table; null = the strategy sets none */
  expected: RakeSpec | null;
  site?: string | null;
  /** every other tree of the hand: the street it solved and its rake */
  others: { street: string; rake: RakeSpec | null | undefined }[];
}): CheckResult {
  if (!a.rake) return na(7, "the tree request was not recorded (a walk from before 2026-09-24)");
  const differ = a.others.filter((o) => o.rake && !sameRake(o.rake, a.rake));
  if (differ.length) {
    return fail(7, `solved at ${rakeTxt(a.rake)}, but the hand's ${[...new Set(differ.map((d) => `${d.street} at ${rakeTxt(d.rake)}`))].join(", ")} — the rake changed within the hand`);
  }
  if (!a.expected) return na(7, `${rakeTxt(a.rake)} — this strategy sets no table rake (GTO Wizard's default)`);
  if (!sameRake(a.rake, a.expected)) return fail(7, `solved at ${rakeTxt(a.rake)}, the table's rake is ${rakeTxt(a.expected)}${a.site ? ` (${a.site})` : ""}`);
  const streets = [...new Set(a.others.map((o) => o.street))];
  return pass(7, `${rakeTxt(a.rake)}${a.site ? ` (${a.site})` : ""}${streets.length ? ` — the same on ${streets.join("/")}` : ""}`);
}

// ── #8 board right ──────────────────────────────────────────────────────────────────────────────────────────────
export function checkBoard(a: { board: string; capture: string[]; k: number; heroCards: string[] }): CheckResult {
  const norm = (c: string) => (c.length === 2 ? `${c[0]!.toUpperCase()}${c[1]!.toLowerCase()}` : c);
  const cards = (a.board.match(/.{2}/g) ?? []).map(norm);
  const want = 3 + a.k;
  const street = ["flop", "turn", "river"][a.k] ?? `street ${a.k}`;
  const cap = a.capture.map(norm).slice(0, want);
  if (cards.length !== want) return fail(8, `${cards.length} card${cards.length === 1 ? "" : "s"} walked on the ${street} (${cards.join("")}) — ${want} expected`);
  if (cap.length < want) return fail(8, `the capture shows ${cap.length} board card${cap.length === 1 ? "" : "s"} (${cap.join("")}), the ${street} was walked on ${cards.join("")}`);
  if (cap.join("") !== cards.join("")) return fail(8, `walked on ${cards.join("")}, the capture shows ${cap.join("")}`);
  const all = [...cards, ...a.heroCards.map(norm)];
  const dup = all.find((c, i) => all.indexOf(c) !== i);
  if (dup) return fail(8, `${dup} appears twice among the board ${cards.join("")} and hero's ${a.heroCards.join("")}`);
  return pass(8, `${cards.join(" ")} — ${want} cards, as captured; no card twice with hero's ${a.heroCards.map(norm).join("")}`);
}

// ── #9 no unnecessary trees ─────────────────────────────────────────────────────────────────────────────────────
export interface TreeLedgerEntry { solId: string; sizeFree: boolean; origin?: string | null; reroute?: boolean }
export function checkTrees(a: {
  street: string;
  tree: "cached" | "created" | "none";
  leak?: { code: string; why: string } | null;
  /** every tree the hand asked for on this street and plan (services/handFacts tree ledger) */
  trees: TreeLedgerEntry[];
}): CheckResult {
  if (a.leak?.code === "tree:recreated") return fail(9, a.leak.why, "tree:recreated");
  const plain = [...new Set(a.trees.filter((t) => t.sizeFree && !t.reroute).map((t) => t.solId))];
  const pinned = new Set(a.trees.filter((t) => !t.sizeFree && !t.reroute).map((t) => t.solId)).size;
  const reroutes = a.trees.filter((t) => t.reroute).length;
  if (plain.length > 1) {
    return fail(9, `the ${a.street}'s default tree was created ${plain.length} times in this hand (${plain.map((x) => x.slice(0, 8)).join(", ")}) — its ranges, pot or stack changed between walks`);
  }
  const now = a.tree === "none" ? "a memo hit on this decision" : a.tree === "created" ? "created on this decision" : "cached on this decision";
  const parts = [`${plain.length} default tree`, ...(pinned ? [`${pinned} with a pinned size`] : []), ...(reroutes ? [`${reroutes} re-created after a 429 (allowed)`] : [])];
  return pass(9, `${parts.join(" + ")} for the ${a.street} in this hand; ${now}`);
}

// ── #10 no node fetched twice ───────────────────────────────────────────────────────────────────────────────────
export function checkNodeReads(a: { leak?: { code: string; why: string } | null; reads?: { cache: number; joined: number; fetched: number; store?: number } | null }): CheckResult {
  if (a.leak?.code === "node:read-twice") return fail(10, a.leak.why, "node:read-twice");
  if (!a.reads) return pass(10, "no node read on this decision");
  const r = a.reads;
  // `store`: of the cache reads, the ones the persistent solve cache served (services/gtowSolveCache)
  return pass(10, `${r.cache} node${r.cache === 1 ? "" : "s"} from the cache${r.store ? ` (${r.store} from the persistent solve cache)` : ""}, ${r.joined} joined, ${r.fetched} fetched — none fetched twice in this hand`);
}

// ── #11 warm-up tree = live tree ────────────────────────────────────────────────────────────────────────────────
export function checkWarmTree(a: { street: string; origin: string | null; solId: string | null; fixed: string[] | null; warm: string[] }): CheckResult {
  if (a.origin === "warm") return na(11, "this is the warm-up itself");
  if (!a.warm.length) return na(11, `no warm-up tree recorded for the ${a.street} (it warmed another street, or did not run)`);
  if (a.solId && a.warm.includes(a.solId)) return pass(11, `the live walk used the warm-up's tree (${a.solId.slice(0, 8)})`);
  if (a.fixed?.length) return pass(11, `a size was pinned since the warm-up (fixed [${a.fixed.join(",")}]) — a tree of its own, by design`);
  return fail(11, `the warm-up solved tree ${a.warm.map((x) => x.slice(0, 8)).join("/")}, the live walk ${a.solId?.slice(0, 8) ?? "?"} — with no size pinned`);
}

// ── #12 solve time bounded ──────────────────────────────────────────────────────────────────────────────────────
/** The rolling per-street solve times (in memory: a restart collects a new baseline). */
export class SolveTimes {
  private readonly m = new Map<string, number[]>();
  record(key: string, ms: number): void {
    const xs = this.m.get(key) ?? [];
    xs.push(ms);
    if (xs.length > TOL.solveWindow) xs.splice(0, xs.length - TOL.solveWindow);
    this.m.set(key, xs);
  }
  median(key: string): { median: number | null; samples: number } {
    const xs = [...(this.m.get(key) ?? [])].sort((a, b) => a - b);
    if (!xs.length) return { median: null, samples: 0 };
    const mid = Math.floor(xs.length / 2);
    return { median: xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2, samples: xs.length };
  }
  reset(): void { this.m.clear(); }
}
export const solveTimes = new SolveTimes();

export function checkSolveTime(a: { street: string; ms: number | null; median: number | null; samples: number; created: boolean }): CheckResult {
  const kind = a.created ? "new trees" : "cached trees";
  if (a.ms == null) return na(12, "not solved on this decision");
  if (a.median == null || a.samples < TOL.solveMinSamples) return na(12, `${a.street} took ${secs(a.ms)} — collecting a baseline (${a.samples}/${TOL.solveMinSamples} ${kind})`);
  const x = solveMedianX();
  if (a.ms > x * a.median && a.ms - a.median > TOL.solveMinOverMs) return fail(12, `the ${a.street} took ${secs(a.ms)}, over ${x}× its rolling median of ${secs(a.median)} (${kind}, last ${a.samples})`);
  return pass(12, `${a.street} ${secs(a.ms)} ≤ ${x}× the median ${secs(a.median)} (${kind})`);
}
export function checkAnswerClock(a: { ms: number; origin: string | null }): CheckResult {
  const clock = actionClockMs();
  if (a.origin !== "live") return na(12, `${a.origin ?? "ad-hoc"} call — not against the table's clock (${secs(a.ms)})`);
  if (a.ms > clock) return fail(12, `the answer took ${secs(a.ms)}, past the ${secs(clock)} action clock`);
  return pass(12, `answered in ${secs(a.ms)}, inside the ${secs(clock)} action clock`);
}

// ── #14 answer at hero's node, legal actions ────────────────────────────────────────────────────────────────────
const answerKind = (label: string): Kind => {
  const u = label.trim().toLowerCase();
  return u.startsWith("fold") ? "fold" : u.startsWith("check") ? "check" : /^(call|limp|complete)/.test(u) ? "call" : "wager";
};
/** The walk's own part (aiChain, at hero's node): both the rotation and GTO Wizard's node name hero. */
export function checkHeroNode(a: { heroPos: string; nodeSaid: string | null }): CheckResult {
  return pass(14, `hero's node: the walk's rotation has ${a.heroPos} to act${a.nodeSaid ? ` and GTO Wizard's node names ${a.nodeSaid}` : ""}`);
}
export function checkButtons(a: {
  actions: { action: string; frequency: number }[];
  toCall: number | null; heroBehind?: number | null;
  /** the table's offered buttons, when the capture carries them (the Ignition wrapper exports none) */
  legal?: string[];
  /** the node's seat against hero's, when both are seat names (heads-up BTN and SB are one seat) */
  nodePos?: string | null; heroPos?: string | null; hu?: boolean;
}): CheckResult {
  // seat names from different vocabularies (a chart's BU is the table's BTN): only the six the table itself uses are
  // compared — a name outside them (OOP/IP, LJ, MP, UTG+1) is not evidence either way
  const seat = (p: string) => {
    const u0 = p.toUpperCase();
    const u = u0 === "BU" || u0 === "D" || u0 === "DEALER" ? "BTN" : u0;
    return a.hu && (u === "BTN" || u === "SB") ? "BTN~SB" : u;
  };
  const named = (p: string | null | undefined): p is string => !!p && ["SB", "BB", "UTG", "HJ", "CO", "BTN", "BU"].includes(p.toUpperCase());
  if (named(a.nodePos) && named(a.heroPos) && seat(a.nodePos) !== seat(a.heroPos)) {
    return fail(14, `the answer is ${a.nodePos}'s node, not hero's (${a.heroPos})`);
  }
  const live = a.actions.filter((x) => x.frequency > 0);
  const kinds = new Set(live.map((x) => answerKind(x.action)));
  const names = live.map((x) => x.action).join(" / ") || "no action";
  if (a.legal?.length) {
    const offered = new Set(a.legal.map(answerKind));
    const extra = [...kinds].filter((k) => !offered.has(k));
    if (extra.length) return fail(14, `the answer offers ${extra.join(", ").toUpperCase()}; the table's buttons are ${a.legal.join(" / ")}`);
    return pass(14, `${names} ⊆ the table's buttons (${a.legal.join(" / ")})`);
  }
  if (a.toCall == null) return na(14, "the amount to call is unknown");
  const bad: string[] = [];
  if (a.toCall > 0.005 && kinds.has("check")) bad.push(`CHECK facing ${r2(a.toCall)}bb`);
  if (!(a.toCall > 0.005) && kinds.has("fold")) bad.push("FOLD with nothing to call");
  if (!(a.toCall > 0.005) && kinds.has("call")) bad.push("CALL with nothing to call");
  if (a.heroBehind != null && a.toCall > 0.005 && a.heroBehind <= a.toCall + 0.01 && kinds.has("wager")) bad.push(`a raise although calling ${r2(a.toCall)}bb puts hero all in (${r2(a.heroBehind)}bb behind)`);
  if (bad.length) return fail(14, `the answer offers ${bad.join("; ")}`);
  return pass(14, `${names} — consistent with ${a.toCall > 0.005 ? `facing ${r2(a.toCall)}bb` : "nothing to call"} (the buttons are not captured: checked against the amount to call)`);
}

// ── #15 mix valid ───────────────────────────────────────────────────────────────────────────────────────────────
export function checkMix(actions: { frequency: number }[]): CheckResult {
  if (!actions.length) return fail(15, "the answer carries no action");
  if (actions.every((x) => !(x.frequency > 0))) return fail(15, "every action at 0%");
  const sum = actions.reduce((s, x) => s + (Number.isFinite(x.frequency) ? x.frequency : 0), 0);
  if (Math.abs(sum - 100) > TOL.mixPct) return fail(15, `the mix sums to ${sum.toFixed(1)}%, not 100%`);
  return pass(15, `sums to ${sum.toFixed(1)}% over ${actions.length} action${actions.length === 1 ? "" : "s"}`);
}

// ── #16 not stale ───────────────────────────────────────────────────────────────────────────────────────────────
export function checkFresh(a: { answerStreet: string | null | undefined; handStreet: string; key: string }): CheckResult {
  if (a.answerStreet && a.answerStreet !== a.handStreet) return fail(16, `the answer is for the ${a.answerStreet}, the decision is on the ${a.handStreet}`);
  return pass(16, `solved for ${a.key} — the decision it was asked for; the relay drops an answer whose key no longer matches the table (the wrapper's side, not visible here)`);
}

// ── #17 strategy for hero's combo ───────────────────────────────────────────────────────────────────────────────
export function checkHeroCombo(a: { heroCombo: number | null; weight: number | null | undefined }): CheckResult {
  if (a.heroCombo == null) return na(17, "hero's cards unknown");
  const name = comboName(a.heroCombo) ?? "hero's combo";
  const w = a.weight ?? 0;
  if (!(w > 0)) return fail(17, `hero's ${name} has no weight in his range at the node — the strategy read is not his hand's`);
  return pass(17, `hero's ${name} carries weight ${w.toFixed(3)} in his range at the node`);
}
export function checkPreflopInRange(a: { notInRange?: boolean | null; heroClass: string | null | undefined }): CheckResult {
  if (a.notInRange) return fail(17, `hero's ${a.heroClass ?? "hand"} is not in the chart's range at the node`);
  return pass(17, `hero's ${a.heroClass ?? "hand"} is in the range at the node`);
}

// ── the Coverage page: every decision's checks over a window ────────────────────────────────────────────────────
export interface CoverageRow { ts: number; client_hand_id: string | null; session_id?: string | null; street: string | null; path?: string | null }
export interface CoverageExample { hand: string; street: string; status: CheckStatus; text: string; ts: number }
export interface CoverageCheck extends CheckDef {
  /** decisions whose worst result for this check was each status */
  pass: number; fail: number; flag: number; na: number;
  /** did any decision in the window produce a real (non-na) result */
  seen: boolean;
  /** hands with a fail (or a flag) — most recent first, one per hand */
  examples: CoverageExample[];
  failHands: number;
}
export interface CoverageReport { decisions: number; withChecks: number; hands: number; checks: CoverageCheck[] }

export function coverageReport(rows: CoverageRow[], maxExamples = 25): CoverageReport {
  const tally = new Map<number, { pass: number; fail: number; flag: number; na: number; ex: Map<string, CoverageExample>; failHands: Set<string> }>();
  for (const d of CHECKS) tally.set(d.id, { pass: 0, fail: 0, flag: 0, na: 0, ex: new Map(), failHands: new Set() });
  let decisions = 0, withChecks = 0;
  const hands = new Set<string>();
  for (const r of rows) {
    if (!r.path) continue;
    let p: { checks?: PathChecks } | null = null;
    try { p = JSON.parse(r.path); } catch { p = null; }
    decisions++;
    if (!p?.checks) continue;
    withChecks++;
    const hand = r.client_hand_id ?? "?";
    hands.add(hand);
    const worst = new Map<number, { c: CheckResult; street: string }>();
    for (const st of CHECK_STREETS) for (const c of p.checks[st] ?? []) {
      const cur = worst.get(c.id);
      if (!cur || STATUS_RANK[c.status] > STATUS_RANK[cur.c.status]) worst.set(c.id, { c, street: st });
    }
    for (const [id, { c, street }] of worst) {
      const t = tally.get(id);
      if (!t) continue;
      t[c.status]++;
      if (c.status === "fail" || c.status === "flag") {
        if (c.status === "fail") t.failHands.add(hand);
        const prev = t.ex.get(hand);
        if (!prev || prev.ts < r.ts || (prev.status === "flag" && c.status === "fail")) t.ex.set(hand, { hand, street, status: c.status, text: c.text, ts: r.ts });
      }
    }
  }
  return {
    decisions, withChecks, hands: hands.size,
    checks: CHECKS.map((d) => {
      const t = tally.get(d.id)!;
      return {
        ...d, pass: t.pass, fail: t.fail, flag: t.flag, na: t.na, seen: t.pass + t.fail + t.flag > 0,
        failHands: t.failHands.size,
        examples: [...t.ex.values()].sort((a, b) => (a.status === b.status ? b.ts - a.ts : a.status === "fail" ? -1 : 1)).slice(0, maxExamples),
      };
    }),
  };
}
