/**
 * Backfill the client's award into archived hands from the debug recordings (port of tests/backfill_results.py,
 * 2026-09-24).
 *
 *   bun run src/tools/backfillResults.ts [--dry]
 *
 * The client's result box reads "<< Result for hand N >>" over "Player S wins ($X)" (or "wins main pot ($X) with
 * (…)"). Until 2026-09-19 the feed dropped the winner's name (the two text nodes touch, and the adjacency test wanted
 * a positive gap), so every showdown line archived as a nameless "★ wins …" — which the dashboard read as HERO's win.
 * This walks every recording's dom.jsonl, pairs each result box with its hand id, and writes result.winnerSeat /
 * wonCents / heroWon into hands.db (rows re-encoded exactly as the archive writes them: json.dumps's separators).
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../env";
import { fmtFixed, pyJsonDumps, pyRound } from "../py";

const DEBUG = paths().debug;
const DB = join(paths().data, "hands.db");
const WIN = /^wins\b.*?\(\$([\d,]+(?:\.\d+)?)\)/i;
const ID = /result for hand\s*(\d+)/i;

type Node = { text: string; x: number; y: number; w: number };
type Award = { winnerSeat: number | null; winnerLabel: string | null; wonCents: number; text: string };

function resultsOf(session: string): Map<string, Award> {
  const out = new Map<string, Award>();
  for (const line of readFileSync(join(DEBUG, session, "dom.jsonl"), "utf8").split("\n")) {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const nodes: Node[] = d.nodes || [];
    for (const n of nodes) {
      const m = ID.exec(n.text);
      if (!m) continue;
      const hid = m[1]!;
      // the award line sits on the next row of the same box
      const row = nodes.filter((x) => 12 <= x.y - n.y && x.y - n.y <= 40 && Math.abs(x.x - n.x) < 120);
      const win = row.find((x) => WIN.test(x.text));
      if (!win) continue;
      const cents = Math.trunc(pyRound(Number(WIN.exec(win.text)![1]!.replace(/,/g, "")) * 100));
      // the rule the wrapper uses live (awardName): a wrapped award's text box starts at the row's left edge, so the
      // 'Player N' node sits INSIDE it rather than to its left — prefer the tagged node on the row outright
      const sameRow = row.filter((x) => x !== win && Math.abs(x.y - win.y) <= 8 && x.x <= win.x + 4);
      const tagged = sameRow.filter((x) => /^Player \d+$/.test(x.text.trim()));
      let name: string;
      if (tagged.length) {
        name = tagged.reduce((b, x) => (Math.abs(x.x - win.x) < Math.abs(b.x - win.x) ? x : b)).text.trim();
      } else {
        const near = sameRow.filter((x) => -4 <= win.x - (x.x + x.w) && win.x - (x.x + x.w) < 60);
        name = near.length ? near.reduce((b, x) => (win.x - (x.x + x.w) < win.x - (b.x + b.w) ? x : b)).text.trim() : "";
      }
      const sm = /Player (\d+)/.exec(name);
      const seat = sm ? Number(sm[1]) : null;
      const rec: Award = { winnerSeat: seat, winnerLabel: name || null, wonCents: cents, text: win.text };
      const had = out.get(hid);
      if (!had || (had.winnerSeat === null && seat !== null)) out.set(hid, rec);
    }
  }
  return out;
}

function main(argv: string[]): number {
  const dry = argv.includes("--dry");
  const found = new Map<string, Award>();
  for (const s of readdirSync(DEBUG).sort()) {
    if (s.startsWith("session_") && existsSync(join(DEBUG, s, "dom.jsonl"))) for (const [k, v] of resultsOf(s)) found.set(k, v);
  }
  console.log(`awards read from recordings: ${found.size} hands, ${[...found.values()].filter((r) => r.winnerSeat !== null).length} with a seat`);
  const db = new Database(DB);
  let patched = 0;
  const update = db.prepare("update hands set data = ?, result_text = ? where rowid = ?");
  for (const { rowid, data } of db.query("select rowid, data from hands").all() as { rowid: number; data: string }[]) {
    const h = JSON.parse(data);
    const cid = h.clientHandId;
    const r = cid ? found.get(cid) : undefined;
    if (!r || r.winnerSeat === null) continue;
    const res: Record<string, any> = { ...(h.result || {}) };
    if (res.winnerSeat === r.winnerSeat && res.wonCents === r.wonCents) continue;
    Object.assign(res, { winnerSeat: r.winnerSeat, winnerLabel: r.winnerLabel, wonCents: r.wonCents,
                         heroWon: r.winnerSeat === (h.heroSeatId ?? null), backfilled: "2026-09-19 from the recording" });
    if (String(res.text ?? "").startsWith("★ wins")) res.text = `★ Player ${r.winnerSeat} ` + String(res.text).slice(2);
    h.result = res;
    console.log(`  hand ${cid} rowid ${rowid}: winner seat ${r.winnerSeat} $${fmtFixed(r.wonCents / 100, 2)} → ${res.heroWon ? "HERO won" : "hero lost/out"}`);
    if (!dry) update.run(pyJsonDumps(h), res.text, rowid);
    patched++;
  }
  console.log(`${dry ? "would patch" : "patched"} ${patched} archived hands`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
