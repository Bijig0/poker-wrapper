/**
 * Probe (2026-10-04): the node-lock's unknowns, before the preflop last resort is rebuilt on it (_probePreflopNodeLock.ts
 * proved the lock itself). Cases:
 *   multiway  a 3-handed tree (BTN/SB/BB, 100bb): BTN's root locked to "open AA only" — do SB's and BB's next nodes move?
 *   units     what "<N>bb" in a size list means when the blinds are not 0.5/1 (13bb came back R33.8 over SB 2.6 / BB 1)
 *   prev      previous_nodes_lock_type: the same lock (SB facing the 3-bet folds all but AA) under street_all, last_node,
 *             street_current_player — which earlier nodes stay as they were, which re-solve
 *
 *   cap / levels / potante / rakecap   what GTO Wizard does with odd posts, a `pot`, and the rake cap's units
 *
 * RESULTS (2026-10-04, account "primary" = Ultra, no 429):
 *   multiway  YES. BTN's root locked to AA only on a BTN/SB/BB 100bb tree: SB facing R2.5 F 84.5/C 0.2/R 15.3 → F 90.8/C 9.2/
 *             R 0; BB after SB folds F 53.0/C 33.1/R 13.9 → F 82.0/C 18.0/R 0; both nodes report BTN's range 6.0.
 *   prev      street_all freezes every earlier node of the street (node_locks_count 3 for a lock at R2.5-R8.8: the root and
 *             BB's node unchanged); last_node freezes none (count 1: SB's root went to limp 99.4%, BB 3-bets 57.5%);
 *             street_current_player freezes the locked player's own earlier nodes (count 2: SB's root kept, BB 3-bets 99.8%).
 *   units     "<N>bb" is N of the LARGER post: 6bb over posts 0.5/3 → R18 (4.23x → R12.69, a multiple of the bet faced).
 *   cap       stacks 600 over a post of 3: accepted — the 250bb limit counts in the larger post (a penny each at 100 deep:
 *             refused, "Only effective stacks up to 250bb").
 *   levels    a larger post UNDER 1 is rescaled to 1 and the stacks are not (0.01/0.5 played as 0.02/1); the larger post
 *             goes to the BIG BLIND whoever sent it (SB 1 / BB 0.01 reads SB 0.01 at the next node).
 *   potante   `pot` is an ante paid from chips GTO Wizard adds: stacks 100 + pot 2 read 101, only 100 can be bet.
 *   rakecap   cap_in_chips is in our units: a game and its copy at half scale (cap halved) solve identically (max |Δ| 0.0000);
 *             the half-scale copy with the cap NOT halved differs (0.435).
 *
 *   . config/env.ps1; & $env:BUN run src/scripts/_probeNodeLockStageA.ts [multiway] [units] [prev] [cap] [levels] [potante] [rakecap]
 *
 * NOT while a session is live. Stops on any 429 / limit-flavoured 401/403, past 1,200 requests in the account's last
 * hour, or past its own budget.
 */
import { Database } from "bun:sqlite";
import { debugTree } from "../services/gtowAiPreflop";
import { gtowSessions } from "../services/gtowSessions";
import { gtowRequests } from "../services/gtowRequestLog";
import { COMBOS } from "../utils/comboIndex/comboIndex";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const API = "https://api.gtowizard.com";
const BUDGET = Number(process.env.PROBE_BUDGET ?? 90);
const db = new Database(`${(process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/")}/poker.sqlite`, { readonly: true });
let sent = 0;
function guard(): void {
  if ((db.query("select id from sessions where ended_at is null").all() as any[]).length) { console.log("a session is LIVE — stopping"); process.exit(1); }
  const hr = (db.query("select count(*) n from gtow_requests where ts > ?").get(Date.now() - 3_600_000) as any).n as number;
  if (hr > 1200) { console.log(`account busy: ${hr} requests in the last hour — stopping`); process.exit(1); }
  if (++sent > BUDGET) { console.log(`probe budget spent (${sent - 1}) — stopping`); process.exit(1); }
}
function wall(status: number, text: string): void {
  if (status === 429 || ((status === 401 || status === 403) && /limit|quota|exceed/i.test(text))) { console.log(`WALL ${status}: ${text.slice(0, 300)}`); process.exit(2); }
}
const best = await gtowSessions.bestToken({ preflop: true, multiway: true });
if (!best) { console.log("no GTO Wizard token"); process.exit(1); }
const SID = best.id;
console.log(`session ${SID}`);
async function post(kind: "tree" | "solution", path: string, data: any): Promise<{ status: number; j: any; t: string }> {
  guard();
  const r = await gtowRequests.fetch(SID, kind, `${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${best!.token}`, "Content-Type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(30_000) });
  const t = await r.text(); wall(r.status, t);
  let j: any = null; try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, j, t };
}
async function node(solId: string, line: string): Promise<any | null> {
  for (let i = 0; i < 14; i++) {
    guard();
    const q = new URLSearchParams({ custom_solution_id: solId, preflop_actions: line, flop_actions: "", turn_actions: "", river_actions: "", board: "" });
    const r = await gtowRequests.fetch(SID, "poll", `${API}/v4/solutions/spot-solution/?${q}`, { headers: { Authorization: `Bearer ${best!.token}` }, signal: AbortSignal.timeout(10_000) });
    const t = await r.text(); wall(r.status, t);
    if (r.status === 200 && t) { const j = JSON.parse(t); if (j?.action_solutions?.length) return j; }
    if (r.status >= 400 && r.status !== 404) { console.log(`   '${line || "root"}' ${r.status}: ${t.slice(0, 300)}`); return null; }
    await new Promise((res) => setTimeout(res, 1500));
  }
  console.log(`   '${line || "root"}' not solved after 14 polls`); return null;
}
async function solve(body: any): Promise<string | null> {
  const tr = await post("tree", "/v4/custom-solutions/custom-trees/", body);
  if (tr.status >= 300) { console.log(`   tree refused ${tr.status}: ${tr.t.slice(0, 300)}`); return null; }
  const so = await post("solution", "/v4/custom-solutions/", { custom_tree_id: tr.j.id, actions: "", board: "" });
  if (so.status >= 300) { console.log(`   solution refused ${so.status}: ${so.t.slice(0, 300)}`); return null; }
  return String(so.j.id);
}
async function lock(parent: string, line: string, at: any, w: (code: string, cls: string) => number, type: string, label: string): Promise<string | null> {
  const codes: string[] = at.action_solutions.map((a: any) => a.action.code);
  const strategy = codes.map((code) => ({ action: code, strategy: COMBOS.map((c) => w(code, c.cls)) }));
  const lk = await post("solution", "/v4/custom-solutions/", { parent_solution_id: parent, last_node_lock: { strategy, hands_locked: COMBOS.map(() => true), action_history: [line], previous_nodes_lock_type: type } });
  console.log(`\n== LOCK ${label} [${type}] at '${line || "root"}' (${codes.join("/")}) → ${lk.status}${lk.j?.id ? ` id ${lk.j.id}, node_locks_count ${lk.j.node_locks_count}` : `: ${lk.t.slice(0, 300)}`}`);
  return lk.status < 300 && lk.j?.id ? String(lk.j.id) : null;
}
const idx = (cls: string) => COMBOS.findIndex((c) => c.cls === cls);
const sumOf = (r: number[]) => r.reduce((x, y) => x + y, 0);
function show(label: string, n: any, classes = ["AA", "KK", "AKs", "T9s", "72o"]): void {
  if (!n) return;
  const sols: any[] = n.action_solutions;
  const actor = n.game?.players?.find((p: any) => p.is_hero)?.position ?? "?";
  console.log(`   ${label} — ${actor}: ` + sols.map((a) => `${a.action.code}${a.action.allin ? "(AI)" : ""} ${(100 * (a.total_frequency ?? 0)).toFixed(1)}%`).join(" · "));
  console.log(`     ranges: ` + (n.players_info ?? []).map((p: any) => `${p.player?.position} ${sumOf(p.range ?? []).toFixed(1)}`).join(", ") +
    ` · pot ${JSON.stringify(n.game?.pot ?? null)} · stacks ${JSON.stringify((n.game?.players ?? []).map((p: any) => [p.position, p.stack, p.chips_on_table ?? p.current_bet ?? null]))}`);
  for (const c of classes) console.log(`     ${c.padEnd(4)} ` + sols.map((a) => `${a.action.code} ${(100 * a.strategy[idx(c)]).toFixed(0)}%`).join(" · "));
}

const want = process.argv.slice(2);
const on = (k: string) => !want.length || want.includes(k);
const pre = (type: string, seatId: number, amount?: number) => ({ seatId, hero: seatId === 1, type, street: "preflop", ...(amount != null ? { amount } : {}) });
const sizesFor = (positions: string[], f: (p: string) => Partial<{ bet: string[]; raise: string[]; second: string[]; third: string[] }>) => positions.map((position) => {
  const s = f(position);
  return { position, type: "FIXED", use_fixed_sizes: true, allow_limp: true, allow_call_opens: true, allow_3betplus_cold_calls: true,
    bet_sizes: s.bet ?? ["2.5x", "100bb"], raise_sizes: s.raise ?? ["3.5x", "100bb"], second_raise_sizes: s.second ?? ["2.2x", "100bb"], third_plus_raise_sizes: s.third ?? ["100bb"] };
});

// ── heads-up base body ────────────────────────────────────────────────────────────────────────────────────────────
const hu: ParsedHand = {
  handId: 1, clientHandId: "probe-nodelock-a", bbCents: 200, heroSeatId: 1, heroCards: ["7s", "7c"], board: [], street: "preflop",
  actions: [pre("post-sb", 1, 0.5), pre("post-bb", 2, 1)], liveSeats: [1, 2], committed: {}, potByStreet: {}, positions: { 1: "SB", 2: "BB" }, stacks: { 1: 100, 2: 100 },
  currentNode: { street: "preflop", toActSeatId: 1, toActIsHero: true, pot: 1.5, toCall: 0.5, legalActions: [], complete: false }, ended: false,
} as unknown as ParsedHand;
const dtHu = debugTree(hu, null);
if ("error" in dtHu) throw new Error(dtHu.error);
const huBody = (blinds: { SB: number; BB: number }, pot: number, f: Parameters<typeof sizesFor>[1]) => ({
  ...dtHu.body, pot,
  bet_sizes: { ...dtHu.body.bet_sizes, street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: sizesFor(["SB", "BB"], f) }] },
  players: dtHu.body.players.map((p: any) => ({ ...p, stack: 100, range: null, blind: blinds[p.position as "SB" | "BB"] })),
});

if (on("multiway")) {
  const h3: ParsedHand = {
    handId: 1, clientHandId: "probe-nodelock-a3", bbCents: 200, heroSeatId: 1, heroCards: ["7s", "7c"], board: [], street: "preflop",
    actions: [pre("post-sb", 2, 0.5), pre("post-bb", 3, 1)], liveSeats: [1, 2, 3], committed: {}, potByStreet: {}, positions: { 1: "BTN", 2: "SB", 3: "BB" }, stacks: { 1: 100, 2: 100, 3: 100 },
    currentNode: { street: "preflop", toActSeatId: 1, toActIsHero: true, pot: 1.5, toCall: 1, legalActions: [], complete: false }, ended: false,
  } as unknown as ParsedHand;
  const dt3 = debugTree(h3, null);
  if ("error" in dt3) throw new Error(dt3.error);
  const b3 = { ...dt3.body, bet_sizes: { ...dt3.body.bet_sizes, street_bet_sizes: [{ street: "PREFLOP", position_bet_sizes: sizesFor(dt3.body.players.map((p: any) => p.position), () => ({})) }] } };
  console.log(`\n== MULTIWAY plain: ${b3.players.map((p: any) => `${p.position} ${p.blind ?? 0}/${p.stack}`).join(", ")} · resolving_policy ${JSON.stringify(b3.resolving_policy)} · max_allowed_limps ${b3.max_allowed_limps}`);
  const sol = await solve(b3);
  const root = sol ? await node(sol, "") : null;
  show("root", root);
  if (sol && root) {
    const open: string = root.action_solutions.find((a: any) => a.action.type === "RAISE" && !a.action.allin)?.action.code;
    show(`'${open}'`, await node(sol, open));
    show(`'${open}-F'`, await node(sol, `${open}-F`));
    const child = await lock(sol, "", root, (code, cls) => (code === open ? (cls === "AA" ? 1 : 0) : code === "F" ? (cls === "AA" ? 0 : 1) : 0), "street_all", "BTN opens AA only");
    if (child) {
      show("root (locked)", await node(child, ""));
      show(`'${open}' (locked)`, await node(child, open));
      show(`'${open}-F' (locked)`, await node(child, `${open}-F`));
    }
  }
}

if (on("units")) {
  // three blind set-ups; SB's open list carries an amount and a multiple; the root's raise codes say what each became
  for (const [label, blinds, pot, bet] of [
    ["control 0.5/1", { SB: 0.5, BB: 1 }, 0, ["6bb", "4.23x"]],
    ["BB posts more: 0.5/3", { SB: 0.5, BB: 3 }, 0, ["6bb", "4.23x"]],
    ["pennies 0.01/0.01 + 1.5 dead", { SB: 0.01, BB: 0.01 }, 1.5, ["6bb", "2.5x"]],
  ] as const) {
    console.log(`\n== UNITS ${label}: SB bet list ${JSON.stringify(bet)}`);
    const sol = await solve(huBody(blinds, pot, (p) => (p === "SB" ? { bet: [...bet, "100bb"] } : {})));
    const root = sol ? await node(sol, "") : null;
    show("root", root, ["AA"]);
  }
}

if (want.includes("cap")) {
  // ARE STACKS IN THE LARGER BLIND'S UNITS TOO? BB posts 3, stacks 600: 200 of the larger blind (accepted under the
  // 250bb cap) if GTO Wizard divides stacks by it, 600bb (refused) if it does not
  const b = huBody({ SB: 0.5, BB: 3 }, 0, (p) => (p === "SB" ? { bet: ["4x", "600bb"] } : {}));
  b.players = b.players.map((p: any) => ({ ...p, stack: 600 }));
  console.log(`\n== CAP BB posts 3, stacks 600`);
  const sol = await solve(b);
  show("root", sol ? await node(sol, "") : null, ["AA"]);
}

if (want.includes("potante")) {
  // WHAT `pot` DOES TO THE CHIPS: blinds 0.5/1, stacks 100, pot 2; SB's list 3bb and 100bb (his all-in). Which code is
  // the all-in, and what pot / chips on the table does the node after the raise to 3 report?
  const b: any = huBody({ SB: 0.5, BB: 1 }, 2, (p) => (p === "SB" ? { bet: ["3bb", "100bb"] } : {}));
  console.log(`\n== POTANTE pot 2, blinds 0.5/1, stacks 100`);
  const sol = await solve(b);
  const root = sol ? await node(sol, "") : null;
  show("root", root, ["AA"]);
  if (sol && root) {
    const r3 = root.action_solutions.find((a: any) => /^R3(\.0+)?$/.test(a.action.code))?.action.code ?? "R3";
    const n = await node(sol, r3);
    show(`'${r3}'`, n, ["AA"]);
    console.log(`   raw game: ${JSON.stringify(n?.game ?? null).slice(0, 900)}`);
    console.log(`   root actions raw: ${JSON.stringify(root.action_solutions.map((a: any) => a.action))}`);
  }
}

if (want.includes("levels")) {
  // WHAT A SMALL POST IS WORTH (posts 0.25/0.25 offered the SB fold/call, and the call put him at 1, not 0.25):
  //   P1 SB 0.01 / BB 0.5 — after SB raises "4x", what is on the BB's chips?
  //   P2 SB 0.42 / BB 0.01 — does the SB (more in) get a check?
  //   P3 SB 1 / BB 0.01 — and with a full blind in?
  for (const [label, blinds] of [["P1 0.01/0.5", { SB: 0.01, BB: 0.5 }], ["P2 0.42/0.01", { SB: 0.42, BB: 0.01 }], ["P3 1/0.01", { SB: 1, BB: 0.01 }]] as const) {
    console.log(`\n== LEVELS ${label}, pot 1.5, stacks 100`);
    const sol = await solve(huBody(blinds, 1.5, () => ({ bet: ["4x", "999bb"], raise: ["3x", "999bb"] })));
    const root = sol ? await node(sol, "") : null;
    if (!root) continue;
    console.log(`   root ${root.game?.players?.find((p: any) => p.is_hero)?.position}: ${JSON.stringify(root.action_solutions.map((a: any) => [a.action.code, a.action.betsize, a.action.allin]))} · ${JSON.stringify(root.game?.players?.map((p: any) => [p.position, p.chips_on_table, p.current_stack]))}`);
    const next = root.action_solutions.find((a: any) => /^[XC]$/.test(a.action.code))?.action.code;
    const r = root.action_solutions.find((a: any) => /^R/.test(a.action.code) && !a.action.allin)?.action.code;
    for (const l of [next, r].filter(Boolean)) {
      const n = await node(sol!, l);
      console.log(`   '${l}' ${n?.game?.players?.find((p: any) => p.is_hero)?.position}: ${JSON.stringify(n?.action_solutions?.map((a: any) => [a.action.code, a.action.betsize]))} · ${JSON.stringify(n?.game?.players?.map((p: any) => [p.position, p.chips_on_table, p.current_stack]))}`);
    }
  }
}

if (want.includes("rakecap")) {
  // IS `rake.cap_in_chips` IN THE INPUT'S UNITS OR IN THE LARGER BLIND'S? A: blinds 0.5/2, stacks 100, cap 0.5.
  // C: the same game halved (0.25/1, 50, cap 0.25) — identical to A if the cap is in input chips.
  // D: halved blinds and stacks but cap 0.5 — identical to A if the cap is counted in the larger blind.
  const mk = (sb: number, bb: number, stack: number, cap: number) => {
    const b: any = huBody({ SB: sb, BB: bb }, 0, () => ({ bet: ["2.5x", "250bb"], raise: ["3x", "250bb"], second: ["2.2x", "250bb"], third: ["250bb"] }));
    b.players = b.players.map((p: any) => ({ ...p, stack }));
    b.rake = { pct_of_pot: 5, cap_in_chips: cap, preflop_rake_type: "no_flop_no_drop" };
    return b;
  };
  const roots: Record<string, any> = {};
  for (const [label, b] of [["A 0.5/2 x100 cap0.5", mk(0.5, 2, 100, 0.5)], ["C 0.25/1 x50 cap0.25", mk(0.25, 1, 50, 0.25)], ["D 0.25/1 x50 cap0.5", mk(0.25, 1, 50, 0.5)]] as const) {
    console.log(`\n== RAKECAP ${label}`);
    const sol = await solve(b);
    roots[label[0]] = sol ? await node(sol, "") : null;
    show("root", roots[label[0]], ["AA", "K5o", "T9s", "J4s", "Q2o"]);
  }
  const vec = (n: any) => (n?.action_solutions ?? []).flatMap((a: any) => a.strategy as number[]);
  const diff = (x: any, y: any) => { const a = vec(x), b = vec(y); if (!a.length || a.length !== b.length) return NaN; let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!)); return d; };
  console.log(`   max |strategy difference| A vs C (cap in input chips): ${diff(roots.A, roots.C).toFixed(4)} · A vs D (cap in the larger blind): ${diff(roots.A, roots.D).toFixed(4)}`);
}

if (on("prev")) {
  const sol = await solve(huBody({ SB: 0.5, BB: 1 }, 0, () => ({})));
  const root = sol ? await node(sol, "") : null;
  if (sol && root) {
    const open: string = root.action_solutions.find((a: any) => a.action.type === "RAISE" && !a.action.allin)?.action.code;
    const n1 = await node(sol, open);
    const three: string = n1?.action_solutions.find((a: any) => a.action.type === "RAISE" && !a.action.allin)?.action.code;
    const at = `${open}-${three}`;
    const n2 = await node(sol, at);
    console.log(`\n== PREV plain`);
    show("root (SB)", root); show(`'${open}' (BB)`, n1); show(`'${at}' (SB)`, n2);
    if (n2) {
      for (const type of ["street_all", "last_node", "street_current_player"]) {
        const child = await lock(sol, at, n2, (code, cls) => (cls === "AA" ? (code === "C" ? 1 : 0) : code === "F" ? 1 : 0), type, `SB facing the 3-bet folds all but AA (AA calls)`);
        if (!child) continue;
        show("root (SB)", await node(child, ""));
        show(`'${open}' (BB)`, await node(child, open));
      }
    }
  }
}
console.log(`\nrequests this run: ${sent}`);
process.exit(0);
