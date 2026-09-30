/**
 * A KNOWN NOTICE ON THE PRESS'S OWN READ IS PRESSED AWAY, THEN THE PRESS GOES (relay.ts actReal, 2026-09-30). A press
 * used to only refuse on a notice and leave the table tick to dismiss it; session_20260930_104219, table 2: the tick
 * never got there (a chat line read as "table broke"), so the refused top-up's notice — one the wrapper knows — held
 * eight Fold presses until hero timed out and was sat out. Any other notice still holds the press.
 * The client is played by the read stub: the notice stays up until its OK is clicked.
 */
import { expect, test } from "bun:test";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { S, resetState, seams } from "../../src/state";
import { act } from "../../src/relay";
import { mySel, tableJs } from "../../src/ignition/dom";
import { scratchDirs } from "./helpers";

const NOTICE = "The amount you entered is more than the maximum buy in amount allowed for this table.";
const OTHER = "Are you sure you want to leave this table?";
const OK = { text: "OK", qa: "modal.action.ok", x: 400, y: 360, w: 120, h: 30 };
const FOLD = { text: "FOLD", qa: "foldButton", x: 100, y: 500, w: 80, h: 30 };
const centre = (b: { x: number; y: number; w: number; h: number }) => [b.x + b.w / 2, b.y + b.h / 2];

const read = (notice: string | null) => ({
  seated: true,
  frame: { x: 0, y: 0, w: 1276, h: 762 },
  nodes: notice ? [{ text: notice, x: 300, y: 300, w: 400, h: 30 }] : [],
  buttons: [FOLD, { text: "CALL 1 BB", qa: "callButton", x: 200, y: 500, w: 80, h: 30 }, ...(notice ? [OK] : [])],
});

function rig(notice: string | null, o: { okWorks?: boolean } = {}) {
  const { okWorks = true } = o;
  delete process.env.TABLE_SLOT;
  delete process.env.TABLE_COUNT;
  reloadConfig();
  resetState();
  scratchDirs("press-modal-");
  setFakeTime(1_790_740_000);
  S.site.id = "ignition";
  const events: [string, any][] = [];
  S.session.id = "session_test";
  S.sessions = { event: (_sid: string, kind: string, data: any = null) => events.push([kind, data || {}]) } as any;
  let up = notice;
  const clicks: number[][] = [];
  const io0 = { ...cdp.io }, seams0 = { ...seams };
  seams.ignitionTarget = async () => ({ id: "client", webSocketDebuggerUrl: "ws://client" }) as any;
  seams.cdpSeq = async () => {};
  cdp.io.evaluate = async (_ws: string, expr: string) => {
    if (expr === tableJs(mySel())) return read(up);
    if (expr === "document.visibilityState") return "visible";
    return null;
  };
  cdp.io.dispatchClick = async (_ws: string, x: number, y: number) => {
    clicks.push([x, y]);
    const [ox, oy] = centre(OK);
    if (okWorks && x === ox && y === oy) up = null;       // the client takes its notice down on OK
  };
  const log0 = console.log;
  console.log = () => {};
  const undo = () => {
    console.log = log0;
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
    realTime();
    resetState();
  };
  return { clicks, events, undo, feed: () => S.feed.map((f) => String(f.line)) };
}

test("a known notice on the press's own read: its OK is pressed, the strip re-read, the press lands", async () => {
  const { clicks, events, feed, undo } = rig(NOTICE);
  try {
    S.liveStatus.modal = { text: NOTICE, harmless: "buy-in above the table maximum" };   // the tick's last word
    const r = await act("FOLD", "action");
    expect(r.ok).toBe(true);
    expect(r.clicked).toBe("FOLD");
    expect(clicks).toEqual([centre(OK), centre(FOLD)]);
    expect(S.liveStatus.modal).toBeNull();
    const ev = events.find(([k]) => k === "modal-dismissed")?.[1];
    expect(ev?.modalKind).toBe("buy-in above the table maximum");
    expect(String(ev?.where)).toContain("press");
    expect(feed().some((l) => l.startsWith("Dismissed the client's notice"))).toBe(true);
  } finally {
    undo();
  }
});

test("a notice the wrapper does not know still holds the press, untouched", async () => {
  const { clicks, events, undo } = rig(OTHER);
  try {
    const r = await act("FOLD", "action");
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain("a client notice is over the action strip");
    expect(clicks).toEqual([]);
    expect(events.some(([k]) => k === "modal-dismissed")).toBe(false);
  } finally {
    undo();
  }
});

test("a known notice that stays up after its OK still holds the press", async () => {
  const { clicks, undo } = rig(NOTICE, { okWorks: false });
  try {
    const r = await act("FOLD", "action");
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain("a client notice is over the action strip");
    expect(clicks).toEqual([centre(OK)]);
  } finally {
    undo();
  }
});

test("a button press (the OK itself, Buy chips, Sit here) never looks for a notice", async () => {
  const { clicks, undo } = rig(NOTICE);
  try {
    const r = await act("OK", "button");
    expect(r.ok).toBe(true);
    expect(clicks).toEqual([centre(OK)]);
  } finally {
    undo();
  }
});
