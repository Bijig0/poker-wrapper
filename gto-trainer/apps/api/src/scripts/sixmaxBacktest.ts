/**
 * Does the 6-max set actually answer the hands we play?
 *
 * Takes real Ignition RING hands (NL100 / NL200 / NL500) and, for EVERY seat that was dealt in, replays the preflop
 * action and stops wherever that seat actually had to act. Each stop is a question the study would have to answer
 * live, so it is asked the way the live path asks it: services/hrc6max.ts picks the chart, services/hrc3max.ts
 * walks the line into it - including the size snapping the live path does when the pool uses an off-tree raise -
 * and the chart's own solution file supplies the node.
 *
 * Outcomes, and the difference between them is the point:
 *
 *   answered      the chart this state wants holds the line and hero's hand
 *   fallback      that chart cannot answer, but one further down the picker's preference list can
 *   not-in-range  the line is in the tree, but equilibrium never reaches this node with hero's hand
 *   pending       nothing answers it today; the chart it wants is in the run and will
 *   uncovered     nothing in the set will ever answer it, however long the run goes
 *
 * Postflop is out of scope by design - the set is preflop only - so the walk stops at the flop.
 *
 *   bun run src/scripts/sixmaxBacktest.ts --hands 400 --out backtest.json
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { chartFor6max, openFromTokens, type Seat6 } from "../services/hrc6max";
import { walk3max, type GetNode, type HrcNode } from "../services/hrc3max";

export const HH_DIR = "C:\\Users\\Brady\\Ignition Casino Poker\\Hand History";
const SOLUTIONS = "C:\\Users\\Brady\\poker\\analysis\\pipeline\\solve\\exploit_ui\\solutions";
const PLAN_DIR = "C:\\Users\\Brady\\poker-zenbook\\hrc-api\\solves\\sixmax_grid";
const ORDER_6 = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;

const arg = (k: string, d?: string) => { const i = Bun.argv.indexOf(k); return i >= 0 ? Bun.argv[i + 1] : d; };

// ---------------------------------------------------------------- hand histories

export interface RawAction { label: string; kind: "fold" | "check" | "call" | "raise" | "allin"; toBB: number | null }
export interface RawSeat { seatNo: number; label: string; hero: boolean; stackBB: number; cards: string[] }
export interface RawHand {
  id: string; stake: string; file: string; seats: RawSeat[]; actions: RawAction[]; posted: boolean;
  /** a flop was dealt (the preflop action closed with two or more players) */
  sawFlop: boolean;
}

function bbOf(name: string): { bb: number; label: string } | null {
  const m = name.match(/ - \$([\d.]+)-\$([\d.]+) - /);
  return m ? { bb: Number(m[2]), label: `$${m[1]}-$${m[2]}` } : null;
}

export function parseFile(path: string, file: string): RawHand[] {
  const stake = bbOf(file);
  if (!stake) return [];
  const out: RawHand[] = [];
  for (const chunk of readFileSync(path, "utf-8").split(/(?=^Ignition Hand #)/m)) {
    if (!chunk.startsWith("Ignition Hand #")) continue;
    const id = chunk.match(/^Ignition Hand #(\d+)/)?.[1];
    if (!id) continue;
    const pre = chunk.split(/^\*\*\* (?:FLOP|SUMMARY) \*\*\*/m)[0] ?? chunk;
    const seats: RawSeat[] = [];
    const actions: RawAction[] = [];
    for (const line of pre.split(/\r?\n/)) {
      const s = line.match(/^Seat (\d+): (.+?)\s*(\[ME\])?\s*\(\$([\d.,]+) in chips\)/);
      if (s) {
        seats.push({ seatNo: Number(s[1]), label: s[2]!.trim(), hero: !!s[3],
          stackBB: Number(s[4]!.replace(/,/g, "")) / stake.bb, cards: [] });
        continue;
      }
      const c = line.match(/^(.+?)\s*(?:\[ME\])?\s*: Card dealt to a spot \[(\w\w) (\w\w)\]/);
      if (c) { const seat = seats.find((x) => x.label === c[1]!.trim()); if (seat) seat.cards = [c[2]!, c[3]!]; continue; }
      const a = line.match(/^(.+?)\s*(?:\[ME\])?\s*: (Folds|Checks|Calls|Raises|All-in\(raise\)|All-in)\b(.*)$/);
      if (a) {
        const label = a[1]!.trim();
        if (!seats.some((x) => x.label === label)) continue;
        const rest = a[3] ?? "";
        const to = rest.match(/to \$([\d.,]+)/) ?? rest.match(/\$([\d.,]+)/);
        const kind = a[2] === "Folds" ? "fold" : a[2] === "Checks" ? "check" : a[2] === "Calls" ? "call"
          : a[2] === "Raises" ? "raise" : "allin";
        actions.push({ label, kind, toBB: to ? Number(to[1]!.replace(/,/g, "")) / stake.bb : null });
      }
    }
    // POSTING IN IS NOT A TREE STATE (2026-09-16). A player joining mid-orbit posts a blind-sized "chip" out of
    // position and may then CHECK when the action reaches them. The pot has two big-blind posts and a seat that is
    // neither blind acts last - our trees hold exactly one big blind, so the hand cannot be expressed at all.
    // These surfaced as a preflop check where no seat can check, which reads like a parse failure and is not one.
    const posted = /: Posts (?:dead )?chip /.test(pre);
    if (seats.length >= 2) out.push({ id, stake: stake.label, file, seats, actions, posted, sawFlop: /^\*\*\* FLOP \*\*\*/m.test(chunk) });
  }
  return out;
}

/**
 * Ignition names seats absolutely (UTG, UTG+1, …, Dealer, Small Blind, Big Blind). Our trees are always the
 * six-seat game, so a short table is seated from the BUTTON BACKWARDS - the seat before the button is the cutoff,
 * then the hijack, then UTG. Same convention as the live path, where five-handed is the six-dealt tree with UTG
 * folded rather than a different game.
 */
export function seatMap(labels: string[]): { map: Record<string, Seat6>; outside: string[]; why?: string }
  | { map: null; outside: string[]; why: string } {
  if (!labels.includes("Dealer")) return { map: null, outside: [], why: "no button seat in the hand" };
  if (!labels.includes("Small Blind") || !labels.includes("Big Blind")) {
    return { map: null, outside: [], why: "a blind is missing" };
  }
  const early = labels.filter((l) => /^UTG/.test(l))
    .sort((a, b) => Number(a.slice(4) || 0) - Number(b.slice(4) || 0));
  // The six seats NEAREST THE BUTTON are the tree; anything earlier than that is outside it. A four-handed table
  // therefore plays the cutoff forward, a nine-handed one plays its last six, and the difference is the rake cap.
  const inside = early.slice(Math.max(0, early.length - 3));
  const outside = early.slice(0, Math.max(0, early.length - 3));
  const slots = (["UTG", "HJ", "CO"] as Seat6[]).slice(3 - inside.length);
  const map: Record<string, Seat6> = { Dealer: "BTN", "Small Blind": "SB", "Big Blind": "BB" };
  inside.forEach((l, i) => { map[l] = slots[i]!; });
  return { map, outside };
}

const RANK = "23456789TJQKA";
export function handClass(cards: string[]): string | null {
  if (cards.length !== 2) return null;
  const r1 = cards[0]![0]!.toUpperCase(), r2 = cards[1]![0]!.toUpperCase();
  if (RANK.indexOf(r1) < 0 || RANK.indexOf(r2) < 0) return null;
  if (r1 === r2) return r1 + r2;
  const [hi, lo] = RANK.indexOf(r1) > RANK.indexOf(r2) ? [r1, r2] : [r2, r1];
  return hi + lo + (cards[0]![1]!.toLowerCase() === cards[1]![1]!.toLowerCase() ? "s" : "o");
}

export const tokenOf = (a: RawAction): string => {
  if (a.kind === "fold") return "F";
  if (a.kind === "check") return "X";
  if (a.kind === "call") return "C";
  if (a.kind === "allin") return "RAI";
  return a.toBB == null ? "R" : `R${Math.round(a.toBB * 100) / 100}`;
};

// ------------------------------------------------------------------ the decisions

interface Decision {
  handId: string; stake: string; seatsDealt: number; heroSeat: Seat6; heroClass: string | null;
  depthBB: number; tokens: string[]; line: string; wanted: string; candidates: string[];
  note: string | null; openSize: string; shortSeat: string;
  /** stacks as dealt (bb) by seat, for every seat still in the hand when hero acts */
  live: Partial<Record<Seat6, number>>;
  /** the seat whose raise hero is facing, or null when hero is first in / facing limps */
  aggressor: Seat6 | null;
  heroStack: number;
}

/** A hand as the live path sees it: the six-seat token line, who owns each token, and the seats dealt in. */
export interface HandLine {
  map: Record<string, Seat6>; dealt: RawSeat[];
  tokens: string[]; owner: (Seat6 | null)[]; real: boolean[];
  stacks: Record<number, number>; positions: Record<number, string>;
}

export function lineOf(h: RawHand): { line: HandLine; skipped: null } | { line: null; skipped: string } {
  if (h.posted) return { line: null, skipped: "a player posted in mid-orbit - two big blinds, no tree for it" };
  const sm = seatMap(h.seats.map((s) => s.label));
  if (!sm.map) return { line: null, skipped: sm.why };
  const map = sm.map;
  const dealt = h.seats.filter((s) => map[s.label]);
  if (dealt.length < 2) return { line: null, skipped: "fewer than two seats dealt" };
  // a seat we are not modelling that only folded costs nothing; one that put money in cannot be expressed
  const played = sm.outside.filter((l) => h.actions.some((a) => a.label === l && a.kind !== "fold"));
  if (played.length) {
    return { line: null, skipped: `${h.seats.length}-handed and a seat outside the six played` };
  }

  // the token walk the live path builds: one token per seat for the opening orbit (F where a seat never acted),
  // then later orbits in action order. `real` marks the tokens that came from an action somebody actually took -
  // a padded fold is not a decision anybody made, and must not be counted as one.
  // Only the six seats we model are in the tree. A seat outside them folded (anything else skipped the hand
  // above), and carrying that fold into the walk pushes the opening orbit past six tokens - which reads to the
  // walker as a line continuing past a terminal, the exact symptom the first table-shape run produced.
  const queue = h.actions.filter((a) => map[a.label]);
  const tokens: string[] = [], owner: (Seat6 | null)[] = [], real: boolean[] = [];
  for (const pos of ORDER_6) {
    const next = queue[0];
    if (next && map[next.label] === pos) { tokens.push(tokenOf(next)); owner.push(pos); real.push(true); queue.shift(); }
    else { tokens.push("F"); owner.push(dealt.some((d) => map[d.label] === pos) ? pos : null); real.push(false); }
  }
  for (const a of queue) { tokens.push(tokenOf(a)); owner.push(map[a.label] ?? null); real.push(true); }

  const stacks: Record<number, number> = {}, positions: Record<number, string> = {};
  for (const s of dealt) { stacks[s.seatNo] = s.stackBB; positions[s.seatNo] = map[s.label]!; }
  return { line: { map, dealt, tokens, owner, real, stacks, positions }, skipped: null };
}

function decisionsFor(h: RawHand): { decisions: Decision[]; skipped: string | null } {
  const got = lineOf(h);
  if (!got.line) return { decisions: [], skipped: got.skipped };
  const { map, dealt, tokens, owner, real, stacks, positions } = got.line;

  const stackOf: Partial<Record<Seat6, number>> = {};
  for (const d of dealt) stackOf[map[d.label]!] = d.stackBB;

  const decisions: Decision[] = [];
  for (const seat of dealt) {
    const mine = map[seat.label]!;
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] !== mine || !real[i]) continue;
      const before = tokens.slice(0, i);
      const choice = chartFor6max({ stacks, committed: {}, positions, heroSeatId: seat.seatNo } as any, mine, before);
      // who is still in when hero acts: everyone dealt, minus seats whose last token before this point is a fold
      const folded = new Set<Seat6>();
      let aggressor: Seat6 | null = null;
      for (let k = 0; k < i; k++) {
        const o = owner[k]; if (!o) continue;
        if (tokens[k] === "F") folded.add(o);
        else if (/^R/.test(tokens[k]!)) aggressor = o;
      }
      const live: Partial<Record<Seat6, number>> = {};
      for (const [pos, bb] of Object.entries(stackOf) as [Seat6, number][]) if (!folded.has(pos)) live[pos] = bb;
      decisions.push({
        handId: h.id, stake: h.stake, seatsDealt: dealt.length, heroSeat: mine,
        heroClass: handClass(seat.cards), depthBB: Math.round(seat.stackBB), tokens: before,
        line: before.join("-"), wanted: choice.id, candidates: choice.candidates, note: choice.note,
        openSize: String(choice.openSize), shortSeat: String(choice.shortSeat),
        live, aggressor, heroStack: seat.stackBB,
      });
    }
  }
  return { decisions, skipped: null };
}

// ---------------------------------------------------------------- answering them

type Verdict = { kind: "answered" | "not-in-range" | "no-line" | "terminal"; detail: string; snapped: number; snapMax: number };

/** |ln(a/b)| between two raise tokens; 0 when either is not a sized raise (an all-in snap is a different question) */
const tokDist = (a: string, b: string): number => {
  const x = Number((a.match(/^R([\d.]+)$/) ?? [])[1]), y = Number((b.match(/^R([\d.]+)$/) ?? [])[1]);
  return Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0 ? Math.abs(Math.log(x / y)) : 0;
};

/** what the chart assumes each seat has, from its id: an even rung, or one short seat at a 100bb table */
function chartStacks(id: string): Partial<Record<Seat6, number>> {
  const un = id.match(/_D(\d+)_s(\d+)_([A-Z]+)_o/);
  const seats: Seat6[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
  const out: Partial<Record<Seat6, number>> = {};
  if (un) { for (const p of seats) out[p] = Number(un[1]); out[un[3] as Seat6] = Number(un[2]); return out; }
  const ev = id.match(/_D(\d+)_o/);
  for (const p of seats) out[p] = ev ? Number(ev[1]) : 100;
  return out;
}

function loadNodes(id: string): Map<string, HrcNode> | null {
  const p = join(SOLUTIONS, `${id}.json.gz`);
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(gunzipSync(readFileSync(p)).toString("utf-8"));
    const m = new Map<string, HrcNode>();
    for (const [line, n] of Object.entries<any>(doc.nodes ?? {})) {
      m.set(line, { pos: n.pos ?? null, terminal: !!n.terminal,
        actions: (n.actions ?? []).map((a: any) => ({ action: a.action, token: a.token ?? null })),
        cells: (n.cells ?? []).map((c: any) => ({ hand: c.hand, actions: c.actions ?? {} })) });
    }
    return m;
  } catch (e) {
    console.error(`  ! ${id} unreadable: ${String(e).slice(0, 70)}`);
    return null;
  }
}

function plannedIds(): Set<string> {
  const ids = new Set<string>();
  for (const cfg of ["grid-6max-nl200", "grid-6max-nl200-asym"]) {
    const p = join(PLAN_DIR, cfg, "plan_6max.json");
    if (!existsSync(p)) continue;
    for (const j of JSON.parse(readFileSync(p, "utf-8"))) ids.add(j.id);
  }
  return ids;
}

async function main() {
  const ALL = Bun.argv.includes("--all");                 // every ring hand in the corpus, every ring stake
  const want = ALL ? Number.MAX_SAFE_INTEGER : Number(arg("--hands", "400"));
  const outPath = arg("--out", "sixmax_backtest.json")!;
  const planned = plannedIds();

  const files: string[] = [];
  for (const acct of readdirSync(HH_DIR)) {
    let names: string[] = [];
    try { names = readdirSync(join(HH_DIR, acct)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".txt") || !n.includes("RING")) continue;
      if (!ALL && !/\$1-\$2|\$0\.50-\$1|\$2\.50-\$5/.test(n)) continue;
      files.push(join(HH_DIR, acct, n));
    }
  }
  files.sort();
  if (ALL) console.log("reading EVERY ring hand in the corpus");
  // EVERY STAKE GETS IN (2026-09-16). A plain stride across the file list sampled NL100 and NL200 only and stepped
  // straight over the five NL500 files, so the first run said nothing about the stake with the deepest stacks.
  // Sample each stake's files on their own stride, so a rare stake is represented rather than rounded away.
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const k = (f.match(/\$[\d.]+-\$[\d.]+/) ?? ["?"])[0];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  const picked: string[] = [];
  for (const [, fs] of groups) {
    const step = ALL ? 1 : Math.max(1, Math.floor(fs.length / 40));
    picked.push(...fs.filter((_, i) => i % step === 0));
  }
  console.log(`the finished set will hold ${planned.size} charts`);
  console.log(`${files.length} ring files at NL100/NL200/NL500; sampling ${picked.length} of them`);

  const hands: RawHand[] = [];
  const perStake = new Map<string, number>();
  const quota = Math.ceil(want / Math.max(1, groups.size));
  for (const f of picked) {
    const k = (f.match(/\$[\d.]+-\$[\d.]+/) ?? ["?"])[0];
    if (!ALL && (perStake.get(k) ?? 0) >= quota) continue;
    for (const h of parseFile(f, f.split("\\").pop()!)) {
      if (!ALL && (perStake.get(k) ?? 0) >= quota) break;
      hands.push(h);
      perStake.set(k, (perStake.get(k) ?? 0) + 1);
    }
  }
  console.log(`hands by stake: ${[...perStake.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}`);

  const decisions: Decision[] = [];
  const skips = new Map<string, number>();
  let usable = 0;
  for (const h of hands) {
    const { decisions: d, skipped } = decisionsFor(h);
    if (skipped) skips.set(skipped, (skips.get(skipped) ?? 0) + 1);
    else usable++;
    decisions.push(...d);
  }
  console.log(`${hands.length} hands, ${usable} of them inside the set's table shapes`);
  console.log(`-> ${decisions.length} preflop decisions, every seat's point of view`);

  // One pass per chart: while it is in memory, walk every decision that lists it, so a 35 MB solution is
  // decompressed once rather than once per preference round.
  const needed = new Map<string, number[]>();
  decisions.forEach((d, i) => {
    for (const c of d.candidates) {
      if (!needed.has(c)) needed.set(c, []);
      needed.get(c)!.push(i);
    }
  });
  const verdicts: Map<string, Verdict>[] = decisions.map(() => new Map());
  const order = [...needed.entries()].sort((a, b) => b[1].length - a[1].length);
  let done = 0;
  for (const [chartId, idxs] of order) {
    done++;
    const nodes = loadNodes(chartId);
    if (done % 10 === 0 || done === order.length) console.log(`  chart ${done}/${order.length} (${chartId}${nodes ? "" : " - not solved yet"})`);
    if (!nodes) continue;
    const get: GetNode = async (line) => nodes.get(line) ?? null;
    for (const i of idxs) {
      const d = decisions[i]!;
      // borrowCaller: walk the way the LIVE 6-max path does (fastSolve.solvePreflop6max, 2026-09-22), so a
      // third caller or limper is read one caller fewer rather than counted as a miss the live path never has.
      const w = await walk3max(d.tokens, get, { borrowCaller: true });
      if (!w.ok) {
        // keep WHERE the walk died — the collision-hole audit (chartHoles.ts) joins misses to holes by line
        verdicts[i]!.set(chartId, { kind: w.reason?.includes("terminal") ? "terminal" : "no-line",
          detail: `${w.reason ?? "no line"}${w.missingAt != null ? ` @ ${w.missingAt || "(root)"}` : ""}`, snapped: 0, snapMax: 0 });
        continue;
      }
      const snapped = w.repaired?.length ?? 0;
      const snapMax = (w.repaired ?? []).reduce((m, r) => Math.max(m, tokDist(r.from, r.to)), 0);
      const cell = d.heroClass ? w.node.cells.find((c) => c.hand === d.heroClass) : undefined;
      verdicts[i]!.set(chartId, cell || !d.heroClass
        ? { kind: "answered", detail: Object.keys(cell?.actions ?? {}).join("/"), snapped, snapMax }
        : { kind: "not-in-range", detail: `${d.heroClass} has no weight at this node`, snapped, snapMax });
    }
  }

  const results = decisions.map((d, i) => {
    const v = verdicts[i]!;
    let status = "", answeredBy: string | null = null, why = "", snapped = 0, snapMax = 0;
    for (const cand of d.candidates) {
      const r = v.get(cand);
      if (!r) continue;                                  // chart not on disk
      if (r.kind === "answered") {
        answeredBy = cand; snapped = r.snapped; snapMax = r.snapMax;
        status = cand === d.wanted ? "answered" : "fallback";
        break;
      }
      if (r.kind === "not-in-range" && !why) why = `${cand}: ${r.detail}`;
      if (!why) why = `${cand}: ${r.detail}`;
    }
    if (!answeredBy) {
      // A chart that HELD the line but not hero's hand has answered the real question - equilibrium never arrives
      // here with this hand, which is what the live path reports as notInRange. That is a different thing from
      // having no chart at all, and counting it as a coverage hole overstates the gap.
      const reached = d.candidates.some((c) => v.get(c)?.kind === "not-in-range");
      if (reached) status = "not-in-range";
      else if (planned.has(d.wanted) && !v.has(d.wanted)) { status = "pending"; why = `${d.wanted} is in the run, not solved yet`; }
      else status = "uncovered";
    }
    // ---- how far is the chart's game from this hand's game ----
    let dist: any = null;
    if (answeredBy) {
      const cs = chartStacks(answeredBy);
      const heroGap = Math.abs(d.heroStack - (cs[d.heroSeat] ?? 100));
      const opp = (Object.entries(d.live) as [Seat6, number][]).filter(([p]) => p !== d.heroSeat);
      const deepestOpp = opp.length ? Math.max(...opp.map(([, bb]) => bb)) : d.heroStack;
      const deepestOppChart = opp.length ? Math.max(...opp.map(([p]) => cs[p] ?? 100)) : (cs[d.heroSeat] ?? 100);
      const effReal = d.aggressor ? Math.min(d.heroStack, d.live[d.aggressor] ?? d.heroStack) : Math.min(d.heroStack, deepestOpp);
      const effChart = d.aggressor ? Math.min(cs[d.heroSeat] ?? 100, cs[d.aggressor] ?? 100) : Math.min(cs[d.heroSeat] ?? 100, deepestOppChart);
      const effGap = Math.abs(effReal - effChart);
      const gaps = (Object.entries(d.live) as [Seat6, number][]).map(([p, bb]) => Math.abs(bb - (cs[p] ?? 100)));
      const tableGapMax = gaps.length ? Math.max(...gaps) : 0;
      const tableGapMean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
      // seats the chart models as deep that are in fact short (beyond the picker's own 15bb tolerance)
      const unmodelledShorts = (Object.entries(d.live) as [Seat6, number][])
        .filter(([p, bb]) => bb < (cs[p] ?? 100) - 15).length;
      const o = openFromTokens(d.tokens);
      const openGap = o.observed != null && typeof o.open === "number" ? Math.abs(Math.log(o.observed / o.open)) : 0;
      const stakeMismatch = d.stake !== "$1-$2";
      const clean = heroGap <= 15 && effGap <= 15 && unmodelledShorts === 0 && snapMax <= 0.15 && openGap <= 0.1;
      const kind = /_s\d+_/.test(answeredBy) ? "uneven" : (effReal > 165 ? "deep-on-150" : "even");
      dist = { kind, effReal: +effReal.toFixed(0), effChart, heroGap: +heroGap.toFixed(1), effGap: +effGap.toFixed(1), tableGapMax: +tableGapMax.toFixed(1),
        tableGapMean: +tableGapMean.toFixed(1), unmodelledShorts, openGap: +openGap.toFixed(3),
        snapMax: +snapMax.toFixed(3), stakeMismatch, clean };
    }
    return { ...d, status, answeredBy, snapped, snapMax, why, dist };
  });

  // ---- distance summary over everything that got an answer ----
  const A = results.filter((r) => r.dist);
  const pct = (xs: number[], q: number) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))]! : 0; };
  const share = (f: (r: any) => boolean) => `${((A.filter(f).length / Math.max(1, A.length)) * 100).toFixed(1)}%`;
  const dsum = (key: string) => { const xs = A.map((r) => r.dist[key] as number); return { p50: pct(xs, 0.5), p90: pct(xs, 0.9), p99: pct(xs, 0.99), max: Math.max(...xs) }; };
  const distance = {
    answered: A.length,
    heroGapBB: dsum("heroGap"), effectiveGapBB: dsum("effGap"), tableGapMaxBB: dsum("tableGapMax"),
    openGapLog: dsum("openGap"), snapMaxLog: dsum("snapMax"),
    shares: {
      heroGapOver25: share((r) => r.dist.heroGap > 25), heroGapOver50: share((r) => r.dist.heroGap > 50),
      effGapOver25: share((r) => r.dist.effGap > 25), effGapOver50: share((r) => r.dist.effGap > 50),
      oneUnmodelledShort: share((r) => r.dist.unmodelledShorts === 1), twoPlusUnmodelledShorts: share((r) => r.dist.unmodelledShorts >= 2),
      snapOver0_2: share((r) => r.dist.snapMax > 0.2), openGapOver0_15: share((r) => r.dist.openGap > 0.15),
      stakeMismatch: share((r) => r.dist.stakeMismatch), clean: share((r) => r.dist.clean),
    },
    // the worst mismatches, by effective-stack gap, then by unmodelled shorts
    worst: [...A].sort((a, b) => (b.dist.effGap - a.dist.effGap) || (b.dist.unmodelledShorts - a.dist.unmodelledShorts)).slice(0, 40)
      .map((r) => ({ hand: r.handId, seat: r.heroSeat, hero: r.heroStack, aggressor: r.aggressor, live: r.live, chart: r.answeredBy, line: r.line, dist: r.dist })),
  };
  const byKind: Record<string, any> = {};
  for (const kind of ["even", "uneven", "deep-on-150"]) {
    const K = A.filter((r) => r.dist.kind === kind);
    const sh = (f: (r: any) => boolean) => +((K.filter(f).length / Math.max(1, K.length)) * 100).toFixed(1);
    const xs = K.map((r) => r.dist.effGap as number);
    byKind[kind] = { decisions: K.length, effGapP50: pct(xs, 0.5), effGapP90: pct(xs, 0.9),
      effGapOver25: sh((r) => r.dist.effGap > 25), twoPlusShorts: sh((r) => r.dist.unmodelledShorts >= 2), clean: sh((r) => r.dist.clean) };
  }
  (distance as any).byKind = byKind;
  (distance as any).sample = A.filter((_, i) => i % 30 === 0).slice(0, 2500)
    .map((r) => ({ hand: r.handId, stake: r.stake, seat: r.heroSeat, hero: r.heroStack, aggressor: r.aggressor, live: r.live, chart: r.answeredBy, line: r.line, dist: r.dist }));
  console.log("\n=== distance from the chart's game (answered decisions only)");
  for (const [k, v] of Object.entries(byKind)) console.log(`  ${k.padEnd(12)} n=${v.decisions}  effGap p50 ${v.effGapP50}bb p90 ${v.effGapP90}bb  >25bb ${v.effGapOver25}%  2+ shorts ${v.twoPlusShorts}%  clean ${v.clean}%`);
  console.log(`  hero stack vs rung   p50 ${distance.heroGapBB.p50}bb  p90 ${distance.heroGapBB.p90}bb  p99 ${distance.heroGapBB.p99}bb  max ${distance.heroGapBB.max}bb`);
  console.log(`  effective stack gap  p50 ${distance.effectiveGapBB.p50}bb  p90 ${distance.effectiveGapBB.p90}bb  p99 ${distance.effectiveGapBB.p99}bb`);
  console.log(`  worst seat at table  p50 ${distance.tableGapMaxBB.p50}bb  p90 ${distance.tableGapMaxBB.p90}bb  p99 ${distance.tableGapMaxBB.p99}bb`);
  for (const [k, v] of Object.entries(distance.shares)) console.log(`  ${k.padEnd(24)} ${v}`);

  const tally = (key: (r: any) => string) => {
    const m = new Map<string, number>();
    for (const r of results) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  };

  const byStatus = tally((r) => r.status);
  console.log("\n=== by outcome");
  for (const [k, v] of Object.entries(byStatus)) {
    console.log(`  ${k.padEnd(13)} ${String(v).padStart(5)}  ${((v / results.length) * 100).toFixed(1)}%`);
  }
  const wouldAnswer = results.filter((r) => ["answered", "fallback", "pending", "not-in-range"].includes(r.status)).length;
  console.log(`\n  answerable once the run finishes: ${((wouldAnswer / results.length) * 100).toFixed(1)}%`);
  console.log("\n=== hands the set does not cover");
  for (const [k, v] of [...skips.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(4)}  ${k}`);

  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(), hands: hands.length, usableHands: usable,
    decisions: results.length, plannedCharts: planned.size,
    byStatus, byStake: tally((r) => r.stake), bySeat: tally((r) => r.heroSeat),
    skippedHands: Object.fromEntries([...skips.entries()].sort((a, b) => b[1] - a[1])),
    byDepthBucket: tally((r) => (r.depthBB > 165 ? "over 165bb" : `${Math.floor(r.depthBB / 25) * 25}-${Math.floor(r.depthBB / 25) * 25 + 24}bb`)),
    byTableSize: tally((r) => `${r.seatsDealt}-handed`),
    // a corpus run produces six figures of rows: keep every failure, and a walk-on sample of the rest
    distance,
    results: results.filter((r) => r.status !== "answered").slice(0, 4000),
    answeredSample: results.filter((r) => r.status === "answered").filter((_, i) => i % 97 === 0).slice(0, 400),
  }, null, 1));
  console.log(`\nwrote ${outPath}`);
}

if (import.meta.main) await main();
