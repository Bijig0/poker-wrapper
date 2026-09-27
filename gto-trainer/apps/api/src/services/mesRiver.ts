/**
 * River (and rare-line turn) MES answers, extracted on demand from the saved
 * LOCKED tree of the solved board.
 *
 * Flop nodes ship in mes_postflop.json and turn nodes in per-board turn files;
 * the river is 49x48 runouts per flop line — far too much to precompute. The
 * trees themselves (~3.5GB each, mes_handoff/trees_refit/) stay on disk and
 * extract.exe walks one exact line (flop actions, turn card, turn actions,
 * river card) and dumps the river subtree. A cold load is ~40-90s, so results
 * are cached on disk per (board, line); a repeated review of the same hand is
 * instant.
 *
 * Only hero's decision is answered; villain nodes are walked for their labels.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pickWeightedAction } from "../utils/pickWeightedAction/pickWeightedAction";
import type { MesActionFreq, MesPostflopHit } from "./mesPostflop";
import { mesRiverCacheDir } from "./storePaths";
import { REPO } from "./repoPaths";

// The locked trees and extract.exe are the chart factory's (poker: analysis/pipeline/limp_study/mes_handoff, the
// Rust compare/ build) and are not shipped: MES_TREE_DIR (';'-separated folders) and MES_EXTRACT_BIN point at them on a
// machine that has them. Without them this lookup answers nothing and the river falls back like any other miss.
const TREE_DIRS = (process.env.MES_TREE_DIR ?? "").split(";").map((d) => d.trim()).filter(Boolean);
const EXTRACT = process.env.MES_EXTRACT_BIN ?? join(REPO, "bin", process.platform === "win32" ? "extract.exe" : "extract");
const CACHE_DIR = mesRiverCacheDir();

export interface RiverArgs {
  family: string; board: string; heroPlayer: number; holesHint?: string[];
  /** full line from the flop root in the solver's labels: flop actions
   *  (incl. the spot prefix), turn card, turn actions, river card */
  line: string[];
  /** observed river tokens so far (X/C/F/R<bb>) — hero to act next */
  riverTokens: string[];
  heroCardsMapped: string[];   // already suit-mapped into the solved board
  potHint?: number;
}

interface XtNode { history: number[]; player: number; actions: string[]; strategy: number[][]; ev: number[][] }
interface XtSubtree { line: string[]; board: string; pot: number; oop_weights: number[]; ip_weights: number[]; nodes: XtNode[] }

function treePath(family: string, board: string): string | null {
  for (const d of TREE_DIRS) {
    const p = join(d, `${family}_${board}.locked.bin`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Cold: spawn extract.exe for one exact line; warm: read the disk cache. */
export async function extractLine(family: string, board: string, line: string[]): Promise<XtSubtree | null> {
  const tree = treePath(family, board);
  if (!tree) return null;
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = createHash("sha1").update(`${family}_${board}|${line.join(",")}`).digest("hex").slice(0, 16);
  const cached = join(CACHE_DIR, `${family}_${board}.${key}.json`);
  if (existsSync(cached)) {
    try { return JSON.parse(readFileSync(cached, "utf-8")) as XtSubtree; } catch { /* fall through */ }
  }
  const spec = join(CACHE_DIR, `${family}_${board}.${key}.spec.json`);
  const out = join(CACHE_DIR, `${family}_${board}.${key}.raw.json`);
  writeFileSync(spec, JSON.stringify({ tree, lines: [line], out }));
  const proc = Bun.spawn([EXTRACT, spec], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 240_000);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0 || !existsSync(out)) return null;
  const raw = JSON.parse(readFileSync(out, "utf-8"));
  const st = raw.subtrees?.[0] as XtSubtree | undefined;
  if (!st) return null;
  writeFileSync(cached, JSON.stringify(st));
  return st;
}

const AMT = /\((\d+(?:\.\d+)?)\)/;
const amountOf = (label: string): number | null => { const m = label.match(AMT); return m ? parseFloat(m[1]!) : null; };
function resolveToken(tok: string, acts: string[]): { idx: number; snapped: boolean } | null {
  const byPrefix = (p: string) => acts.findIndex((a) => a.startsWith(p));
  if (tok === "X") { const i = byPrefix("Check"); return i >= 0 ? { idx: i, snapped: false } : null; }
  if (tok === "F") { const i = byPrefix("Fold"); return i >= 0 ? { idx: i, snapped: false } : null; }
  if (tok === "C") { const i = byPrefix("Call"); return i >= 0 ? { idx: i, snapped: false } : null; }
  const sized = acts.map((a, i) => ({ i, amt: amountOf(a) })).filter((x) => x.amt != null && /^(Bet|Raise|AllIn)/.test(acts[x.i]!)) as { i: number; amt: number }[];
  if (!sized.length) return null;
  if (tok === "RAI") { const ai = acts.findIndex((a) => a.startsWith("AllIn")); return { idx: ai >= 0 ? ai : sized[sized.length - 1]!.i, snapped: ai < 0 }; }
  const m = tok.match(/^R([\d.]+)$/);
  if (!m) return null;
  const chips = parseFloat(m[1]!) * 100;
  let best = sized[0]!, bd = Infinity;
  for (const s of sized) { const d = Math.abs(Math.log(s.amt / chips)); if (d < bd) { bd = d; best = s; } }
  return { idx: best.i, snapped: bd > 0.05 };
}

export async function mesRiverLookup(a: RiverArgs): Promise<MesPostflopHit | null> {
  const st = await extractLine(a.family, a.board, a.line);
  if (!st) return null;
  const byH = new Map(st.nodes.map((n) => [n.history.join(","), n]));
  let h: number[] = [], pot = st.pot, snapped = false;
  const committed: Record<number, number> = { 0: 0, 1: 0 };
  for (const tok of a.riverTokens) {
    const n = byH.get(h.join(","));
    if (!n) return null;
    const r = resolveToken(tok, n.actions);
    if (!r) return null;
    snapped ||= r.snapped;
    const label = n.actions[r.idx]!;
    const amt = amountOf(label);
    if (amt != null) { pot += amt - committed[n.player]!; committed[n.player] = amt; }
    else if (label.startsWith("Call")) { const to = Math.max(committed[0]!, committed[1]!); pot += to - committed[n.player]!; committed[n.player] = to; }
    h = [...h, r.idx];
  }
  const node = byH.get(h.join(","));
  if (!node || node.player !== a.heroPlayer) return null;
  // combo index: the extract's weight arrays are in the same hole order as the
  // locked.json holes (the caller passes them as holesHint)
  const holes = a.holesHint ?? [];
  const key = (cs: string[]) => [...cs].sort().join("");
  const holeIdx = new Map(holes.map((hs, i) => [key([hs.slice(0, 2), hs.slice(2, 4)]), i]));
  const idx = holeIdx.get(key(a.heroCardsMapped));
  const w = a.heroPlayer === 0 ? st.oop_weights : st.ip_weights;
  const inRange = idx != null && (w[idx] ?? 0) > 0;
  const ci = idx ?? -1;
  const actions: MesActionFreq[] = idx == null ? [] : node.actions.map((lab, ai) => {
    const amt = amountOf(lab); const bb = amt != null ? amt / 100 : null;
    const pct = amt != null && pot > 0 ? Math.round((amt / pot) * 100) : null;
    return { action: bb != null ? `${lab.replace(/\(.*/, "")} ${+bb.toFixed(2)}bb` : lab.replace(/\(.*/, ""),
      frequency: (node.strategy[ai]?.[ci] ?? 0) * 100,
      ev: node.ev[ai]?.[ci] != null ? +(node.ev[ai]![ci]! / 100).toFixed(2) : undefined,
      ...(pct != null ? { betsize: `${pct}% pot` } : {}) };
  });
  return {
    family: a.family, board: a.board, actualBoard: st.board.slice(0, 6), exact: true,
    evGainBb: NaN, notInRange: !inRange, actions, gtoActions: [],
    exploitDecision: inRange && actions.length ? pickWeightedAction(actions) : null,
    chartDecision: null,
    tag: `${a.family} @ ${a.board} river (extracted on demand from the locked tree)`,
    warning: [snapped ? "An observed bet size was snapped to the solved tree's nearest size." : null,
      "River answer extracted on demand from the same locked tree (MES continuation); no GTO pair on this street."].filter(Boolean).join(" "),
  };
}
