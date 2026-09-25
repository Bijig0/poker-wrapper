/**
 * huSizingRegret — what does GTO Wizard's AUTOMATIC (one size per node) cost a heads-up player, in EV, against an
 * opponent who keeps a full menu of sizes?
 *
 * WHY (2026-09-22, Brady: "is a heads up size grid necessary? … what is the EV regret of single sized strategies
 * like what Automatic does vs full all sizes equilibrium"). Every heads-up postflop answer of the 6-max strategy
 * is solved on AUTOMATIC, and in one limped spot the BB's only lead was a 400% overbet. Whether a size grid is
 * worth its extra solve time is an EV question, so it is answered in EV.
 *
 * METHOD. Restrict ONE player and let the other keep every size: the restricted player's EV drop is then exactly
 * what the simplification costs against an opponent free to punish it (the standard way solver vendors price a
 * simplified strategy). GTO Wizard takes sizing per position, so per spot four trees, same ranges/pot/stacks/rake:
 *
 *   FULL      both players: bets 25/33/50/75/100/150% pot, raises 50/100%, every street
 *   OOP-AUTO  OOP on AUTOMATIC, IP full                      -> OOP's loss = EV_OOP(FULL) - EV_OOP(OOP-AUTO)
 *   IP-AUTO   IP on AUTOMATIC, OOP full                      -> IP's loss  = EV_IP(FULL)  - EV_IP(IP-AUTO)
 *   FULL-R    FULL with the size lists reversed — the same game under a new tree id, so a fresh solve: the
 *             EV gap between FULL and FULL-R is the AI solver's own noise, the floor under which a "loss" means
 *             nothing.
 *
 * EV. OOP's = Σ over its root actions of frequency × range EV. IP's = Σ over OOP's root actions of P(action) ×
 * IP's range EV at the node that action leads to (IP's range is the same at every child — OOP's action does not
 * condition it).
 *
 * Spots are real heads-up flops the chain solved, read back from data/solves.sqlite (their exact ranges).
 *
 *   bun src/scripts/huSizingRegret.ts [--ids 2383,2379,...] [--out regret.json]
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gtowSessions } from "../services/gtowSessions";
import { solvesDbPath } from "../services/storePaths";

const API = "https://api.gtowizard.com";
const arg = (k: string, d?: string) => { const i = Bun.argv.indexOf(k); return i >= 0 ? Bun.argv[i + 1] : d; };
const DEFAULT_IDS = [2383, 2379, 2378, 2377, 2368, 2371, 2366, 2364];
const BETS = ["25%", "33%", "50%", "75%", "100%", "150%"];
const RAISES = ["50%", "100%"];

type Cfg = "auto" | "full" | "fullR";
const posCfg = (position: string, c: Cfg) => {
  if (c === "auto") return { position, type: "AUTOMATIC", allow_limp: false };
  const b = c === "fullR" ? [...BETS].reverse() : BETS;
  const r = c === "fullR" ? [...RAISES].reverse() : RAISES;
  return { position, type: "FIXED", use_fixed_sizes: true, allow_limp: false,
    bet_sizes: b, raise_sizes: r, second_raise_sizes: r, third_plus_raise_sizes: r };
};

function tree(s: any, oop: Cfg, ip: Cfg) {
  const street = (name: string) => ({ street: name, position_bet_sizes: [posCfg("OOP", oop), posCfg("IP", ip)] });
  const player = (position: string, display: string, range: number[]) => ({
    position, display_position: display, blind: null, range, stack: s.flopStack,
    tournament_instant_bounty: null, tournament_total_bounty: null });
  return {
    starting_street: "FLOP", pot: s.flopPot, ante: null, ante_distribution_method: "PER_PLAYER",
    bet_sizes: { allin_threshold: 60, allin_if_less_than: 500, merge_sizes_threshold: 10, max_num_raises: 5,
      street_bet_sizes: [street("FLOP"), street("TURN"), street("RIVER")] },
    players: [player("OOP", s.oopPos ?? "BB", s.oopRange), player("IP", s.ipPos ?? "BTN", s.ipRange)],
    tree_operations: [], resolving_policy: null,
    rake: s.rake ?? { pct_of_pot: 5, cap_in_chips: 2, preflop_rake_type: null }, tournament_data: null,
  };
}

async function token(): Promise<string> {
  const b = await gtowSessions.bestToken({ multiway: false });
  if (!b) throw new Error("no GTO Wizard token");
  return b.token;
}

async function solve(body: any, board: string): Promise<string> {
  const H = { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" };
  const tr = await fetch(`${API}/v4/custom-solutions/custom-trees/`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!tr.ok) throw new Error(`custom-trees ${tr.status}: ${(await tr.text()).slice(0, 200)}`);
  const t: any = await tr.json();
  const so = await fetch(`${API}/v4/custom-solutions/`, { method: "POST", headers: H, body: JSON.stringify({ custom_tree_id: t.id, actions: "", board }), signal: AbortSignal.timeout(30_000) });
  if (!so.ok) throw new Error(`custom-solutions ${so.status}: ${(await so.text()).slice(0, 200)}`);
  const sol: any = await so.json();
  return String(sol.id ?? sol.custom_solution_id);
}

async function node(solId: string, board: string, flop: string): Promise<any> {
  const q = new URLSearchParams({ custom_solution_id: solId, preflop_actions: "", flop_actions: flop, turn_actions: "", river_actions: "", board });
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const r = await fetch(`${API}/v4/solutions/spot-solution/?${q}`, { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (r && r.ok && r.status !== 204) { const j: any = await r.json().catch(() => null); if (j?.action_solutions?.length) return j; }
    else if (r && !r.ok && r.status !== 404) throw new Error(`spot-solution ${r.status}: ${(await r.text()).slice(0, 160)}`);
    await new Promise((res) => setTimeout(res, 1200));
  }
  throw new Error(`node '${flop}' timed out`);
}

/**
 * Range EV of the acting player at a node. GTO Wizard leaves `total_ev` at 0 on custom solves, so it is built
 * from the per-combo arrays: Σ_combo w · Σ_action strategy·ev, over Σ_combo w. Only combos with weight count —
 * a zero-weight combo's EV slot is uninitialised (see memory r2-solve-db-index: "EV for zero-weight hands is
 * garbage").
 */
function rangeEv(n: any, w: number[]): number {
  const sols = n.action_solutions as any[];
  let num = 0, den = 0;
  for (let c = 0; c < w.length; c++) {
    const wc = w[c] ?? 0;
    if (wc <= 0) continue;
    let reach = 0, ev = 0;
    for (const a of sols) { const st = Number(a.strategy?.[c] ?? 0); reach += st; ev += st * Number(a.evs?.[c] ?? 0); }
    if (reach <= 1e-9) continue;                               // board-blocked: not in the game
    num += wc * ev; den += wc;
  }
  return den ? num / den : 0;
}

async function evs(solId: string, board: string, s: any) {
  const root = await node(solId, board, "");
  const evOop = rangeEv(root, s.oopRange);
  let evIp = 0;
  const menu: string[] = [];
  for (const a of root.action_solutions as any[]) {
    const f = Number(a.total_frequency ?? 0);
    const code = String(a.action?.code ?? "");
    menu.push(`${code} ${(100 * f).toFixed(0)}%`);
    if (f < 1e-4) continue;                                    // unreached: contributes nothing
    const child = await node(solId, board, code);
    evIp += f * rangeEv(child, s.ipRange);
  }
  return { evOop, evIp, menu };
}

async function main() {
  const ids = (arg("--ids") ?? DEFAULT_IDS.join(",")).split(",").map(Number);
  const out = arg("--out");
  const db = new Database(solvesDbPath(), { readonly: true });
  await gtowSessions.forceRefresh();
  const results: any[] = [];
  for (const id of ids) {
    const row = db.query<any, [number]>("SELECT trace, line FROM solves WHERE id = ?").get(id);
    if (!row) { console.log(`#${id}: not found`); continue; }
    const s = JSON.parse(Buffer.from(Bun.gunzipSync(row.trace)).toString("utf-8")).spec;
    const board = String(s.board).slice(0, 6);                 // the FLOP — this prices the flop decision onward
    const pre = String(row.line ?? "").split("/")[0];
    const label = `#${id} ${s.oopPos}v${s.ipPos} ${board} pot ${s.flopPot} (${pre})`;
    try {
      const cfgs: [string, Cfg, Cfg][] = [["FULL", "full", "full"], ["FULL-R", "fullR", "fullR"], ["OOP-AUTO", "auto", "full"], ["IP-AUTO", "full", "auto"]];
      const r: Record<string, any> = {};
      for (const [name, o, i] of cfgs) r[name] = await evs(await solve(tree(s, o, i), board), board, s);
      const pct = (x: number) => `${(100 * x / s.flopPot).toFixed(2)}%`;
      const noise = Math.max(Math.abs(r.FULL.evOop - r["FULL-R"].evOop), Math.abs(r.FULL.evIp - r["FULL-R"].evIp));
      const oopLoss = r.FULL.evOop - r["OOP-AUTO"].evOop;
      const ipLoss = r.FULL.evIp - r["IP-AUTO"].evIp;
      console.log(`\n${label}`);
      console.log(`   sanity: FULL EV_OOP ${r.FULL.evOop.toFixed(2)} + EV_IP ${r.FULL.evIp.toFixed(2)} = ${(r.FULL.evOop + r.FULL.evIp).toFixed(2)}bb of a ${s.flopPot}bb pot (the rest is rake)`);
      console.log(`   noise (FULL vs FULL-R):  ${noise.toFixed(3)}bb = ${pct(noise)} of pot`);
      console.log(`   OOP on AUTOMATIC loses:  ${oopLoss.toFixed(3)}bb = ${pct(oopLoss)} of pot   (OOP root, full:  ${r.FULL.menu.join(" · ")})`);
      console.log(`                                                               (OOP root, auto:  ${r["OOP-AUTO"].menu.join(" · ")})`);
      console.log(`   IP  on AUTOMATIC loses:  ${ipLoss.toFixed(3)}bb = ${pct(ipLoss)} of pot`);
      results.push({ id, label, pot: s.flopPot, noise, oopLoss, ipLoss, r });
    } catch (e) {
      console.log(`\n${label}\n   FAILED — ${e instanceof Error ? e.message : e}`);
    }
  }
  if (results.length) {
    const mean = (k: string) => results.reduce((a, x) => a + x[k], 0) / results.length;
    const meanPct = (k: string) => results.reduce((a, x) => a + x[k] / x.pot, 0) / results.length * 100;
    console.log(`\n${"=".repeat(90)}\n${results.length} spots`);
    console.log(`   solver noise           mean ${mean("noise").toFixed(3)}bb (${meanPct("noise").toFixed(2)}% of pot)`);
    console.log(`   OOP AUTOMATIC regret   mean ${mean("oopLoss").toFixed(3)}bb (${meanPct("oopLoss").toFixed(2)}% of pot)`);
    console.log(`   IP  AUTOMATIC regret   mean ${mean("ipLoss").toFixed(3)}bb (${meanPct("ipLoss").toFixed(2)}% of pot)`);
  }
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  process.exit(0);
}

await main();
