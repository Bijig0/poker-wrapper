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
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { pyFloatStr, pyJsonDumps } from "../../src/py";
import { S, resetState, seams } from "../../src/state";
import * as TABLES from "../../src/tables";
import * as TERMINAL from "../../src/terminal";
import { boardCards, domHeroSeat, heroCards, modalOf, parseSeats, splitStrip, tableJs, toAct, watchJs } from "../../src/ignition/dom";
import { handState } from "../../src/ignition/hand";
import { tableState } from "../../src/ignition/reader";
import { tapFrame } from "../../src/ignition/ws";
import { pickReady } from "../../src/relay";
import { feedLoopOnce } from "../../src/loops";
import { state } from "../../src/view";
import "../../src/session";
import { canon, corpusFiles, firstDiff, normPy, readCorpus } from "./lib";

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
const huLineFixed = (file: string, i: number, key: string) =>
  HU_LINE_KEYS.has(key) && (HU_LINE_FIXED.get(file) || []).some(([a, b]) => i >= a! && i <= b!);

const PICKS = ["Fold", "Call", "Check", "Raise 2.5", "BET 3.35", "Bet 33%", "All-in", "RAISE 12", "Limp", "jam",
               "r4", "Bet 4.5bb", "X", "CHECK", "raise", "bet"];
const PLANS = [{ kind: "action", label: "fold" }, { kind: "action", label: "check" },
               { kind: "action", label: "call" }, { kind: "action", label: "all-in" },
               { kind: "action", label: "raise" }, { kind: "action", label: "bet" },
               { kind: "raise-to", amount: "2.5", verb: "raise" }, { kind: "raise-to", amount: "100", verb: "raise" },
               { kind: "raise-to", amount: "7.25", verb: "bet" }];
const TARGET = { id: "replay", webSocketDebuggerUrl: "ws://replay", url: "https://www.ignitioncasino.eu/static/poker-game/replay",
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
      if (expr === tableJs(TABLES.domSlot())) return structuredClone(cur.d);
      if (expr === watchJs(TABLES.domSlot())) {
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
    try {
      let k = 0;
      for (let r = 1; r < recs.length && fails.length < 6; r++) {
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
        const light = await state(true);
        for (const x of ["panelVersion", "setupVersion", "tables"]) delete light[x];
        const rc = S.shadow.rc;
        let pick: unknown = null;
        if (h) {
          const saved = structuredClone(S.study);
          try {
            const n = (h.actions || []).length;
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
            bound: S.tapBound, foreign: S.tapForeign, held: S.tapHeld, seen: normPy(S.tapSeen), dealt: normPy(S.tapDealt),
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
        if (!outRec) continue;
        for (const [key, v] of Object.entries(outRec)) if (key !== "type" && key !== "i") expected[key] = v;
        for (const [key, raw] of Object.entries(snap)) {
          if (!(key in expected)) continue;
          const v = supersededHu(key, raw);
          // re-synced like any divergence: state that outlives the hand (lastArchived) keeps the corrected value
          if (huLineFixed(file, inp.i, key)) {
            expected[key] = normPy(v);
            continue;
          }
          if (canon(v) !== canon(supersededHu(key, expected[key]))) {
            fails.push(`input ${inp.i} (${inp.kind}${inp.kind === "ws" ? " " + inp.d.pid : ""}) ${key}: ${firstDiff(v, expected[key])}`);
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
    console.log(`${file}: ${compared} snapshots compared, ${fails.length} difference(s)`);
    expect(fails).toEqual([]);
  }, 900_000);
}
