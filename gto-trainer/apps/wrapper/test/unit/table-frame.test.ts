/**
 * OUR TABLE'S FRAME, AS THE CAPTURE FOUND IT (reader.ts noteFrame, 2026-09-25): which tables the client has open by its
 * own tag, ours doubled, and whether the browser is still drawing it — each said once, and on /state as `tableFrame`
 * with the tag the reader pinned (dom.ts pinFrame; its going and coming back are cross-table.test.ts's). A frame that is not being drawn keeps its DOM (hero's hole cards still changed on slot 4's stuck
 * frame, sessions 20260925_044829 / _134058) but its animations stop, so a board it was clearing stayed on screen for
 * hands: such a capture is no evidence of the board or of a seat's action. Real captures from session
 * 20260925_180244 (test/fixtures/ign-socket-move-20260925.jsonl.gz, table 3's frame) drive the reader.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { S, resetState, seams } from "../../src/state";
import { forgetFrame, pinFrame } from "../../src/ignition/dom";
import { mySel, tableJs, watchJs } from "../../src/ignition/dom";
import { FRAME_IDLE_MS, feedTick, noteFrame } from "../../src/ignition/reader";
import { state } from "../../src/view";
import { checker, J, scratchDirs } from "./helpers";

const TARGET = { id: "replay", webSocketDebuggerUrl: "ws://replay", url: "https://www.ignitioncasino.uno/static/poker-game/replay", title: "replay", type: "page" };
const DRAWN = { beats: 900, idleMs: 16, ageMs: 15000, pageHidden: false, offscreen: false };
const STUCK = { beats: 900, idleMs: 4000, ageMs: 15000, pageHidden: false, offscreen: false };

/** Table 3's own frame (client tag 2) over 18:10-18:12:40, every capture as recorded. */
const TABLE3: any[] = new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(import.meta.dir, "..", "fixtures", "ign-socket-move-20260925.jsonl.gz"))))
  .split("\n").filter((l) => l).map((l) => JSON.parse(l)).filter((r) => r.k === "cap" && r.tag === 2);

function withSlot<T>(slot: number | null, fn: () => T): T {
  const was = process.env.TABLE_SLOT;
  if (slot === null) delete process.env.TABLE_SLOT;
  else process.env.TABLE_SLOT = String(slot);
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.TABLE_SLOT;
    else process.env.TABLE_SLOT = was;
  }
}

test("our table's frame: doubled, not being drawn — each said once", () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  scratchDirs();
  resetState();
  const log0 = console.log;
  const logs: string[] = [];
  console.log = (m: unknown) => { logs.push(String(m)); };
  let seen = 0;
  const said = () => {
    const out = logs.slice(seen).filter((l) => l.startsWith("[frame]"));
    seen = logs.length;
    return out;
  };
  try {
    withSlot(3, () => {
      pinFrame("2", true);
      const seated = (draw: any, tags = [0, 1, 2, 3]) => ({ seated: true, frameTag: "2", tags, draw });
      eq("a capture from before these fields is unknown — never \"not drawn\"", [noteFrame({ seated: true, nodes: [] }), S.frameHealth.drawn], [true, null]);
      eq("a frame drawn 16 ms ago is being drawn", [noteFrame(seated(DRAWN)), S.frameHealth.drawn, S.frameHealth.tags], [true, true, [0, 1, 2, 3]]);
      eq("  ... and nothing is said", said(), []);
      eq(`one not drawn for ${STUCK.idleMs} ms (over ${FRAME_IDLE_MS}) is not: the capture is no evidence`,
         [noteFrame(seated(STUCK)), S.frameHealth.drawn], [false, false]);
      const l1 = said();
      check("  ... said once, with why", l1.length === 1 && l1[0]!.includes("table 3's frame is not being drawn")
            && l1[0]!.includes("the browser has stopped drawing this table's frame"), J(l1));
      check("  ... and on the panel's feed", S.feed.some((f) => String(f.line).startsWith("table 3's frame is not being drawn")), J(S.feed));
      noteFrame(seated(STUCK));
      eq("  ... not again while it stays so", said(), []);
      eq("the first capture drawn again is not trusted either (frozen picture -> live one is no round of actions)",
         noteFrame(seated(DRAWN)), false);
      check("  ... and it is said", said().some((l) => l.includes("table 3's frame is being drawn again")), "");
      eq("  ... the next one is", noteFrame(seated(DRAWN)), true);
      noteFrame(seated({ ...STUCK, offscreen: true }));
      check("off screen: the lobby is in front", said().some((l) => l.includes("off screen (its lobby is in front)")), "");
      noteFrame(seated({ ...STUCK, pageHidden: true }));
      check("a hidden page: the window is not being drawn", said().some((l) => l.includes("client window is not being drawn")), "");
      noteFrame(seated({ ...STUCK, idleMs: 5000, ageMs: 900 }));
      eq("a heartbeat installed under 1.5 s ago cannot have missed a frame yet", S.frameHealth.drawn, true);
      said();
      noteFrame({ seated: false, slot: { ord: 2, me: 3, tag: "2" }, tags: [0, 1, 3] });
      eq("our tag gone from the page: the page's tags are kept (the pin says gone, cross-table.test.ts)", S.frameHealth.tags, [0, 1, 3]);
      eq("  ... and nothing is said here", said(), []);
      noteFrame(seated(DRAWN, [0, 1, 2, 2, 3]));
      eq("two frames carrying our tag are counted", S.frameHealth.dup, 2);
      check("  ... and said", said().some((l) => l.includes("2 frames carry table 3's tag")), "");
    });
    withSlot(null, () => {
      resetState();
      noteFrame({ seated: true, tags: [] });
      eq("one table: never doubled", S.frameHealth.dup, 0);
    });
  } finally {
    console.log = log0;
    forgetFrame();
    resetState();
  }
  expect(fails).toEqual([]);
});

/** Table 3's recorded frame through the reader, every capture marked with `draw` (null: as recorded). */
async function readFrames(draw: any) {
  const io0 = { ...cdp.io };
  const seams0 = { ...seams };
  const log0 = console.log;
  let cur: any = null;
  const boards = new Set<string>();
  try {
    process.env.TABLE_SLOT = "3";
    process.env.TABLE_COUNT = "4";
    scratchDirs("wrapper-table-frame-");
    reloadConfig();
    resetState();
    cdp.io.available = async () => true;
    cdp.io.pageTargets = async () => [{ ...TARGET }];
    cdp.io.evaluate = async (_ws: string, expr: string) => {
      // the capture as today's TABLE_JS returns it: our tag and the page's, plus how long since the frame drew
      if (expr === tableJs(mySel())) return { ...structuredClone(cur), frameTag: "2", tags: [0, 1, 2, 3], ...(draw ? { draw } : {}) };
      if (expr === watchJs(mySel())) return [];
      return null;
    };
    cdp.io.dispatchClick = async () => {};
    seams.ignitionTarget = async () => ({ ...TARGET });
    seams.registry = () => [];
    console.log = () => {};
    setFakeTime(TABLE3[0].ts);
    for (const r of TABLE3) {
      setFakeTime(Math.max(time(), r.ts));
      cur = r.d;
      await feedTick();
      if ((S.liveStatus.board || []).length) boards.add(S.liveStatus.board.join(" "));
    }
    const light = await state(true);
    return { actions: [...(S.ws.actions || [])], feed: S.feed.map((f) => String(f.line)), boards: [...boards], tableFrame: light.tableFrame };
  } finally {
    console.log = log0;
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
    realTime();
    delete process.env.TABLE_SLOT;
    delete process.env.TABLE_COUNT;
    resetState();
  }
}

test("a frame the browser is not drawing gives the reader no board and no seat actions (real captures, table 3)", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  // DOM ticks only — no socket — so every action here is the DOM backfill's
  const recorded = await readFrames(null);
  const drawn = await readFrames(DRAWN);
  const stuck = await readFrames(STUCK);
  check("as recorded, the backfill files seat actions off the screen", recorded.actions.length > 0, J(recorded.actions.length));
  check("  ... and the screen's boards reach the live status", recorded.boards.length > 0, J(recorded.boards));
  eq("a frame being drawn reads exactly as the recording", [drawn.actions, drawn.boards], [recorded.actions, recorded.boards]);
  eq("a frame NOT being drawn: no seat action from it", stuck.actions, []);
  eq("  ... and no board", stuck.boards, []);
  check("  ... and the panel's feed says why", stuck.feed.some((l) => l.startsWith("table 3's frame is not being drawn")), J(stuck.feed.slice(0, 5)));
  eq("/state tableFrame reports it", [stuck.tableFrame.drawn, stuck.tableFrame.tag, stuck.tableFrame.idleMs, stuck.tableFrame.missing],
     [false, "2", 4000, false]);
  expect(fails).toEqual([]);
}, 120_000);
