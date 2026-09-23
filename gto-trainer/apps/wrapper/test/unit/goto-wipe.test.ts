/**
 * Port of tests/test_goto_adding.py and tests/test_hand_end_wipe.py.
 *
 * Taking the SECOND seat: goto's refusal is the single-table rule; `adding` takes the seat from a page that already
 * has a table, names the NEW slot, cannot be failed by a log line, and never navigates the top document while
 * tables are seated. The whole client is faked at the CDP layer (every probe, wait and click goes through it).
 *
 * The hand-end wipe is not a fold — and it IS hero's fold when the hand ended on hero's turn (hand 4917810302,
 * replayed from its recording; skipped, as in Python, when the recording is not on this machine).
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime } from "../../src/clock";
import { paths } from "../../src/env";
import * as F from "../../src/formats";
import { S, TupleSet, resetState, seams } from "../../src/state";
import { handState } from "../../src/ignition/hand";
import { feedTick } from "../../src/ignition/reader";
import { checker, J, scratchDirs } from "./helpers";

const MODAL = "Buy-In\nMINIMUM $40.00\nMAXIMUM $200.00\nWait for Big Blind\nTAKE MY SEAT";

/** A fake Ignition client: N seated tables, a lobby, and a wizard that says yes to everything. TAKE MY SEAT adds
 *  the next data-multitableslot. The dispatch below is test_goto_adding.py's Client.ev, in order. */
class Client {
  slots: number[];
  navigated: string[] = [];
  detectSlots: (number | null)[] = [];
  seatPresses = 0;
  constructor(seated = 1, public lobby = true) {
    this.slots = [...Array(seated).keys()];
  }
  params(slot: number) {
    return { gameType: "NLHE", gameFormat: "ring", seat: "1", playMode: "real", quickSeatSmallBlind: "100",
             quickSeatBigBlind: "200", quickSeatBuyInAmount: "20000", waitForBigBlind: "true",
             gameTableUrl: "/poker-game/ring", tableName: `Table ${slot}`, _title: "NL Hold'em $1/$2" };
  }
  ev(js: string): any {
    const m = /const SLOT = (null|\d+);/.exec(js);
    if (m) {
      const want = m[1] === "null" ? null : Number(m[1]);
      this.detectSlots.push(want);
      if (want === null) return this.slots.length ? this.params(this.slots[0]!) : null;
      return this.slots.includes(want) ? this.params(want) : null;
    }
    if (js === F.SIGNED_OUT_JS()) return false;                 // F._signed_out = lambda: False
    if (js.includes("data-multitableslot") && js.includes("slots")) return JSON.stringify({ slots: [...this.slots], tagged: true });
    if (js.startsWith("location.href")) {
      this.navigated.push(js);
      return true;
    }
    if (js.includes("!!L") && js.trim().endsWith("!!L")) return this.lobby;
    if (!this.lobby) return null;
    if (js.includes("Start Cash Game") || (js.includes("Select Stake") && js.includes("includes"))) return true;
    if (js.includes("TAKE MY SEAT") && js.includes("b.click()")) {
      this.seatPresses++;
      this.slots.push(this.slots.length);
      return true;
    }
    if (js.includes("TAKE MY SEAT")) return "ready";
    if (js.includes("custom-toggle")) return false;
    if (js.includes("switch-btn")) return false;
    if (js.includes("MAXIMUM") && js.includes("b.click()")) return "200.00";
    if (js.includes("otherAmount")) return "200.00";
    if (js.includes("input[type=checkbox]")) return true;
    if (js.includes("Buy-In") && js.includes("TAKE MY SEAT")) return MODAL;
    if (js.includes("/TAKE MY SEAT/")) return MODAL;
    if (js.includes("close-btn")) return false;
    if (js.includes("querySelectorAll('li')")) return true;
    if (js.includes(".pop(); if(e) e.click()") || js.includes("b.click(); return /active/")) return js.includes("active") ? "active" : true;
    return true;
  }
}

function install(c: Client) {
  cdp.io.available = async () => true;
  cdp.io.pageTargets = async () => [{ id: "fake", webSocketDebuggerUrl: "ws://fake", url: "https://ignitioncasino.eu/casino" }];
  cdp.io.evaluateStrict = async (_ws: string, js: string) => c.ev(js);
  cdp.io.evaluate = async (_ws: string, js: string) => c.ev(js);
}

test("taking the SECOND seat: formats.goto(..., adding=True)", async () => {
  const { fails, check } = checker();
  const io0 = { ...cdp.io };
  const slot0 = process.env.TABLE_SLOT;
  delete process.env.TABLE_SLOT;
  scratchDirs();
  setFakeTime(1_790_000_000);                    // the wizard's waits and settles are instant
  const FID = "ign-ring-NL200-6";
  const quiet = () => {};
  try {
    let c = new Client(1);
    install(c);
    let r = await F.goto(FID, 100, 0, true, quiet);
    check("a table open and adding=False → still refuses", r.ok === false && String(r.error).includes("already open"), J(r).slice(0, 120));
    check("  ... and presses nothing", c.seatPresses === 0, String(c.seatPresses));

    c = new Client(1);
    install(c);
    r = await F.goto(FID, 100, 0, true, quiet, true);
    check("a table open and adding=True → takes the seat", r.ok === true, J(r).slice(0, 200));
    check("  ... exactly one TAKE MY SEAT", c.seatPresses === 1, String(c.seatPresses));
    check("the new slot is named", r.slot === 1, String(r.slot));
    check("  ... and detect() was asked about slot 1", c.detectSlots.includes(1), J(c.detectSlots));

    c = new Client(0);
    install(c);
    r = await F.goto(FID, 100, 0, true, quiet);
    check("no table open → seats normally", r.ok === true, J(r).slice(0, 200));
    check("  ... and never asks about a slot it invented", c.detectSlots.length > 0 && c.detectSlots.every((s) => s === null), J(c.detectSlots));

    // A LOG LINE CANNOT FAIL THE SEAT (the cp1252 arrow of 2026-09-21)
    c = new Client(1);
    install(c);
    r = await F.goto(FID, 100, 0, true, () => { throw new Error("'charmap' codec can't encode character"); }, true);
    check("a log that raises does not fail the walk", r.ok === true, J(r).slice(0, 200));
    check("  ... the seat is still taken", c.seatPresses === 1, String(c.seatPresses));
    check("  ... and the steps are still recorded for the panel and the record",
          (r.steps || []).some((s: string) => s.includes("Cash games")), J(r.steps).slice(0, 200));

    // NAVIGATION IS REFUSED WITH TABLES SEATED
    c = new Client(2, false);
    install(c);
    r = await F.goto(FID, 100, 0, true, quiet, true);
    check("no lobby frame + tables seated → refuses", r.ok === false && String(r.error).includes("not navigating"), J(r).slice(0, 160));
    check("  ... and the page was NEVER navigated", c.navigated.length === 0, J(c.navigated));
    c = new Client(0, false);
    install(c);
    await F.goto(FID, 100, 0, true, quiet);
    check("no lobby frame + nothing seated → still hops (the old path)", c.navigated.length > 0, J(c.navigated));
  } finally {
    Object.assign(cdp.io, io0);
    if (slot0 !== undefined) process.env.TABLE_SLOT = slot0;
    realTime();
  }
  expect(fails).toEqual([]);
});

const REC = join(paths().root, "debug", "session_20260912_140454");
const FIRST = 216, LAST = 233;

function frames(lo: number, hi: number): any[] {
  return readFileSync(join(REC, "dom.jsonl"), "utf8").split(/\r?\n/).filter((l) => l.trim())
    .map((l) => JSON.parse(l)).filter((d) => d.seq >= lo && d.seq <= hi);
}
function logged(seq: number): any {
  for (const l of readFileSync(join(REC, "log.jsonl"), "utf8").split(/\r?\n/)) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    if (r.seq === seq) return r;
  }
  throw new Error(`no log line ${seq}`);
}

function seed() {
  resetState();
  S.fakeMode = false;
  S.handNo = 6;
  S.handIds.set(6, "4917810302");
  const acts = [
    { seat: 3, type: "post-sb", cents: 100, street: "preflop" }, { seat: 1, type: "post-bb", cents: 200, street: "preflop" },
    { seat: 2, type: "raise", cents: 560, street: "preflop" }, { seat: 3, type: "raise", cents: 2400, street: "preflop" },
    { seat: 1, type: "fold", street: "preflop" }, { seat: 2, type: "raise", cents: 5200, street: "preflop" },
    { seat: 3, type: "raise", cents: 20360, street: "preflop" },
  ];
  const seen = new TupleSet();
  seen.add(["fold", 1]);
  S.ws = {
    bb: 200, bbSeen: true, board: [], pot: "128.8 BB", potCents: 25760, dealt: [1, 2, 3], heroSeat: 2, dealer: 2,
    actions: acts, committed: new Map([[1, 200], [2, 5200], [3, 20360]]), maxBet: 20360, actionOn: 2, heroFolded: false,
    handOver: false, endedSince: null, actSeen: seen, foldedSeats: new Set([1]), heroCards: ["7♥", "6♥"], domGraceUntil: 0,
    heroToActAt: 0.0, heroLastActAt: 0.0,
  };
  const prev = logged(FIRST - 1);
  // the log's seats carry STRING keys, as the Python test's feed_prev did
  S.feedPrev = { seated: true, seats: new Map(Object.entries(prev.seats)), board: prev.board.length, pot: prev.pot,
                 heroHand: null, toAct: prev.toAct, heroCards: prev.heroCards.join(" ") };
  Object.assign(S.liveStatus, { hero: "in-hand", board: [], toAct: prev.toAct });
}

async function replay(fs: any[], bumpFrom: number | null = null, bumpTo: string | null = null) {
  let cur: any = null;
  cdp.io.evaluate = async () => (cur !== null ? cur : {});
  seams.ignitionTarget = async () => ({ webSocketDebuggerUrl: "ws://recorded" });
  for (const d of fs) {
    if (bumpFrom !== null && d.seq >= bumpFrom && bumpTo !== null) {
      const nodes = d.nodes || [];
      const n = nodes.find((x: any) => x.text.toLowerCase().startsWith("total pot"));
      if (n) {
        const right = nodes.filter((m: any) => Math.abs(m.y - n.y) < 10 && m.x > n.x);
        if (right.length) right.reduce((a: any, b: any) => (b.x < a.x ? b : a)).text = bumpTo;
      }
    }
    cur = d;
    await feedTick();
    await new Promise((r) => setTimeout(r, 10));
  }
}

test.skipIf(!existsSync(join(REC, "dom.jsonl")))("the hand-end wipe is not a fold — and IS hero's fold on hero's turn", async () => {
  const { fails, check } = checker();
  scratchDirs();
  realTime();
  const io0 = { ...cdp.io };
  const seams0 = { ...seams };
  const log0 = console.log;
  console.log = () => {};
  try {
    const fs = frames(FIRST, LAST);
    seed();
    await replay(structuredClone(fs));
    let a = (S.ws.actions || []).map((x: any) => [x.seat, x.type]);
    check("the wipe files no villain fold", !a.some(([s, t]: any) => s === 3 && t === "fold"), J(a));
    check("hero's fold is inferred (hand ended on hero's turn)", a.some(([s, t]: any) => s === 2 && t === "fold"), J(a));
    check("heroFolded is set", S.ws.heroFolded === true);
    const h = handState() || {};
    check("the export says the hand ended by hero's fold", h.heroFolded === true && h.heroWon === false);
    seed();
    await replay(structuredClone(fs), 226, "176.8 BB");
    a = (S.ws.actions || []).map((x: any) => [x.seat, x.type]);
    check("pot grew after the prompt -> no fold inferred", !a.some(([s, t]: any) => s === 2 && t === "fold"), J(a));
    check("...and still no villain fold from the wipe", !a.some(([s, t]: any) => s === 3 && t === "fold"), J(a));
  } finally {
    console.log = log0;
    Object.assign(cdp.io, io0);
    Object.assign(seams, seams0);
  }
  expect(fails).toEqual([]);
});
