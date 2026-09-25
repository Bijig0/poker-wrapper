/**
 * GOLDEN: the Ignition reader over every recorded session (tests/golden/record_reader.py -> corpus/reader-*.jsonl.gz).
 *
 * Each scenario's inputs — DOM ticks (the in-page capture + the watcher's events) interleaved by time with the
 * WebSocket frames the tap dumped — are fed through exactly what the live loops run: a DOM tick through
 * feedLoopOnce (the tick, then the flush / auto / top-up chain), a frame through tapFrame (accept or hold, the
 * held-frame replay, the reader). After every input the wrapper's observable state is snapshotted the way the
 * Python recorder did, and compared key by key with what Python produced.
 *
 * Nothing touches the real data/ or debug/: both are pointed at a temp directory, the CDP layer answers from the
 * recording, and a press is recorded instead of made.
 *
 * THE WRAPPER IS TYPESCRIPT ONLY NOW: the Python recorder made the first baseline; a deliberate change to the reader
 * re-baselines from THIS implementation — same inputs, same delta format, each key stored exactly as the comparison
 * below reads it (post-recording fields dropped, the heads-up supersession applied):
 *   GOLDEN_UPDATE=1 bun test test/golden/reader.test.ts      (then review the corpus diff before committing)
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { pyFloatStr, pyJsonDumps } from "../../src/py";
import { S, resetState, seams } from "../../src/state";
import * as TABLES from "../../src/tables";
import * as TERMINAL from "../../src/terminal";
import { boardCards, domHeroSeat, heroCards, modalOf, mySel, parseSeats, splitStrip, tableJs, toAct, watchJs } from "../../src/ignition/dom";
import { handState } from "../../src/ignition/hand";
import { tableState } from "../../src/ignition/reader";
import { TAP_DEAL_LAG_S, tapFrame } from "../../src/ignition/ws";
import { holeCardsRefusal, keyCards, pickReady } from "../../src/relay";
import { feedLoopOnce } from "../../src/loops";
import { state } from "../../src/view";
import "../../src/session";
import { canon, CORPUS, corpusFiles, firstDiff, normPy, readCorpus } from "./lib";

const UPDATE = process.env.GOLDEN_UPDATE === "1";

/** Fields added after the Python recording, verified on their own (test/golden/start-stacks.test.ts, 636 of 636
 *  seat-hands against the table's own accounts): the hand's stacks as dealt (/hand `startStacks`, archived with the
 *  row) and the per-hand money behind them (S.ws.startCents / moneyIn). Everything else still compares key by key.
 *  ROUND 3 (2026-09-25): every dealt seat's chips as the WebSocket reports them — /hand `wsStack` / `wsInFront` /
 *  `wsDead` (live only, never archived) and the ledger behind them (S.ws.wsAccount / wsFront / wsDead / wsStale) —
 *  verified on their own in test/golden/ws-chips.test.ts (590 seat-hands against the table's CO_RESULT_INFO, and
 *  dealt − behind = the line's chips on 4,247 seat-frames of every clean hand) and test/unit/ws-chips.test.ts. */
const POST_RECORDING = new Set(["startStacks", "startCents", "moneyIn", "wsStack", "wsInFront", "wsDead", "wsAccount", "wsFront", "wsStale"]);
/** POST-INS are recorded since 2026-09-25 (CO_BLIND_INFO btn 8 → a `post` action; hands 4920414446 / 4920414607):
 *  the Python recording never filed them. Compared WITHOUT them — a post-in is an extra entry in the action lists and
 *  nothing else here (the pick key never counts one: relay.ts), verified on its own in test/unit/post-in.test.ts
 *  against hand 4920414446's frames. Every other action still compares entry by entry. */
const isPostIn = (a: any) => a && typeof a === "object" && a.type === "post" && ("seat" in a || "seatId" in a);
function dropPostRecording(x: unknown): unknown {
  if (Array.isArray(x)) return x.filter((a) => !isPostIn(a)).map(dropPostRecording);
  if (x && typeof x === "object") {
    return Object.fromEntries(Object.entries(x).filter(([k]) => !POST_RECORDING.has(k)).map(([k, v]) => [k, dropPostRecording(v)]));
  }
  return x;
}

/**
 * THE CROSS-TABLE FIXES (2026-09-25, session 20260925_180244 — hand 4920571422's "internally inconsistent" capture),
 * compared narrower where they apply, decided by the INPUT (the frame's own hole cards, the capture's), never the
 * output — everywhere else every snapshot still compares exactly:
 *  - `pick`: the HOLE-CARD GUARD (relay.ts holeCardsRefusal). A decision whose hole cards the frame contradicts is
 *    refused, and at several tables one whose cards the frame does not show yet. Every one in the corpus checked by
 *    hand (GOLDEN_GUARD_LOG=1 lists them): 156 snapshots over 11 hands. The 9 contradictions are all a capture on
 *    ANOTHER table's hand — 7 hands the ledger below flags as a mixed/duplicated stream (20260920_131406 x5, 20260921_
 *    131211 x2: J♠J♣ captured with J♥K♦ on screen, Q♣T♥ with K♦9♥, ...), 4919910081 (already a known-wrong line: 4♠T♠
 *    with 9♣T♠) and 4919910493 in the UNTAGGED replay of 20260922_194132 (the tap accepting both tables' sockets: 8♥2♠,
 *    table 1's, with 5♥5♦ on screen; its slot-2 replay isolates and is not refused). The 2 "not shown" (20260922_
 *    194118-slot1: 2♥6♣, 8♥2♠) are each ONE tick of the deal animation — card backs with the buttons up, the cards
 *    drawn 0.25 s later — a press a tick later, not a lost one. A recorded "ok" there becomes the guard's refusal; a
 *    recorded refusal (an earlier check) still compares as recorded.
 *  - `tap.mismatch`: the verify rides out our frame showing the HAND BEFORE's cards for TAP_DEAL_LAG_S after a new
 *    deal (18:12:15, 6♦5♦ on screen 3.7 s after 9♠9♣ was dealt, let the right socket go). The recorded counter counted
 *    that lag (1-4 ticks, never the 8 of an unbind — every case checked: frame = the hand before, 0.1-1.8 s after the
 *    deal); inside that window the counter is not compared.
 */
const guarded = { picks: 0, lagTicks: 0, byHand: new Map<string, string>() };
function supersededCrossTable(key: string, got: any, want: any): [any, any] {
  if (key === "pick" && want && want.ok === true && got && got.key) {
    const why = holeCardsRefusal(keyCards(got.key), S.tapDomCards);
    if (why) {
      guarded.picks++;
      const hk = String(S.handIds.get(S.handNo) ?? S.handNo);
      guarded.byHand.set(hk, `${keyCards(got.key)?.join(" ")} captured, frame ${S.tapDomCards.join(" ") || "(no cards)"}`);
      return [got, { ...want, ok: false, reason: why, plan: null }];
    }
  }
  if (key === "tap" && got && want && S.tapDomCards.length >= 2 && S.tapPrevHero.length >= 2
      && canon([...S.tapDomCards].sort()) === canon([...S.tapPrevHero].sort()) && time() - S.tapDealtAt < TAP_DEAL_LAG_S) {
    const { mismatch: _g, ...g } = got;
    const { mismatch: _w, ...w } = want;
    if (canon(g) === canon(w) && _g !== _w) guarded.lagTicks++;
    return [g, w];
  }
  return [got, want];
}

/**
 * SUPERSEDED 2026-09-24 (hand 4920374906, 75o: no answer on the turn or river) — compared narrower, not skipped:
 *  - `rc` on a table DEALT TWO, past the flop: the Python reader put the small blind first on every heads-up street;
 *    the big blind acts first postflop (the dealer posts the SB). Verified on this corpus's own 4919645501: its event
 *    line has the BB first on the flop, turn and river, which is what the fixed reconciler now files. Still compared
 *    there: the hand, the seats and blinds, the street, the PREFLOP journal.
 *  - the shadow audit's VERDICT (agree / differ / last.agree / last.diffs): a hand whose archived line came from the
 *    reconciler is now diffed against the event line, not against itself (a vacuous "agree"). Still compared: how
 *    many hands were audited, which one was last, its violation count.
 * Both are decided by the table's facts, never by the output, and both are idempotent (the re-sync below stores them).
 */
function supersededHu(key: string, x: any): any {
  const verdictFree = (s: any) => (!s || "audited" in s ? s
    : { audited: (s.agree ?? 0) + (s.differ ?? 0), last: s.last && { hand: s.last.hand, clientHandId: s.last.clientHandId, violations: s.last.violations } });
  // THE TAP'S DEAL BOOKKEEPING (2026-09-25): S.tapDealt — the deals seen while unbound, never cleared — was replaced
  // by S.tapDeals (every socket's CURRENT-hand deal, stamped, kept while bound too) so a stale deal can never bind a
  // socket again (session 20260925_180244). What the binder DID is still compared: bound, rejected, claims, held,
  // hold, the dump's tap events and every frame's status.
  if (key === "tap" && x && typeof x === "object" && "dealt" in x) {
    const { dealt: _dealt, ...rest } = x;
    return rest;
  }
  if (key === "shadow") return verdictFree(x);
  if (key === "light" && x && x.shadow) return { ...x, shadow: verdictFree(x.shadow) };
  if (key === "rc" && x && !("huPostflop" in x) && Array.isArray(x.dealt) && x.dealt.length === 2 && (x.street ?? 0) > 0) {
    return { huPostflop: true, hand: x.hand, dealt: x.dealt, sb: x.sb, bbs: x.bbs, hero: x.hero, street: x.street,
             preflop: (x.journal || []).filter((a: any) => a.street === "preflop") };
  }
  return x;
}

/** The only snapshots in the corpus the heads-up fix changes — three heads-up hands of one session, every one of the
 *  186 differences inside them checked by hand 2026-09-24 (fail cap lifted, no re-sync) and each a correction:
 *   3098-3100  4909420828, hero SB: the feed has "Seat 6 checks" before hero's flop turn; Python's cut-over DROPPED it
 *              ("dropped: 6 check"), the fix keeps it first. (Both keep the "flop 2 check via buttons" of that frame's
 *              request-without-buttons flicker — a separate artefact, unchanged.)
 *   3384-3479  hero BB, who acts first postflop: Python INVENTED an SB check before hero ("added: 6 check") and later
 *              read the SB's bet as a check (toCall 0 facing 2 BB); the fix keeps the event line, so lineNote clears.
 *   3538-3574  hero SB: Python dropped the BB's flop check before hero's bet; the fix files it (archived 7 actions).
 *  Keys: the line and everything read off it — hand, light, pick, terminal, archived, lastArchived. */
const HU_LINE_FIXED = new Map([["reader-session_20260807_115240.jsonl.gz", [[3098, 3100], [3384, 3479], [3538, 3574]]]]);
const HU_LINE_KEYS = new Set(["hand", "light", "pick", "terminal", "archived", "lastArchived"]);
/** POST-IN HANDS the 2026-09-25 fix changes beyond the action lists, each checked by hand:
 *    20260923_020036 2774-3005  hand 734 (6♠7♦ — one of the four post-in no-answers): Python's cut-over swapped in the
 *                               level reconciler's line, which read seat 1's 1bb POST as "seat 1 call 1"; the event line
 *                               (with the post) is now kept, its lineNote says why, and the pick key counts one action
 *                               fewer — the API's count, which never includes a post.
 *    20260923_020036 498, 20260920_131406 2544  the archived rows of post-in hands: they now carry their posts
 *                               (action_count +1 per post, the row's body lists them).
 *  Keys: the line and everything read off it. */
const POST_IN_FIXED = new Map([
  ["reader-session_20260923_020036.jsonl.gz", [[498, 498], [2774, 3005]]],
  ["reader-session_20260920_131406.jsonl.gz", [[2544, 2544]]],
]);
const huLineFixed = (file: string, i: number, key: string) =>
  HU_LINE_KEYS.has(key) && [...(HU_LINE_FIXED.get(file) || []), ...(POST_IN_FIXED.get(file) || [])].some(([a, b]) => i >= a! && i <= b!);

/**
 * THE API GATE'S EXACT-CHIPS INVARIANT ON THE FULL PIPELINE (round 3). ws-chips.test.ts checks it on the WebSocket's
 * own line; here the export is the one the poller reads — DOM backfill, dedupe, the level reconciler's cut-over — so a
 * disagreement on a clean hand is a refusal the API would make at the table on a good capture. For every seat the
 * export covers: stack as dealt − chips behind (wsStack) − dead blinds = the chips the exported line put in. A hand
 * whose money frames came from two sockets or twice running is the 2026-09-20/21 socket-mixing capture (ws-chips.test.ts
 * says why): counted apart. Checked at hero's decisions (what the poller would answer), with the API's tolerance: half a
 * hundredth per amount on the WebSocket's own line, half a tenth on the reconciler's (it reads the chips on screen, which
 * Ignition shows to 0.1bb — hand 4919957671: 3.5 for 3.53). Required to be zero on clean hands but for the lines below,
 * each checked by hand against the frames and each WRONG — the refusal is the gate doing its job:
 */
const KNOWN_WRONG_LINES: Record<string, string> = {
  // the SB's CO_SELECT_INFO raised to 3 (raise +500 over his 100 blind, account 19700 → 19200) and the event line said
  // so; the level reconciler's cut-over swapped in "raise 2.5" off the chips on screen, and hero's toCall with it
  "4919480412": "the reconciler read the SB's raise to 3bb as 2.5bb",
  // the BTN limped 1bb and raised +40 → 21.005bb (account 21559 → 17559); the reconciled line says raise to 20
  "4919670726": "the reconciler read the BTN's raise to 21bb as 20bb",
  // one BB call of 2bb on the WS (account 19800 → 19400); the event line filed the BB calling three times (2, 1.5, 2.5)
  // off the chips on screen of a table recorded as two (recording 20260922_194132, multi-table)
  "4919910081": "the event line holds two phantom BB calls from the screen",
  // hero on the river clock (CO_SELECT_REQ asks 2605 to call) right after the BB's CO_SELECT_INFO bet of 13.025bb; the
  // reconciled line still ends at hero's check and says toCall 0 — the old gate had nothing to catch it with
  "4919957671": "at hero's river decision the reconciled line lacks the BB's 13bb bet the WS had filed",
};
function ledgerDisagreements(h: any): string[] {
  if (!h?.wsStack || !h.startStacks) return [];
  const get = (m: any, k: number) => (m instanceof Map ? m.get(k) : m?.[k]);
  const per = new Map<string, Map<number, number>>();
  for (const a of h.actions || []) {
    if (a.amount == null) continue;
    const m = per.get(a.street) ?? new Map<number, number>();
    per.set(a.street, m);
    m.set(a.seatId, a.type === "call" ? (m.get(a.seatId) ?? 0) + a.amount : Math.max(m.get(a.seatId) ?? 0, a.amount));
  }
  const out: string[] = [];
  for (const [seat, behind] of h.wsStack as Map<number, number>) {
    const start = get(h.startStacks, seat);
    if (start === undefined) continue;
    let line = 0;
    for (const m of per.values()) line += m.get(seat) ?? 0;
    const n = (h.actions || []).filter((a: any) => a.seatId === seat && a.amount != null).length;
    const diff = start - behind - (get(h.wsDead, seat) ?? 0) - line;
    const unit = h.lineSource === "reconciled" ? 0.05 : 0.005;
    if (Math.abs(diff) > unit * n + 0.005 + 1e-9) out.push(`seat ${seat} off by ${Math.round(diff * 1000) / 1000} (line ${pyFloatStr(Math.round(line * 100) / 100)}, ${h.lineSource})`);
  }
  return out;
}

const PICKS = ["Fold", "Call", "Check", "Raise 2.5", "BET 3.35", "Bet 33%", "All-in", "RAISE 12", "Limp", "jam",
               "r4", "Bet 4.5bb", "X", "CHECK", "raise", "bet"];
const PLANS = [{ kind: "action", label: "fold" }, { kind: "action", label: "check" },
               { kind: "action", label: "call" }, { kind: "action", label: "all-in" },
               { kind: "action", label: "raise" }, { kind: "action", label: "bet" },
               { kind: "raise-to", amount: "2.5", verb: "raise" }, { kind: "raise-to", amount: "100", verb: "raise" },
               { kind: "raise-to", amount: "7.25", verb: "bet" }];
const TARGET = { id: "replay", webSocketDebuggerUrl: "ws://replay", url: "https://www.ignitioncasino.uno/static/poker-game/replay",
                 title: "replay", type: "page" };

const verdict = (v: TERMINAL.TerminalVerdict) => ({ terminal: v.terminal, kind: v.kind, why: v.why, final_stack_known: v.finalStackKnown, details: v.details });

/** json.dumps([street, board, heroCards, toCall, n]) as Python wrote the synthetic key: toCall is a Python float
 *  (printed "2.0") unless the export's `or 0` made it the int 0. */
function syntheticKey(h: Record<string, any>, n: number): string {
  const tc = (h.currentNode || {}).toCall;
  const tcs = tc === null || tc === undefined ? "null" : tc === 0 ? "0" : pyFloatStr(tc);
  return `[${pyJsonDumps(h.street ?? null)}, ${pyJsonDumps(h.board ?? null)}, ${pyJsonDumps(h.heroCards ?? null)}, ${tcs}, ${n}]`;
}

for (const file of corpusFiles("reader-")) {
  test(`golden: Ignition reader ${file}`, async () => {
    const recs = [...readCorpus(file)];
    const meta = recs[0];
    const slot: string | null = meta.slot;
    // ---- the scenario's environment, exactly as record_reader.py set it
    for (const k of ["TABLE_SLOT", "TABLE_COUNT", "FAKE_TABLE", "PANEL_PORT", "CDP_PORT", "PANEL_TAG", "WRAPPER_HEADLESS"]) delete process.env[k];
    if (slot) {
      process.env.TABLE_SLOT = slot;
      process.env.TABLE_COUNT = "2";
    }
    const tmp = mkdtempSync(join(tmpdir(), `golden-reader-`));
    mkdirSync(join(tmp, "data"));
    process.env.WRAPPER_DATA_DIR = join(tmp, "data");
    process.env.WRAPPER_DEBUG_DIR = join(tmp, "debug");
    reloadConfig();
    resetState();
    setFakeTime(meta.t0);

    const cur: { d: any; events: any[] } = { d: {}, events: [] };
    const effects: any[] = [];
    const io0 = { ...cdp.io };
    const seams0 = { ...seams };
    cdp.io.available = async () => true;
    cdp.io.pageTargets = async () => [{ ...TARGET }];
    cdp.io.evaluate = async (_ws: string, expr: string) => {
      if (expr === tableJs(mySel())) return structuredClone(cur.d);
      if (expr === watchJs(mySel())) {
        const ev = cur.events;
        cur.events = [];
        return ev;
      }
      if (expr === "document.visibilityState") return "visible";
      effects.push({ eval: [...expr].slice(0, 80).join("") });
      return null;
    };
    cdp.io.dispatchClick = async (_ws: string, x: number, y: number) => { effects.push({ click: [x, y] }); };
    seams.ignitionTarget = async () => ({ ...TARGET });
    seams.act = async (label: string, kind = "action") => {
      effects.push({ act: [label, kind] });
      return { ok: true, clicked: label, kind, at: [0, 0] };
    };
    seams.raiseTo = async (amount: string, strict = false) => {
      effects.push({ raise_to: [amount, strict] });
      return { ok: true };
    };
    seams.cdpSeq = async (_ws: string, cmds: [string, Record<string, unknown>][]) => { effects.push({ cdp_seq: cmds.map((c) => c[0]) }); };
    seams.registry = () => [];
    seams.livePeers = async () => [];
    Object.assign(S.liveStatus, meta.initLive || {});
    const log0 = console.log;
    console.log = () => {};

    let lastRow = 0;
    let dumpSeen = 0;
    const loop = { fails: 0 };
    const fails: string[] = [];
    const expected: Record<string, unknown> = {};
    let compared = 0;
    Object.assign(guarded, { picks: 0, lagTicks: 0, byHand: new Map() });
    const ledger = { seats: 0, bad: new Map<string, string>(), corrupt: new Set<string>() };
    const handRids = new Map<string, Set<string>>();
    let lastMoney = "";
    const rebased: string[] = [JSON.stringify(meta)];     // GOLDEN_UPDATE: the corpus rewritten from this implementation
    const prev = new Map<string, string>();
    try {
      let k = 0;
      for (let r = 1; r < recs.length && (UPDATE || fails.length < 6); r++) {
        const inp = recs[r];
        if (inp.type !== "in") continue;
        const outRec = recs[r + 1] && recs[r + 1].type === "out" && recs[r + 1].i === inp.i ? recs[++r] : null;
        k = inp.i;
        setFakeTime(Math.max(time(), inp.ts));
        effects.length = 0;
        if (inp.kind === "dom") {
          cur.d = inp.d;
          cur.events = [...(inp.events || [])];
          await feedLoopOnce(loop, (kind, e) => effects.push({ [kind === "tick" ? "tickError" : "chainError"]: String(e?.stack ?? e).slice(0, 300) }));
        } else {
          try {
            tapFrame(inp.d, inp.rid ?? null);
          } catch (e: any) {
            effects.push({ tapError: String(e?.stack ?? e).slice(0, 300) });
          }
        }
        const h = handState();
        if (inp.kind === "ws" && ["CO_SELECT_INFO", "CO_SELECT_SPEED_INFO", "CO_BLIND_INFO"].includes(inp.d?.pid)) {
          const hk = String(S.handIds.get(S.handNo) ?? S.handNo);
          const rs = handRids.get(hk) ?? new Set<string>();
          handRids.set(hk, rs);
          rs.add(String(inp.rid ?? ""));
          const money = JSON.stringify(inp.d);
          if (money === lastMoney) ledger.corrupt.add(hk);
          lastMoney = money;
          if (rs.size > 1) ledger.corrupt.add(hk);
        }
        if (h?.wsStack && h.currentNode?.toActIsHero && !h.ended) {
          ledger.seats += h.wsStack.size;
          const hk = String(S.handIds.get(S.handNo) ?? S.handNo);
          const why = ledgerDisagreements(h);
          if (process.env.WS_LEDGER_ALL && why.length) log0(`LEDGER ${file} ${hk} input ${inp.i} ${h.street} toCall ${h.currentNode.toCall}: ${why.join("; ")} :: ${JSON.stringify(h.actions.map((a: any) => [a.street[0], a.seatId, a.type, a.amount ?? null]))} ws=${JSON.stringify(Object.fromEntries(h.wsStack))} start=${JSON.stringify(Object.fromEntries(h.startStacks))}`);
          if (why.length && !ledger.bad.has(hk)) ledger.bad.set(hk, `input ${inp.i}: ${why.join("; ")}`);
        }
        const light = await state(true);
        for (const x of ["panelVersion", "setupVersion", "tables"]) delete light[x];
        const rc = S.shadow.rc;
        let pick: unknown = null;
        if (h) {
          const saved = structuredClone(S.study);
          try {
            // the key stands in for the API's, which never counts a post-in (utils/foldPostIns; relay.ts, 2026-09-25)
            const n = (h.actions || []).filter((a: any) => a.type !== "post").length;
            Object.assign(S.study, { on: true, text: "golden", pick: PICKS[k % PICKS.length],
                                     decisionKey: syntheticKey(h, n + (k % 7 === 0 ? 1 : 0)),
                                     handId: k % 11 ? h.handId ?? null : (h.handId || 0) + 1, at: time(), executed: null });
            pick = normPy(pickReady());
          } finally {
            for (const key of Object.keys(S.study)) delete S.study[key];
            Object.assign(S.study, saved);
          }
        }
        const archived: any[] = [];
        const dbp = join(tmp, "data", "hands.db");
        if (existsSync(dbp)) {
          const c = new Database(dbp);
          try {
            for (const row of c.query("SELECT rowid, hand_id, played_at, stakes, street, result_text, result_amount, hero_cards,"
                                      + " action_count, data FROM hands WHERE rowid > ? ORDER BY rowid").all(lastRow) as any[]) {
              lastRow = Math.max(lastRow, row.rowid);
              archived.push({ ...row, data: JSON.parse(row.data) });
            }
          } finally {
            c.close();
          }
        }
        const allv = S.wsDump;
        const fresh = allv.length >= dumpSeen ? allv.slice(dumpSeen) : allv;
        dumpSeen = allv.length;
        const dump = fresh.map((e) => {
          const rec: any = {};
          for (const key of ["hand", "pid", "seat", "rid", "status"]) if (key in e) rec[key] = e[key];
          if (e.replayed) rec.replayed = true;
          if (String(e.pid ?? "").startsWith("<")) rec.data = normPy(e.data);
          return rec;
        });
        const snap: Record<string, unknown> = {
          hand: normPy(h),
          light: normPy(light),
          live: normPy(S.liveStatus),
          handNo: S.handNo,
          handIds: normPy(S.handIds),
          ws: normPy(S.ws),
          feedPrev: normPy(S.feedPrev),
          feedTail: normPy(S.feed.slice(-40)),
          tap: {
            bound: S.tapBound, foreign: S.tapForeign, held: S.tapHeld, seen: normPy(S.tapSeen),
            claims: normPy(S.tapClaims), rejected: normPy(S.tapRejected),
            hold: Object.fromEntries([...S.tapHold].map(([rid, v]) => [String(rid), v.length])),
            mismatch: S.tapMismatch, domCards: normPy(S.tapDomCards), stall: normPy(S.tapStall),
          },
          rc: rc === null ? null : normPy({
            hand: S.shadow.hand, journal: rc.journal, violations: rc.violations, faults: rc.faults(), armed: rc.armed,
            ended: rc.ended, street: rc.street, live: rc.live, dealt: rc.dealt, allin: rc.allin, sb: rc.sb, bbs: rc.bbs,
            hero: rc.hero, C: rc.C, maxBet: rc.maxBet, revivals: rc.revivals,
          }),
          shadow: normPy({ agree: S.shadow.agree, differ: S.shadow.differ, last: S.shadow.last }),
          health: normPy(S.stateHealth),
          seatMem: normPy(S.seatMem),
          handBlinds: normPy(S.handBlinds), handBoard: normPy(S.handBoard), roundSeen: normPy(S.roundSeen),
          winsSeen: normPy(S.winsSeen), resultSeen: normPy(S.resultSeen), awards: normPy(S.awards),
          toasts: normPy(S.toastsSeen), modalState: normPy(S.modalState),
          study: normPy(Object.fromEntries(["lastTopUp", "stackStable", "topUpHand", "topUpDue", "autoNotFired", "uncertain"]
                                             .map((key) => [key, S.study[key] ?? null]))),
          lastArchived: normPy(S.lastArchived),
          pick,
          terminal: h ? { plans: PLANS.map((p) => normPy(verdict(TERMINAL.isTerminal(p, h)))), heroDone: normPy(verdict(TERMINAL.heroDone(h))) } : null,
          archived: normPy(archived),
          dump,
          effects: normPy(effects),
        };
        if (inp.kind === "dom") {
          const d = inp.d;
          const hasStrip = !!((d.frame && Object.keys(d.frame).length) || (d.buttons && d.buttons.length));
          let acts: any[] = [], presets: any[] = [];
          if (hasStrip) {
            try {
              [acts, presets] = splitStrip(d);
            } catch (e: any) {
              presets = [{ error: String(e) }];
            }
          }
          snap.dom = normPy({
            board: boardCards(d), heroCards: heroCards(d), seats: parseSeats(d),
            actions: acts.map((a) => a.text ?? null), presets: presets.map((p) => p.text ?? null),
            toAct: hasStrip ? toAct(d) : null, heroSeatDom: domHeroSeat(d), modal: modalOf(d),
            table: await tableState(),
          });
        }
        if (UPDATE) {
          rebased.push(JSON.stringify(inp));
          const delta: Record<string, unknown> = { type: "out", i: inp.i };
          for (const [key, raw] of Object.entries(snap)) {
            const v = normPy(supersededHu(key, dropPostRecording(raw)));
            const enc = canon(v);
            if (prev.get(key) !== enc) {
              delta[key] = v;
              prev.set(key, enc);
            }
          }
          rebased.push(JSON.stringify(delta));
          compared++;
          continue;
        }
        if (!outRec) continue;
        for (const [key, v] of Object.entries(outRec)) if (key !== "type" && key !== "i") expected[key] = v;
        for (const [key, raw] of Object.entries(snap)) {
          if (!(key in expected)) continue;
          const v = supersededHu(key, dropPostRecording(raw));
          // re-synced like any divergence: state that outlives the hand (lastArchived) keeps the corrected value
          if (huLineFixed(file, inp.i, key)) {
            expected[key] = normPy(v);
            continue;
          }
          const [vv, ww] = supersededCrossTable(key, v, supersededHu(key, expected[key]));
          if (canon(vv) !== canon(ww)) {
            const hk = String(S.handIds.get(S.handNo) ?? S.handNo);
            const why = key === "pick" && v && typeof v === "object"
              ? ` (hand ${hk}${ledger.corrupt.has(hk) ? ", a mixed/duplicated stream" : ""}; reason: ${JSON.stringify((v as any).reason ?? null)})`
              : key === "tap" ? ` (frame ${JSON.stringify(S.tapDomCards)}, socket ${JSON.stringify(S.ws.heroCards)}, hand before ${JSON.stringify(S.tapPrevHero)}, dealt ${(time() - S.tapDealtAt).toFixed(1)} s ago)` : "";
            fails.push(`input ${inp.i} (${inp.kind}${inp.kind === "ws" ? " " + inp.d.pid : ""}) ${key}: ${firstDiff(v, expected[key])}${why}`);
            // re-sync this key so one divergence is reported once, not on every later input
            expected[key] = normPy(v);
          }
        }
        compared++;
      }
    } finally {
      console.log = log0;
      Object.assign(cdp.io, io0);
      Object.assign(seams, seams0);
      realTime();
    }
    if (UPDATE) {
      const body = rebased.map((x) => x + String.fromCharCode(10)).join("");
      writeFileSync(join(CORPUS, file), Bun.gzipSync(new TextEncoder().encode(body), { level: 9 }));
      console.log(`${file}: re-baselined, ${compared} snapshots`);
      return;
    }
    console.log(`${file}: ${compared} snapshots compared, ${fails.length} difference(s)`
      + (guarded.picks || guarded.lagTicks ? ` (cross-table fixes: ${guarded.picks} pick(s) refused by the hole-card guard, ${guarded.lagTicks} deal-lag tick(s) not counted)` : ""));
    if (process.env.GOLDEN_GUARD_LOG) {
      for (const [hk, what] of guarded.byHand) console.log(`  guard ${file} ${hk}${ledger.corrupt.has(hk) ? " [mixed/duplicated stream]" : KNOWN_WRONG_LINES[hk] ? " [known-wrong line]" : ""}: ${what}`);
    }
    const cleanBad = [...ledger.bad].filter(([hk]) => !ledger.corrupt.has(hk) && !KNOWN_WRONG_LINES[hk]);
    const knownWrong = [...ledger.bad].filter(([hk]) => !ledger.corrupt.has(hk) && KNOWN_WRONG_LINES[hk]);
    console.log(`${file}: exact chips vs the exported line at hero's decisions — ${ledger.seats} seat-snapshots, ${cleanBad.length} clean hand(s) disagree` +
      `${knownWrong.length ? `, ${knownWrong.length} known-wrong line(s) refused (${knownWrong.map(([hk]) => `${hk}: ${KNOWN_WRONG_LINES[hk]}`).join("; ")})` : ""}` +
      `${ledger.bad.size - cleanBad.length - knownWrong.length ? `, ${ledger.bad.size - cleanBad.length - knownWrong.length} mixed/duplicated-stream hand(s) refused` : ""}` +
      `${cleanBad.length ? `: ${cleanBad.map(([hk, w]) => `${hk} ${w}`).join(" | ")}` : ""}`);
    expect(fails).toEqual([]);
    expect(cleanBad).toEqual([]);
  }, 900_000);
}
