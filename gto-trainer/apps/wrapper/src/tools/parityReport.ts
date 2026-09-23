/**
 * Geometric parity: recorded client DOM vs the replica's measured constants (port of tests/parity_report.py,
 * 2026-09-24).
 *
 *   bun run src/tools/parityReport.ts [session_dir]          (default: the newest debug/session_*)
 *
 * Reads a debug session's dom.jsonl (the raw table-JS output captured off the real client) and checks the geometry
 * the fake table renders from — card sizes, pitches, aspect ratios, board layout — against what the client drew.
 * dom.jsonl coordinates are viewport pixels and the client's CSS zoom computes to 1, so nothing external gives the
 * du scale: it is SELF-CALIBRATED from the hero hole cards (36du wide), and every other measurement is converted
 * through it. A wrong calibration cannot silently pass: independent elements would all disagree together.
 *
 * Replica constants duplicated from gto-trainer .../components/table/types.ts; if that changes, change EXPECTED.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { paths } from "../env";
import { fmtFixed, fmtG, pyRepr, pyStr } from "../py";

const EXPECTED = {
  hero_card_w: 36.0,          // PARTS.holeCard.w
  hero_pitch: 39.0,           // PARTS.holeCard.pitch
  villain_card_w: 30.0,       // PARTS.villainCard.w
  board_card_w: 51.0,         // PARTS.boardCard.w
  board_pitch: 61.0,          // PARTS.boardCard.pitch
  card_aspect: 150 / 100,     // h/w — every real card SVG is 100x150
  board_slots: 5,
  placeholder_aspect: 199 / 134,   // empty board slots use a 134:199 graphic
};
const TOL = 0.03;   // 3% — generous for rounding to whole px at ~1.17 scale

type Card = { qa?: string; x: number; y: number; w: number; h: number };

function decode(qa: string): number | null {
  return qa.startsWith("card") && /^\d+$/.test(qa.slice(4).replace(/^-+/, "")) ? Number(qa.slice(4)) : null;
}
const realId = (qa: string) => qa.startsWith("card") && /^\d+$/.test(qa.slice(4));

/** statistics.median: the middle value, or the mean of the two middle values. */
function med(vals: number[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const pairs = (xs: number[]) => xs.slice(1).map((b, i) => b - xs[i]!);

/**
 * Bucket every card element in every tick. `cards` (top-left boxes with w+h) is the mid-band board filter; anything
 * in `allCards` (CENTRES, width only) with a real id that is NOT at a board position is a hole card.
 */
function classify(dom: any[]) {
  const out = { placeholder: [] as Card[], board: [] as Card[], hole: [] as Card[], board_stride: [] as number[], five_slot_ticks: [] as number[][] };
  for (const d of dom) {
    const cards: Card[] = d.cards || [];
    const boardCtr = cards.map((c) => [c.x + c.w / 2, c.y + c.h / 2] as const);
    for (const c of cards) {
      const cid = decode(c.qa || "");
      if (c.qa === "card-placeholder") out.placeholder.push(c);
      else if (cid !== null && cid >= 0 && cid <= 51) out.board.push(c);
    }
    for (const c of (d.allCards || []) as Card[]) {
      const cid = decode(c.qa || "");
      if (cid === null || !(cid >= 0 && cid <= 51)) continue;
      if (boardCtr.some(([bx, by]) => Math.abs(c.x - bx) < 6 && Math.abs(c.y - by) < 6)) continue;
      out.hole.push(c);
    }
    // slot x-positions from the PLACEHOLDER rack only (real cards animate; the hidden layer is a second row)
    const xs = [...new Set(cards.filter((c) => c.qa === "card-placeholder").map((c) => c.x))].sort((a, b) => a - b);
    out.board_stride.push(...pairs(xs).filter((dl) => dl >= 20 && dl <= 150));
    if (xs.length === 5) out.five_slot_ticks.push(xs);
  }
  return out;
}

class Report {
  rows: [string, string, string, boolean | null][] = [];
  add(name: string, measured: string, expected: string, ok: boolean | null) {
    this.rows.push([name, measured, expected, ok]);
  }
  check(name: string, measured: number | null, expected: number) {
    if (measured === null) return this.add(name, "—", fmtG(expected), null);
    this.add(name, fmtFixed(measured, 3), fmtG(expected), Math.abs(measured - expected) / expected <= TOL);
  }
  dump(): number {
    const w = Math.max(...this.rows.map((r) => r[0].length)) + 2;
    let fails = 0;
    for (const [name, m, e, ok] of this.rows) {
      const mark = ok === null ? "  " : ok ? "OK" : "FAIL";
      if (ok === false) fails++;
      console.log(`  ${name.padEnd(w)} measured ${m.padStart(10)}   expected ${e.padStart(8)}   ${mark}`);
    }
    return fails;
  }
}

function main(argv: string[]): number {
  const debug = paths().debug;
  const S = argv[0] ? resolve(argv[0]) : join(debug, readdirSync(debug).filter((f) => f.startsWith("session_")).sort().pop()!);
  const domPath = join(S, "dom.jsonl");
  if (!existsSync(domPath)) {
    console.log(`no dom.jsonl in ${S}`);
    return 2;
  }
  const dom = readFileSync(domPath, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  console.log(`session ${basename(S)}: ${dom.length} ticks`);
  const cards = classify(dom);

  // WIDTH CLUSTERS, anchor-free: exactly three real-card sizes with fixed ratios (villain 30du : hero 36du : board
  // 51du). Take the modes and let the ratios say which is which; villain and board agreeing through the hero scale
  // is itself the parity evidence. Every card-shaped element counts (villain backs are the only villain samples in a
  // no-showdown session); only card-1 (the hidden layer) and the placeholder rack stay out.
  const hist = new Map<number, number>();
  for (const d of dom) for (const c of (d.allCards || []) as Card[]) if (realId(c.qa || "")) hist.set(c.w, (hist.get(c.w) ?? 0) + 1);
  const top = Math.max(...hist.values());
  const modes = [...hist].filter(([, n]) => n >= top * 0.05).map(([w]) => w).sort((a, b) => a - b);
  const merged: number[] = [];                    // merge ±1px rounding neighbours into their heavier mode
  for (const w of modes) {
    if (merged.length && w - merged[merged.length - 1]! <= 1) {
      if (hist.get(w)! > hist.get(merged[merged.length - 1]!)!) merged[merged.length - 1] = w;
    } else merged.push(w);
  }
  if (merged.length < 2) {
    console.log(`not enough width clusters to calibrate (got ${pyRepr(merged)})`);
    return 2;
  }
  const [villainW, heroW] = merged.length === 2 ? [merged[0]!, merged[1]!] : [merged[merged.length - 3]!, merged[merged.length - 2]!];
  const boardW = merged.length >= 3 ? merged[merged.length - 1]! : null;
  const s = heroW / EXPECTED.hero_card_w;
  console.log(`width clusters (px): ${pyRepr(merged)}  ->  villain ${pyStr(villainW)}, hero ${pyStr(heroW)}, board ${pyStr(boardW)}`);
  console.log(`scale s = ${fmtFixed(s, 4)} px/du   (hero cluster, ${hist.get(heroW)} samples; CSS zoom reported ${pyStr(dom[dom.length >> 1].zoom ?? null)})`);
  console.log("");

  const r = new Report();
  r.check("villain card w (du)", villainW / s, EXPECTED.villain_card_w);
  if (boardW !== null) {
    r.check("board card w (du)", boardW / s, EXPECTED.board_card_w);
    const bd = cards.board.filter((c) => Math.abs(c.w - boardW) <= 1);
    if (bd.length) r.check("card aspect h/w (board)", med(bd.map((c) => c.h / c.w)), EXPECTED.card_aspect);
  }
  if (cards.board_stride.length) r.check("board pitch (du)", med(cards.board_stride)! / s, EXPECTED.board_pitch);
  // hero pitch: adjacent hero-width cards in one tick (x values are centres; for equal widths the deltas agree)
  const heroPitch: number[] = [];
  for (const d of dom) {
    const hx = [...new Set(((d.allCards || []) as Card[]).filter((c) => realId(c.qa || "") && Math.abs(c.w - heroW) <= 1).map((c) => c.x))].sort((a, b) => a - b);
    heroPitch.push(...pairs(hx).filter((dl) => dl > 0 && dl < heroW * 2));
  }
  if (heroPitch.length) r.check("hero pitch (du)", med(heroPitch)! / s, EXPECTED.hero_pitch);
  if (cards.placeholder.length) r.check("placeholder aspect h/w", med(cards.placeholder.map((c) => c.h / c.w)), EXPECTED.placeholder_aspect);
  for (const xs of cards.five_slot_ticks.slice(0, 1)) r.add("board slots", String(xs.length), "5", xs.length === 5);
  // board equal spacing: max deviation between strides in a 5-slot tick
  const dev = cards.five_slot_ticks.map((xs) => Math.max(...pairs(xs)) - Math.min(...pairs(xs)));
  if (dev.length) r.add("board slot spacing max jitter (px)", pyStr(Math.max(...dev)), "<= 2", Math.max(...dev) <= 2);

  const fails = r.dump();
  const fr = dom[dom.length >> 1].frame || {};
  if (Object.keys(fr).length) {
    console.log(`\n  frame ${pyStr(fr.w ?? null)}x${pyStr(fr.h ?? null)} px = ${fmtFixed((fr.w ?? 0) / s, 0)}x${fmtFixed((fr.h ?? 0) / s, 0)} du (replica felt: 955x512 du)`);
  }
  console.log(`\n${fails === 0 ? "PARITY HOLDS" : `${fails} DEVIATIONS`} on the self-similar geometry (sizes, pitches, aspects).`);
  return fails ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
