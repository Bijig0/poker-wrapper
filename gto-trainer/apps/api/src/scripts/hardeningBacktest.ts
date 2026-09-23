/**
 * HARDENING BACKTEST (2026-09-23) — every hero decision in the wrapper's whole archive, replayed through the
 * CURRENT production solve path, beside what the table actually got at the time. The solver half of the
 * per-decision verdict table; src/scripts/hardeningVerdicts.ts joins the executor half
 * (sessions.sqlite pick-executed / pick-outcome events, the archived hero action) and writes the CSV.
 *
 * Extends scripts/sessionBacktest.ts (2026-09-21) in the ways that run made necessary:
 *   - the WHOLE corpus by default (that run took three days), scoped to the sessions that played the 6-max
 *     ring strategy (SCOPE=6max) or everything (SCOPE=all);
 *   - EVERY live answers row for the decision is joined, not the last — a decision asked five times with
 *     five different refusals is five facts, and "then_ok" means ANY row carried text;
 *   - the capture is graded on its own (captureFaults, repairDeadSmallBlind) so a refusal of a corrupt
 *     capture is filed as CORRECT-REFUSAL, never as a failure of the solver — the rotation cross-check was
 *     built to refuse;
 *   - GTO Wizard's REQUEST cap is respected from the shared ledger (services/gtowRequestLog.ts): a decision
 *     that will need the cloud is skipped (not failed) once the account's headroom drops below GTOW_RESERVE,
 *     and cloud decisions are paced by PACE_MS. Requests spent per decision are recorded on the row.
 *
 * ONE WORKER ONLY (three concurrent workers earned 429s in the collapse calibration). Resumable: rows are
 * appended to OUT keyed by "<dbId>|<idx>" and finished keys are skipped on the next run.
 *
 * Run (from gto-trainer/apps/api):
 *   bun src/scripts/hardeningBacktest.ts                        # SCOPE=6max MODE=all
 *   MODE=preflop CLOUD=0 bun src/scripts/hardeningBacktest.ts   # only what the local charts can answer
 *   MODE=postflop PACE_MS=4000 GTOW_RESERVE=400 bun src/scripts/hardeningBacktest.ts
 *   ONLY=657,714 bun src/scripts/hardeningBacktest.ts           # specific dbIds
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { allRows, enrichSync, truncateAt, HANDS_DB } from "../routes/dashboard";
import { answerLog, failKindOf } from "../services/answerLog";
import { fastSolve } from "../services/fastSolve";
import { gtowRequests } from "../services/gtowRequestLog";
import { captureFaults, repairDeadSmallBlind } from "../utils/repairPostflopRotation/repairPostflopRotation";

const OUT = process.env.OUT ?? join(import.meta.dir, "hardening_backtest.jsonl");
const SCOPE = process.env.SCOPE ?? "6max";                       // 6max | all
const MODE = process.env.MODE ?? "all";                          // preflop | postflop | all
const CLOUD = process.env.CLOUD !== "0";                          // 0 = skip decisions that need GTO Wizard
const LIMIT = Number(process.env.LIMIT ?? 1e9);
const ONLY = new Set((process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number));
const PACE_MS = Number(process.env.PACE_MS ?? 3000);             // between CLOUD decisions
const GTOW_RESERVE = Number(process.env.GTOW_RESERVE ?? 350);    // requests to leave for a live session
const STRATEGY = "ign200-ring-6max-equilibrium";
const SESSIONS_DB = join(HANDS_DB, "..", "sessions.sqlite");

/** Blinds are not decisions. */
const isDecision = (a: { hero: boolean; type: string }) => a.hero && a.type !== "post-sb" && a.type !== "post-bb";

/** decision_key is [street, board, cards, toCall, index] — the 5th element is the action index. */
function indexOfAnswer(a: any): number | null {
  try { const k = JSON.parse(a.decision_key ?? "null"); return Array.isArray(k) ? Number(k[4]) : null; } catch { return null; }
}

/**
 * Root-cause buckets for a refusal string. Ordered: the most specific match wins. `capture` buckets are the
 * wrapper's, `tree` the solve library's, `infra` the environment's; `legit` is a refusal that is correct
 * behaviour (hand over, hero not to act).
 */
export function classifyReason(reason: string): string {
  const r = reason.toLowerCase();
  if (/hand is over|hero folded|hand won|uncontested/.test(r)) return "legit/hand-over";
  if (/not hero'?s turn|not to act|action on seat/.test(r)) return "legit/not-to-act";
  if (/429|request limit|quota|daily.*limit|out of allowance|allowance/.test(r)) return "infra/gtow-quota";
  if (/unable to connect|not connected|no gto wizard|no access token|unreachable|timed out|timeout|econnrefused|chart server/.test(r)) return "infra/unreachable";
  if (/skipped \(cloud budget\)|gtow_reserve|gtow_block|blocked by gtow/.test(r)) return "skipped/cloud-budget";
  if (/dead small blind|sb posted the big blind|posted the big blind/.test(r)) return "capture/dead-sb";
  if (/out of rotation|rotation|acts twice|acting twice|twice running/.test(r)) return "capture/rotation";
  if (/didn'?t close|did not close|missed action|ends on villain|ends on a terminal|past a terminal|line continues past/.test(r)) return "capture/line-desync";
  if (/not walkable|fold.*flop#|no preflop action|reaching .* with no/.test(r)) return "capture/street-stamp";
  if (/position unknown|positions? .*unknown|no hero position|geometry/.test(r)) return "capture/position-unknown";
  if (/no hero cards|hero cards|cards unknown|missing cards|cards are not known/.test(r)) return "capture/no-cards";
  if (/board .* has \d+ card|board-incomplete|street frame was missed/.test(r)) return "capture/board-incomplete";
  if (/internally inconsistent|contradict|impossible|phantom/.test(r)) return "capture/inconsistent";
  if (/two limp|second limp|limpers|max_allowed_limps|limp.*ceiling/.test(r)) return "tree/limps";
  if (/node_does_not_exist|not offered|no chart|not in the charts|too far from|off-tree|log-dist|past the ladder|depth/.test(r)) return "tree/gap";
  if (/players reach the flop|no collapse|four-way|multiway|3\+ player|more than three/.test(r)) return "tree/multiway";
  if (/isn'?t in the chart range|not in range|0-weight|zero weight/.test(r)) return "solver/not-in-range";
  if (/no identifiable villain|no decision|never asked|no solution/.test(r)) return "solver/no-solution";
  if (/threw:/.test(r)) return "code/exception";
  return "other";
}

/** Will this decision need GTO Wizard? Heuristic from the shape; used only to honour the budget. */
function needsCloud(hand: any, upto: number): boolean {
  const t = truncateAt(hand, upto);
  if (t.street !== "preflop") return true;
  const seats = Object.keys(hand.positions ?? {}).length;
  if (seats !== 6) return true;
  const vol = t.actions.filter((a: any) => a.type !== "post-sb" && a.type !== "post-bb");
  // a limp (call with no raise before it) sends the spot to the limp charts or the AI piece
  let raised = false;
  for (const a of vol) {
    if (a.type === "raise" || a.type === "bet" || a.type === "all-in") raised = true;
    else if (a.type === "call" && !raised) return true;
  }
  return false;
}

function sessionStrategies(): Map<string, { strategy: string | null; format: string | null; tables: number | null; test: boolean }> {
  const out = new Map();
  if (!existsSync(SESSIONS_DB)) return out;
  const db = new Database(SESSIONS_DB, { readonly: true });
  for (const r of db.query<{ id: string; config: string | null }, []>("SELECT id, config FROM sessions").all()) {
    let cfg: any = {};
    try { cfg = JSON.parse(r.config ?? "{}"); } catch { /* keep {} */ }
    out.set(r.id, { strategy: cfg.strategy ?? null, format: cfg.format ?? null, tables: cfg.tables ?? null, test: /NL5/.test(cfg.format ?? "") });
  }
  db.close();
  return out;
}

const done = new Set<string>();
if (existsSync(OUT)) {
  for (const l of readFileSync(OUT, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { done.add(JSON.parse(l).key); } catch { /* partial line */ }
  }
}
console.error(`${done.size} decisions already replayed; resuming → ${OUT}`);
console.error(`hands.db: ${HANDS_DB} · scope ${SCOPE} · mode ${MODE} · cloud ${CLOUD ? "on" : "OFF"} · reserve ${GTOW_RESERVE} · pace ${PACE_MS} ms`);

const sessions = sessionStrategies();
const rows = allRows().filter((r) => {
  if (ONLY.size) return ONLY.has(r.rowid);
  if (SCOPE === "all") return true;
  let sid: string | null = null;
  try { sid = JSON.parse(r.data).sessionId ?? null; } catch { /* unreadable */ }
  const s = sid ? sessions.get(sid) : null;
  if (s) return s.strategy === STRATEGY;
  // hands before sessionId was stamped: the $1/$2 ring hands of 2026-09-17 onward
  return r.stakes === "$1.00/$2.00" && (r.played_at ?? 0) >= Date.parse("2026-09-17T00:00:00Z");
});
console.error(`${rows.length} archived hands in scope`);

const startReq = gtowRequests.stats().last24h.total;
let n = 0, fixed = 0, stillBad = 0, wasOk = 0, brokeNow = 0, skipped = 0, correctRefusal = 0;
// THE BUDGET GOES TO THE DECISIONS THAT FAILED LIVE FIRST (PRIORITY=failed): a cloud pass over the whole
// corpus is ~300 decisions and several days of the request cap, so the ones that were never answered (or
// never asked) are worth more per request than the ones that were fine.
const PRIORITY = process.env.PRIORITY ?? "failed";
type Job = { row: typeof rows[number]; e: NonNullable<ReturnType<typeof enrichSync>>; i: number; failedLive: boolean };
const jobs: Job[] = [];
for (const row of rows) {
  const e = enrichSync(row);
  if (!e) { console.error(`  ! hand #${row.rowid} unreadable`); continue; }
  const logged = (e.clientHandId ? (answerLog.forHand(e.clientHandId) as any[]) : []).map((a) => ({ ...a, idx: indexOfAnswer(a) }));
  for (let i = 0; i < e.hand.actions.length; i++) {
    if (!isDecision(e.hand.actions[i]!)) continue;
    if (done.has(`${row.rowid}|${i}`)) continue;
    const t = truncateAt(e.hand, i);
    if (MODE === "preflop" && t.street !== "preflop") continue;
    if (MODE === "postflop" && t.street === "preflop") continue;
    const before = logged.filter((a) => a.idx === i);
    jobs.push({ row, e, i, failedLive: !before.some((a) => !!a.text) });
  }
}
if (PRIORITY === "failed") jobs.sort((a, b) => Number(b.failedLive) - Number(a.failedLive));
console.error(`${jobs.length} decisions to replay (${jobs.filter((j) => j.failedLive).length} failed or never asked live${PRIORITY === "failed" ? ", first" : ""})`);

outer: for (const job of jobs) {
  const { row, e, i } = job;
  const hand = e.hand;
  const heroPos = e.summary.heroPos ?? hand.positions?.[hand.heroSeatId] ?? null;
  const sid = (hand as any).sessionId ?? null;
  const sess = sid ? sessions.get(sid) ?? null : null;
  const logged = (e.clientHandId ? (answerLog.forHand(e.clientHandId) as any[]) : []).map((a) => ({ ...a, idx: indexOfAnswer(a) }));
  const faultsWhole = captureFaults(hand);
  const deadSb = repairDeadSmallBlind(hand).note;
  {
    const key = `${row.rowid}|${i}`;
    const t = truncateAt(hand, i);
    if (++n > LIMIT) { console.error("LIMIT reached"); break outer; }

    const before = logged.filter((a) => a.idx === i);
    const thenOk = before.length ? before.some((a) => !!a.text) : null;     // null = never logged (no-probe)
    const thenKinds = [...new Set(before.map((a) => a.fail_kind ?? (a.text ? "ok" : failKindOf(a.fail_reason))))];
    const last = before[before.length - 1] ?? null;
    const cloud = needsCloud(hand, i);
    const faultsHere = captureFaults(t);

    let res: any;
    const reqBefore = gtowRequests.stats().last24h.total;
    const t0 = Date.now();
    if (cloud && !CLOUD) {
      res = { ok: false, reason: "skipped (cloud budget): CLOUD=0" };
      skipped++;
    } else if (cloud && gtowRequests.headroom("primary") < GTOW_RESERVE) {
      console.error(`GTO Wizard headroom below the reserve (${gtowRequests.headroom("primary")} < ${GTOW_RESERVE}) — stopping; re-run to resume`);
      break outer;
    } else {
      try {
        res = await fastSolve({ ...t, currentNode: { ...t.currentNode, toActIsHero: true } }, heroPos,
          { heroPos, strategyId: STRATEGY, origin: "replay", sessionId: sid });
      } catch (err) {
        res = { ok: false, reason: `THREW: ${err instanceof Error ? err.message : err}` };
      }
    }
    const ms = Date.now() - t0;
    const req = gtowRequests.stats().last24h.total - reqBefore;
    const nowOk = !!res.ok;
    const bucket = nowOk ? null : classifyReason(String(res.reason ?? ""));
    // A refusal that names a fault the capture really has is CORRECT behaviour, not a solver failure.
    // a capture with no hero cards or a board that is not a street is unsolvable by construction: refusing it is right
    const isCorrectRefusal = !nowOk && (bucket?.startsWith("capture/") ?? false)
      && (faultsHere.length > 0 || !!deadSb || bucket === "capture/no-cards" || bucket === "capture/board-incomplete");
    if (isCorrectRefusal) correctRefusal++;

    const rec = {
      key, dbId: row.rowid, upto: i, playedAt: row.played_at, clientHandId: e.clientHandId, sessionId: sid,
      sessionStrategy: sess?.strategy ?? null, testStake: sess?.test ?? false, tableSlot: (hand as any).tableSlot ?? null,
      stakes: row.stakes, street: t.street, heroPos, heroCards: hand.heroCards, board: t.board.join(""),
      seats: Object.keys(hand.positions ?? {}).length, nActions: hand.actions.length,
      heroAction: { type: hand.actions[i]!.type, amount: (hand.actions[i] as any).amount ?? null },
      lineSource: (hand as any).lineSource ?? null, lineUncertain: (hand as any).lineUncertain ?? null,
      capture: { faultsAtDecision: faultsHere, faultsWholeHand: faultsWhole, deadSb: deadSb ?? null },
      then: { probed: before.length > 0, rows: before.length, ok: thenOk, kinds: thenKinds,
              lastKind: last?.fail_kind ?? null, lastReason: last?.fail_reason ?? null, lastTier: last?.tier ?? null,
              pick: before.find((a) => a.text)?.pick ?? null, text: before.find((a) => a.text)?.text ?? null,
              latencyMs: before.find((a) => a.text)?.latency_ms ?? null },
      now: nowOk
        ? { ok: true, tier: res.tier ?? null, source: res.source ?? null, decision: res.decision?.action ?? null,
            top: (res.decisions ?? res.decision?.options ?? null), warning: res.warning ?? null, approx: !!res.approx, line: res.line ?? null }
        : { ok: false, reason: String(res.reason ?? "?"), bucket, correctRefusal: isCorrectRefusal },
      cloud, ms, req,
    };
    appendFileSync(OUT, JSON.stringify(rec) + "\n");

    const wasSkipped = !nowOk && String(res.reason ?? "").startsWith("skipped");
    if (wasSkipped) { /* not scored */ }
    else if (thenOk === false && nowOk) fixed++;
    else if (thenOk === false && !nowOk) stillBad++;
    else if (thenOk === true && nowOk) wasOk++;
    else if (thenOk === true && !nowOk) brokeNow++;
    const tag = res.reason?.startsWith("skipped") ? "SKIP " : thenOk === null ? "NEW  " : thenOk && nowOk ? "ok   " : thenOk && !nowOk ? (isCorrectRefusal ? "REFUSE" : "BROKE") : nowOk ? "FIXED" : "still";
    console.error(`  [${n}] ${tag} #${row.rowid}@${i} ${t.street.padEnd(7)} ${String(ms).padStart(6)}ms req=${req}  ` +
      (nowOk ? `${rec.now.decision}` : `${String(rec.now.reason).slice(0, 90)}`));
    if (cloud && CLOUD && PACE_MS > 0 && ms > 200) await new Promise((r) => setTimeout(r, PACE_MS));
  }
}
const spent = gtowRequests.stats().last24h.total - startReq;
console.error(`\nreplayed ${n} decisions — fixed ${fixed}, still failing ${stillBad}, already fine ${wasOk}, regressed ${brokeNow} (of which correct refusals ${correctRefusal}), skipped ${skipped}; GTO Wizard requests spent this run ≈ ${spent}`);
