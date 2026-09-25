/**
 * EACH WRAPPER READS AND TAPS ITS OWN TABLE — replayed on the real page of session 20260925_180244 (4 tables).
 *
 * The page as it really was, per client TAG (`data-multitableslot` 0-3): every table's own frame as the four
 * wrappers' recordings captured it, and every socket frame the four ws_dumps hold (test/fixtures, built from
 * debug/session_20260925_18024x + ws_dump*.jsonl; wallet and nicknames scrubbed). Each wrapper's DOM read goes through
 * the REAL resolver (src/js/launch.FRAME_JS.js) with the wrapper's own selector (dom.ts mySel: its tag, pinned on its
 * first read) over a page shim carrying those tags, then feedTick / tapFrame as live.
 *
 *  TABLE CLOSE (18:13:16, ign-table-close-20260925): table 2 closed, the others kept their tags. The resolver took the
 *  Nth TAGGED FRAME, so wrapper 2 read table 3 from then on, wrapper 3 table 4 and wrapper 4 nothing at all (its
 *  recording stops at 18:13:16.64); the press guard refused "that press would land on table 3, not table 2" and the
 *  taps followed the screens onto the other tables' sockets. The 2026-09-21 ordinal resolver reproduces that first.
 *
 *  SOCKET MOVE (18:10-18:12:40, ign-socket-move-20260925): every table got a new socket (hero's seats 4, 6, 4, 3 —
 *  seat 4 at two tables). Live, the leader bound table 3's new socket on its sit-in naming seat 4 (18:11:19), let its
 *  own go 4 s after a deal because the frame still showed the last hand's cards (18:12:15), then took table 3's again
 *  because it "deals into our seat 4" (18:12:19) and flip-flopped on it. Cards, not seats, decide now.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { js } from "../../src/js";
import { S, resetState, seams } from "../../src/state";
import { mySel, tableJs, watchJs } from "../../src/ignition/dom";
import { handState } from "../../src/ignition/hand";
import { feedTick, maybeFlushEnded } from "../../src/ignition/reader";
import { tapFrame } from "../../src/ignition/ws";
import { checker, J, scratchDirs } from "./helpers";

const TARGET = { id: "replay", webSocketDebuggerUrl: "ws://replay", url: "https://www.ignitioncasino.uno/static/poker-game/replay", title: "replay", type: "page" };
const TABLE_1 = "2864.10523", TABLE_2 = "2864.10656", TABLE_3 = "2864.10681", TABLE_4 = "2864.11921";

/** The resolver as it was from 2026-09-21 to 2026-09-25 (logic only): the SLOT-th tagged table frame in tag order. */
const ORDINAL_2026_09_21 = `
  const __frame = (SLOT) => {
    const play = f => /playMode=/.test(f.getAttribute('src') || '');
    const all = [...document.querySelectorAll('iframe')].filter(play);
    if (SLOT === null) return all[0];
    const tagged = all.filter(f => f.getAttribute('data-multitableslot') !== null);
    if (!tagged.length) return SLOT === 0 ? all[0] : undefined;
    tagged.sort((a, b) => Number(a.getAttribute('data-multitableslot'))
                        - Number(b.getAttribute('data-multitableslot')));
    return tagged[SLOT];
  };`;

type Rec = { k: string; ts: number; tag?: number; d?: any; rid?: string };
function fixture(name: string): { meta: any; recs: Rec[] } {
  const recs: Rec[] = new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(import.meta.dir, "..", "fixtures", name))))
    .split("\n").filter((l) => l).map((l) => JSON.parse(l));
  return { meta: recs.shift(), recs };
}
const CLOSE = fixture("ign-table-close-20260925.jsonl.gz");
const MOVE = fixture("ign-socket-move-20260925.jsonl.gz");

type Trace = { read: [number, number | null][]; bound: [number, string | null][]; hands: Map<string, string[]>; logs: string[]; frame: any;
               taps: string[] };

/** One wrapper (table `slot` of 4) over the recorded page, reading through `resolverJs` — handed the wrapper's own
 *  selector, or (`byOrdinal`, the 2026-09-21 resolver) the bare ordinal it was handed then. */
async function replay(fx: { meta: any; recs: Rec[] }, slot: number, resolverJs: string, byOrdinal = false): Promise<Trace> {
  const env0 = { TABLE_SLOT: process.env.TABLE_SLOT, TABLE_COUNT: process.env.TABLE_COUNT };
  const io0 = { ...cdp.io };
  const seams0 = { ...seams };
  const log0 = console.log;
  const out: Trace = { read: [], bound: [], hands: new Map(), logs: [], frame: null, taps: [] };
  try {
    process.env.TABLE_SLOT = String(slot);
    process.env.TABLE_COUNT = "4";
    scratchDirs("wrapper-table-binding-");
    reloadConfig();
    resetState();
    // the page: tag -> that table's latest capture (the close fixture's tag 0 is a stub no wrapper under test reads)
    const page = new Map<number, any>(fx.meta.close ? [[0, { seated: true, stub: "table 1" }]] : []);
    const pageWindow: Record<string, any> = {};             // where the page keeps who holds which tag
    const frames = () => [...page].map(([tag, cap]) => ({
      tag, cap,
      getAttribute: (n: string) => (n === "data-multitableslot" ? String(tag) : n === "src" ? "x?playMode=real" : null),
      getBoundingClientRect: () => {
        const f = cap.frame || { x: 0, y: 0, w: 0, h: 0 };
        return { left: f.x, top: f.y, right: f.x + f.w, bottom: f.y + f.h, width: f.w, height: f.h };
      },
    }));
    const tableRead = () => {
      const fs = frames();
      const doc = { querySelectorAll: (sel: string) => (sel === "iframe" ? fs : []) };
      const frame = new Function("document", "window", "Date", "innerWidth", "innerHeight", resolverJs + "\nreturn __frame;")(
        doc, pageWindow, { now: () => time() * 1000 }, 2560, 1600);
      const sel: any = mySel();
      const f = frame(byOrdinal ? sel.ord : sel);
      const tags = fs.map((x) => x.tag).sort((a, b) => a - b);
      out.read.push([time(), f ? f.tag : null]);
      return f ? { ...structuredClone(f.cap), frameTag: String(f.tag), tags } : { seated: false, slot: sel, tags };
    };
    cdp.io.available = async () => true;
    cdp.io.pageTargets = async () => [{ ...TARGET }];
    cdp.io.evaluate = async (_ws: string, expr: string) => {
      if (expr === tableJs(mySel())) return tableRead();
      if (expr === watchJs(mySel())) return [];
      if (expr === "document.visibilityState") return "visible";
      return null;
    };
    cdp.io.dispatchClick = async () => {};
    seams.ignitionTarget = async () => ({ ...TARGET });
    console.log = (m: unknown) => { out.logs.push(String(m)); };
    setFakeTime(fx.meta.t0);
    for (const r of fx.recs) {
      setFakeTime(Math.max(time(), r.ts));
      if (r.k === "gone") page.delete(r.tag!);
      else if (r.k === "cap") {
        page.set(r.tag!, r.d);
        if (page.size === 4 || (fx.meta.close && r.ts > fx.meta.close)) {   // every table has shown itself: read ours
          await feedTick();
          maybeFlushEnded();
        }
      } else tapFrame(r.d, r.rid);
      if (S.tapBound !== (out.bound.at(-1)?.[1] ?? null)) out.bound.push([time(), S.tapBound]);
      const h = handState();
      if (h?.clientHandId && h.heroCards?.length) out.hands.set(String(h.clientHandId), [...h.heroCards].sort());
    }
    out.frame = { ...S.frameHealth, tag: S.frame.tag, lost: S.frame.lost };
    out.taps = S.wsDump.filter((e) => /^<tap-(bound|unbound)>$/.test(String(e.pid)))
      .map((e) => `${new Date((e.ts + 7 * 3600) * 1000).toISOString().slice(11, 23)} ${e.pid} ${e.data.rid}: ${e.data.why}`);
  } finally {
    console.log = log0;
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
    realTime();
    for (const [k, v] of Object.entries(env0)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    resetState();
  }
  return out;
}

const after = (xs: [number, any][], t: number) => xs.filter(([ts]) => ts > t).map(([, v]) => v);
const before = (xs: [number, any][], t: number) => xs.filter(([ts]) => ts <= t).map(([, v]) => v);
const tags = (t: Trace) => [...new Set(t.read.map(([, tag]) => tag))];
const sockets = (t: Trace) => t.bound.map(([, b]) => b);
const cards = (...c: string[]) => J([...c].sort());

test("a table closing moves no wrapper onto another table (18:13:16)", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const close = CLOSE.meta.close;
  const NEW = js("launch.FRAME_JS");

  // ---- the failure, reproduced first: the ordinal resolver on the same page
  const old2 = await replay(CLOSE, 2, ORDINAL_2026_09_21, true);
  const old3 = await replay(CLOSE, 3, ORDINAL_2026_09_21, true);
  const old4 = await replay(CLOSE, 4, ORDINAL_2026_09_21, true);
  eq("ORDINAL: wrapper 2 read table 2 (tag 1) until the close", [...new Set(before(old2.read, close))], [1]);
  eq("ORDINAL: ... and table 3 (tag 2) after it", [...new Set(after(old2.read, close))], [2]);
  eq("ORDINAL: wrapper 3 read table 3 (tag 2) until the close", [...new Set(before(old3.read, close))], [2]);
  eq("ORDINAL: ... and table 4 (tag 3) after it", [...new Set(after(old3.read, close))], [3]);
  eq("ORDINAL: wrapper 4 read table 4 (tag 3) until the close", [...new Set(before(old4.read, close))], [3]);
  eq("ORDINAL: ... and nothing after it, its table still open", [...new Set(after(old4.read, close))], [null]);
  check("ORDINAL: wrapper 2's capture followed its screen onto table 3's socket", after(old2.bound, close).includes(TABLE_3), J(old2.bound));
  check("ORDINAL: wrapper 3's capture followed its screen onto table 4's socket", after(old3.bound, close).includes(TABLE_4), J(old3.bound));

  // ---- the fix: every wrapper reads its own tag, and nothing when its table is gone
  const new2 = await replay(CLOSE, 2, NEW);
  const new3 = await replay(CLOSE, 3, NEW);
  const new4 = await replay(CLOSE, 4, NEW);
  eq("wrapper 2 reads table 2 (tag 1) until the close", [...new Set(before(new2.read, close))], [1]);
  eq("  ... and NOTHING after it: table 2 is gone, and table 3 is not table 2", [...new Set(after(new2.read, close))], [null]);
  eq("  ... its capture never takes another table's socket", sockets(new2).filter((b) => b !== null), []);
  eq("  ... it pinned the client's tag 1 on its first read, and says it is gone, with the tables the client does have",
     [new2.frame.tag, new2.frame.lost !== null, new2.frame.tags], ["1", true, [0, 2, 3]]);
  check("  ... in the log, once", new2.logs.filter((l) => l.includes("the client's table tagged 1 is gone")).length === 1,
        J(new2.logs.filter((l) => l.startsWith("[tables]"))));
  eq("wrapper 3 reads table 3 (tag 2) before AND after the close", tags(new3), [2]);
  eq("  ... its capture binds table 3's socket and never leaves it", sockets(new3), [TABLE_3]);
  check("  ... it exports table 3's hand 4920571422 with hero's 8♥ A♣", J(new3.hands.get("4920571422")) === cards("8♥", "A♣"), J([...new3.hands]));
  check("  ... and never table 4's hand 4920571454 (K♠ 5♥)", !new3.hands.has("4920571454"), J([...new3.hands]));
  check("  ... it pinned tag 2 and it is never reported gone", new3.frame.tag === "2" && new3.frame.lost === null, J(new3.frame));
  eq("wrapper 4 reads table 4 (tag 3) before AND after the close", tags(new4), [3]);
  eq("  ... and binds table 4's socket, the one that dealt the K♠ 5♥ its own frame shows", sockets(new4), [TABLE_4]);
  check("  ... exporting table 4's hand 4920571454", J(new4.hands.get("4920571454")) === cards("K♠", "5♥"), J([...new4.hands]));
  expect(fails).toEqual([]);
}, 120_000);

test("every table's socket replaced at once: each wrapper binds its own table's new socket by the cards (18:10-18:12)", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const NEW = js("launch.FRAME_JS");
  const at = (hms: string) => new Date(`2026-09-25T${hms}+07:00`).getTime() / 1000;
  const w1 = await replay(MOVE, 1, NEW);
  const w2 = await replay(MOVE, 2, NEW);
  const w3 = await replay(MOVE, 3, NEW);
  const w4 = await replay(MOVE, 4, NEW);
  eq("each wrapper reads its own tag throughout", [tags(w1), tags(w2), tags(w3), tags(w4)], [[0], [1], [2], [3]]);
  // the leader: table 1's new socket, never table 3's though both seat hero at 4
  eq("wrapper 1 binds table 1's new socket only — never table 3's, which also seats hero at 4", sockets(w1), [TABLE_1]);
  check("  ... once its frame shows the 6♦ 5♦ that socket dealt (not on table 3's sit-in at 18:11:19)",
        w1.bound[0]![0] > at("18:11:27"), J(w1.bound));
  check("  ... and it rides out the frame showing the last hand's 6♦ 5♦ for 7 s after the 9♠ 9♣ deal (18:12:11-18:12:18)",
        w1.bound.length === 1, J(w1.bound));
  check("  ... exporting 4920571310 with 6♦ 5♦", J(w1.hands.get("4920571310")) === cards("6♦", "5♦"), J([...w1.hands]));
  check("  ... and 4920571374 with 9♠ 9♣", J(w1.hands.get("4920571374")) === cards("9♠", "9♣"), J([...w1.hands]));
  check("  ... and not one hand of table 3's", ![...w1.hands.keys()].some((h) => w3.hands.has(h)), J([...w1.hands.keys()]));
  eq("wrapper 2 binds table 2's new socket only", sockets(w2), [TABLE_2]);
  check("  ... exporting 4920571284 with 2♦ Q♣", J(w2.hands.get("4920571284")) === cards("2♦", "Q♣"), J([...w2.hands]));
  check("wrapper 3 binds table 3's new socket only", J(sockets(w3)) === J([TABLE_3]), J(w3.taps));
  check("  ... exporting 4920571200 with 6♠ K♥", J(w3.hands.get("4920571200")) === cards("6♠", "K♥"), J([...w3.hands]));
  eq("wrapper 4, whose new socket sent nothing any dump kept, binds nothing — no other table's either", sockets(w4), []);
  expect(fails).toEqual([]);
}, 120_000);
