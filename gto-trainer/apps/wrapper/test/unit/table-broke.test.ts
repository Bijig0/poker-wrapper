/**
 * "TABLE BROKE" IS READ OFF THE FELT, AND THE CLIENT'S NOTICES COME FIRST (ignition/reader.ts feedTick, 2026-09-30).
 * session_20260930_104219, table 2: the chat panel's "Player 3 has joined you from another table with $6.08" matched
 * the table-broke rule (/another table/ in the frame's upper 70%) every tick from 10:46:54 to the session's end — the
 * tick returned before the recorder, the state checks and handleModal, so the refused top-up's notice (a KNOWN one)
 * was never pressed away, eight Fold presses refused on it, and hero timed out and was sat out. Now: the message panel
 * (the frame's right sixth) is not the felt, and a known notice is dismissed before any early return.
 * The read is a real capture (test/fixtures/disconnect-overlay-2026-09-25.json, seq 514) with nodes added.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { S, resetState, seams } from "../../src/state";
import { mySel, tableJs, watchJs } from "../../src/ignition/dom";
import { FELT_W, feedTick } from "../../src/ignition/reader";

const FIX = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "disconnect-overlay-2026-09-25.json"), "utf8"));
const GOOD = FIX.ticks.find((t: any) => t.seq === 514).d;
const FR = GOOD.frame as { x: number; y: number; w: number; h: number };
const CHAT = "Player 3 has joined you from another table with $6.08";
const NOTICE = "The amount you entered is more than the maximum buy in amount allowed for this table.";

/** The capture with a line of text at a point of the frame (fractions of its width / height), and optionally the
 *  client's refused-top-up notice with its OK button in the middle of the felt. */
function read(o: { text?: string; fx?: number; fy?: number; notice?: boolean }): Record<string, any> {
  const d = structuredClone(GOOD);
  if (o.text) d.nodes.push({ text: o.text, x: Math.round(FR.x + FR.w * (o.fx ?? 0.5)), y: Math.round(FR.y + FR.h * (o.fy ?? 0.3)), w: 188, h: 32 });
  if (o.notice) {
    const ok = { text: "OK", qa: "modal.action.ok", x: FR.x + 560, y: FR.y + 400, w: 120, h: 30 };
    d.buttons.push(ok);
    d.nodes.push({ text: NOTICE, x: ok.x - 140, y: ok.y - 60, w: 400, h: 30 });
  }
  return d;
}

function rig() {
  delete process.env.TABLE_SLOT;
  delete process.env.TABLE_COUNT;
  reloadConfig();
  resetState();
  setFakeTime(1_790_740_000);
  S.site.id = "ignition";
  const io0 = { ...cdp.io }, seams0 = { ...seams };
  let cur: Record<string, any> = read({});
  const presses: string[] = [];
  const target = { id: "client", webSocketDebuggerUrl: "ws://client", url: "https://www.ignitioncasino.uno/static/poker-game/" };
  cdp.io.available = async () => true;
  cdp.io.pageTargets = async () => [target];
  cdp.io.evaluate = async (_ws: string, expr: string) => {
    if (expr === tableJs(mySel())) return structuredClone(cur);
    if (expr === watchJs(mySel())) return [];
    return null;
  };
  cdp.io.dispatchClick = async () => {};
  seams.ignitionTarget = async () => target;
  seams.livePeers = async () => [];
  seams.act = async (label: string) => { presses.push(label); return { ok: true }; };
  const log0 = console.log;
  console.log = () => {};
  const tick = async (d: Record<string, any>) => {
    cur = d;
    setFakeTime(time() + 2.5);                       // past handleModal's 2 s between presses
    await feedTick();
  };
  const feed = () => S.feed.map((f) => String(f.line));
  const undo = () => {
    console.log = log0;
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
    realTime();
    resetState();
  };
  return { tick, feed, presses, undo };
}

test("a chat line about another table is not the table breaking; the same words on the felt are", async () => {
  const { tick, feed, undo } = rig();
  try {
    await tick(read({}));
    expect(S.feedPrev.seated).toBe(true);
    await tick(read({ text: CHAT, fx: 0.83, fy: 0.3 }));    // where the client's message panel draws it (both layouts)
    expect(S.feedPrev.waiting).toBeUndefined();
    expect(S.feedPrev.seated).toBe(true);
    expect(feed().some((l) => l.startsWith("table broke"))).toBe(false);
    await tick(read({ text: "Please wait — moving you to another table", fx: 0.4, fy: 0.3 }));
    expect(S.feedPrev.waiting).toBe(true);
    expect(feed().filter((l) => l.startsWith("table broke")).length).toBe(1);
    expect(FELT_W).toBeLessThan(0.83);
    expect(FELT_W).toBeGreaterThan(0.6);
  } finally {
    undo();
  }
});

test("a known notice is pressed away on a read that would otherwise return early", async () => {
  const { tick, feed, presses, undo } = rig();
  try {
    await tick(read({}));
    // the felt says "another table" (a real table-broke read) AND the client's notice is up: the notice is pressed
    await tick(read({ text: "Please wait — moving you to another table", fx: 0.4, fy: 0.3, notice: true }));
    expect(S.feedPrev.waiting).toBe(true);
    expect(presses).toEqual(["OK"]);
    expect(S.liveStatus.modal?.harmless).toBe("buy-in above the table maximum");
    expect(feed().some((l) => l.startsWith("Dismissed the client's notice (buy-in above the table maximum)"))).toBe(true);
    // the next read, notice gone: /state's modal is cleared even though the tick still returns early
    await tick(read({ text: "Please wait — moving you to another table", fx: 0.4, fy: 0.3 }));
    expect(S.liveStatus.modal).toBeNull();
    expect(presses).toEqual(["OK"]);
  } finally {
    undo();
  }
});
