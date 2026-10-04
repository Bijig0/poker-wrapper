/**
 * THE POOL-LOCKED LIMPER, MEASURED (2026-10-05; gtowAiPreflop.solvePreflopPoolLocked). Does a GTO Wizard AI preflop tree
 * with the limper's limp node-locked to a pool range play hero's node like a tree SOLVED with that lock?
 *
 *   A  the mechanism: a 100bb HJ limps, hero's BB option. Three trees — GTO Wizard plain, GTO Wizard with the HJ's limp
 *      locked to limp_first_deep (3.1%), and our D100_olimp_pool3 (HRC, the HJ's first-in limp locked to the same range).
 *      The locked GTO Wizard tree should sit far closer to the chart than the plain one.
 *   B  hand 4922555015's shape: a 39bb HJ limps, hero's BB option — plain vs locked at limp_first_short_le60 (26.3%).
 *   C  hero on the BTN behind a 30bb UTG limp — plain vs locked (fold or raise: the AI tree holds one limper).
 *
 *   POKER_DATA_DIR=C:/Users/Brady/poker-data bun run src/scripts/poolLockStudy.ts
 *
 * NOT while a session is live: it solves on the live GTO Wizard accounts (a few dozen requests).
 */
import { Database } from "bun:sqlite";
import { fetchNode, poolLockSeams, solvePreflopPoolLocked } from "../services/gtowAiPreflop";
import { nodeGetter } from "../services/hrc6max";
import type { PoolLockTarget } from "../services/poolLimpFloor";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const db = new Database("C:/Users/Brady/poker-data/poker.sqlite", { readonly: true });
if ((db.query("select id from sessions where ended_at is null").all() as any[]).length) { console.log("a session is LIVE — not running"); process.exit(2); }

const SEAT = { UTG: 1, HJ: 2, CO: 3, BTN: 4, SB: 5, BB: 6 } as const;
type Pp = keyof typeof SEAT;
let n = 0;
const hand = (heroPos: Pp, acts: [Pp, string, number?][], stacks: Partial<Record<Pp, number>> = {}): ParsedHand => {
  const hero = SEAT[heroPos];
  const a = (pos: Pp, type: string, amount?: number) => ({ seatId: SEAT[pos], hero: SEAT[pos] === hero, type, street: "preflop", ...(amount != null ? { amount } : {}) });
  const st: Record<number, number> = { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100 };
  for (const [p, v] of Object.entries(stacks)) st[SEAT[p as Pp]] = v!;
  return {
    handId: 900000 + ++n, clientHandId: `pool-lock-study-${Date.now()}-${n}`, bbCents: 200, heroSeatId: hero, heroCards: ["7h", "6d"], board: [], street: "preflop",
    actions: [a("SB", "post-sb", 0.5), a("BB", "post-bb", 1), ...acts.map(([p, t, x]) => a(p, t, x))],
    liveSeats: [1, 2, 3, 4, 5, 6], committed: {}, potByStreet: {}, positions: { 1: "UTG", 2: "HJ", 3: "CO", 4: "BTN", 5: "SB", 6: "BB" },
    stacks: st, startStacks: { ...st },
    currentNode: { street: "preflop", toActSeatId: hero, toActIsHero: true, pot: 0, toCall: 0, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
};

/** per class: the share of the class that RAISES (any size) — from a GTO Wizard node (per combo) */
function gtowRaise(data: any): Record<string, number> {
  const sols = (data?.action_solutions ?? []) as any[];
  const acc: Record<string, { s: number; k: number }> = {};
  for (let i = 0; i < 1326; i++) {
    let r = 0;
    for (const a of sols) if (/^R/i.test(String(a?.action?.code ?? ""))) r += Number(a.strategy?.[i] ?? 0);
    const c = COMBOS[i]!.cls;
    (acc[c] ??= { s: 0, k: 0 }).s += r; acc[c]!.k++;
  }
  return Object.fromEntries(Object.entries(acc).map(([c, v]) => [c, v.s / v.k]));
}
/** …and from a chart node (per class, actions by token) */
function chartRaise(node: any): Record<string, number> {
  const tok = new Map<string, string | null>((node.actions ?? []).map((a: any) => [a.action, a.token]));
  const out: Record<string, number> = {};
  for (const cell of node.cells ?? []) {
    let r = 0, t = 0;
    for (const [act, f] of Object.entries(cell.actions as Record<string, number>)) { t += f; if (/^R/i.test(String(tok.get(act) ?? act))) r += f; }
    out[cell.hand] = t > 0 ? r / t : 0;
  }
  return out;
}
const combosOf = (c: string) => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
const rangeRaise = (r: Record<string, number>) => {
  let s = 0, k = 0;
  for (const [c, v] of Object.entries(r)) { s += v * combosOf(c); k += combosOf(c); }
  return k ? (100 * s) / k : NaN;
};
const distance = (a: Record<string, number>, b: Record<string, number>) => {
  let d = 0, k = 0, flip = 0;
  for (const c of Object.keys(a)) {
    if (b[c] == null) continue;
    d += Math.abs(a[c]! - b[c]!) * combosOf(c); k += combosOf(c);
    if ((a[c]! > 0.5) !== (b[c]! > 0.5)) flip += combosOf(c);
  }
  return { meanAbs: d / k, flipPct: (100 * flip) / k };
};

/** solve plain + locked for one case; returns hero's node data on each */
async function both(h: ParsedHand, heroPos: Pp, target: PoolLockTarget) {
  let parent: string | null = null;
  const seen = new Map<string, any>();
  const s0 = { ...poolLockSeams };
  poolLockSeams.solve = async (k, b, need) => { const r = await s0.solve(k, b, need); if ("solId" in r) parent = r.solId; return r; };
  poolLockSeams.node = async (solId, line) => { const r = await s0.node(solId, line); if (!("error" in r)) seen.set(`${solId}|${line}`, r.data); return r; };
  const t0 = Date.now();
  const r = await solvePreflopPoolLocked(h, heroPos, target, { skipPin: () => true });
  Object.assign(poolLockSeams, s0);
  if (!r.ok) throw new Error(r.reason);
  const locked = seen.get(`${r.solId}|${r.usedLine}`);
  const plainRead = await fetchNode(parent!, r.usedLine);
  if ("error" in plainRead) throw new Error(`plain node: ${plainRead.error}`);
  const lockNode = seen.get(`${r.solId}|F`) ?? seen.get(`${r.solId}|`);
  return { r, locked, plain: plainRead.data, secs: (Date.now() - t0) / 1000, lockNode };
}

const pct = (x: number) => `${x.toFixed(1)}%`;
const out: string[] = [];
const say = (s: string) => { console.log(s); out.push(s); };

// ── A: the mechanism, against the HRC tree solved with the same lock
{
  const h = hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]]);
  const t: PoolLockTarget = { pos: "HJ", key: "limp_first_deep", stack: 100, complete: false, alsoSb: false };
  const x = await both(h, "BB", t);
  const chart = await nodeGetter("ign200_6max_D100_olimp_pool3")("F-C-F-F-F");
  if (!chart || chart === "unreachable") throw new Error("D100_olimp_pool3 node F-C-F-F-F not readable");
  const cR = chartRaise(chart), pR = gtowRaise(x.plain), lR = gtowRaise(x.locked);
  const dp = distance(pR, cR), dl = distance(lR, cR);
  say(`A  100bb HJ limps, BB to act — the BB's raise share (any size), over his whole range`);
  say(`   D100_olimp_pool3 (HRC, HJ limp locked to limp_first_deep): ${pct(rangeRaise(cR))}`);
  say(`   GTO Wizard plain:                                          ${pct(rangeRaise(pR))}   vs the chart: mean |diff| per hand ${dp.meanAbs.toFixed(3)}, top action differs on ${pct(dp.flipPct)} of hands`);
  say(`   GTO Wizard, HJ limp LOCKED to limp_first_deep:            ${pct(rangeRaise(lR))}   vs the chart: mean |diff| per hand ${dl.meanAbs.toFixed(3)}, top action differs on ${pct(dl.flipPct)} of hands`);
  say(`   (${x.secs.toFixed(1)} s; ${x.r.note.slice(0, 120)}…)`);
}

// ── B: hand 4922555015's shape, a 39bb HJ
{
  const h = hand("BB", [["UTG", "fold"], ["HJ", "call", 1], ["CO", "fold"], ["BTN", "fold"], ["SB", "fold"]],
    { UTG: 11.6, HJ: 39, CO: 26.2, BTN: 96.2, SB: 151.2, BB: 135.8 });
  const t: PoolLockTarget = { pos: "HJ", key: "limp_first_short_le60", stack: 39, complete: false, alsoSb: false };
  const x = await both(h, "BB", t);
  const pR = gtowRaise(x.plain), lR = gtowRaise(x.locked);
  const d = distance(lR, pR);
  say(`B  39bb HJ limps (hand 4922555015), BB to act — plain ${pct(rangeRaise(pR))} raise, locked at limp_first_short_le60 ${pct(rangeRaise(lR))} raise; top action differs on ${pct(d.flipPct)} of hands (${x.secs.toFixed(1)} s)`);
  say(`   76o: plain ${pct(100 * (pR["76o"] ?? 0))} raise, locked ${pct(100 * (lR["76o"] ?? 0))} raise · ATo: plain ${pct(100 * (pR.ATo ?? 0))}, locked ${pct(100 * (lR.ATo ?? 0))}`);
}

// ── C: hero on the BTN behind a 30bb UTG limp
{
  const h = hand("BTN", [["UTG", "call", 1], ["HJ", "fold"], ["CO", "fold"]], { UTG: 30 });
  const t: PoolLockTarget = { pos: "UTG", key: "limp_first_short_le60", stack: 30, complete: false, alsoSb: false };
  const x = await both(h, "BTN", t);
  const pR = gtowRaise(x.plain), lR = gtowRaise(x.locked);
  const acts = (x.locked?.action_solutions ?? []).map((a: any) => a.action.code).join("/");
  say(`C  30bb UTG limps, BTN to act (offered ${acts}) — plain ${pct(rangeRaise(pR))} raise, locked ${pct(rangeRaise(lR))} raise (${x.secs.toFixed(1)} s)`);
  say(`   ATo: plain ${pct(100 * (pR.ATo ?? 0))} raise, locked ${pct(100 * (lR.ATo ?? 0))} · KQo: plain ${pct(100 * (pR.KQo ?? 0))}, locked ${pct(100 * (lR.KQo ?? 0))}`);
}

await Bun.write(`C:/Users/Brady/poker-data/audits/pool-lock-study-${new Date().toISOString().slice(0, 10)}.txt`, out.join("\n") + "\n");
process.exit(0);
