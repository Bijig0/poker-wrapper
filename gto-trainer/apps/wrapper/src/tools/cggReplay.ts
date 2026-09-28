/**
 * REPLAY A CLUBGG RECORDING through the screen reader: every frame -> OCR -> cggFrame.parseFrame -> cggFeed, printing
 * the feed lines and a per-hand summary. A recording is a folder of frames + index.jsonl ({ts, hwnd, title, file}),
 * written by the wrapper's ClubGG session recorder (PNG) or poker-data/clubgg/cgg_record.ps1 (JPEG).
 *
 * Each frame's Snapshot is cached in <dir>/snapshots.jsonl, so a change to the REDUCER replays in seconds; pass
 * --reparse after changing the frame parser (or the templates) to rebuild the cache (OCR is ~150 ms a frame).
 *
 * A recording made by screen copy has frames where another window covered the table (the live reader refuses
 * those: sites/clubgg.ts checks the table is on top first). Here they are guessed from what the OCR saw.
 *
 *   bun src/tools/cggReplay.ts <recording dir> [--from N] [--to N] [--reparse] [--quiet] [--json out.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { share } from "../sites/cggCards";
import { exportHand, Room } from "../sites/cggFeed";
import { parseFrame, stakesOf, type Snapshot } from "../sites/cggFrame";
import { decodeImage, recognize, stop } from "../sites/cggOcr";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!dir) {
  console.error("usage: bun src/tools/cggReplay.ts <recording dir> [--from N] [--to N] [--reparse] [--quiet] [--json out.json]");
  process.exit(2);
}
const from = Number(opt("--from") ?? 0), to = Number(opt("--to") ?? 1e9);
const quiet = args.includes("--quiet");
const rows: any[] = readFileSync(join(dir, "index.jsonl"), "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/)
  .map((l) => JSON.parse(l.replace(/^\uFEFF/, "")));
const cachePath = join(dir, "snapshots.jsonl");
type Rec = { snap: Snapshot | null; felt?: [number, number] };
const cache = new Map<number, Rec>();
if (existsSync(cachePath) && !args.includes("--reparse")) {
  for (const l of readFileSync(cachePath, "utf8").split(/\r?\n/)) {
    if (!l.trim()) continue;
    const j = JSON.parse(l);
    cache.set(j.i, { snap: j.snap, felt: j.felt });
  }
}
let dirty = args.includes("--reparse");

/** Felt where the table always shows felt — left of the middle and the right rail — or another window is over it
 *  (the ClubGG lobby list opens over the table's right side). */
function feltOf(f: { width: number; height: number; bgra: Uint8Array }): [number, number] {
  const s = f.width / 1698;
  const green = (c: [number, number, number]) => c[1] > c[0] + 25 && c[1] > c[2] + 15;
  return [share(f, 320 * s, 480 * s, 480 * s, 530 * s, green, 3), share(f, 1440 * s, 700 * s, 1480 * s, 760 * s, green, 2)];
}

/** Another window over the table (the lobby list, a chat): what the OCR saw gives it away. */
export function looksCovered(s: Snapshot): string | null {
  if (s.seats.length < 2) return "fewer than two seats readable";
  const foreign = s.texts.find((t) => /running tables|unlimited|welcome to|withdrawal|^notice|^level \d|direct messages|friends/i.test(t));
  return foreign ? `a foreign window's text ("${foreign}")` : null;
}

const rooms = new Map<string, Room>();
let covered = 0, parsed = 0;
const t0 = performance.now();
for (let i = Math.max(0, from); i < Math.min(rows.length, to + 1); i++) {
  const r = rows[i];
  let rec = cache.get(i);
  if (!rec || !rec.felt) {
    try {
      const f = await decodeImage(join(dir, r.file));
      const felt = feltOf(f);
      let snap = rec ? rec.snap : null;
      // not worth an OCR when another window is over the table
      if (!rec && felt[0] >= 0.5 && felt[1] >= 0.9) {
        const o = await recognize(f);
        snap = parseFrame(f, o.lines, r.ts / 1000);
        parsed++;
      }
      rec = { snap, felt };
    } catch (e: any) {
      console.error(`#${i} ${r.file}: ${e?.message ?? e}`);
      rec = { snap: null, felt: [0, 0] };
    }
    cache.set(i, rec);
    dirty = true;
  }
  const snap = rec.snap;
  if (!snap || rec.felt![0] < 0.5 || rec.felt![1] < 0.9) {
    covered++;
    continue;
  }
  const why = looksCovered(snap);
  if (why) {
    covered++;
    continue;
  }
  const key = String(r.hwnd ?? r.title);
  let room = rooms.get(key);
  if (!room) {
    room = new Room(key, r.title || key);
    room.stakes = stakesOf(r.title || "");
    rooms.set(key, room);
  }
  const lines = room.apply(snap);
  if (!quiet) for (const l of lines) console.log(`#${String(i).padStart(4)} ${l}`);
}
for (const room of rooms.values()) room.finish();
stop();
if (dirty) writeFileSync(cachePath, [...cache].sort((a, b) => a[0] - b[0]).map(([i, v]) => JSON.stringify({ i, ...v })).join("\n") + "\n");

const hands: any[] = [];
for (const room of rooms.values()) {
  for (const h of room.finished) {
    const ph = exportHand(room, { ...h, done: false });
    hands.push({ id: h.id, t0: h.t0, board: h.board, bomb: h.bomb, joinedLate: h.joinedLate, actions: h.actions.length,
                 inferred: h.actions.filter((a) => a.inferred).length, uncertain: h.uncertain, winners: h.winners,
                 pot: ph?.currentNode?.pot ?? null, lineUncertain: ph?.lineUncertain ?? null });
  }
}
console.log(`\n${rows.length} frames (${Math.min(rows.length, to + 1) - Math.max(0, from)} replayed, ${parsed} parsed now, ${covered} covered) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log(`${hands.length} hands; ${hands.filter((h) => !h.uncertain.length).length} with no uncertainty; ${hands.reduce((a, h) => a + h.inferred, 0)} inferred actions`);
for (const h of hands) {
  console.log(`  hand ${h.id}${h.bomb ? " BOMB" : ""}${h.joinedLate ? " (joined late)" : ""}: ${h.actions} actions (${h.inferred} inferred), board ${h.board.join(" ") || "-"}, `
    + `winners ${h.winners.map((w: any) => w.name + (w.won !== null ? " +" + w.won : "")).join(", ") || "?"}${h.uncertain.length ? `\n      ! ${h.uncertain.join("\n      ! ")}` : ""}`);
}
const out = opt("--json");
if (out) writeFileSync(out, JSON.stringify(hands, null, 1));
