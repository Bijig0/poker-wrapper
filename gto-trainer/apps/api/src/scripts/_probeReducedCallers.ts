/**
 * THE REDUCED TREE ON THE HANDS THAT USED IT (2026-10-04): for each hand, the flop-entering ranges as THIS checkout
 * reads them (arrivalRangesGtowAi at hero's first postflop decision) — every seat's range in combos, the share of its
 * range each caller keeps — and the flop answer through the live path (fastSolve). Run it from a checkout of the old
 * code and of the new to see what the caller read changed.
 *
 *   . config/env.ps1; & $env:BUN run src/scripts/_probeReducedCallers.ts [--hands 4921861748,4921846667] [--cap 60] [--ranges]
 *
 * --dump <file>: append each hand's ranges (class weights) as a JSON line, to compare two checkouts.
 *
 * It SOLVES on the live GTO Wizard accounts where the solve cache lacks a node (every request counted; refused past
 * --cap). NOT while a session is live.
 */
import { Database } from "bun:sqlite";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt } from "../utils/archivedHand/archivedHand";
import { arrivalRangesGtowAi } from "../services/gtowAiPreflop";
import { fastSolve } from "../services/fastSolve";
import { gtowRequests } from "../services/gtowRequestLog";

const argv = process.argv.slice(2);
const arg = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? "" : null; };
const IDS = (arg("hands") ?? "4921861748,4921846667").split(",").filter(Boolean);
const CAP = Number(arg("cap") ?? 60);
const db = new Database(`${(process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/")}/poker.sqlite`, { readonly: true });
if ((db.query("select id from sessions where ended_at is null").all() as any[]).length) { console.log("a session is LIVE — not running"); process.exit(2); }
let spent = 0;
const orig = gtowRequests.fetch.bind(gtowRequests);
(gtowRequests as any).fetch = async (...a: Parameters<typeof orig>) => {
  if (spent >= CAP) return new Response("probe cap reached", { status: 429 });
  spent++;
  return orig(...a);
};
const N = (c: string) => (c.length === 2 ? 6 : c.endsWith("s") ? 4 : 12);
const combos = (rec: Record<string, number>) => Object.entries(rec).reduce((s, [c, w]) => s + w * N(c), 0);
const brief = (rec: Record<string, number>) => {
  const top = Object.entries(rec).sort((x, y) => y[1] * N(y[0]) - x[1] * N(x[0])).slice(0, 12).map(([c, w]) => `${c} ${w.toFixed(2)}`).join(", ");
  return `${Object.keys(rec).length} classes · ${combos(rec).toFixed(1)} combos (heaviest class = 1) · ${top}`;
};

for (const id of IDS) {
  const row = db.query("select data from hands where client_hand_id = ? order by rowid desc limit 1").get(id) as any;
  if (!row) { console.log(`\n### ${id}: not archived`); continue; }
  const hand = normalizeHand(JSON.parse(row.data)).hand;
  const upto = hand.actions.findIndex((a) => a.hero && a.street !== "preflop");
  if (upto < 0) { console.log(`\n### ${id}: hero has no postflop decision`); continue; }
  const t = truncateAt(hand, upto);
  const at = { ...t, currentNode: { ...t.currentNode, toActIsHero: true } };
  const heroPos = hand.positions[hand.heroSeatId] ?? null;
  const pre = hand.actions.filter((a) => a.street === "preflop" && !/^post/.test(a.type))
    .map((a) => `${hand.positions[a.hero ? hand.heroSeatId : a.seatId] ?? "?"}${a.hero ? "*" : ""} ${a.type}${a.amount != null ? ` ${a.amount}` : ""}`).join(", ");
  console.log(`\n### ${id}: hero ${heroPos} ${hand.heroCards.join("")} · ${at.street} ${at.board.join(" ")} · preflop: ${pre}`);
  const s0 = spent, t0 = Date.now();
  const r = await arrivalRangesGtowAi(at, heroPos, 6);
  console.log(`== arrival ranges: ${r.ok ? "ok" : "REFUSED — " + r.reason} (${Date.now() - t0} ms, ${spent - s0} requests)`);
  if (r.ok) {
    console.log("   id:", r.id, "| reduced:", JSON.stringify(r.reduced ?? null));
    for (const [pos, rec] of Object.entries(r.ranges)) console.log(`   ${pos.padEnd(4)} ${brief(rec)}`);
    console.log("   note:", r.note);
    if (arg("dump")) { const { appendFileSync } = await import("node:fs"); appendFileSync(arg("dump")!, JSON.stringify({ id, ranges: r.ranges }) + "\n"); }
  }
  if (argv.includes("--ranges")) continue;
  const s1 = spent, t1 = Date.now();
  const sol: any = await fastSolve(at, heroPos, { heroPos, strategyId: "ign200-ring-6max-equilibrium", origin: "replay" } as any);
  console.log(`== flop answer: ${sol.ok ? "ANSWERED" : "NO ANSWER — " + sol.reason} (${Date.now() - t1} ms, ${spent - s1} requests)`);
  if (sol.ok) {
    console.log("   source", sol.source, "· line", sol.line, "· ranges:", sol.gametype);
    console.log("   mix:", (sol.actions ?? []).map((x: any) => `${x.action} ${x.frequency}%`).join(" · "));
  }
}
console.log(`\nGTO Wizard requests this run: ${spent}`);
process.exit(0);
