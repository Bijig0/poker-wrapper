/**
 * What the poller ACTUALLY HAD at each hero decision, replayed from the raw frames (port of the Python
 * tests/replay_ws_decisions.py, 2026-09-24 — the wrapper is TypeScript only now).
 *
 *   bun run src/tools/replayWsDecisions.ts [dump.jsonl ...] [--out FILE]
 *
 * The archive (hands.db) is the COMPLETE capture: by the time a hand is archived every frame has landed and the
 * reconciler has had its say. A live no-answer caused by the export lacking an action at that instant does not
 * reproduce from the archive and looks "fixed". This replays `debug/ws_dump*.jsonl` through the real parser (no
 * client, no DOM, no network) and snapshots handState() at the moment the client asks HERO to act (the rising
 * edge of heroTurn), i.e. the export the poller would have read on that tick, WS-only. One JSON line per
 * snapshot, for the hardening verdict table (gto-trainer/apps/api/src/scripts/hardeningVerdicts.ts), which compares
 * it to the archived hand truncated at the same decision: identical / missing actions / divergent.
 *
 * WS-only is a LOWER BOUND on what the live export had — the DOM backfill and the reconciler are not in this
 * replay — so "missing actions" means "the WS tap alone had not seen them", not "the panel showed a wrong line".
 *
 * SANDBOXED: the parser archives finished hands, so data/ and debug/ are pointed at a throwaway directory before
 * anything runs (an unguarded replay once inserted 13 replayed hands into the real hands.db).
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "replay-ws-"));
process.env.WRAPPER_DATA_DIR = join(sandbox, "data");
process.env.WRAPPER_DEBUG_DIR = join(sandbox, "debug");
mkdirSync(process.env.WRAPPER_DATA_DIR, { recursive: true });

const { paths } = await import("../env");
const { S, resetState } = await import("../state");
const { onGameMsg } = await import("../ignition/ws");
const { handState, positionsAll } = await import("../ignition/hand");
const { pyJsonDumps } = await import("../py");

const ROOT = join(paths().repo, "ignition-study-wrapper");

function replayDecisions(path: string, write: (line: string) => void) {
  const stats = { dump: path, frames: 0, applied: 0, decisions: 0, errors: 0, hands: 0 };
  let prevTurn: unknown = null;
  let prevHand: number | null = null;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    stats.frames++;
    const data = e?.data, pid = e?.pid;
    if (!data || typeof data !== "object" || Array.isArray(data) || !pid || String(pid).startsWith("<")) continue;
    try {
      onGameMsg(data);
      stats.applied++;
    } catch (exc: any) {
      stats.errors++;
      write(pyJsonDumps({ error: `${pid}: ${exc?.message ?? exc}`, frame: stats.frames }));
      continue;
    }
    const handNo = S.handNo;
    if (handNo !== prevHand) {
      prevHand = handNo;
      prevTurn = null;
      stats.hands++;
    }
    const turn = S.ws.heroTurn;
    // the RISING EDGE of the client's request is the tick the poller first sees hero's turn
    if (turn && !prevTurn) {
      let h: Record<string, any> | null;
      try {
        h = handState();
      } catch (exc: any) {
        stats.errors++;
        write(pyJsonDumps({ error: `handState after ${pid}: ${exc?.message ?? exc}`, frame: stats.frames }));
        prevTurn = turn;
        continue;
      }
      const rec: Record<string, any> = {
        dump: basename(path), frame: stats.frames, t: e.t ?? null, ts: e.ts ?? null, rid: e.rid ?? null,
        wrapperHand: handNo, clientHandId: S.handIds.get(handNo) ?? null, exported: !!h,
      };
      if (h) {
        const node = h.currentNode || {};
        Object.assign(rec, {
          street: h.street ?? null, board: h.board ?? null, heroCards: h.heroCards ?? null, heroSeatId: h.heroSeatId ?? null,
          positions: h.positions ?? null, nActions: (h.actions || []).length,
          actions: (h.actions || []).map((a: any) => ({ seatId: a.seatId ?? null, type: a.type ?? null, street: a.street ?? null,
                                                       ...("amount" in a ? { amount: a.amount } : {}) })),
          toCall: node.toCall ?? null, pot: node.pot ?? null, toActIsHero: node.toActIsHero ?? null,
          lineSource: h.lineSource ?? null, lineUncertain: h.lineUncertain ?? null, bbCents: h.bbCents ?? null,
        });
      } else {
        rec.why = !positionsAll().size ? "no dealer/positions yet" : !(S.ws.dealt || []).length ? "no dealt seats" : "hero seat unknown";
      }
      write(pyJsonDumps(rec, { ensureAscii: false }));
      stats.decisions++;
    }
    prevTurn = turn;
  }
  return stats;
}

function main(argv: string[]): number {
  const args = [...argv];
  let outPath: string | null = null;
  const i = args.indexOf("--out");
  if (i >= 0) {
    outPath = resolve(args[i + 1]!);
    args.splice(i, 2);
  }
  const debug = join(ROOT, "debug");
  const dumps = args.length ? args.map((a) => resolve(a))
    : readdirSync(debug).filter((f) => /^ws_dump.*\.jsonl$/.test(f)).sort().map((f) => join(debug, f));
  outPath ??= join(ROOT, "tests", "backtest", "ws_decisions.jsonl");
  mkdirSync(dirname(outPath), { recursive: true });
  const fd = openSync(outPath, "w");
  const log0 = console.log;
  try {
    resetState();
    for (const d of dumps) {
      // a fresh parser per dump: the two dumps are two tables, not one stream
      S.handNo = 0;
      S.handIds.clear();
      for (const k of Object.keys(S.ws)) delete (S.ws as any)[k];
      Object.assign(S.ws, { bb: 0, board: [], pot: null });
      console.log = () => {};            // the parser's own feed lines
      const st = replayDecisions(d, (line) => writeSync(fd, line + "\n"));
      console.log = log0;
      console.log(`${basename(d)}: frames ${st.frames} applied ${st.applied} hands ${st.hands} hero-turn snapshots ${st.decisions} errors ${st.errors}`);
    }
  } finally {
    console.log = log0;
    closeSync(fd);
  }
  console.log(`-> ${outPath}`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
