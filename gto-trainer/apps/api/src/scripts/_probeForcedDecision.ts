/**
 * Probe (2026-10-04): the forced-bet tree under the 2026-10-03 settings (allin_threshold 100 / allin_if_less_than 0 /
 * no merging), for a preflop last resort rebuilt on it — WHICH WAS NOT BUILT, because of `range` below.
 *
 * RESULTS (2026-10-04):
 *   range   GTO WIZARD IGNORES A SEAT'S `range` ON A PREFLOP TREE. The same tree with the raiser given KK/QQ/JJ/AK/
 *           AQs/KQs/AJs, given nothing, and given 72o alone: hero's node identical to the cent (F 18.1 / C 51.7 /
 *           R 30.2; AA call EV 36.64 in all three), and the node reports 1,326 combos for both seats. So a forced tree
 *           reads its caller against ANY TWO CARDS — the reduced arrival tree (utils/reducedArrival) has always done so.
 *   ip      the raiser in position with no size listed has the check alone at the root: X 100%.
 *   sizes   a multiple in a size list is a multiple of the bet FACED: "2.5x" over a 17.6 post is R44 from either seat
 *           ("8.8x", the old formula for a raiser in position, came back as the caller's all-in).
 *   allin   "<stack>bb" in a size list is the seat's all-in, named R<stack>; with `pot` > 0 the reply does not flag it
 *           (GTO Wizard adds pot/n to each stack and antes it: the flagged all-in is stack + pot/n).
 *   zero    a seat posting a penny solves.
 *   cover   a forced bet of the OTHER seat's whole stack is never solved (the root offers the poster fold/call and no
 *           node behind it solves); one blind short of it solves, from either seat.
 *   short   a poster all in for his OWN whole stack solves only as the tree's BB (as its SB: the same broken root). The 2026-10-01 trees were solved under the old
 * `allin_if_less_than: 500`: GTO Wizard added the raiser's all-in at the root and his check carried 22-98% of his
 * range. What this asks:
 *   ip      the raiser in position (posts the tree's SB), no size listed for him: is the root the check alone?
 *   allin   how a seat's all-in is listed in a tree whose big blind is not 1 ("<stack>bb" or a multiple of the blind)
 *   oop     the raiser out of position: hero at the root with a re-raise and his all-in
 *   zero    hero with nothing in yet (posts a penny)
 *   cover   a raise that covers hero: forced bet = hero's stack (the 2026-10-01 probe: never solved) and one blind less
 *
 *   . config/env.ps1; bun run src/scripts/_probeForcedDecision.ts [ip allin oop zero cover]
 *
 * NOT while a session is live (it solves on the live GTO Wizard accounts).
 */
import { Database } from "bun:sqlite";
import { debugSolveBody, debugTree } from "../services/gtowAiPreflop";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const db = new Database(`${(process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/")}/poker.sqlite`, { readonly: true });
if ((db.query("select id from sessions where ended_at is null").all() as any[]).length) { console.log("a session is LIVE — not running"); process.exit(1); }

const pre = (type: string, seatId: number, amount?: number) => ({ seatId, hero: seatId === 2, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const hu: ParsedHand = {
  handId: 1, clientHandId: "probe-forced-decision", bbCents: 200, heroSeatId: 2, heroCards: ["7s", "7c"], board: [], street: "preflop",
  actions: [pre("post-sb", 2, 0.5), pre("post-bb", 1, 1)], liveSeats: [1, 2], committed: {}, potByStreet: {}, positions: { 2: "SB", 1: "BB" }, stacks: { 2: 153.5, 1: 91.5 },
  currentNode: { street: "preflop", toActSeatId: 2, toActIsHero: true, pot: 1.5, toCall: 0.5, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand;
const dt = debugTree(hu, null);
if ("error" in dt) throw new Error(dt.error);
const b: any = dt.body;
const strong: number[] = COMBOS.map((c) => (/^(KK|QQ|JJ|AKs|AKo|AQs|KQs|AJs)$/.test(c.cls) ? 1 : 0));
const limpy: number[] = COMBOS.map((c) => (/^(AA|KK|QQ|JJ|TT|99|88|77|66|55|44|33|22|A[2-9TJQK]s|K[9TJQ]s|Q[9TJ]s|J[9T]s|T9s|98s|87s|76s|AKo|AQo|AJo|KQo|KJo|QJo)$/.test(c.cls) ? 1 : c.cls.endsWith("s") ? 0.2 : 0.03));

type Seat = { blind: number; stack: number; range: number[] };
type Sizes = Record<string, { bet?: string[]; raise?: string[] }>;
const RAISES = ["3.2x", "3.8x", "4.5x"], FOUR = ["2.2x", "2.6x"], FIVE = ["2.2x"];
function body(pot: number, sb: Seat, bb: Seat, sizes: Sizes) {
  return {
    ...b, pot,
    bet_sizes: { ...b.bet_sizes, street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: ["SB", "BB"].map((position) => ({
      position, type: "FIXED", use_fixed_sizes: true, allow_limp: true, allow_call_opens: true, allow_3betplus_cold_calls: true,
      bet_sizes: sizes[position]?.bet ?? [], raise_sizes: [...RAISES, ...(sizes[position]?.raise ?? [])],
      second_raise_sizes: [...FOUR, ...(sizes[position]?.raise ?? [])], third_plus_raise_sizes: [...FIVE, ...(sizes[position]?.raise ?? [])],
    })) }] },
    players: b.players.map((p: any) => ({ ...p, ...(p.position === "SB" ? sb : bb) })),
  };
}
const share = (range: number[], strategy: number[]) => { let w = 0, f = 0; for (let i = 0; i < 1326; i++) { w += range[i]!; f += range[i]! * (strategy[i] ?? 0); } return w ? f / w : 0; };
async function run(label: string, bd: any, lines: (root: any[]) => string[], ranges: Record<string, number[]>) {
  console.log(`\n== ${label}`);
  console.log(`   settings ${JSON.stringify({ allin_threshold: bd.bet_sizes.allin_threshold, allin_if_less_than: bd.bet_sizes.allin_if_less_than, merge: bd.bet_sizes.merge_sizes_threshold })} · pot ${bd.pot} · ` +
    bd.players.map((p: any) => `${p.position} posts ${p.blind} of ${p.stack}`).join(", ") + " · bets " +
    JSON.stringify(Object.fromEntries(bd.bet_sizes.street_bet_sizes[0].position_bet_sizes.map((x: any) => [x.position, x.bet_sizes]))));
  const t0 = Date.now();
  const sol = await debugSolveBody(`probe|${Bun.hash(JSON.stringify(bd)).toString(36)}`, bd, 2);
  if ("error" in sol) { console.log("   REFUSED —", sol.error.slice(0, 300)); return; }
  const show = async (line: string) => {
    const n = await sol.get(line);
    if ("error" in n) { console.log(`   '${line || "root"}': — ${n.error.slice(0, 200)} (${Date.now() - t0} ms)`); return [] as any[]; }
    const actor = n.data?.game?.players?.find((p: any) => p.is_hero)?.position ?? "?";
    const sols: any[] = n.data?.action_solutions ?? [];
    console.log(`   '${line || "root"}' ${actor} (${Date.now() - t0} ms): ` + sols.map((a) =>
      `${a.action.code}[${a.action.type}${a.action.allin ? " ALLIN" : ""} ${a.action.betsize}] ${(100 * share(ranges[actor] ?? [], a.strategy)).toFixed(1)}%`).join(" · "));
    return sols;
  };
  const root = await show("");
  for (const l of lines(root)) await show(l);
}
const want = process.argv.slice(2);
const on = (k: string) => !want.length || want.includes(k);
const R = { SB: strong, BB: limpy }, Rrev = { SB: limpy, BB: strong };

if (on("ip")) await run("ip: raiser IN POSITION posts SB 17.6, hero BB posts 5, 10.4 dead; hero's re-raise 8.8x only",
  body(10.4, { blind: 17.6, stack: 153.5, range: strong }, { blind: 5, stack: 91.5, range: limpy }, { BB: { bet: ["8.8x"] } }), (root) => root.map((a) => a.action.code), R);
if (on("allin")) {
  await run("allin A: hero's all-in listed as '91.5bb' (bet list and raise lists), raiser's as '153.5bb'",
    body(10.4, { blind: 17.6, stack: 153.5, range: strong }, { blind: 5, stack: 91.5, range: limpy }, { BB: { bet: ["8.8x", "91.5bb"], raise: ["91.5bb"] }, SB: { raise: ["91.5bb"] } }), () => ["X", "X-R44"], R);
  await run("allin B: hero's all-in listed as a multiple of the tree's big blind, '18.3x'",
    body(10.4, { blind: 17.6, stack: 153.5, range: strong }, { blind: 5, stack: 91.5, range: limpy }, { BB: { bet: ["8.8x", "18.3x"] } }), () => ["X"], R);
}
if (on("oop")) await run("oop: raiser OUT OF POSITION posts BB 17.6, hero SB posts 5; hero 2.5x + '91.5bb'",
  body(10.4, { blind: 5, stack: 91.5, range: limpy }, { blind: 17.6, stack: 153.5, range: strong }, { SB: { bet: ["2.5x", "91.5bb"], raise: ["91.5bb"] }, BB: { raise: ["91.5bb"] } }), () => ["R44"], Rrev);
if (on("zero")) await run("zero: hero with nothing in, in position: SB posts 0.01, raiser BB posts 7.5, 1.5 dead",
  body(1.5, { blind: 0.01, stack: 91.5, range: limpy }, { blind: 7.5, stack: 153.5, range: strong }, { SB: { bet: ["2.5x", "91.5bb"], raise: ["91.5bb"] }, BB: { raise: ["91.5bb"] } }), () => [], Rrev);
if (on("cover")) {
  await run("cover A: raiser IP shoves 153.5 over hero's 5 (stack 55.5): forced bet = hero's whole stack 55.5",
    body(1.5, { blind: 55.5, stack: 153.5, range: strong }, { blind: 5, stack: 55.5, range: limpy }, {}), (root) => root.map((a) => a.action.code), R);
  await run("cover B: the same, forced bet one blind short of hero's stack (54.5)",
    body(1.5, { blind: 54.5, stack: 153.5, range: strong }, { blind: 5, stack: 55.5, range: limpy }, {}), (root) => root.map((a) => a.action.code), R);
  await run("cover C: raiser OOP (BB posts 54.5), hero SB posts 5 of 55.5",
    body(1.5, { blind: 5, stack: 55.5, range: limpy }, { blind: 54.5, stack: 153.5, range: strong }, {}), () => [], Rrev);
}
if (on("allin2")) {
  // GTO Wizard books `pot` as an ante it ADDS to each stack first (91.5 shows as 96.7 with 10.4 dead, two seats): is the
  // seat's all-in then its stack, or its stack + its share of the dead money?
  await run("allin2 A: hero at the root, re-raise 2.5x, all-in listed as stack + dead/2 = '96.7bb'",
    body(10.4, { blind: 5, stack: 91.5, range: limpy }, { blind: 17.6, stack: 153.5, range: strong }, { SB: { bet: ["2.5x", "96.7bb"], raise: ["96.7bb"] }, BB: { raise: ["96.7bb"] } }), () => ["R44"], Rrev);
  await run("allin2 B: raiser in position, hero behind his check: 2.5x and '91.5bb'",
    body(10.4, { blind: 17.6, stack: 153.5, range: strong }, { blind: 5, stack: 91.5, range: limpy }, { BB: { bet: ["2.5x", "91.5bb"], raise: ["91.5bb"] }, SB: { raise: ["91.5bb"] } }), () => ["X", "X-R44"], R);
}
if (on("short")) {
  await run("short A: the raiser all in from the deal, in position: SB posts 20 of 20, hero BB posts 1 of 100, 3.5 dead",
    body(3.5, { blind: 20, stack: 20, range: strong }, { blind: 1, stack: 100, range: limpy }, {}), (root) => root.map((a) => a.action.code), R);
  await run("short B: the raiser all in from the deal, out of position: BB posts 20 of 20, hero SB posts 0.5 of 100",
    body(3.5, { blind: 0.5, stack: 100, range: limpy }, { blind: 20, stack: 20, range: strong }, {}), () => [], Rrev);
}
if (on("range")) {
  // IS A SEAT'S `range` HONOURED ON A PREFLOP TREE? The same forced tree three times: the raiser given a strong range,
  // given none, given 72o alone. If hero's node is the same in all three, GTO Wizard solves a preflop tree from full
  // ranges whatever `range` says.
  const only72: number[] = COMBOS.map((c) => (c.cls === "72o" ? 1 : 0));
  const full: number[] = COMBOS.map(() => 1);
  const cls = (name: string) => COMBOS.findIndex((c) => c.cls === name);
  for (const [label, rr] of [["raiser = KK/QQ/JJ/AK/AQs/KQs/AJs", strong], ["raiser = no range given", null], ["raiser = 72o only", only72]] as const) {
    const bd = body(1, { blind: 2.6, stack: 100, range: full }, { blind: 13, stack: 100, range: rr as any }, { SB: { bet: ["2.5x"] } });
    console.log(`\n== range: ${label} — raiser BB posts 13, hero SB posts 2.6, 1 dead`);
    const sol = await debugSolveBody(`probe|${Bun.hash(JSON.stringify(bd)).toString(36)}`, bd, 2);
    if ("error" in sol) { console.log("   REFUSED —", sol.error.slice(0, 300)); continue; }
    const n = await sol.get("");
    if ("error" in n) { console.log("   root —", n.error.slice(0, 200)); continue; }
    const sols: any[] = n.data.action_solutions;
    console.log("   hero over all hands: " + sols.map((a) => `${a.action.code} ${(100 * share(full, a.strategy)).toFixed(1)}%`).join(" · "));
    for (const p of n.data.players_info ?? []) console.log(`   the node's own range for ${p.player.position}: ${p.range.reduce((x: number, y: number) => x + y, 0).toFixed(0)} combos`);
    for (const c of ["AA", "AKs", "KQo", "T9s", "72o"]) console.log(`   ${c.padEnd(4)} ` + sols.map((a) => `${a.action.code} ${(100 * a.strategy[cls(c)]).toFixed(0)}% (ev ${Number(a.evs?.[cls(c)] ?? 0).toFixed(2)})`).join(" · "));
  }
}
process.exit(0);
