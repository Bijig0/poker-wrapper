/**
 * THE INPUT-MUTATION HARNESS (2026-09-25, Brady: "test all in a manner of how our system would actually function
 * in a real table … don't have enough permutative data on game states that could happen in an actual game").
 *
 * Deals hands the way an Ignition 6-max table deals them, renders each hero decision as the wrapper's own hand
 * export (the earliest point the study API reads), mutates that state the way real tables and real captures vary,
 * and asks the real answer pipeline the only question that matters at the table: DOES A SOLVER INPUT EXIST?
 *   preflop  → fastSolve must answer from the charts (or say it needs the cloud, which is gated off here)
 *   postflop → fastSolve runs to the moment the cloud would be called and reports the assembled input
 *              (POSTFLOP_DRY_RUN=1: ranges for every flop seat, hero's weight, pot, stacks, the collapse plan)
 * Offline: GTOW_BLOCK=1, the baked charts only, no quota. Every finding is a reproducible fixture.
 *
 *   bun src/scripts/mutationHarness.ts [--seeds=400] [--ops=all|a,b,c] [--pairs=200] [--triples=0] [--out=src/scripts/mutation/out] [--seed0=1]
 *
 * Operators (each is a behaviour a real table or a real capture produces):
 *   nl5-rounding     the 5c test stake: every amount is what the client executes in cents (2.5x → 2.6bb, SB 0.4)
 *   nl25-rounding    the same at 25c
 *   stack-drift      the behind stacks read ±0.3bb differently on each street (the live reading wobbles)
 *   short-seat       one seat dealt 18-70bb (every position, every rung)
 *   deep-seat        one seat dealt 130-200bb
 *   thin-table       4 or 5 seats (3 = the AI piece; counted as cloud-gated, never a finding)
 *   dead-sb          no small blind seat this hand
 *   limps            1-3 open limps before the first raise
 *   odd-open         an open size off every chart menu (2.3x, 2.8x, 3.3x, 4x)
 *   odd-3bet         a 3-bet at 2.5x or 6x the open
 *   jam              a short stack jams preflop
 *   hero-deviates    hero takes an unlikely action (cold-calls a 3-bet, limps, min-raises)
 *   late-fold        a villain's preflop fold is filed one action late (the reader's badge lag)
 *   missed-fold      a villain's preflop fold never reaches the export at all (the tap misses folds; nothing backfills it)
 *   post-in          a player (hero in about a third) POSTS IN a live 1bb out of turn (0.4bb sometimes at 5c): the
 *                    wrapper's {type:"post"}; his free option is a check, a call is the increment (utils/foldPostIns)
 *   undealt-seat     a labelled seat that was not dealt (sitting out): absent from liveSeats, no action, no start stack
 *   dropped-call     a villain's preflop call never reaches the export         → a refusal is the RIGHT answer
 *   lost-sb-complete the small blind COMPLETES (a limped pot) and the complete never reaches the export; he folds
 *                    later or plays on — the case the pot ledger's 0.6bb slack could not see (round 3)
 *                                                                              → a refusal is the RIGHT answer
 *   lost-flop-call   a villain's flop call never reaches the export (before a later hero decision)
 *                                                                              → a refusal is the RIGHT answer
 *   dup-card         a board card equals one of hero's                          → a refusal is the RIGHT answer
 *   board-short      the flop export carries two cards                          → a refusal is the RIGHT answer
 *   unlabelled-seat  a villain who acted has no position label                  → a refusal is the RIGHT answer
 *
 * The lost-action operators drop the ACTION only: the chips stay truthful in the export (`committed`, `stacks`, and since
 * round 3 the wrapper's exact per-seat WebSocket counts `wsStack` / `wsInFront`), because at a table the money moved —
 * so the capture gate's exact per-seat rule (utils/repairPostflopRotation lostActionFaults) is what must catch them.
 *
 * Verdicts per decision: ok · cloud-gated (the AI piece, blocked here) · expected-refusal · FINDING (a refusal, a
 * throw, a zero-weight hero, or a slow local answer where an answer was due). A finding is reported with the SMALLEST
 * operator set that produces it while the unmutated seed passes (baseline failures are findings of their own).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// ---- environment: offline, dry, and pointed at the baked charts even from a worktree -----------------------------
// The answer log opens its file when the module loads, so that one is fixed here; everything else is applied
// around a sweep and restored after it (bun runs every test file in one process — a flag left behind here failed
// the request-log and poller tests on the first run).
process.env.ANSWERS_DB_PATH ??= ":memory:";
export function harnessEnv(): () => void {
  const saved = { GTOW_BLOCK: process.env.GTOW_BLOCK, POSTFLOP_DRY_RUN: process.env.POSTFLOP_DRY_RUN, HRC6MAX_DB: process.env.HRC6MAX_DB,
    NODE_TRUST_FILE: process.env.NODE_TRUST_FILE };
  process.env.GTOW_BLOCK = "1";
  process.env.POSTFLOP_DRY_RUN = "1";
  if (!process.env.HRC6MAX_DB) {
    // THE BAKE THE LIVE API READS (2026-10-03). The harness used to take the main checkout's own data/ copy — which on
    // the owner's machine was a bake of 2026-09-27, 124 charts, from the bodies as they were BEFORE the 2026-10-01
    // re-conversion; the live API reads the factory's bake (FACTORY_DATA_DIR in config/local.env). So the gated tests,
    // the replay gate's first run and every offline check answered from charts the tables no longer get. Order now:
    // FACTORY_DATA_DIR (the env's, else config/local.env's of the main checkout), then a data/ copy as before.
    const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: import.meta.dir, encoding: "utf8" }).stdout?.trim();
    const root = common ? dirname(common) : "";
    let factory = process.env.FACTORY_DATA_DIR ?? "";
    if (!factory && root) {
      try {
        const m = readFileSync(join(root, "config", "local.env"), "utf8").match(/^\s*FACTORY_DATA_DIR\s*=\s*(.+?)\s*$/m);
        if (m) factory = m[1]!;
      } catch { /* no local.env on this machine: the data/ copies below */ }
    }
    const candidates = [
      factory ? join(factory, "hrc6max-preflop.sqlite") : "",
      join(import.meta.dir, "..", "..", "data", "hrc6max-preflop.sqlite"),
      root ? join(root, "gto-trainer", "apps", "api", "data", "hrc6max-preflop.sqlite") : "",
    ];
    const found = candidates.find((p) => p && existsSync(p));
    if (found) process.env.HRC6MAX_DB = found;
  }
  // THE TRUST SCORES THE LIVE API READS (2026-10-02/03). Trust comes from the bake set above (its trust tables); the
  // factory's limp_node_trust.json is only the fallback for a chart the bake does not score — and since the v2 limp
  // re-solve an olimp chart scored by neither is REFUSED (services/nodeTrust). A git worktree has no data/ copy and the
  // gate does not load config/local.env, so point the fallback at the factory's file (FACTORY_DATA_DIR of the env, else
  // of the main checkout's config/local.env) — never at a checkout's stale data/ snapshot.
  if (!process.env.NODE_TRUST_FILE && !process.env.FACTORY_DATA_DIR) {
    const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: import.meta.dir, encoding: "utf8" }).stdout?.trim();
    const root = common ? dirname(common) : "";
    let factory = "";
    try { factory = /^\s*FACTORY_DATA_DIR\s*=\s*(.+?)\s*$/m.exec(readFileSync(join(root, "config", "local.env"), "utf8"))?.[1] ?? ""; } catch { /* no local.env */ }
    const file = factory ? join(factory, "limp_node_trust.json") : "";
    if (file && existsSync(file)) process.env.NODE_TRUST_FILE = file;
  }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { fastSolve, forgetPreflopPin, forgetPostflopPin } from "../services/fastSolve";
import { withStartStacks } from "../utils/archivedHand/archivedHand";
import { setRangeWalkRecorder, type RecordedRangeWalk } from "../utils/reconstructFlopRanges/reconstructFlopRanges";
import { nodeGetter } from "../services/hrc6max";
import { layer1, layer2Postflop, layer2Preflop, truthLine, postflopTokenMismatch, repickOf, type OracleFinding } from "./mutation/rangeOracle";
import { rakeCapCents } from "../services/profiles";

/**
 * The export as the API reads it LIVE (feed/resolveHand, live path): normalizeHand, then withStartStacks — every seat
 * the table's own account covers reads its money as dealt minus what its captured actions put in. The harness used
 * to stop at normalizeHand (2026-09-25, overnight fixer), so its `stacks` carried a lost call's chips, evidence the
 * live API never sees; an oracle fed by that would pass a capture gate that is blind at the table.
 */
export const liveHand = (raw: any) => withStartStacks(normalizeHand(raw).hand!);

const STRATEGY = "ign200-ring-6max-equilibrium";
const POS: Record<number, string[]> = { 3: ["BTN", "SB", "BB"], 4: ["CO", "BTN", "SB", "BB"], 5: ["HJ", "CO", "BTN", "SB", "BB"], 6: ["UTG", "HJ", "CO", "BTN", "SB", "BB"] };
const RANKS = "23456789TJQKA", SUITS = "cdhs";

// ---- a small deterministic RNG (mulberry32) ---------------------------------------------------------------------
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number { let t = (this.s += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)]!; }
  chance(p: number): boolean { return this.next() < p; }
  weighted<T>(xs: readonly [T, number][]): T { const tot = xs.reduce((s, [, w]) => s + w, 0); let r = this.next() * tot; for (const [x, w] of xs) { r -= w; if (r <= 0) return x; } return xs[xs.length - 1]![0]; }
}

// ---- the hand: seats, stacks, a legal betting sequence, a board ----------------------------------------------------
export interface Seat { id: number; pos: string; stack: number }
export interface Action { street: 0 | 1 | 2 | 3; seat: number; type: "post-sb" | "post-bb" | "post" | "fold" | "check" | "call" | "bet" | "raise" | "all-in"; amount?: number }
export interface Hand {
  seats: Seat[]; hero: number; bbCents: number; sbPost: number; heroCards: [string, string]; board: string[];
  actions: Action[]; ops: string[];
  /** a player who POSTED IN out of turn this hand (the wrapper's {type:"post"}), and how much */
  postIn?: { seat: number; amount: number } | null;
  /** a seat that holds a position label but was not dealt (sitting out): no action, not in liveSeats */
  undealt?: number | null;
  /** a DEAD BUTTON (the undealt seat is the button): the labels a wrapper before 2026-10-04 exported — the undealt seat
   *  BTN, the dealt ones a name early — where `seats[].pos` holds the truth, the names among the dealt */
  exportPos?: Record<number, string> | null;
}
export interface GenOpts {
  seatsN?: number; shortSeat?: { pos: string; bb: number } | null; deepSeat?: { pos: string; bb: number } | null; deadSb?: boolean;
  limps?: number; oddOpen?: number | null; odd3bet?: number | null; jam?: boolean; heroDeviates?: boolean; bbCents?: number;
  postIn?: boolean; undealtSeat?: boolean;
  /** the small blind (not hero) completes whenever the pot is unopened when he acts — so `lost-sb-complete` has one to drop */
  sbCompletes?: boolean;
  /** every seat facing a FLOP bet calls it (hero included) — so `lost-flop-call` has a villain call before a later hero decision */
  flopCaller?: boolean;
}

const roundCents = (bb: number, bbCents: number): number => Math.round(Math.round(bb * bbCents) / bbCents * 100) / 100;

/** What hero does at a preflop decision: the study tool's own pick, executed the way the client executes it. */
export type HeroPolicy = (partial: Hand, street: 0 | 1 | 2 | 3) => Promise<{ type: "fold" | "check" | "call" | "raise" | "all-in"; to?: number } | null>;

export async function dealHand(rng: Rng, o: GenOpts = {}, heroPolicy?: HeroPolicy): Promise<Hand> {
  const n = o.seatsN ?? rng.weighted([[6, 5], [5, 3], [4, 2]]);
  const bbCents = o.bbCents ?? 200;
  const ids = [1, 2, 3, 4, 5, 6].sort(() => rng.next() - 0.5).slice(0, n).sort((a, b) => a - b);
  const start = rng.int(n);
  const seats: Seat[] = ids.map((id, i) => ({ id, pos: POS[n]![(i - start + n) % n]!, stack: 100 }));
  for (const s of seats) s.stack = rng.weighted([[100, 6], [rng.pick([96.5, 98.2, 103.4, 108.7, 112.1]), 3], [rng.pick([88, 92.5, 95]), 1]]);
  if (o.shortSeat) { const s = seats.find((x) => x.pos === o.shortSeat!.pos); if (s) s.stack = o.shortSeat.bb; }
  if (o.deepSeat) { const s = seats.find((x) => x.pos === o.deepSeat!.pos); if (s) s.stack = o.deepSeat.bb; }
  if (o.deadSb) { const i = seats.findIndex((x) => x.pos === "SB"); if (i >= 0) seats.splice(i, 1); }
  // a labelled seat that was not dealt (sitting out): never a blind, never hero
  const undealtCands = o.undealtSeat ? seats.filter((x) => x.pos !== "SB" && x.pos !== "BB") : [];
  const undealt = undealtCands.length ? rng.pick(undealtCands).id : null;
  const hero = rng.pick(seats.filter((x) => x.id !== undealt)).id;
  const sbPost = bbCents === 5 ? 0.4 : 0.5;
  // cards
  const deck: string[] = []; for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) { const j = rng.int(i + 1); [deck[i], deck[j]] = [deck[j]!, deck[i]!]; }
  const heroCards: [string, string] = [deck[0]!, deck[1]!];
  const board = deck.slice(2, 7);
  // A DEAD BUTTON (2026-10-04, hands 4922296152 / 4922299303): when the seat sitting out is the BUTTON, the truth is the
  // dealt seats named among the dealt (the dealt non-blind seats take the latest names: five dealt HJ/CO/BTN/SB/BB) —
  // the BTN acts after the CO, so a missing button is not a padded fold behind hero. The export keeps the labels a
  // wrapper before the fix sent (the undealt seat BTN, the rest one name early), so normalizeHand's renaming is what the
  // case tests; the oracle and the action order read the truth. The undealt seat is no position at all here.
  let exportPos: Record<number, string> | null = null;
  const undealtSeat = seats.find((x) => x.id === undealt);
  if (undealtSeat?.pos === "BTN") {
    exportPos = Object.fromEntries(seats.map((s) => [s.id, s.pos]));
    const others = seats.filter((s) => s.id !== undealt && s.pos !== "SB" && s.pos !== "BB")
      .sort((x, y) => POS[n]!.indexOf(x.pos) - POS[n]!.indexOf(y.pos));
    const late = ["UTG", "HJ", "CO", "BTN"].slice(4 - others.length);
    others.forEach((s, i) => { s.pos = late[i]!; });
    undealtSeat.pos = "-";
  }
  const hand: Hand = { seats, hero, bbCents, sbPost, heroCards, board, actions: [], ops: [], undealt, exportPos };
  const byPos = (p: string) => seats.find((x) => x.pos === p);
  const committed = new Map<number, number>(); const behind = new Map(seats.map((s) => [s.id, s.stack]));
  const live = new Set(seats.map((s) => s.id).filter((id) => id !== undealt));
  const put = (a: Action, amt: number) => { // amt = total this street for raises/bets/posts, added for calls
    const prev = committed.get(a.seat) ?? 0;
    const total = a.type === "call" ? prev + amt : amt;
    const add = total - prev;
    behind.set(a.seat, Math.round((behind.get(a.seat)! - add) * 100) / 100);
    committed.set(a.seat, total);
  };
  const post = (p: string, type: "post-sb" | "post-bb", amt: number) => { const s = byPos(p); if (!s) return; const a: Action = { street: 0, seat: s.id, type, amount: amt }; hand.actions.push(a); put(a, amt); };
  post("SB", "post-sb", sbPost); post("BB", "post-bb", 1);
  // POSTED IN (Ignition btn 8): a new player's live blind, in WS order after the blinds — 1bb, or 0.4bb at the 5c stake;
  // hero himself in about a third of the hands
  if (o.postIn) {
    const cands = seats.filter((x) => x.id !== undealt && x.pos !== "SB" && x.pos !== "BB");
    const heroCand = cands.find((x) => x.id === hero);
    const who = heroCand && rng.chance(0.35) ? heroCand : cands.length ? rng.pick(cands) : null;
    if (who) {
      const amount = bbCents === 5 && rng.chance(0.4) ? 0.4 : 1;
      const a: Action = { street: 0, seat: who.id, type: "post", amount };
      hand.actions.push(a); put(a, amount);
      hand.postIn = { seat: who.id, amount };
    }
  }
  // preflop order: after the BB, clockwise by position list
  const order = (street: number): number[] => {
    const ps = POS[n]!.filter((p) => byPos(p));
    if (street === 0) { const i = ps.indexOf("BB"); return [...ps.slice(i + 1), ...ps.slice(0, i + 1)].map((p) => byPos(p)!.id); }
    const i = ps.indexOf("SB") >= 0 ? ps.indexOf("SB") : ps.indexOf("BB");
    return [...ps.slice(i), ...ps.slice(0, i)].map((p) => byPos(p)!.id);
  };
  const allin = (id: number) => (behind.get(id) ?? 0) <= 0.001;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const play = async (street: 0 | 1 | 2 | 3, pot: number): Promise<number> => {
    if (street > 0) committed.clear();
    let level = street === 0 ? 1 : 0; let lastInc = street === 0 ? 1 : 0; let raises = 0;
    // Nobody starts matched, the big blind included: in a limped pot the BB still has his option and a real table
    // records his check (or raise). Seeding the BB as matched ended every limped round at the last limp with the BB
    // never acting — no check in the export, hero-in-the-BB never asked — and the flop read "hero (BB) is not among
    // the seats reaching the flop" (2026-09-25, the `limps` findings: a generator bug, not the pipeline's).
    const matched = new Set<number>();
    const ring = order(street).filter((id) => live.has(id));
    let limpsLeft = street === 0 ? (o.limps ?? 0) : 0;
    let guard = 0, i = 0; let acted = 0;
    while (guard++ < 60) {
      if ([...live].filter((id) => !allin(id)).length < 2 && [...live].every((id) => allin(id) || matched.has(id) || (committed.get(id) ?? 0) >= level)) break;
      const id = ring[i % ring.length]!; i++;
      if (!live.has(id) || allin(id)) { if (acted >= ring.length && [...live].every((x) => allin(x) || matched.has(x))) break; continue; }
      if (matched.has(id) && (committed.get(id) ?? 0) >= level) { if ([...live].every((x) => allin(x) || matched.has(x))) break; continue; }
      const isHero = id === hero; const prev = committed.get(id) ?? 0; const owe = r2(level - prev); const stack = behind.get(id)!;
      const potNow = pot + [...committed.values()].reduce((s, v) => s + v, 0);
      let type: Action["type"]; let to: number | null = null;
      const minTo = r2(level + Math.max(lastInc, street === 0 ? 1 : 1));
      const canRaise = stack > owe + 0.01 && raises < 4;
      const policyPick = isHero && street === 0 && heroPolicy && !(o.heroDeviates && rng.chance(0.3)) ? await heroPolicy(hand, street) : null;
      // the poster with nothing to call has a free option: he checks or raises, never folds
      const freeOption = street === 0 && hand.postIn?.seat === id && owe <= 0.01;
      if (policyPick) {
        type = policyPick.type;
        // an "All-in" pick is the client's all-in button: hero's whole stack. It used to take the min-raise here (no
        // size in the label) and stay typed all-in, so a 175bb hero "went all-in for 30" and then acted again — the
        // flop refused the capture as "CO acted preflop after going all-in" (seed 1065 [deep-seat], a generator bug)
        if (type === "all-in") to = r2(prev + stack);
        if (type === "raise") { to = policyPick.to ?? minTo; if (to < minTo) to = minTo; if (to >= prev + stack - 0.01) { to = r2(prev + stack); type = "all-in"; } }
        if (type === "call" && owe <= 0.01) type = "check";
        if (type === "check" && owe > 0.01) type = "call";
        if ((type === "raise") && !canRaise) type = owe > 0.01 ? "call" : "check";
      } else if (street === 0) {
        const unopened = level <= 1;
        if (unopened && o.sbCompletes && !isHero && byPos("SB")?.id === id) type = "call";
        else if (unopened && limpsLeft > 0 && !isHero && byPos("BB")?.id !== id) { type = "call"; limpsLeft--; }
        else if (unopened && byPos("BB")?.id === id && level <= 1) type = rng.chance(0.75) ? "check" : "raise";
        else if (unopened && freeOption) type = rng.chance(0.75) ? "check" : "raise";
        else if (unopened) type = rng.weighted([["fold", 62], ["raise", 33], ["call", isHero && o.heroDeviates ? 30 : 4]]);
        else if (raises === 1) type = rng.weighted([["fold", 58], ["call", 30], ["raise", 12]]);
        else type = rng.weighted([["fold", 55], ["call", isHero && o.heroDeviates ? 40 : 28], ["raise", 12]]);
        if (type === "check" && owe > 0.01) type = "call";
        if (type === "raise" && !canRaise) type = owe > 0.01 ? "call" : "check";
        if (type === "call" && owe <= 0.01) type = "check";
        if (type === "raise") {
          if (unopened) { const mult = o.oddOpen ?? rng.weighted([[2.5, 55], [3, 22], [2, 12], [3.5, 7], [2.2, 4]]); to = mult; if (isHero && o.heroDeviates && rng.chance(0.4)) to = minTo; }
          else if (raises === 1) { const m = o.odd3bet ?? rng.weighted([[3, 30], [3.5, 30], [4, 18], [4.5, 10], [5, 12]]); to = r2(level * m); }
          else to = r2(level * rng.weighted([[2.2, 40], [2.5, 40], [3, 20]]));
          if (to < minTo) to = minTo;
          if (o.jam && stack < 45 && !isHero && rng.chance(0.8)) to = r2(prev + stack);
          if (to >= prev + stack - 0.01) { to = r2(prev + stack); type = "all-in"; }
        }
      } else {
        const facing = owe > 0.01;
        if (!facing) type = rng.weighted([["check", 55], ["bet", 45]]);
        else type = rng.weighted([["fold", 40], ["call", 45], ["raise", 15]]);
        if (o.flopCaller && street === 1 && facing) type = "call";
        if ((type === "bet" || type === "raise") && !canRaise) type = facing ? "call" : "check";
        if (type === "bet") { to = r2(potNow * rng.weighted([[0.33, 35], [0.5, 30], [0.75, 25], [1, 10]])); if (to < 1) to = 1; }
        if (type === "raise") { to = r2(Math.max(minTo, level * rng.weighted([[2.5, 40], [3, 40], [4, 20]]))); }
        if (to != null && to >= prev + stack - 0.01) { to = r2(prev + stack); type = "all-in"; }
      }
      if (type === "call" && owe >= stack - 0.01) { type = "all-in"; to = r2(prev + stack); }
      const a: Action = { street, seat: id, type };
      if (type === "fold") { live.delete(id); hand.actions.push(a); acted++; if (live.size < 2) return potNow; continue; }
      if (type === "check") { matched.add(id); hand.actions.push(a); acted++; if ([...live].every((x) => allin(x) || matched.has(x))) break; continue; }
      if (type === "call") { a.amount = owe; hand.actions.push(a); put(a, owe); matched.add(id); acted++; if ([...live].every((x) => allin(x) || matched.has(x))) break; continue; }
      // bet / raise / all-in: a new level
      const total = to!; const cents = roundCents(total, bbCents);
      a.amount = cents; hand.actions.push(a); put(a, cents); acted++;
      if (cents > level + 0.01) { lastInc = Math.max(lastInc, r2(cents - level)); level = cents; raises++; matched.clear(); }
      matched.add(id);
      i = ring.indexOf(id) + 1;
    }
    return pot + [...committed.values()].reduce((s, v) => s + v, 0);
  };
  let pot = await play(0, 0);
  for (const st of [1, 2, 3] as const) { if (live.size < 2) break; if ([...live].filter((id) => !allin(id)).length < 2) break; pot = await play(st, pot); }
  return hand;
}

// ---- the export the wrapper would write at one of hero's decisions -------------------------------------------------
const STREETS = ["preflop", "flop", "turn", "river"] as const;
export function exportAt(hand: Hand, k: number, key: string, drift = 0, streetAt?: 0 | 1 | 2 | 3): any {
  const upto = hand.actions.slice(0, k);
  const cur = { street: hand.actions[k]?.street ?? streetAt ?? 0 };
  const streetName = STREETS[cur.street];
  const committed: Record<number, number> = {}; const spent: Record<number, number> = {};
  const perStreet: Record<number, Record<number, number>> = {};
  for (const a of upto) {
    if (a.amount == null) continue;
    const m = (perStreet[a.street] ??= {});
    m[a.seat] = a.type === "call" ? (m[a.seat] ?? 0) + a.amount : Math.max(m[a.seat] ?? 0, a.amount);
  }
  for (const [st, m] of Object.entries(perStreet)) for (const [seat, v] of Object.entries(m)) {
    spent[+seat] = (spent[+seat] ?? 0) + v;
    if (+st === cur.street) committed[+seat] = v;
  }
  const potByStreet: Record<string, number> = {};
  for (const [st, m] of Object.entries(perStreet)) if (+st < cur.street) potByStreet[STREETS[+st]!] = Object.values(m).reduce((s, v) => s + v, 0);
  const potBefore = Object.values(potByStreet).reduce((s, v) => s + v, 0);
  const pot = Math.round((potBefore + Object.values(committed).reduce((s, v) => s + v, 0)) * 100) / 100;
  const level = Math.max(0, ...Object.values(committed));
  const toCall = Math.round((level - (committed[hand.hero] ?? 0)) * 100) / 100;
  const folded = new Set(upto.filter((a) => a.type === "fold").map((a) => a.seat));
  const stacks: Record<number, number> = {};
  for (const s of hand.seats) stacks[s.id] = Math.round((s.stack - (spent[s.id] ?? 0) + (drift ? (((s.id * 7 + cur.street * 3) % 5) - 2) * drift / 2 : 0)) * 100) / 100;
  const positions: Record<number, string> = {}; for (const s of hand.seats) positions[s.id] = hand.exportPos?.[s.id] ?? s.pos;
  // THE TABLE'S OWN CHIP COUNTS, AS THE WRAPPER EXPORTS THEM (round 3, wrapper ignition/ws.ts wsChips): chips behind for
  // every dealt seat that has sent a frame this hand (a blind, a post, any action — a fold's frame too), chips in front
  // this street for every dealt seat. Computed from the DEALT line, so an export operator that loses an action leaves
  // the money truthful — exactly what the WebSocket does at a table. Exact: never drifted.
  const dealtIds = hand.seats.filter((s) => s.id !== hand.undealt).map((s) => s.id);
  const framed = new Set(upto.map((a) => a.seat));
  const wsStack: Record<number, number> = {}, wsInFront: Record<number, number> = {};
  for (const s of hand.seats) {
    if (!dealtIds.includes(s.id)) continue;
    if (framed.has(s.id)) wsStack[s.id] = Math.round((s.stack - (spent[s.id] ?? 0)) * 10000) / 10000;
    wsInFront[s.id] = committed[s.id] ?? 0;
  }
  return {
    handId: 1, clientHandId: key, bbCents: hand.bbCents, heroSeatId: hand.hero, heroCards: hand.heroCards,
    board: hand.board.slice(0, cur.street === 0 ? 0 : cur.street + 2), street: streetName,
    actions: upto.map((a) => ({ seatId: a.seat, hero: a.seat === hand.hero, type: a.type, street: STREETS[a.street], ...(a.amount != null ? { amount: a.amount } : {}) })),
    liveSeats: hand.seats.filter((s) => s.id !== hand.undealt).map((s) => s.id), committed, potByStreet, positions, stacks,
    startStacks: Object.fromEntries(hand.seats.filter((s) => s.id !== hand.undealt).map((s) => [s.id, s.stack])),
    // MUTATION_WS_CHIPS=0: the export as it was before round 3 (no per-seat WS counts) — to measure what the old gate let through
    ...(process.env.MUTATION_WS_CHIPS === "0" ? {} : { wsStack, wsInFront, lineSource: "ws" }),
    currentNode: { street: streetName, toActSeatId: hand.hero, toActIsHero: true, pot, toCall, legalActions: [], complete: false },
    heroFolded: false, heroWon: false, ended: false, sessionId: "mutation-harness", folded: [...folded],
  };
}

// ---- operators -------------------------------------------------------------------------------------------------------
export const OPERATORS = ["nl5-rounding", "nl25-rounding", "stack-drift", "short-seat", "deep-seat", "thin-table", "dead-sb", "limps", "odd-open", "odd-3bet", "jam", "hero-deviates", "late-fold", "missed-fold", "post-in", "undealt-seat", "dropped-call", "lost-sb-complete", "lost-flop-call", "dup-card", "board-short", "unlabelled-seat"] as const;
export type Op = (typeof OPERATORS)[number];
export const EXPECT_REFUSAL: ReadonlySet<string> = new Set(["dropped-call", "lost-sb-complete", "lost-flop-call", "dup-card", "board-short", "unlabelled-seat"]);

/** Generator-level operators shape the deal; export-level ones corrupt the capture afterwards. */
export function genOptsFor(ops: Op[], rng: Rng): GenOpts {
  const o: GenOpts = {};
  for (const op of ops) {
    if (op === "nl5-rounding") o.bbCents = 5;
    if (op === "nl25-rounding") o.bbCents = 25;
    if (op === "short-seat") o.shortSeat = { pos: rng.pick(["UTG", "HJ", "CO", "BTN", "SB", "BB"]), bb: rng.pick([18, 23, 30, 37, 45, 52, 60, 70]) };
    if (op === "deep-seat") o.deepSeat = { pos: rng.pick(["UTG", "HJ", "CO", "BTN", "SB", "BB"]), bb: rng.pick([130, 150, 175, 200]) };
    if (op === "thin-table") o.seatsN = rng.pick([4, 5, 5, 3]);
    if (op === "dead-sb") o.deadSb = true;
    if (op === "limps") o.limps = rng.pick([1, 1, 2, 3]);
    if (op === "odd-open") o.oddOpen = rng.pick([2.3, 2.8, 3.3, 4]);
    if (op === "odd-3bet") o.odd3bet = rng.pick([2.5, 6]);
    if (op === "jam") { o.jam = true; o.shortSeat ??= { pos: rng.pick(["HJ", "CO", "BTN", "SB", "BB"]), bb: rng.pick([12, 18, 25, 32]) }; }
    if (op === "hero-deviates") o.heroDeviates = true;
    if (op === "post-in") o.postIn = true;
    if (op === "undealt-seat") o.undealtSeat = true;
    if (op === "lost-sb-complete") o.sbCompletes = true;
    if (op === "lost-flop-call") o.flopCaller = true;
  }
  return o;
}
export function mutateExport(exp: any, ops: Op[], rng: Rng): any {
  const e = JSON.parse(JSON.stringify(exp));
  // the line's own defects first, then the labels and cards read off it: `unlabelled-seat` means "a villain who
  // ACTED has no label" — applied before `missed-fold` it could pick the seat whose only action the fold op then
  // removed, leaving a silent unlabelled seat that corrupts nothing (seeds 4329/4696/5265, a harness artefact)
  const ORDER: Op[] = ["late-fold", "missed-fold", "dropped-call", "lost-sb-complete", "lost-flop-call", "unlabelled-seat", "dup-card", "board-short"];
  ops = [...ops].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  for (const op of ops) {
    if (op === "late-fold") {
      const pre = e.actions.filter((a: any) => a.street === "preflop" && !a.hero);
      const idx = e.actions.findIndex((a: any) => a.type === "fold" && !a.hero && a.street === "preflop");
      if (idx >= 0 && idx + 1 < e.actions.length && pre.length && e.actions[idx + 1].street === "preflop") { const [f] = e.actions.splice(idx, 1); e.actions.splice(idx + 1, 0, f); }
    }
    if (op === "missed-fold") {
      // the first villain fold that came BEFORE a later preflop action (a fold with nothing after it on the street is
      // indistinguishable from a seat still to act — that is the table's state, not a capture defect)
      const idx = e.actions.findIndex((a: any, i: number) => a.type === "fold" && !a.hero && a.street === "preflop" && e.actions[i + 1]?.street === "preflop");
      if (idx >= 0) e.actions.splice(idx, 1);
    }
    if (op === "dropped-call") {
      const idx = e.actions.findIndex((a: any) => a.type === "call" && !a.hero && a.street === "preflop");
      if (idx >= 0) e.actions.splice(idx, 1);
    }
    if (op === "lost-sb-complete") {
      // the SB's COMPLETE: his preflop call while the pot was unopened (his round total to 1bb) — the chips stay truthful
      const sb = Number(Object.entries(e.positions).find(([, p]) => p === "SB")?.[0]);
      const idx = e.actions.findIndex((a: any) => a.seatId === sb && !a.hero && a.street === "preflop" && a.type === "call"
        && !e.actions.slice(0, e.actions.indexOf(a)).some((b: any) => b.street === "preflop" && (b.type === "raise" || b.type === "all-in")));
      if (idx >= 0) e.actions.splice(idx, 1);
    }
    if (op === "lost-flop-call") {
      const idx = e.actions.findIndex((a: any) => a.type === "call" && !a.hero && a.street === "flop");
      if (idx >= 0) e.actions.splice(idx, 1);
    }
    if (op === "dup-card" && e.board.length) e.board[0] = e.heroCards[0];
    if (op === "board-short" && e.board.length >= 3) e.board = e.board.slice(0, 2);
    if (op === "unlabelled-seat") {
      const v = e.actions.find((a: any) => !a.hero && a.type !== "post-sb" && a.type !== "post-bb");
      if (v) delete e.positions[v.seatId];
    }
  }
  void rng;
  return e;
}

// ---- one case: every hero decision of one (seed, ops) hand -------------------------------------------------------------
export interface Verdict { seed: number; ops: string[]; street: string; k: number; verdict: "ok" | "cloud-gated" | "expected-refusal" | "finding"; kind?: string; reason?: string; ms: number; note?: string; explained?: boolean; refUnwalkable?: boolean; explainedWhy?: string }
export interface CaseResult { seed: number; ops: string[]; verdicts: Verdict[]; hand?: Hand; exportsFailing?: any[] }

const CLOUD_GATED = /GTOW_BLOCK|no GTO Wizard|blocked|thinned to|the 6-max charts cover 4-6|dealt with no small blind|GTO Wizard AI preflop|last resort/i;

export async function runCase(seed: number, ops: Op[], opts: { slowMs?: number; oracle?: boolean } = {}): Promise<CaseResult> {
  // A CASE IS A FIXTURE ONLY IF IT REPLAYS (2026-09-25, overnight fixer). The study tool's pick rolls its mix with
  // Math.random (utils/pickWeightedAction) and hero plays that pick here, so the same seed dealt a different hand
  // on every run and a finding's seed/ops did not reproduce it. The roll is seeded from the case for its duration.
  const realRandom = Math.random;
  const rollRng = new Rng(seed * 7717 + ops.join("+").length * 131 + 99991);
  Math.random = () => rollRng.next();
  try { return await runCaseInner(seed, ops, opts); } finally { Math.random = realRandom; }
}
async function runCaseInner(seed: number, ops: Op[], opts: { slowMs?: number; oracle?: boolean }): Promise<CaseResult> {
  const rng = new Rng(seed * 1000003 + ops.length * 7919 + ops.reduce((s, o) => s + o.length, 0));
  const key = `mh-${seed}-${ops.join("+") || "base"}`;
  const drift0 = ops.includes("stack-drift") ? 0.3 : 0;
  // HERO PLAYS THE STUDY TOOL'S PICK, executed as the client executes it (a 2.5 pick at a 5c blind lands on 2.6):
  // the harness tests the system as it runs at the table, not a hero who raises 72o into the chart's 0%
  const policy: HeroPolicy = async (partial, street) => {
    const raw = mutateExport(exportAt(partial, partial.actions.length, key, drift0, street), ops, rng);
    let h; try { h = liveHand(raw); } catch { return null; }
    let r: any; try { r = await fastSolve(h, h.positions[h.heroSeatId] ?? null, { strategyId: STRATEGY, origin: "harness" }); } catch { return null; }
    if (!r?.ok || !r.decision) return null;
    const label = String(r.decision.action);
    if (/^fold/i.test(label)) return { type: "fold" };
    if (/^check/i.test(label)) return { type: "check" };
    // "Limp" is the pool-locked limp trees' name for the SB's complete / an open-limp: a call. It used to fall
    // through to the raise branch with no size, and hero MIN-RAISED where the pick said complete (seed 138 [limps]:
    // the flop then refused hero's QTo "not in range after F-C-F-F-R2.5-C-F" — a generator bug, not the pipeline's)
    if (/^(call|limp|complete)/i.test(label)) return { type: "call" };
    if (/all-?in/i.test(label)) return { type: "all-in" };
    const m = /([\d.]+)/.exec(label);
    return { type: "raise", to: m ? parseFloat(m[1]!) : undefined };
  };
  forgetPreflopPin(key); forgetPostflopPin(key);
  const hand = await dealHand(rng, genOptsFor(ops, rng), policy);
  hand.ops = ops;
  const verdicts: Verdict[] = [];
  const failingExports: any[] = [];
  // a post (a blind, or a posted-in live blind) is not a decision
  const heroIdx = hand.actions.map((a, i) => [a, i] as const).filter(([a]) => a.seat === hand.hero && a.type !== "post-sb" && a.type !== "post-bb" && a.type !== "post").map(([, i]) => i);
  const drift = drift0;
  let cloudGatedPreflop = false;
  forgetPreflopPin(key); forgetPostflopPin(key);
  for (const k of heroIdx) {
    const clean = exportAt(hand, k, key, drift);
    const raw = mutateExport(clean, ops, rng);
    // did the corrupting operator actually touch THIS export? (a dropped flop card changes nothing preflop)
    // (compared against the export with only the BENIGN operators applied: a late-filed fold changes the export too,
    // and board-short+late-fold at a preflop decision was counted as a corrupt capture answered — seeds 41, 101)
    const benign = mutateExport(clean, ops.filter((o) => !EXPECT_REFUSAL.has(o)), rng);
    const corrupted = ops.some((o) => EXPECT_REFUSAL.has(o)) && JSON.stringify(raw) !== JSON.stringify(benign);
    const street = raw.street as string;
    let hand2; try { hand2 = liveHand(raw); } catch (e: any) {
      const v: Verdict = { seed, ops, street, k, verdict: EXPECT_REFUSAL.has(ops.find((o) => EXPECT_REFUSAL.has(o)) ?? "") ? "expected-refusal" : "finding", kind: "normalize-threw", reason: String(e?.message ?? e), ms: 0 };
      verdicts.push(v); if (v.verdict === "finding") failingExports.push(raw); continue;
    }
    const heroPos = hand2.positions[hand2.heroSeatId] ?? null;
    const t0 = Date.now();
    let res: any;
    const walks: RecordedRangeWalk[] = [];
    const unrecord = setRangeWalkRecorder((w) => walks.push(w));
    try { res = await fastSolve(hand2, heroPos, { strategyId: STRATEGY, origin: "harness" }); }
    catch (e: any) { res = { ok: false, reason: `THREW: ${e?.stack ?? e}`, threw: true }; }
    finally { unrecord(); }
    const ms = Date.now() - t0;
    const expectRefusal = corrupted;
    let v: Verdict;
    if (res.ok) {
      const zero = res.notInRange === true;
      // A FREE OPTION NEVER FOLDS (post-in, 2026-09-25): hero posted in, nobody raised — the answer must not say Fold
      const freeFold = street === "preflop" && hand.postIn?.seat === hand.hero && !(Number(raw.currentNode?.toCall) > 0.01) && /^fold/i.test(String(res.decision?.action ?? ""));
      // THE RAKE FOLLOWS THE PLAYERS DEALT (Ignition: $1/$2/$3/$4 at 2/3/4-5/6+, profiles.rakeCapCents, in NL200 bb)
      const dealtN = hand.seats.filter((s) => s.id !== hand.undealt).length;
      const wantCap = rakeCapCents(Math.max(2, dealtN)) / 200;
      const rakeOff = res.dryRun?.rake && Math.abs(Number(res.dryRun.rake.cap_in_chips) - wantCap) > 1e-9
        ? `the tree is raked with a ${res.dryRun.rake.cap_in_chips}bb cap, the table dealt ${dealtN} (cap ${wantCap}bb)` : null;
      // A CORRUPT CAPTURE ANSWERED IS THE WORST OUTCOME: a dropped call reads as a fold, and the answer comes from a
      // spot that never happened. The chips are still in the export (committed / stacks), so it is detectable.
      if (expectRefusal) v = { seed, ops, street, k, verdict: "finding", kind: "answered-corrupt-capture", reason: `answered a capture mutated by ${ops.filter((o) => EXPECT_REFUSAL.has(o)).join("+")} (${res.source ?? "?"}: ${String(res.warning ?? "").slice(0, 160)})`, ms };
      else if (zero) v = { seed, ops, street, k, verdict: "finding", kind: "hero-zero-weight", reason: res.warning ?? "hero not in range", ms };
      else if (freeFold) v = { seed, ops, street, k, verdict: "finding", kind: "fold-free-check", reason: `hero posted in and faces nothing, and the answer says ${res.decision?.action} (${String(res.warning ?? "").slice(0, 160)})`, ms };
      else if (rakeOff) v = { seed, ops, street, k, verdict: "finding", kind: "rake-cap", reason: rakeOff, ms };
      // THREE-HANDED IS THE AI PIECE'S (the 6-max strategy's routing: the charts cover 4-6 dealt, fastSolve.is6Handed)
      else if (dealtN <= 3 && (res.source === "hrc-6max-preflop" || /_6max_/.test(String(res.rangeSource ?? ""))))
        v = { seed, ops, street, k, verdict: "finding", kind: "piece-routing", reason: `${dealtN} players were dealt, and the answer came from the 6-max charts (${res.source === "hrc-6max-preflop" ? res.gametype : res.rangeSource})`, ms };
      else if (ms > (opts.slowMs ?? 2500)) v = { seed, ops, street, k, verdict: "finding", kind: "slow-local-answer", reason: `${ms} ms for a local answer`, ms };
      else if (res.dryRun && inputMismatch(hand, res.dryRun)) v = { seed, ops, street, k, verdict: "finding", kind: "solver-input-mismatch", reason: `${inputMismatch(hand, res.dryRun)} (${String(res.warning ?? "").slice(0, 200)})`, ms };
      else {
        // ROUND 2: the range-level oracle (scripts/mutation/rangeOracle.ts) — what the input SAYS, not only that it exists
        const o = await rangeVerdict(hand, k, res, walks, opts.oracle !== false);
        if (o.finding) v = { seed, ops, street, k, verdict: "finding", kind: o.finding.kind, reason: `${o.finding.reason} (${String(res.warning ?? "").slice(0, 200)})`, ms };
        else v = { seed, ops, street, k, verdict: "ok", ms, note: res.warning ?? undefined, ...(o.explained ? { explained: true } : {}), ...(o.unwalkable ? { refUnwalkable: true } : {}), ...(o.why ? { explainedWhy: o.why } : {}) };
      }
    } else if (res.threw) {
      v = { seed, ops, street, k, verdict: "finding", kind: "threw", reason: String(res.reason).slice(0, 600), ms };
    } else if (res.kind === "capture-fault" || res.kind === "no-hero-cards" || res.kind === "board-incomplete") {
      v = { seed, ops, street, k, verdict: expectRefusal ? "expected-refusal" : "finding", kind: res.kind, reason: res.reason, ms };
    } else if (CLOUD_GATED.test(String(res.reason))) {
      v = { seed, ops, street, k, verdict: "cloud-gated", kind: "needs-cloud", reason: String(res.reason).slice(0, 300), ms };
      if (street === "preflop") cloudGatedPreflop = true;
      // …but a table of 4-6 DEALT players with its blinds is the charts', not "thinned" (the golden dead-button hands
      // 4919260843/4919958663: five dealt, the BTN label sitting out, sent to the AI piece by the first dealt-seats cut)
      const dealtHere = hand.seats.filter((s) => s.id !== hand.undealt).length;
      if (street === "preflop" && /table thinned to/.test(String(res.reason)) && dealtHere >= 4 && hand.seats.some((s) => s.pos === "SB") && hand.seats.some((s) => s.pos === "BB")) {
        v = { seed, ops, street, k, verdict: "finding", kind: "piece-routing", reason: `${dealtHere} players were dealt with both blinds, and the answer was sent to the AI piece as a thinned table (${String(res.reason).slice(0, 160)})`, ms };
      }
    } else {
      v = { seed, ops, street, k, verdict: expectRefusal ? "expected-refusal" : "finding", kind: res.kind ?? "refused", reason: String(res.reason).slice(0, 600), ms };
    }
    // a postflop street after a cloud-gated preflop cannot have a pin: its miss is the cloud's, not a finding
    if (v.verdict === "finding" && street !== "preflop" && cloudGatedPreflop && /no charts|AI preflop|cloud|GTO Wizard/i.test(v.reason ?? "")) v.verdict = "cloud-gated";
    // …and after a cloud-gated preflop decision hero played WITHOUT a pick (the policy had none, so the generator
    // chose), which live the AI piece would have answered and pinned. A later decision where hero's class carries no
    // weight is then hero's unpicked action, not a piece's mismatch — the harness cannot say what the AI would have
    // told him (2026-09-25: seeds 178 and 245 [short-seat], a 4-bet with J2s the chart never makes, flagged as a bug).
    if (v.verdict === "finding" && cloudGatedPreflop && (v.kind === "hero-zero-weight" || /PREFLOP PIN .* not in range/.test(v.reason ?? ""))) {
      v.verdict = "cloud-gated"; v.note = `after a cloud-gated preflop decision hero played without a pick: ${v.reason ?? ""}`.slice(0, 300);
    }
    verdicts.push(v);
    if (v.verdict === "finding") failingExports.push(raw);
  }
  return { seed, ops, verdicts, hand, exportsFailing: failingExports };
}

/**
 * THE RANGE-LEVEL VERDICT (2026-09-25, round 2). A chart-read preflop answer: hero's node against the reference walk
 * of the dealt line on the same chart. A postflop dry run: layer 1 (invariants over the walks the pipeline recorded)
 * and layer 2 (every flop seat's range against the reference walk). See scripts/mutation/rangeOracle.ts.
 */
const chartGet = (id: string) => { const g = nodeGetter(id); return async (line: string) => { const n = await g(line); return n === "unreachable" ? null : (n as any); }; };
export async function rangeVerdict(hand: Hand, k: number, res: any, walks: RecordedRangeWalk[], on = true):
  Promise<{ finding: OracleFinding | null; explained: boolean; unwalkable: boolean; why?: string }> {
  const none = { finding: null, explained: false, unwalkable: false };
  if (!on || !res?.ok) return none;
  const posOf = (seat: number) => hand.seats.find((s) => s.id === seat)?.pos ?? "?";
  const heroPos = posOf(hand.hero);
  const dealt = hand.seats.filter((s) => s.id !== hand.undealt).map((s) => s.pos);
  const note = String(res.warning ?? "");
  if (res.street === "preflop") {
    if (res.source !== "hrc-6max-preflop" || !/_6max_/.test(String(res.gametype))) return none;
    const truth = truthLine(hand.actions.slice(0, k), posOf);
    const r = await layer2Preflop({ truth, dealt, heroPos, note, line: String(res.line ?? ""), get: chartGet(res.gametype) });
    return { finding: r.findings[0] ?? null, explained: r.explained, unwalkable: false };
  }
  if (!res.dryRun) return none;
  const truth = truthLine(hand.actions, posOf);
  const src = String(res.rangeSource ?? "");
  const get = /_6max_/.test(src) ? chartGet(src) : null;
  const tokOff = postflopTokenMismatch(hand.actions, k, posOf, res.dryRun);
  if (tokOff) return { finding: { kind: "postflop-line-mismatch", reason: tokOff }, explained: false, unwalkable: false };
  // the villains the note says were re-picked onto another chart (round 2.1): their walks replay on that chart
  const rp = get ? repickOf(note) : null;
  const rpGet = rp ? chartGet(rp.chart) : null;
  const getFor = (seat: string) => (rp && rpGet && seat.toUpperCase() !== heroPos.toUpperCase() && rp.seats.includes(seat.toUpperCase()) ? rpGet : null);
  const l1 = await layer1({ truth, heroPos, heroCards: hand.heroCards, note, dry: res.dryRun, walks, get, getFor });
  if (l1.length) return { finding: l1[0]!, explained: false, unwalkable: false };
  if (!get) return none;
  const l2 = await layer2Postflop({ truth, dealt, heroPos, note, dry: res.dryRun, get, getFor: chartGet });
  return { finding: l2.findings[0] ?? null, explained: l2.explained, unwalkable: l2.unwalkable, why: l2.why };
}

/**
 * THE INPUT MUST BE THE TABLE'S (2026-09-25, overnight fixer). "A solver input exists" is not enough: a 25bb jam
 * read as a 2.5bb open, or a caller handed another seat's token, builds an input for a spot that never happened, and
 * the verdict was "ok". A postflop dry run's input is checked against the generator's own hand — the dealt truth, not
 * the (possibly mutated) export: the flop pot must be every preflop chip (0.25bb of slack: the tree seats the SB at
 * 0.5 where NL5 posts 0.4), and the flop seats must be exactly the players who did not fold preflop.
 */
export function inputMismatch(hand: Hand, dry: { flopPot: number; flopSeats: string[]; flopStack?: number }): string | null {
  const per = new Map<number, number>();
  for (const a of hand.actions) {
    if (a.street !== 0 || a.amount == null) continue;
    per.set(a.seat, a.type === "call" ? (per.get(a.seat) ?? 0) + a.amount : Math.max(per.get(a.seat) ?? 0, a.amount));
  }
  const truePot = Math.round([...per.values()].reduce((s, x) => s + x, 0) * 100) / 100;
  if (Math.abs(dry.flopPot - truePot) > 0.25) return `the solver's flop pot is ${dry.flopPot}bb, the table's ${truePot}bb`;
  const folded = new Set(hand.actions.filter((a) => a.street === 0 && a.type === "fold").map((a) => a.seat));
  // a player all-in preflop never acts again: he is not a flop seat while two others can play (his chips are pot)
  const allIn = new Set(hand.actions.filter((a) => a.street === 0 && a.type === "all-in").map((a) => a.seat));
  const inHand = hand.seats.filter((s) => !folded.has(s.id) && s.id !== hand.undealt);
  const canAct = inHand.filter((s) => !allIn.has(s.id));
  const want = (canAct.length >= 2 ? canAct : inHand).map((s) => s.pos).sort();
  const got = dry.flopSeats.map((p) => p.toUpperCase()).sort();
  if (want.join("/") !== got.join("/")) return `the solver's flop seats are ${got.join("/")}, the table's ${want.join("/")}`;
  // THE STACK BEHIND (round 2): every tree seat plays at the effective stack — hero's dealt stack against the deepest
  // opponent still in (hrc6max.dealtEffective) — less the preflop price. Skipped when anyone is all-in preflop (the
  // side-pot geometry is its own approximation, said in the note) and for re-rooted/collapsed spots.
  if (dry.flopStack != null && !allIn.size && canAct.length === 2) {
    const heroSeat = hand.seats.find((s) => s.id === hand.hero)!;
    const opp = canAct.filter((s) => s.id !== hand.hero).map((s) => s.stack);
    const eff = Math.min(heroSeat.stack, Math.max(...opp));
    const level = Math.max(0, ...[...per.entries()].filter(([id]) => canAct.some((s) => s.id === id)).map(([, v]) => v));
    const wantStack = Math.round((eff - level) * 100) / 100;
    if (Math.abs(dry.flopStack - wantStack) > 0.6) return `the solver's stack behind is ${dry.flopStack}bb, the table's effective ${wantStack}bb (${eff}bb dealt less the ${level}bb preflop price)`;
  }
  return null;
}

// ---- the sweep: baseline, every single operator, sampled pairs; minimal sets for findings ---------------------------
export interface Finding { seed: number; ops: string[]; minimal: boolean; street: string; kind: string; reason: string; ms: number; fixture: any }

export async function sweep(o: { seeds: number; seed0: number; ops: Op[]; pairs: number; triples?: number; onProgress?: (s: string) => void }): Promise<{ findings: Finding[]; matrix: Record<string, Record<string, number>>; cases: number; decisions: number; oracle: { explained: number; refUnwalkable: number; cases: { seed: number; ops: string[]; street: string; why: string }[] } }> {
  const restore = harnessEnv();
  try { return await sweepInner(o); } finally { restore(); }
}
async function sweepInner(o: { seeds: number; seed0: number; ops: Op[]; pairs: number; triples?: number; onProgress?: (s: string) => void }): Promise<{ findings: Finding[]; matrix: Record<string, Record<string, number>>; cases: number; decisions: number; oracle: { explained: number; refUnwalkable: number; cases: { seed: number; ops: string[]; street: string; why: string }[] } }> {
  const findings: Finding[] = [];
  const matrix: Record<string, Record<string, number>> = {};
  const bump = (op: string, verdict: string) => { (matrix[op] ??= {})[verdict] = (matrix[op]![verdict] ?? 0) + 1; };
  let cases = 0, decisions = 0;
  const oracle = { explained: 0, refUnwalkable: 0, cases: [] as { seed: number; ops: string[]; street: string; why: string }[] };
  const record = (r: CaseResult, minimal: boolean) => {
    cases++;
    const label = r.ops.join("+") || "baseline";
    for (const v of r.verdicts) { decisions++; bump(label, v.verdict); if (v.explained) oracle.explained++; if (v.refUnwalkable) oracle.refUnwalkable++; if (v.explainedWhy) oracle.cases.push({ seed: r.seed, ops: r.ops, street: v.street, why: v.explainedWhy }); }
    const bad = r.verdicts.filter((v) => v.verdict === "finding");
    for (let i = 0; i < bad.length; i++) {
      const v = bad[i]!;
      findings.push({ seed: r.seed, ops: r.ops, minimal, street: v.street, kind: v.kind ?? "?", reason: v.reason ?? "", ms: v.ms, fixture: r.exportsFailing?.[i] ?? null });
    }
    return bad.length > 0;
  };
  const rng = new Rng(o.seed0 * 31 + 17);
  for (let s = o.seed0; s < o.seed0 + o.seeds; s++) {
    const base = await runCase(s, []);
    const baseBad = record(base, true);
    for (const op of o.ops) {
      const r = await runCase(s, [op]);
      record(r, !baseBad);
    }
    o.onProgress?.(`seed ${s} done (${findings.length} findings so far)`);
  }
  // pairs, sampled: a pair is only reported when neither single passes... (minimal = both singles clean)
  const singleBad = new Set(findings.map((f) => `${f.seed}|${f.ops.join("+")}`));
  for (let p = 0; p < o.pairs; p++) {
    const s = o.seed0 + rng.int(o.seeds);
    const a = rng.pick(o.ops), b = rng.pick(o.ops.filter((x) => x !== a));
    if (!b) continue;
    const r = await runCase(s, [a, b]);
    const minimal = !singleBad.has(`${s}|${a}`) && !singleBad.has(`${s}|${b}`) && !singleBad.has(`${s}|`);
    record(r, minimal);
  }
  // triples, sampled (round 2): three operators at once — the capture defects and table states that only meet in a
  // real session (a post-in whose fold the tap lost at a 5c table). Reported minimal only when no single of it failed
  for (let t = 0; t < (o.triples ?? 0); t++) {
    const s = o.seed0 + rng.int(o.seeds);
    const pool = [...o.ops];
    const pick3: Op[] = [];
    while (pick3.length < 3 && pool.length) pick3.push(pool.splice(rng.int(pool.length), 1)[0]!);
    if (pick3.length < 3) continue;
    const r = await runCase(s, pick3);
    record(r, !pick3.some((x) => singleBad.has(`${s}|${x}`)) && !singleBad.has(`${s}|`));
  }
  return { findings, matrix, cases, decisions, oracle };
}

export function summarize(res: Awaited<ReturnType<typeof sweep>>): string {
  const rows = Object.entries(res.matrix).sort();
  const cols = ["ok", "cloud-gated", "expected-refusal", "finding"];
  const lines = [`# Input-mutation harness — ${res.cases} cases, ${res.decisions} hero decisions, ${res.findings.length} findings`, "",
    `range oracle: ${res.oracle.explained} answer(s) whose ranges differ from the reference walk as a named approximation explains; ${res.oracle.refUnwalkable} the reference could not walk (approximation named)`, "",
    `| operator | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---:").join("|")}|`];
  for (const [op, m] of rows) lines.push(`| ${op} | ${cols.map((c) => m[c] ?? 0).join(" | ")} |`);
  lines.push("", "## Findings by class", "");
  const byKind: Record<string, Finding[]> = {};
  for (const f of res.findings) (byKind[`${f.street} · ${f.kind}`] ??= []).push(f);
  for (const [k, fs] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
    const reasons: Record<string, number> = {};
    for (const f of fs) { const r = f.reason.replace(/\d+(\.\d+)?/g, "#").slice(0, 110); reasons[r] = (reasons[r] ?? 0) + 1; }
    lines.push(`### ${k} — ${fs.length} (${fs.filter((f) => f.minimal).length} with a minimal operator set)`);
    for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)) lines.push(`- ${n}× ${r}`);
    lines.push(`  e.g. seed ${fs[0]!.seed} ops [${fs[0]!.ops.join(", ")}]`);
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1]!;
  const seeds = Number(arg("seeds", "400")); const seed0 = Number(arg("seed0", "1")); const pairs = Number(arg("pairs", "200")); const triples = Number(arg("triples", "0"));
  const opsArg = arg("ops", "all"); const ops = (opsArg === "all" ? [...OPERATORS] : opsArg.split(",")) as Op[];
  const out = arg("out", join(import.meta.dir, "mutation", "out"));
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const res = await sweep({ seeds, seed0, ops, pairs, triples, onProgress: (s) => { if (/0 done/.test(s)) console.error(s); } });
  writeFileSync(join(out, "findings.jsonl"), res.findings.map((f) => JSON.stringify(f)).join("\n") + "\n");
  // the differences the range oracle let through because the answer named an approximation — the audit trail
  writeFileSync(join(out, "explained.jsonl"), res.oracle.cases.map((f) => JSON.stringify(f)).join("\n") + "\n");
  const md = summarize(res) + `\n\n${Date.now() - t0} ms · seeds ${seed0}..${seed0 + seeds - 1} · ops ${ops.join(",")} · pairs ${pairs} · triples ${triples}\n`;
  writeFileSync(join(out, "summary.md"), md);
  // one fixture per distinct class, for the fixer
  const seen = new Set<string>();
  for (const f of res.findings) {
    const cls = `${f.street}-${f.kind}-${f.reason.replace(/[^a-z]/gi, "").slice(0, 40)}`;
    if (seen.has(cls) || !f.fixture) continue; seen.add(cls);
    writeFileSync(join(out, `fixture-${seen.size}-${f.street}-${f.kind}.json`), JSON.stringify({ seed: f.seed, ops: f.ops, reason: f.reason, hand: f.fixture }, null, 1));
  }
  console.log(md);
}
