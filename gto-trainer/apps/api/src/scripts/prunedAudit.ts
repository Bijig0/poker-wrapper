/**
 * WHICH SPOTS LEAVE THE CHARTS, AND HOW OFTEN? (2026-09-25, Brady: "I don't know how many other spots there are like
 * this" — hand 4920396764, A9dd, where a 30bb SB's ~0% flat of a button open met a chart node HRC never exported.)
 *
 * Every real Ignition ring hand in the local hand-history corpus is walked through the 6-max chart path the way the
 * live answer path walks it — chartFor6max picks the chart, the SQLite bake supplies the nodes, walkFitted fits the
 * line, and the node-trust guard judges the node — with NO cloud call. Each preflop decision lands in one routing
 * class; every class but `chart` is a spot the live path hands to the GTO Wizard AI tree:
 *
 *   chart            the chart answers
 *   pruned-reach     the walk meets a node HRC left out below its reach threshold (the A9dd class)
 *   pruned-cut       the walk meets a node the solved tree's own caps stop (a line real play reaches)
 *   terminal-other   the walk meets a genuine close and the line goes on (capture noise, not the chart)
 *   starved          the node exists but the solver never trained it (services/nodeTrust)
 *   size-past-tau    the size faced is off the chart's menu past τ
 *   rotation         the chart's node belongs to another seat
 *   walk-miss        any other walk failure (node absent, size > 2x off)
 *   no-chart         no baked chart for the state
 *
 * Hero's FLOPS are then classified the way the preflop pin + range walk treat them (services/preflopPin,
 * reconstructFlopRanges): the chart that answered hero's LAST preflop decision supplies the flop ranges —
 *   ai-pinned                hero's last decision already left the charts, so the AI tree supplies the flop
 *   re-picked                the pinned chart cannot hold the line; the shape pick (recon6max) walks it clean
 *   clean                    the full line walks to a real close
 *   pruned-then-folds        a pruned terminal followed only by folds (reconstructFlopRanges takes it as the flop)
 *   pruned-then-action       a pruned terminal followed by a call/raise: the chart-pinned flop HARD-FAILS
 *   ends-on-pruned           the line ends ON a pruned terminal (walkFitted acceptTerminal would call it the flop)
 *   other                    any other walk failure
 *
 *   bun run src/scripts/prunedAudit.ts [--limit N] [--out file.json]
 *
 * Mirrors the live config TRUST_GUARD_ALL=1 (config/local.env) unless the env says otherwise. borrowHeroCall (the
 * third-caller borrow after a successful walk) is not replayed: it changes which node answers, never whether one does.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chartFor6max, resolveChart6max, type Seat6 } from "../services/hrc6max";
import { hrc6maxDb } from "../services/hrc6maxDb";
import { nodeTrust } from "../services/nodeTrust";
import type { GetNode, HrcNode } from "../services/hrc3max";
import { walkFitted } from "../utils/fitLine/fitLine";
import { HH_DIR, lineOf, parseFile, type RawHand } from "./sixmaxBacktest";

process.env.TRUST_GUARD_ALL ??= "1";

const arg = (k: string, d?: string) => { const i = Bun.argv.indexOf(k); return i >= 0 ? Bun.argv[i + 1] : d; };
const LIMIT = Number(arg("--limit", "0"));
const OUT = arg("--out", "pruned_audit.json")!;

// ---- nodes: the bake only (an unbaked tree is "no-chart" here, never a :8777 call), memoised per run
const memo = new Map<string, HrcNode | null>();
const nodeOf = (source: string, line: string): HrcNode | null => {
  const key = `${source}|${line}`;
  let n = memo.get(key);
  if (n === undefined) {
    n = hrc6maxDb.covers(source) ? (hrc6maxDb.node(source, line) ?? null) : null;
    if (memo.size > 400_000) memo.clear();
    memo.set(key, n);
  }
  return n;
};
const getter = (id: string): GetNode => async (line) => nodeOf(id, line);

/** walkFitted, reading the HH parser's `RAI` as a CALL wherever the node offers no raise: Ignition writes an all-in
 *  call as "All-in", which sixmaxBacktest.tokenOf cannot tell from a jam — the live feed never has this problem. */
async function walk(tokens: string[], get: GetNode, opts: Parameters<typeof walkFitted>[2]) {
  let line = tokens;
  for (let k = 0; ; k++) {
    const w = await walkFitted(line, get, opts);
    if (w.ok || k >= 4 || !/^all-in not offered \(have: [^)]*\bC\b/.test(w.reason ?? "")) return w;
    const fitted = w.fittedLine ?? line;
    const idx = w.missingAt ? w.missingAt.split("-").length : 0;
    if (fitted[idx] !== "RAI") return w;
    line = fitted.slice(); line[idx] = "C";
  }
}

type DecisionClass = "chart" | "pruned-reach" | "pruned-cut" | "terminal-other" | "starved" | "size-past-tau"
  | "rotation" | "walk-miss" | "no-chart";

interface Classified { cls: DecisionClass; chart: string | null; line: string; detail: string }

async function classifyDecision(line: ReturnType<typeof lineOf>["line"] & object, seatNo: number, seat: Seat6,
                                before: string[]): Promise<Classified> {
  const choice = chartFor6max({ stacks: line.stacks, committed: {}, positions: line.positions, heroSeatId: seatNo } as any,
    seat, before);
  const resolved = await resolveChart6max(choice, async (src, l) => nodeOf(src, l));
  const at = before.join("-");
  if (!resolved || resolved === "unreachable") return { cls: "no-chart", chart: null, line: at, detail: choice.candidates.join(",") };
  const w = await walk(before, getter(resolved.id), { heroSeat: seat, stack: choice.depth });
  if (!w.ok) {
    const r = w.reason ?? "";
    const cls: DecisionClass = r.includes("(pruned:") ? "pruned-reach" : r.includes("(cut:") ? "pruned-cut"
      : r.includes("terminal") ? "terminal-other" : "walk-miss";
    return { cls, chart: resolved.id, line: at, detail: `${r} @ ${w.missingAt ?? "?"}` };
  }
  const nodePos = String(w.node.pos ?? "").toUpperCase();
  if (nodePos && nodePos !== seat) return { cls: "rotation", chart: resolved.id, line: at, detail: `node is ${nodePos}` };
  const far = w.repaired.find((r) => r.far && !r.borrowed);
  if (far) return { cls: "size-past-tau", chart: resolved.id, line: at, detail: `${far.from}->${far.to}` };
  const trust = nodeTrust(resolved.id, w.tokens.join("-"));
  if (trust.starved) {
    return { cls: "starved", chart: resolved.id, line: at,
      detail: `reach ${trust.reach ?? "?"} regret ${trust.regret?.toFixed(3) ?? "?"}` };
  }
  return { cls: "chart", chart: resolved.id, line: at, detail: "" };
}

type FlopClass = "ai-pinned" | "clean" | "re-picked" | "pruned-then-folds" | "pruned-then-action" | "ends-on-pruned" | "other";

async function main() {
  const files: string[] = [];
  for (const acct of readdirSync(HH_DIR)) {
    let names: string[] = [];
    try { names = readdirSync(join(HH_DIR, acct)); } catch { continue; }
    for (const n of names) if (n.endsWith(".txt") && n.includes("RING")) files.push(join(HH_DIR, acct, n));
  }
  files.sort();
  const hands: RawHand[] = [];
  for (const f of files) {
    hands.push(...parseFile(f, f.split("\\").pop()!));
    if (LIMIT && hands.length >= LIMIT) break;
  }
  if (LIMIT) hands.length = Math.min(hands.length, LIMIT);
  console.log(`${files.length} ring files, ${hands.length} hands; bake covers ${hrc6maxDb.size} trees`);

  const all = new Map<DecisionClass, number>(), hero = new Map<DecisionClass, number>();
  const flop = new Map<FlopClass, number>();
  const byStake = new Map<string, { hero: number; heroOff: number; flops: number; flopFail: number }>();
  const examples: Record<string, { hand: string; stake: string; seat: string; chart: string | null; line: string; detail: string }[]> = {};
  const note = (k: string, e: (typeof examples)[string][number]) => { const a = (examples[k] ??= []); if (a.length < 25) a.push(e); };
  const bump = <K,>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
  const skipped = new Map<string, number>();
  let usable = 0, t0 = Date.now();

  for (let hi = 0; hi < hands.length; hi++) {
    const h = hands[hi]!;
    if (hi % 2000 === 0 && hi) console.log(`  ${hi}/${hands.length} hands (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    const got = lineOf(h);
    if (!got.line) { bump(skipped, got.skipped); continue; }
    usable++;
    const L = got.line;
    const heroSeat = L.dealt.find((s) => s.hero);
    const heroPos = heroSeat ? L.map[heroSeat.label]! : null;
    const st = byStake.get(h.stake) ?? { hero: 0, heroOff: 0, flops: 0, flopFail: 0 };
    byStake.set(h.stake, st);

    let heroLast: Classified | null = null;
    let heroLastIdx = -1;
    for (const s of L.dealt) {
      const pos = L.map[s.label]!;
      for (let i = 0; i < L.owner.length; i++) {
        if (L.owner[i] !== pos || !L.real[i]) continue;
        const c = await classifyDecision(L, s.seatNo, pos, L.tokens.slice(0, i));
        bump(all, c.cls);
        if (s.hero) {
          bump(hero, c.cls);
          st.hero++;
          if (c.cls !== "chart") { st.heroOff++; note(`hero:${c.cls}`, { hand: h.id, stake: h.stake, seat: pos, chart: c.chart, line: c.line, detail: c.detail }); }
          heroLast = c; heroLastIdx = i;
        } else if (c.cls !== "chart") {
          note(`seat:${c.cls}`, { hand: h.id, stake: h.stake, seat: pos, chart: c.chart, line: c.line, detail: c.detail });
        }
      }
    }

    // ---- hero's flop, as the pin + range walk would take it
    if (!h.sawFlop || !heroSeat || !heroPos || !heroLast) continue;
    const heroFolded = L.tokens.some((t, i) => t === "F" && L.owner[i] === heroPos);
    if (heroFolded) continue;
    st.flops++;
    let fc: FlopClass;
    let detail = "";
    let chartUsed: string | null = heroLast.chart;
    if (heroLast.cls !== "chart" || !heroLast.chart) {
      fc = "ai-pinned";
    } else {
      const flopWalk = async (chartId: string, depth: number): Promise<{ fc: FlopClass; detail: string }> => {
        const w = await walk(L.tokens, getter(chartId), { heroSeat: heroPos, stack: depth, acceptTerminal: true });
        const r = w.ok ? "" : (w.reason ?? "");
        const missingAt = w.ok ? undefined : w.missingAt;
        const d = `${r || "walk ended on a live decision node"} @ ${missingAt ?? "?"}`;
        const prunedMark = r.includes("(pruned:") || r.includes("(cut:");
        if (w.fitted && !w.ok) return { fc: prunedMark ? "ends-on-pruned" : "clean", detail: d };
        if (!w.ok && prunedMark && r.startsWith("line continues past a terminal")) {
          const at = (missingAt ?? "").split("-").filter(Boolean).length;
          const rest = (w.fittedLine ?? L.tokens).slice(at);
          return { fc: rest.every((t) => t === "F") ? "pruned-then-folds" : "pruned-then-action", detail: d };
        }
        return { fc: "other", detail: d };
      };
      const pinChoice = chartFor6max({ stacks: L.stacks, committed: {}, positions: L.positions, heroSeatId: heroSeat.seatNo } as any,
        heroPos, L.tokens.slice(0, heroLastIdx));
      let res = await flopWalk(heroLast.chart, pinChoice.depth);
      // THE PIN IS UNUSABLE → recon6max picks by the whole line's shape (fastSolve: a pin the capture has outgrown
      // "falls through to the walk below"). Hero SB completing in a raise chart, a limp answered before the line
      // turned limped, …: the shape pick is a limp chart that holds the line.
      if (res.fc === "other" || res.fc === "pruned-then-action") {
        const shape = chartFor6max({ stacks: L.stacks, committed: {}, positions: L.positions, heroSeatId: heroSeat.seatNo } as any,
          heroPos, L.tokens);
        const resolved = await resolveChart6max(shape, async (src, l) => nodeOf(src, l));
        if (resolved && resolved !== "unreachable" && resolved.id !== heroLast.chart) {
          const again = await flopWalk(resolved.id, shape.depth);
          if (again.fc === "clean" || again.fc === "pruned-then-folds") { res = { fc: "re-picked", detail: `pin ${res.detail}` }; chartUsed = resolved.id; }
          else if (res.fc === "other") { res = again; chartUsed = resolved.id; }
        }
      }
      fc = res.fc; detail = res.detail;
      if (fc !== "clean") note(`flop:${fc}`, { hand: h.id, stake: h.stake, seat: heroPos, chart: chartUsed, line: L.tokens.join("-"), detail });
    }
    bump(flop, fc);
    if (fc === "pruned-then-action" || fc === "other") st.flopFail++;
  }

  const show = <K extends string>(title: string, m: Map<K, number>) => {
    const tot = [...m.values()].reduce((a, b) => a + b, 0);
    console.log(`\n=== ${title} (${tot})`);
    for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(20)} ${String(v).padStart(7)}  ${((v / Math.max(1, tot)) * 100).toFixed(2)}%`);
    }
  };
  console.log(`\n${usable} hands inside the set's table shapes (${hands.length - usable} skipped)`);
  show("hero's preflop decisions — routing class", hero);
  show("every seat's preflop decisions — routing class", all);
  show("hero's flops — how the flop ranges are found", flop);
  console.log("\n=== by stake (hero)");
  for (const [k, v] of [...byStake.entries()].sort((a, b) => b[1].hero - a[1].hero)) {
    console.log(`  ${k.padEnd(12)} decisions ${String(v.hero).padStart(6)}  off-chart ${((v.heroOff / Math.max(1, v.hero)) * 100).toFixed(2)}%` +
      `   flops ${String(v.flops).padStart(5)}  hard-fail ${v.flopFail}`);
  }
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), hands: hands.length, usable, trustGuardAll: process.env.TRUST_GUARD_ALL,
    hero: Object.fromEntries(hero), allSeats: Object.fromEntries(all), flops: Object.fromEntries(flop),
    byStake: Object.fromEntries(byStake), skipped: Object.fromEntries(skipped), examples,
  }, null, 1));
  console.log(`\nwrote ${OUT}`);
}

if (import.meta.main) await main();
