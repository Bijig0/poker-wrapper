/**
 * THE LAST RESORT AGAINST EXACT ANSWERS (2026-10-04). The preflop last resort answers lines no tree holds, so it has no
 * truth of its own. This takes decisions the exact GTO Wizard AI tree DID answer live (hero facing a raise), pretends it
 * had failed, and reads two last resorts beside the exact node:
 *   old      hero vs the last aggressor on a heads-up tree, everyone else's chips as `pot` (until 2026-10-04)
 *   plain    the same tree with no dead money (today's last resort)
 * (A third was tried here first — the last raise as a forced bet with the raiser's range given to the tree. GTO Wizard
 * ignores `range` on a preflop tree, scripts/_probeForcedDecision.ts, so it read hero against any two cards: on the
 * first five decisions it differed from the exact tree on 53% of hero's range and cost 0.21 bb/hand, against 32-37%
 * and 0.12-0.15 for the two heads-up trees. It was taken out.)
 * Per decision, over hero's whole range at the exact node (weighted by it): the share of it whose top action differs
 * from the exact tree's, and what playing the variant's mix costs against the exact tree's own EVs (bb per hand, less
 * what the exact mix itself gives up). Hero's dealt hand is reported too.
 *
 * RESULT (2026-10-04, 45 decisions of 2026-10-03/04, both trees answered all 45):
 *                                              top action differs      costs, bb/hand        hero's dealt hand
 *   all 45                          old            41.7%                  0.399             21/45 differ, 0.295 bb
 *                                   plain          29.1%                  0.211             15/45 differ, 0.128 bb
 *   a live player folded out (16)   old            52.4%                  0.598
 *                                   plain          27.4%                  0.196
 *   only folded chips dead (21)     old            38.6%                  0.377
 *                                   plain          30.5%                  0.278
 *   2bb or more dead (14)           old            52.1%                  0.962
 *                                   plain          26.9%                  0.446
 *   no dead money (8, same tree)    both           28.6%                  0.062   <- the heads-up re-seating alone
 * The plain tree was never the worse of the two by more than 0.001 bb on any decision. It is still rough.
 *
 * THE LOCKED TREE (2026-10-04, gtowAiPreflop.solveLockedLastResort): hero against the last raise, the raise an action
 * NODE-LOCKED to the raiser's range on the exact tree; `locked` prices hero with the folded players' chips and a blind
 * still to act as dead money, `lockednd` with none. 45 decisions of 2026-10-03/04 (the newest), 43 answered by all three
 * (two min-raises the even-post tree cannot list fell to the plain tree):
 *                                              top action differs      costs, bb/hand        hero's dealt hand
 *   all 43                          plain          30.2%                  0.220             15/43 differ, 0.134 bb
 *                                   locked          7.4%                  0.026              6/43 differ, 0.101 bb
 *                                   lockednd        9.0%                  0.023              8/43 differ, 0.110 bb
 *   a live player folded out (15)   plain 29.0% / 0.209 · locked 2.8% / 0.006 · lockednd 3.1% / 0.007
 *   only folded chips dead (20)     plain 31.8% / 0.292 · locked 9.7% / 0.048 · lockednd 13.0% / 0.043
 *   2bb or more dead (13)           plain 28.6% / 0.480 · locked 6.6% / 0.074 · lockednd 7.3% / 0.066
 *   no dead money (8, same tree)    plain 28.6% / 0.062 · locked 10.2% / 0.007
 * Worst locked decision: a 5-bet pot (QhTh calls 86% where the exact tree folds, 0.716 bb/hand) — hero's own range is
 * every hand on the locked tree. CAVEAT: here the raiser's range is read on an exact tree that held the whole line; in a
 * real last resort it is read on a line fitted for him, so the locked tree's real error is larger than this.
 * Fresh locked solves: median 4.1 s, p90 5.8 s, worst 11 s (the first, exact-tree reads included).
 * --fit-only (the raiser read on a line fitted for him, as a real last resort meets it), 12 decisions: 11 could not be
 * read that way at all (their lines need no fit — lastRaiseReads' fitOnly then has nothing to read) and the locked tree
 * refused (the plain tree answers); the one it read: 8.6% / 0.036 bb (plain 83.5% / 0.454). How often a real last
 * resort can read its raiser is not measured.
 *
 *   . config/env.ps1; bun run src/scripts/lastResortStudy.ts [--since 2026-10-03] [--max 40] [--hands id,id] [--out file.json]
 *     [--variants plain,locked,lockednd]   (the default; "old" is the retired dead-money tree)
 *
 * It SOLVES on the live GTO Wizard accounts (a heads-up tree a variant per decision, a locked one is ~6-8 requests;
 * the exact nodes come from the solve cache) and stops when the hour's request count passes --budget (default 1200). NOT while a session is live.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
import { truncateAt, withStartStacks } from "../utils/archivedHand/archivedHand";
import { dealtCount } from "../utils/dealtSeats/dealtSeats";
import { allInCalls } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { fetchNode, lockedSeams, reduceToHeadsUp, solvePreflopGtowAi, solveLockedLastResort, type AiPreflopOutcome } from "../services/gtowAiPreflop";
import { comboIndex } from "../utils/comboIndex/comboIndex";

const argv = process.argv.slice(2);
const arg = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] ?? "" : null; };
const SINCE = arg("since") ?? "2026-10-03";
const MAX = Number(arg("max") ?? 40);
const BUDGET = Number(arg("budget") ?? 1200);
const ONLY = arg("hands")?.split(",").filter(Boolean) ?? null;
const OUT = arg("out");
// --fit-only: the locked tree reads the raiser on a line FITTED for him, as a real last resort meets it (the exact tree
// cannot hold the line there); without it the exact tree's own walk is used where it holds — an easier case
if (argv.includes("--fit-only")) lockedSeams.fitOnly = true;
const DATA = (process.env.POKER_DATA_DIR ?? "C:/Users/Brady/poker-data").replace(/\\/g, "/");
const db = new Database(`${DATA}/poker.sqlite`, { readonly: true });
const live = () => (db.query("select id from sessions where ended_at is null").all() as any[]).length > 0;
const lastHour = () => (db.query("select count(*) n from gtow_requests where ts > ?").get(Date.now() - 3600_000) as { n: number }).n;
if (live()) { console.log("a session is LIVE — not running"); process.exit(2); }

const ids: string[] = ONLY ?? (db.query(
  `select distinct client_hand_id h from answers where street = 'preflop' and source = 'gtow-ai-preflop' and ts > ?
   and text not like '%LAST RESORT%' and coalesce(warning, '') not like '%LAST RESORT%' and coalesce(warning, '') not like '%LINE FITTED%' order by ts desc`,
).all(new Date(`${SINCE}T00:00:00`).getTime()) as { h: string }[]).map((r) => r.h);
console.log(`${ids.length} hands with a GTO Wizard AI preflop answer since ${SINCE}; requests in the last hour: ${lastHour()} (budget ${BUDGET})`);

type Group = [number, number, number];   // fold, call (or check), raise (any size, the all-in included)
const groupOf = (sols: any[], i: number): Group | null => {
  let f = 0, c = 0, r = 0;
  for (const a of sols) {
    const code = String(a?.action?.code ?? ""), v = Number(a?.strategy?.[i] ?? 0);
    if (/^F/i.test(code)) f += v; else if (/^[CX]/i.test(code)) c += v; else r += v;
  }
  const t = f + c + r;
  return t > 0.5 ? [f / t, c / t, r / t] : null;
};
/** the exact node's EV of each group for a combo: fold, call, the best raise (the call's when no raise is offered) */
const evOf = (sols: any[], i: number): Group => {
  let f = 0, c = -Infinity, r = -Infinity;
  for (const a of sols) {
    const code = String(a?.action?.code ?? ""), v = Number(a?.evs?.[i] ?? 0);
    if (/^F/i.test(code)) f = v; else if (/^[CX]/i.test(code)) c = Math.max(c, v); else r = Math.max(r, v);
  }
  if (!Number.isFinite(c)) c = f;
  if (!Number.isFinite(r)) r = c;
  return [f, c, r];
};
const top = (g: Group) => (g[0] >= g[1] && g[0] >= g[2] ? 0 : g[1] >= g[2] ? 1 : 2);
const NAMES = ["Fold", "Call", "Raise"];
const fmt = (g: Group | null) => (g ? g.map((x, k) => `${NAMES[k]![0]}${Math.round(x * 100)}`).join("/") : "—");

interface Row { hand: string; line: string; heroPos: string; cards: string; raiser: string; deadBb: number; live: string; n: number;
  exact: { mine: Group; rangeCombos: number };
  variants: Record<string, { ok: boolean; why?: string; mine?: Group | null; flip?: number; loss?: number; mineLoss?: number; mineFlip?: boolean; secs?: number }> }
const rows: Row[] = [];
const ALL_VARIANTS = ["old", "plain", "locked", "lockednd"] as const;
type Variant = (typeof ALL_VARIANTS)[number];
// --variants plain,locked,lockednd (the default): "old" is the dead-money heads-up tree retired 2026-10-04
const VARIANTS: readonly Variant[] = arg("variants")?.split(",").filter((v): v is Variant => (ALL_VARIANTS as readonly string[]).includes(v)) ?? ["plain", "locked", "lockednd"];

let done = 0;
for (const id of ids) {
  if (done >= MAX) break;
  if (live()) { console.log("a session went LIVE — stopping"); break; }
  if (lastHour() > BUDGET) { console.log(`request budget reached (${lastHour()} in the last hour) — stopping`); break; }
  const row = db.query("select data from hands where client_hand_id = ? order by rowid desc limit 1").get(id) as { data: string } | null;
  if (!row) continue;
  let hand: any;
  try { hand = normalizeHand(JSON.parse(row.data)).hand; } catch { continue; }
  const heroPos: string | null = hand.positions?.[hand.heroSeatId] ?? null;
  if (hand.heroCards?.length !== 2) continue;
  const idx = comboIndex(hand.heroCards[0], hand.heroCards[1]);
  const decisions = hand.actions.map((a: any, i: number) => ({ a, i })).filter(({ a }: any) => a.hero && a.street === "preflop" && !/^post/.test(a.type)).map((x: any) => x.i as number);
  for (const n of decisions) {
    if (done >= MAX) break;
    const cut = withStartStacks(truncateAt(hand, n));
    const t = { ...cut, currentNode: { ...cut.currentNode, toActIsHero: true } } as any;
    // hero facing a villain's raise, and a heads-up reduction of it
    const calls = allInCalls(t.actions);
    if (!t.actions.some((a: any) => a.street === "preflop" && !a.hero && (a.type === "raise" || a.type === "bet" || (a.type === "all-in" && !calls.has(a))))) continue;
    const red = reduceToHeadsUp(t, heroPos);
    if (!red) continue;
    // the players the reduction folds out who are still in the hand by choice (a caller, a limper): live ranges
    const posOf = (a: any) => String(t.positions?.[a.hero ? t.heroSeatId : a.seatId] ?? "").toUpperCase();
    const pre = t.actions.filter((a: any) => a.street === "preflop");
    const foldedPos = new Set(pre.filter((a: any) => a.type === "fold").map(posOf));
    const livePos = [...new Set(pre.filter((a: any) => /^(call|raise|bet|all-in)$/.test(a.type)).map(posOf))].filter((p) => red.droppedPos.includes(p as string) && !foldedPos.has(p));
    // THE TRUTH: the exact tree's own node — only a plain walk of it (no fitted line), read without waiting on a solve
    const exact = await solvePreflopGtowAi(t, heroPos, "study", { skipPin: () => true });
    if (!exact.ok || exact.fits?.length) continue;
    const en = await fetchNode(exact.solId, exact.usedLine);
    if ("error" in en) continue;
    const esols: any[] = en.data?.action_solutions ?? [];
    const hero = (en.data?.players_info ?? []).find((p: any) => p?.player?.is_hero) ?? null;
    const range: number[] = hero?.range ?? new Array(1326).fill(1);
    const eMine = groupOf(esols, idx);
    if (!eMine || !esols.every((a) => Array.isArray(a.evs))) continue;
    const combos = range.reduce((x, w) => x + (w > 0 ? w : 0), 0);
    const r: Row = { hand: id, line: exact.line, heroPos: red.heroPos, cards: hand.heroCards.join(""), raiser: red.aggressorPos, deadBb: Math.round(red.deadBb * 100) / 100,
      live: livePos.join("/"), n: exact.shape.n, exact: { mine: eMine, rangeCombos: Math.round(combos) }, variants: {} };
    const dealt = dealtCount(t, heroPos);
    const headsUp = (deadBb: number): Promise<AiPreflopOutcome> =>
      solvePreflopGtowAi(red.hand, red.hand.positions[red.hand.heroSeatId] ?? null, "study", { deadBb, rakeSeats: dealt, skipPin: () => true });
    const run: Record<Variant, () => Promise<AiPreflopOutcome>> = {
      old: () => headsUp(red.deadBb), plain: () => headsUp(0),
      // THE LOCKED TREE (2026-10-04): the raiser's raise locked to his range on the exact tree; with the folded
      // players' chips and the blinds still to act as dead money ("locked"), and with none ("lockednd")
      locked: () => solveLockedLastResort(t, heroPos, "study", { dead: true }),
      lockednd: () => solveLockedLastResort(t, heroPos, "study", { dead: false }),
    };
    for (const v of VARIANTS) {
      const t0 = Date.now();
      let out: AiPreflopOutcome;
      try { out = await run[v](); } catch (e) { out = { ok: false, reason: `threw ${(e as Error).message}` }; }
      if (!out.ok) { r.variants[v] = { ok: false, why: out.reason.slice(0, 160) }; continue; }
      const vn = await fetchNode(out.solId, out.usedLine);
      if ("error" in vn) { r.variants[v] = { ok: false, why: `node: ${vn.error.slice(0, 120)}` }; continue; }
      const vsols: any[] = vn.data?.action_solutions ?? [];
      let w = 0, flip = 0, loss = 0;
      for (let i = 0; i < 1326; i++) {
        const wi = range[i] ?? 0;
        if (!(wi > 0)) continue;
        const ge = groupOf(esols, i), gv = groupOf(vsols, i);
        if (!ge || !gv) continue;
        const ev = evOf(esols, i);
        const val = (g: Group) => g[0] * ev[0] + g[1] * ev[1] + g[2] * ev[2];
        w += wi;
        if (top(ge) !== top(gv)) flip += wi;
        loss += wi * (val(ge) - val(gv));
      }
      const vMine = groupOf(vsols, idx);
      const ev = evOf(esols, idx);
      const val = (g: Group) => g[0] * ev[0] + g[1] * ev[1] + g[2] * ev[2];
      r.variants[v] = { ok: true, mine: vMine, flip: w ? flip / w : 0, loss: w ? loss / w : 0,
        mineLoss: vMine ? val(eMine) - val(vMine) : undefined, mineFlip: vMine ? top(vMine) !== top(eMine) : undefined, secs: (Date.now() - t0) / 1000 };
    }
    rows.push(r);
    done++;
    console.log(`${String(done).padStart(3)} ${id} ${r.heroPos.padEnd(3)} ${r.cards} vs ${r.raiser} '${r.line}' ${r.deadBb}bb dead${r.live ? ` [live: ${r.live}]` : ""} · exact ${fmt(eMine)} · ` +
      VARIANTS.map((v) => { const x = r.variants[v]!; return x.ok ? `${v} ${fmt(x.mine ?? null)} flip ${(100 * x.flip!).toFixed(0)}% loss ${x.loss!.toFixed(3)}` : `${v} — (${x.why})`; }).join(" · "));
  }
}

// ---- the summary ---------------------------------------------------------------------------------------------------
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const med = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const table = (label: string, sel: (r: Row) => boolean) => {
  const sub = rows.filter(sel);
  // only decisions every variant answered: the same hands under each
  const all = sub.filter((r) => VARIANTS.every((v) => r.variants[v]?.ok));
  console.log(`\n== ${label}: ${sub.length} decisions, ${all.length} answered by every variant (${VARIANTS.join(", ")})`);
  for (const v of VARIANTS) {
    const xs = all.map((r) => r.variants[v]!);
    const answered = sub.filter((r) => r.variants[v]?.ok).length;
    console.log(`   ${v.padEnd(8)} answered ${answered}/${sub.length} · over hero's range: top action differs ${(100 * mean(xs.map((x) => x.flip!))).toFixed(1)}% (median ${(100 * med(xs.map((x) => x.flip!))).toFixed(1)}%), ` +
      `costs ${mean(xs.map((x) => x.loss!)).toFixed(3)} bb/hand (median ${med(xs.map((x) => x.loss!)).toFixed(3)}, worst ${Math.max(...xs.map((x) => x.loss!)).toFixed(3)}) · ` +
      `hero's dealt hand: top action differs ${xs.filter((x) => x.mineFlip).length}/${xs.length}, costs ${mean(xs.map((x) => x.mineLoss ?? 0)).toFixed(3)} bb`);
  }
};
table("ALL", () => true);
table("a live player folded out (his chips were the dead money)", (r) => !!r.live);
table("only folded players' chips dead", (r) => !r.live && r.deadBb > 0);
table("2bb or more dead", (r) => r.deadBb >= 2);
table("no dead money at all (the two trees are the same)", (r) => !(r.deadBb > 0));
console.log(`\nrequests in the last hour now: ${lastHour()}`);
if (OUT) { writeFileSync(OUT, JSON.stringify({ since: SINCE, rows }, null, 1)); console.log(`wrote ${OUT}`); }
process.exit(0);
