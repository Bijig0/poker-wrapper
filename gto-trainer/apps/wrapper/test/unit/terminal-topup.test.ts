/**
 * Port of tests/test_terminal_topup.py — top up before ANY terminal action, and the reader rules of the
 * 2026-09-23 hardening pass: which picks start a pre-action run (and nothing else), auto-execute holds while it is
 * active, `banked` follows the time-bank PRESS, a pending press blocks a second buy but a refused one does not, the
 * refusal notice is filed against its press, sessions.event keeps its own kind/time, the cut-over never drops a
 * hero action the client reported, the archive refuses hands hero was not dealt into and duplicate client ids,
 * the showdown-pending window, and the relay guards.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, time } from "../../src/clock";
import { C } from "../../src/config";
import { pyJsonDumps } from "../../src/py";
import { SessionStore } from "../../src/sessions";
import { S, resetState, seams } from "../../src/state";
import { archiveHand } from "../../src/archive";
import { handSeams, handStateIgnition, reconciledLine } from "../../src/ignition/hand";
import { didAsTold, maybeAutoAct, pickReady, relaySeams } from "../../src/relay";
import { maybePrefoldTopUp, noteTopUpRefusal, topupSeams, topUpWindow } from "../../src/topup";
import { checker, J, scratchDirs } from "./helpers";

type A = [number, string, (number | null)?, string?];

function hand(o: { street?: string; hero?: number; dealt?: number[]; actions?: A[]; toCall?: number; stacks?: Record<string, number> | null } = {}) {
  const { street = "river", hero = 4, dealt = [3, 4], actions = [], toCall = 6.0, stacks = null } = o;
  const acts = actions.map((a) => {
    const rec: any = { seatId: a[0], hero: a[0] === hero, type: a[1], street: a.length > 3 ? a[3] : street };
    if (a.length > 2 && a[2] !== null && a[2] !== undefined) rec.amount = a[2];
    return rec;
  });
  const n = ({ preflop: 0, flop: 3, turn: 4, river: 5 } as Record<string, number>)[street]!;
  return { handId: 7, heroSeatId: hero, heroCards: ["A♠", "K♠"], board: ["2♣", "7♦", "9♥", "T♠", "3♣"].slice(0, n), street, actions: acts,
           liveSeats: [...dealt].sort((a, b) => a - b), committed: {}, positions: Object.fromEntries(dealt.map((s) => [String(s), "X"])),
           stacks: stacks || Object.fromEntries(dealt.map((s) => [String(s), 100.0])),
           currentNode: { street, toActSeatId: hero, toActIsHero: true, pot: 20.0, toCall }, heroFolded: false, ended: false };
}

test("top up before ANY terminal action, and the 2026-09-23 reader rules", async () => {
  const { fails, check } = checker();
  scratchDirs();
  realTime();
  resetState();
  const started: string[] = [];
  const events: [string, any][] = [];
  const saved = { seams: { ...seams }, topup: { ...topupSeams }, relay: { ...relaySeams }, io: { ...cdp.io } };
  const REAL_ACT = seams.act;
  const log0 = console.log;
  console.log = () => {};
  topupSeams.spawn = (name) => { started.push(name); };
  topupSeams.takeTime = async () => null;
  seams.act = async () => ({ ok: true });
  const seed = (pick: string, h: any, o: { auto?: boolean; toAct?: boolean } = {}) => {
    const { auto = true, toAct = true } = o;
    S.fakeMode = false;
    S.session.id = "session_test";
    S.sessions = { event: (_sid: string, kind: string, data: any = null) => events.push([kind, data || {}]) } as any;
    Object.assign(S.study, { on: true, auto, topUp: true, text: pick, pick, at: time(),
                             decisionKey: pyJsonDumps([h.street, h.board, h.heroCards, h.currentNode.toCall, h.actions.length]),
                             handId: h.handId, executed: null, uncertain: null, topUpHand: null, lastTopUp: null, autoTried: null,
                             autoDue: null, autoHeld: null, timeBank: true, timeBankAt: 0.0, autoNotFired: null, autoDelay: "instant" });
    Object.assign(S.topupPrefold, { active: false, key: null, hand: null, deadline: 0.0, startedAt: 0.0, banked: false });
    S.topupAbort = false;
    S.topupLocked = false;
    Object.assign(S.topupPanel, { open: false, lastCloseAt: 0.0, domTicks: 0 });
    S.liveStatus = { hero: "in-hand", toAct, practice: true, modal: null, buyPanel: false, timeBank: null };
    S.feedPrev = { seated: true, waiting: false, toAct };
    S.handNo = h.handId;
    S.handIds.set(h.handId, `cid-${h.handId}`);
    handSeams.override = () => h;
    topupSeams.read = async () => ({ seated: true, stackCents: 17000, maxCents: 20000, bbCents: 200, zone: false, panelOpen: false });
  };
  try {
    const cases: [string, any, boolean, string | null][] = [
      ["FOLD", hand({ street: "flop", actions: [[3, "bet", 6.0]], toCall: 6.0 }), true, "fold"],
      ["CALL 6", hand({ street: "river", actions: [[3, "bet", 6.0]], toCall: 6.0 }), true, "closing-river-call"],
      ["CHECK", hand({ street: "river", actions: [[3, "check", null]], toCall: 0.0 }), true, "closing-river-check"],
      ["ALL-IN", hand({ street: "turn", actions: [[3, "bet", 6.0]], toCall: 6.0 }), true, "shove"],
      ["CALL 60", hand({ street: "flop", actions: [[3, "bet", 60.0]], toCall: 60.0, stacks: { 3: 40.0, 4: 55.0 } }), true, "all-in-call"],
      ["CALL 6", hand({ street: "flop", actions: [[3, "bet", 6.0]], toCall: 6.0 }), false, null],
      ["CHECK", hand({ street: "turn", actions: [[3, "check", null]], toCall: 0.0 }), false, null],
      ["RAISE 12", hand({ street: "river", actions: [[3, "bet", 6.0]], toCall: 6.0 }), false, null],
      ["CALL 6", hand({ street: "river", dealt: [1, 3, 4], actions: [[3, "bet", 6.0]], toCall: 6.0 }), false, null],
    ];
    for (const [pick, h, want, kind] of cases) {
      started.length = 0;
      events.length = 0;
      seed(pick, h);
      await maybePrefoldTopUp();
      const got = started.length > 0;
      check(`${pick} on the ${h.street} → ${want ? "run" : "no run"}`, got === want, `started=${got}`);
      if (want && got) {
        const ev = events.find(([k]) => k === "top-up-prefold")?.[1] || {};
        check(`    …event names the kind ${kind}`, ev.terminalKind === kind && S.topupPrefold.kind === kind, J(ev));
        check("    …finalStackKnown only for the fold", ev.finalStackKnown === (kind === "fold"), String(ev.finalStackKnown));
        check("    …the run took the lock", S.topupLocked === true);
        S.topupLocked = false;
      }
    }

    // auto-execute holds while the run is active (TU-06)
    started.length = 0;
    events.length = 0;
    seed("FOLD", hand({ street: "flop", actions: [[3, "bet", 6.0]], toCall: 6.0 }));
    await maybePrefoldTopUp();
    S.topupLocked = false;
    const executed: any[] = [];
    relaySeams.executePick = async (...a: any[]) => { executed.push(a); return { ok: true }; };
    await maybeAutoAct();
    const held = events.find(([k]) => k === "study-auto-held")?.[1];
    check("the same tick's auto press is HELD, not fired", !executed.length && held && String(held.why).includes("pre-action"), `executed=${J(executed)} held=${J(held)}`);
    S.topupPrefold.active = false;
    await maybeAutoAct();
    check("the run's finally releases the hold: the press fires", executed.length > 0);

    // banked follows the PRESS, not the button (TU-07)
    started.length = 0;
    events.length = 0;
    seed("FOLD", hand({ street: "flop", actions: [[3, "bet", 6.0]], toCall: 6.0 }));
    S.liveStatus.timeBank = { text: "+16s" };
    topupSeams.takeTime = async () => null;
    await maybePrefoldTopUp();
    let ev = events.find(([k]) => k === "top-up-prefold")?.[1] || {};
    check("button visible but not pressed → banked False, base budget", ev.timeBank === false && ev.budgetS === C.TOP_UP_PREFOLD_BUDGET_S, J(ev));
    started.length = 0;
    events.length = 0;
    seed("FOLD", hand({ street: "flop", actions: [[3, "bet", 6.0]], toCall: 6.0 }));
    S.liveStatus.timeBank = { text: "+16s" };
    topupSeams.takeTime = async () => ({ ok: true, label: "+16s" });
    await maybePrefoldTopUp();
    ev = events.find(([k]) => k === "top-up-prefold")?.[1] || {};
    check("+16s granted → banked True, budget grows by the grant, never the +45s budget",
          ev.timeBank === true && C.TOP_UP_PREFOLD_BUDGET_S < (ev.budgetS || 0) && (ev.budgetS || 0) < C.TOP_UP_PREFOLD_BANKED_S, J(ev));
    topupSeams.takeTime = async () => null;

    // a pending press blocks a second buy; a refused one does not (TU-09 / TU-10)
    started.length = 0;
    events.length = 0;
    seed("FOLD", hand({ street: "flop", actions: [[3, "bet", 6.0]], toCall: 6.0 }));
    S.study.lastTopUp = { pressed: true, receiptCents: null, at: Math.trunc(time() * 1000) - 5000, amountCents: 3000 };
    await maybePrefoldTopUp();
    check("press awaiting its receipt → no pre-action run", !started.length);
    S.study.lastTopUp.refused = true;
    await maybePrefoldTopUp();
    check("the same press marked REFUSED → the run starts", started.length > 0);

    // the refusal notice is filed against the press
    events.length = 0;
    S.study.lastTopUp = { pressed: true, receiptCents: null, at: Math.trunc(time() * 1000) - 4000, amountCents: 3000, trigger: "pre-action", terminalKind: "closing-river-call" };
    noteTopUpRefusal({ harmless: "buy-in above the table maximum", text: "The amount you entered is more than the maximum buy in amount allowed for this table." });
    const rec = S.study.lastTopUp;
    const rev = events.find(([k]) => k === "top-up-refused-over-max")?.[1];
    check("record marked refused, not ok", rec.refused === true && rec.ok === false);
    check("one top-up-refused-over-max event with the press's kind", rev && rev.terminalKind === "closing-river-call", J(rev));
    events.length = 0;
    noteTopUpRefusal({ harmless: "buy-in above the table maximum", text: "…" });
    check("a second notice for the same press files nothing more", !events.length);
    noteTopUpRefusal({ harmless: null, text: "Are you sure you want to leave this table?" });
    check("an unknown notice is not a refusal", !events.length);

    // sessions.event: the event's kind and time win over the payload's
    const store = new SessionStore(join(mkdtempSync(join(tmpdir(), "sess-")), "sessions.sqlite"));
    const srec = store.start("session_test_events", "p", null, null, {}, {}, {});
    const sid = srec?.id;
    store.event(sid, "state-check", { kind: "request-without-buttons", at: "seated", detail: "x" });
    const e = store.get(sid).events.at(-1);
    check("kind is the event's", e.kind === "state-check", J(e));
    check("the payload's colliding keys survive under a prefix", e.payload_kind === "request-without-buttons" && e.payload_at === "seated", J(e));
    check("at is a timestamp", Number.isInteger(e.at));

    // _reconciled_line never drops a hero action the client reported
    handSeams.override = null;
    const fakeRc = (line: any[]) => ({ armed: true, bbs: 5, C: new Map([[4, 0.0]]), maxBet: 6.0, violations: [], line: () => line, faults: () => [] });
    const old = [{ seatId: 3, hero: false, type: "post-sb", street: "preflop", amount: 0.5 }, { seatId: 4, hero: true, type: "post-bb", street: "preflop", amount: 1.0 },
                 { seatId: 3, hero: false, type: "bet", street: "turn", amount: 4.3 }, { seatId: 4, hero: true, type: "fold", street: "turn" }];
    const derived = [{ seat: 3, type: "post-sb", street: "preflop", amount: 0.5 }, { seat: 4, type: "post-bb", street: "preflop", amount: 1.0 },
                     { seat: 3, type: "bet", street: "turn", amount: 4.3 }, { seat: 4, type: "check", street: "turn" }, { seat: 3, type: "fold", street: "river" }];
    Object.assign(S.shadow, { hand: 7, rc: fakeRc(derived) });
    S.handNo = 7;
    S.ws.dealt = [3, 4];
    let [acts, , , note, src] = reconciledLine(old, 4, "turn");
    check("hero's WS fold is missing from the derived line → the event line is kept",
          src === "ws" && acts === old && (note || "").includes("hero's own reported action"), `${src} ${note}`);
    const derived2 = [{ seat: 3, type: "post-sb", street: "preflop", amount: 0.5 }, { seat: 4, type: "post-bb", street: "preflop", amount: 1.0 },
                      { seat: 3, type: "bet", street: "turn", amount: 4.3 }, { seat: 4, type: "fold", street: "turn" }, { seat: 4, type: "check", street: "flop" }];
    Object.assign(S.shadow, { hand: 7, rc: fakeRc(derived2) });
    [acts, , , note, src] = reconciledLine(old, 4, "turn");
    check("the reconciler ADDING a hero check the WS missed is still taken", src === "reconciled", `${src} ${note}`);

    // the archive refuses hands hero was not dealt into, and duplicates across processes
    Object.assign(S.shadow, { hand: null, rc: null });
    const dataDir = process.env.WRAPPER_DATA_DIR!;
    Object.assign(S.ws, { heroSeat: 2, dealt: [1, 2, 3], heroDealt: false, dealer: 3, bb: 200, bbSeen: true,
                          actions: [{ seat: 1, type: "post-sb", cents: 100, street: "preflop" }, { seat: 2, type: "post-bb", cents: 200, street: "preflop" }],
                          committed: new Map(), board: [], heroCards: [] });
    S.handNo = 9;
    S.handIds.set(9, "cid-9");
    check("_hand_state is None when the deal frame showed no face-up seat", handStateIgnition() === null);
    S.ws.heroDealt = true;
    S.ws.heroCards = ["A♠", "K♠"];
    Object.assign(S.feedPrev, { seated: true, seats: new Map() });
    const h9 = handStateIgnition();
    check("…and exports again once hero's cards are seen", h9 !== null && J(h9.heroCards) === J(["A♠", "K♠"]), J(h9 && h9.heroCards));
    Object.assign(S.lastArchived, { no: 0, fp: null, body: null });
    S.session.id = null;
    archiveHand();
    const count = () => {
      const c = new Database(join(dataDir, "hands.db"));
      try {
        return (c.query("select count(*) as n from hands").get() as any).n;
      } finally {
        c.close();
      }
    };
    check("the hand is archived once", count() === 1, String(count()));
    S.handNo = 10;
    S.handIds.set(10, "cid-9");
    Object.assign(S.lastArchived, { no: 0, fp: null, body: null });
    archiveHand();
    check("a client hand id already on file is not archived again", count() === 1, String(count()));
    S.handNo = 11;
    S.handIds.set(11, "cid-11");
    S.ws.heroDealt = false;
    archiveHand();
    check("a hand hero was not dealt into is not archived", count() === 1, String(count()));

    // the showdown-pending window opens once hero's part is over
    seed("CHECK", hand({ street: "river", actions: [[4, "bet", 6.0], [3, "call", 6.0]], toCall: 0.0 }), { toAct: false });
    Object.assign(S.ws, { heroFolded: false, handOver: false });
    S.liveStatus.toAct = false;
    let [ok, trig, why] = topUpWindow();
    check("river bet called, hand not over → window open, trigger names the showdown", ok && (trig || "").startsWith("showdown"), `${ok} ${trig} ${why}`);
    seed("CHECK", hand({ street: "river", actions: [[4, "bet", 6.0]], toCall: 0.0 }), { toAct: false });
    Object.assign(S.ws, { heroFolded: false, handOver: false });
    [ok, trig, why] = topUpWindow();
    check("river bet unanswered → still 'a hand is live for hero'", !ok && why === "a hand is live for hero", `${ok} ${trig} ${why}`);
    seed("CHECK", hand({ street: "turn", actions: [[4, "bet", 6.0], [3, "call", 6.0]], toCall: 0.0 }), { toAct: false });
    Object.assign(S.ws, { heroFolded: false, handOver: false });
    [ok, trig, why] = topUpWindow();
    check("turn bet called → no window (the river is still to come)", !ok, `${ok} ${trig} ${why}`);

    // relay guards (EVM-03 / EVM-15 / EVM-08 / EVM-12)
    seed("CALL 6", hand({ street: "river", actions: [[3, "bet", 6.0]], toCall: 6.0 }));
    S.liveStatus.buyPanel = true;
    const r = pickReady();
    check("a manual/any pick is refused while the Buy-chips panel is over the strip", !r.ok && String(r.reason || "").includes("Buy-chips"), String(r.reason));
    S.liveStatus.buyPanel = false;
    const snapshot = {
      seated: true,
      buttons: [{ text: "FOLD", qa: "foldButton", x: 10, y: 500, w: 80, h: 30, row: 0 }, { text: "OK", qa: "modal.action.ok", x: 400, y: 300, w: 80, h: 30 }],
      nodes: [{ text: "The amount you entered is more than the maximum buy in amount allowed for this table.", x: 300, y: 200, w: 300, h: 20 }],
      frame: { x: 0, y: 0, w: 900, h: 700 },
    };
    seams.ignitionTarget = async () => ({ webSocketDebuggerUrl: "ws://stub" });
    cdp.io.evaluate = async () => snapshot;
    const res = await REAL_ACT("fold", "action");
    check("act() refuses an action when its own fresh read shows a notice over the strip", !res.ok && String(res.reason || "").includes("notice"), J(res));
    const D = didAsTold;
    check("an unsized Raise pick is confirmed by a raise", D({ kind: "action", label: "raise" }, { type: "raise", amount: 5.0 }, 100) === true);
    check("an unsized Bet pick is confirmed by a bet", D({ kind: "action", label: "bet" }, { type: "bet", amount: 5.0 }, 100) === true);
    check("an unsized Bet pick is NOT confirmed by a check", D({ kind: "action", label: "bet" }, { type: "check" }, 100) === false);
    check("all-in judged on the stack at send: a landed 86bb shove is confirmed even though 0 is behind now",
          D({ kind: "action", label: "all-in" }, { type: "raise", amount: 86.0 }, 86.0) === true);
  } finally {
    Object.assign(seams, saved.seams);
    Object.assign(topupSeams, saved.topup);
    Object.assign(relaySeams, saved.relay);
    Object.assign(cdp.io, saved.io);
    handSeams.override = null;
    console.log = log0;
    resetState();
  }
  expect(fails).toEqual([]);
});
