/**
 * THE 2026-09-25 SESSION, REPLAYED (session_20260925_180244, 18:10:00 → 18:14:10: four NL5 tables, real money, auto
 * on; a wifi drop had just replaced the tables). The fixture (gto-trainer/apps/wrapper/test/fixtures/
 * multitable-2026-09-25.json.gz, cut by the investigation) holds every WebSocket frame any of the four wrappers dumped
 * — four sockets — and the recorded DOM ticks of two of them. Each is fed through exactly what the live loops run
 * (feedLoopOnce for a DOM tick, tapFrame for a frame), as the golden reader does.
 *
 * What happened live, and what must not happen again:
 *   TABLE 1 (top-left; its hands 9♠9♣ then 5♣7♣, socket 2864.10523): bound the A8o table's socket 2864.10681 on its
 *     sit-in (hero sat in seat 4 at both), let its own socket go at 18:12:15 because its frame still showed the hand
 *     before's 6♦5♦ 3.7 s after 9♠9♣ was dealt, then re-bound 10681 sixteen times on a stale deal — exporting 4hQd and
 *     A8o as its own hands, and pressing their answers on its own table.
 *   TABLE 3 (bottom-left; the A8o table's own reader, socket 2864.10681): read A8o correctly until its frame lookup
 *     moved to the bottom-right table at 18:13:19 (the ordinal — fixed separately, cross-table.test.ts), then carried
 *     the A8o hand on while its frame showed another table's: "seat 6 acted on the preflop but has no position label;
 *     preflop actions appear after turn actions; SEAT5 checked preflop" — the "internally inconsistent" capture.
 * The replay keeps the recorded DOM, so table 3's frame still moves at 18:13:19 here: what is checked is that the
 * tap no longer lets that turn into a mixed hand.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { S, resetState, seams } from "../../src/state";
import { mySel, tableJs, watchJs } from "../../src/ignition/dom";
import { handState } from "../../src/ignition/hand";
import { tapFrame } from "../../src/ignition/ws";
import { feedLoopOnce } from "../../src/loops";
import "../../src/session";
import { checker, J, scratchDirs } from "./helpers";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "multitable-2026-09-25.json.gz");
const A8O = "2864.10681", TL = "2864.10523";
const clock = (ts: number) => new Date((ts + 7 * 3600) * 1000).toISOString().slice(11, 23);

type Snap = { ts: number; kind: string; bound: string | null; hand: string | null; cards: string; seats: number[]; abandoned: boolean;
              dropped: number | null };

async function replay(fx: any, slot: number): Promise<{ snaps: Snap[]; events: any[]; presses: any[] }> {
  const s0 = process.env.TABLE_SLOT, c0 = process.env.TABLE_COUNT;
  process.env.TABLE_SLOT = String(slot);
  process.env.TABLE_COUNT = "4";
  scratchDirs("cross-table-replay-");
  reloadConfig();
  resetState();
  setFakeTime(fx.window[0]);
  const io0 = { ...cdp.io };
  const seams0 = { ...seams };
  const cur: { d: any; events: any[] } = { d: {}, events: [] };
  const presses: any[] = [];
  cdp.io.available = async () => true;
  cdp.io.pageTargets = async () => [{ id: "replay", webSocketDebuggerUrl: "ws://replay", url: "https://www.ignitioncasino.uno/static/poker-game/", type: "page" }];
  cdp.io.evaluate = async (_ws: string, expr: string) => {
    if (expr === tableJs(mySel())) return structuredClone(cur.d);
    if (expr === watchJs(mySel())) {
      const ev = cur.events;
      cur.events = [];
      return ev;
    }
    if (expr === "document.visibilityState") return "visible";
    return null;
  };
  cdp.io.dispatchClick = async (_ws: string, x: number, y: number) => { presses.push({ click: [x, y] }); };
  seams.ignitionTarget = async () => ({ id: "replay", webSocketDebuggerUrl: "ws://replay" });
  seams.act = async (label: string, kind = "action") => { presses.push({ act: [label, kind] }); return { ok: true }; };
  seams.raiseTo = async (amount: string) => { presses.push({ raiseTo: amount }); return { ok: true }; };
  const log0 = console.log;
  console.log = () => {};
  const inputs = [
    ...fx.dom[String(slot)].map((t: any) => ({ ts: t.ts, kind: "dom", t })),
    ...fx.frames.map((f: any) => ({ ts: f.ts, kind: "ws", f })),
  ].sort((a, b) => a.ts - b.ts || (a.kind === "ws" ? -1 : 1));
  const snaps: Snap[] = [];
  const loop = { fails: 0 };
  try {
    for (const inp of inputs) {
      setFakeTime(Math.max(time(), inp.ts));
      if (inp.kind === "dom") {
        cur.d = inp.t.d;
        cur.events = [...(inp.t.events || [])];
        await feedLoopOnce(loop);
      } else {
        tapFrame(inp.f.d, inp.f.rid);
      }
      const h = handState();
      snaps.push({
        ts: inp.ts, kind: inp.kind === "ws" ? `ws ${inp.f.rid} ${inp.f.d.pid}` : "dom", bound: S.tapBound,
        hand: S.handIds.get(S.handNo) ?? null, cards: [...(h?.heroCards ?? [])].sort().join(" "),
        seats: [...new Set<number>((h?.actions ?? []).map((a: any) => a.seatId))].sort((a, b) => a - b),
        abandoned: S.handAbandoned === S.handNo, dropped: S.handAbandoned,
      });
    }
    return { snaps, events: S.wsDump.filter((e) => String(e.pid).startsWith("<tap-")).map((e) => ({ t: clock(e.ts), ...e.data })), presses };
  } finally {
    console.log = log0;
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
    realTime();
    if (s0 === undefined) delete process.env.TABLE_SLOT;
    else process.env.TABLE_SLOT = s0;
    if (c0 === undefined) delete process.env.TABLE_COUNT;
    else process.env.TABLE_COUNT = c0;
    resetState();
  }
}

const fixture = () => JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(FIXTURE))));

/** Local wall time on 2026-09-25 (the session ran at UTC+7) as the recording's epoch seconds. */
const at = (hms: string) => {
  const [h, m, s] = hms.split(":").map(Number);
  return Date.UTC(2026, 8, 25, h! - 7, m!, 0) / 1000 + s!;
};
const between = (snaps: Snap[], a: string, b: string) => snaps.filter((s) => s.ts >= at(a) && s.ts <= at(b));
const seatsOf = (snaps: Snap[], hand: string) => [...new Set(snaps.filter((s) => s.hand === hand).flatMap((s) => s.seats))].sort((x, y) => x - y);

test.skipIf(!existsSync(FIXTURE))("2026-09-25 replayed: table 1 never reads the A8o table, table 3 never carries A8o onto another", async () => {
  const fx = fixture();
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const trace = (slot: number, events: any[]) => events.filter((e) => /bound|unbound/.test(e.pid)).map((e) => `${e.t} ${e.pid} ${e.rid}`).join(" | ");

  // ---- TABLE 1 (top-left): 9♠9♣ and 5♣7♣ on its own socket 2864.10523 -------------------------------------------
  const t1 = await replay(fx, 1);
  console.log(`table 1: ${trace(1, t1.events)}`);
  eq("table 1 is never on the A8o table's socket during 4hQd and A8o (live: 16 binds, both hands exported as its own)",
     [...new Set(between(t1.snaps, "18:12:19", "18:13:50").map((s) => s.bound))].filter((b) => b === A8O), []);
  eq("  ... and never exports either hand", t1.snaps.filter((s) => s.hand === "4920571386" || s.hand === "4920571422").length, 0);
  eq("table 1 keeps its own socket while its frame still shows 6♦5♦ after 9♠9♣ is dealt (live: let go at 18:12:15)",
     [...new Set(between(t1.snaps, "18:12:11.6", "18:12:30").map((s) => s.bound))], [TL]);
  const wrong = t1.events.find((e) => e.pid === "<tap-bound>" && e.rid === A8O);
  const gone = t1.events.find((e) => e.pid === "<tap-unbound>" && e.rid === A8O);
  check("a sit-in claim that bound the A8o table's socket while table 1's hero sat out is let go within 10 s (live: 56 s)",
        !wrong || (gone && at(gone.t) - at(wrong.t) < 10), J([wrong?.t, gone?.t]));
  // a seat number is not a table: that sit-in binds nothing now, so the A8o table's 4920571200 is never read at all
  eq("  ... table 1 never reads the A8o table's 6♠K♥ hand (live: read for 56 s, table 1's own seats 2, 3, 4, 5 merged in)",
     t1.snaps.filter((s) => s.hand === "4920571200").length, 0);
  check("no press was made (auto is off in the replay)", t1.presses.length === 0, J(t1.presses));

  // ---- TABLE 3 (bottom-left): the A8o table's own reader, socket 2864.10681 ------------------------------------
  const t3 = await replay(fx, 3);
  console.log(`table 3: ${trace(3, t3.events)}`);
  // the recorded frame moves (the old ordinal lookup) on the DOM tick at 18:13:16.72
  eq("table 3 reads A8o on its socket from the deal until its frame moves", [...new Set(between(t3.snaps, "18:12:45.4", "18:13:16.7").map((s) => s.bound))], [A8O]);
  eq("A8o is only ever seats 2 and 4 — no other table's seat merged in (live: seats 6, 3, 5, 1: 'internally inconsistent')",
     seatsOf(t3.snaps, "4920571422"), [2, 4]);
  // the frame shows the K♠5♥ table 4's socket dealt: the capture moves there at once (tapSwitch) and the A8o hand
  // goes with the old socket (tapUnbind drops it: never archived) before table 4's hand is replayed from its start
  const moved = between(t3.snaps, "18:13:16.7", "18:13:21");
  const before = t3.snaps.filter((s) => s.ts < at("18:13:16.7")).at(-1);
  check("when table 3's frame shows another table's hand the A8o hand is DROPPED, not carried on",
        moved.some((s) => s.dropped !== null && s.dropped !== (before?.dropped ?? null)) && moved.every((s) => s.hand !== "4920571422"),
        J(moved.map((s) => [s.bound, s.hand, s.dropped])));
  eq("  ... and never read again on another socket", between(t3.snaps, "18:13:20.5", "18:14:10").filter((s) => s.hand === "4920571422").length, 0);
  check("no press was made", t3.presses.length === 0, J(t3.presses));
  expect(fails).toEqual([]);
}, 300_000);
