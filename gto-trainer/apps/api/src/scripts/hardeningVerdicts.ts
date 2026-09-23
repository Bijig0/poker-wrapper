/**
 * THE PER-DECISION VERDICT TABLE (hardening pass, 2026-09-23; port of ignition-study-wrapper/tests/backtest/
 * verdicts.py, 2026-09-24 — no Python left in the wrapper's tooling).
 *
 *   bun src/scripts/hardeningVerdicts.ts [--out DIR]          (from gto-trainer/apps/api)
 *
 * One row per hero decision in the archive, four columns of truth side by side:
 *   CAPTURE   the archived line (complete) beside the WS-only snapshot the raw frames give at the moment the client
 *             asked hero to act (apps/wrapper/src/tools/replayWsDecisions.ts -> tests/backtest/ws_decisions.jsonl),
 *             and the capture faults captureFaults names on the archived line.
 *   ANSWER    what the table got THEN (every answers.sqlite row for that decision) and what the CURRENT solve path
 *             returns NOW (hardeningBacktest.ts -> src/scripts/hardening_backtest.jsonl).
 *   EXECUTE   what the wrapper did with it: the pick-executed / pick-outcome / pick-refused / study-auto-held events
 *             of the session (sessions.sqlite), hero's archived action, whether it FOLLOWED the pick, and whether
 *             auto was armed with no press recorded (a manual takeover or a missed press).
 *   VERDICT   OK · FIXED · STILL(<class>) · BROKE · CORRECT-REFUSAL · NEVER-ASKED · SKIPPED · UNVERIFIED
 *
 * A refusal of a capture that is provably corrupt is CORRECT behaviour, never a regression. The root-cause class of
 * every STILL comes from the solver's reason and is reported by DISTINCT HAND (one corrupt hand fires the same
 * reason at every decision). Inputs are read-only. Outputs: <out>/verdicts.csv, <out>/summary.json, summary.md.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pyJsonDumps, pyRepr, pyStr, PyTuple } from "../../../wrapper/src/py";

const REPO = resolve(import.meta.dir, "../../../../..");
const WR = join(REPO, "ignition-study-wrapper");
const API = join(REPO, "gto-trainer", "apps", "api");
const HANDS_DB = join(WR, "data", "hands.db");
const SESSIONS_DB = join(WR, "data", "sessions.sqlite");
const ANSWERS_DB = join(API, "data", "answers.sqlite");
const BACKTEST = join(API, "src", "scripts", "hardening_backtest.jsonl");
const WS_DECISIONS = join(WR, "tests", "backtest", "ws_decisions.jsonl");
const OUT = join(WR, "tests", "backtest", "out");
const STRATEGY = "ign200-ring-6max-equilibrium";
const BLINDS = new Set(["post-sb", "post-bb"]);

type Row = Record<string, any>;
const ro = (path: string) => new Database(path, { readonly: true });
const isNum = (x: unknown): x is number => typeof x === "number";
const truthy = (x: unknown) => !(x === null || x === undefined || x === false || x === 0 || x === "" || (Array.isArray(x) && !x.length));
/** A Counter: insertion-ordered counts, as dict(Counter(...)) prints them. */
function counter<T>(xs: Iterable<T>): Map<T, number> {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}
const jsonl = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : []);

interface Session { strategy: unknown; format: unknown; tables: unknown; autoWindows: [number | null, number][]; events: Map<unknown, any[]>;
                    started: unknown; ended: number | null; test: boolean }

const EVENT_KINDS = new Set(["pick-executed", "pick-outcome", "pick-refused", "pick-retried", "study-auto-held", "study-auto-resumed",
  "time-bank", "top-up-prefold", "unknown-modal", "request-without-buttons", "buttons-without-request", "dealt-without-cards"]);

/** session id -> {strategy, format, tables, auto windows [(from, to)], events by wrapper hand no}. */
function loadSessions(): Map<string, Session> {
  const out = new Map<string, Session>();
  const c = ro(SESSIONS_DB);
  for (const r of c.query("SELECT id, started_at, ended_at, config, events FROM sessions").all() as any[]) {
    const cfg = JSON.parse(r.config || "{}");
    const events: any[] = JSON.parse(r.events || "[]");
    // auto-execute windows: study-auto on:true .. (study-auto on:false | study-auto-expired | session end)
    const windows: [number | null, number][] = [];
    let openAt: number | null | undefined = undefined;
    for (const e of events) {
      const k = e.kind;
      const at = isNum(e.at) ? e.at : null;
      if (k === "study-auto" && truthy(e.on) && openAt === undefined) openAt = at;
      else if (k === "study-auto-expired" || (k === "study-auto" && !truthy(e.on))) {
        if (openAt !== undefined) {
          windows.push([openAt, at || r.ended_at || 4e12]);
          openAt = undefined;
        }
      }
    }
    if (openAt !== undefined) windows.push([openAt, r.ended_at || 4e12]);
    const byHand = new Map<unknown, any[]>();
    for (const e of events) {
      if (!EVENT_KINDS.has(e.kind)) continue;
      const h = e.hand ?? null;
      if (!byHand.has(h)) byHand.set(h, []);
      byHand.get(h)!.push(e);
    }
    out.set(r.id, { strategy: cfg.strategy ?? null, format: cfg.format ?? null, tables: cfg.tables ?? null, autoWindows: windows,
                    events: byHand, started: r.started_at, ended: r.ended_at, test: pyStr(cfg.format ?? null).includes("NL5") });
  }
  return out;
}

/** (clientHandId, idx) -> [rows]. */
function loadAnswers(): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const d of ro(ANSWERS_DB).query("SELECT * FROM answers WHERE client_hand_id IS NOT NULL").all() as Row[]) {
    let idx: number;
    try {
      idx = Math.trunc(Number(JSON.parse(d.decision_key)[4]));
      if (!Number.isFinite(idx)) continue;
    } catch {
      continue;
    }
    const key = `${pyStr(d.client_hand_id)}|${idx}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(d);
  }
  return out;
}

function loadBacktest(): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const l of jsonl(BACKTEST)) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      out.set(`${r.dbId}|${r.upto}`, r);
    } catch {}
  }
  return out;
}

/** clientHandId -> WS-only snapshots at hero's turn. */
function loadWsDecisions(): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const l of jsonl(WS_DECISIONS)) {
    try {
      const r = JSON.parse(l);
      if (!truthy(r.clientHandId)) continue;
      const k = pyStr(r.clientHandId);
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(r);
    } catch {}
  }
  return out;
}

/** A capture with no hero cards or a board that is not a street has no spot to solve: refusing it is correct. */
function unsolvable(now: Row): boolean {
  const r = pyStr(now.reason || "");
  return r.includes("cards are not known") || r.includes("street frame was missed") || r.includes("no street deals");
}

const lineOf = (actions: Row[]) => actions.map((a) => `${pyStr(a.seatId ?? null)}:${pyStr(a.type ?? null)}${a.amount === null || a.amount === undefined ? "" : ":" + pyStr(a.amount)}`).join(" ");

/** Did hero's archived action follow the pick? null = cannot tell. */
function heroActionMatches(pick: string | null, act: Row): boolean | null {
  if (!pick) return null;
  const p = pick.trim().toLowerCase();
  const t = String(act.type || "").toLowerCase();
  const amt = act.amount ?? null;
  if (p.startsWith("fold")) return t === "fold";
  if (p.startsWith("check")) return t === "check";
  if (p.startsWith("call") || p.startsWith("limp")) return t === "call" || t === "all-in";
  if (p.startsWith("all") || p.startsWith("jam") || p.startsWith("shove")) return t === "all-in" || t === "raise" || t === "bet";
  if (p.startsWith("raise") || p.startsWith("bet") || p.slice(0, 1) === "r") {
    if (!["raise", "bet", "all-in"].includes(t)) return false;
    const m = /(\d+(?:\.\d+)?)/.exec(p);
    if (!m || amt === null) return null;
    const want = Number(m[1]);
    return Math.abs(Number(amt) - want) <= Math.max(0.12 * want, 0.05);
  }
  return null;
}

/** csv.DictWriter's cell: None -> "", bools True/False, numbers as Python prints them; QUOTE_MINIMAL. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : pyStr(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main(argv: string[]): number {
  const outDir = argv.includes("--out") ? resolve(argv[argv.indexOf("--out") + 1]!) : OUT;
  mkdirSync(outDir, { recursive: true });
  const sessions = loadSessions(), answers = loadAnswers(), backtest = loadBacktest(), ws = loadWsDecisions();

  const rows: Row[] = [];
  for (const h of ro(HANDS_DB).query("SELECT rowid, played_at, stakes, data FROM hands ORDER BY rowid").all() as any[]) {
    const rowid: number = h.rowid, played: number | null = h.played_at, stakes: string | null = h.stakes;
    const d = JSON.parse(h.data);
    const sid = d.sessionId ?? null;
    const sess = sid ? sessions.get(sid) ?? null : null;
    const inScope = sess ? sess.strategy === STRATEGY : stakes === "$1.00/$2.00" && (played || 0) >= 1789689600000;
    if (!inScope) continue;
    const chid = pyStr(d.clientHandId || "");
    const acts: Row[] = d.actions || [];
    const heroNo = d.handId ?? null;
    const ev: any[] = sess ? sess.events.get(heroNo) ?? [] : [];
    const autoOn = sess ? sess.autoWindows.some(([a, b]) => (a ?? -Infinity) <= (played || 0) && (played || 0) <= b) : false;
    // decisions this hand in order, to match pick events by order when there are several
    const decIdx = acts.map((a, i) => [a, i] as const).filter(([a]) => truthy(a.hero) && !BLINDS.has(a.type)).map(([, i]) => i);
    const picks = ev.filter((e) => e.kind === "pick-executed");
    const outcomes = ev.filter((e) => e.kind === "pick-outcome");
    const refused = ev.filter((e) => e.kind === "pick-refused");
    const held = ev.filter((e) => e.kind === "study-auto-held");
    const snaps = ws.get(chid) ?? [];
    decIdx.forEach((i, n) => {
      const a = acts[i]!;
      const bt = backtest.get(`${rowid}|${i}`) ?? null;
      const ans = chid ? answers.get(`${chid}|${i}`) ?? [] : [];
      const thenOk = ans.length ? ans.some((r) => truthy(r.text)) : null;
      const thenPick = ans.find((r) => truthy(r.text))?.pick ?? null;
      // EVERY pick the table was shown: more than one distinct pick means the decision was re-solved and RE-ROLLED
      // live (the decisionKey carries toCall, which flickers) — the pick could flip under hero
      const thenPicks = [...new Set(ans.filter((r) => truthy(r.text) && truthy(r.pick)).map((r) => pyStr(r.pick)))].sort();
      const rerolled = thenPicks.length > 1;
      const thenKinds = [...new Set(ans.map((r) => r.fail_kind || (truthy(r.text) ? "ok" : "unknown")))].sort();
      // WS-only snapshot with the same action count at hero's turn, if the raw frames covered this hand
      const snap = snaps.find((s) => truthy(s.exported) && s.nActions === i) ?? null;
      const snapAny = n < snaps.length ? snaps[n]! : null;
      let capture = "no-dump";
      if (snaps.length) {
        if (snap) {
          const pairs = (xs: Row[]) => JSON.stringify(xs.map((x) => [x.seatId ?? null, x.type ?? null]));
          capture = pairs(snap.actions) === pairs(acts.slice(0, i)) ? "ws-identical" : "ws-divergent";
        } else if (snapAny && truthy(snapAny.exported)) {
          capture = (snapAny.nActions || 0) < i ? `ws-missing-actions(${pyStr(snapAny.nActions ?? null)}<${i})` : `ws-extra-actions(${pyStr(snapAny.nActions ?? null)}>${i})`;
        } else if (snapAny) capture = `ws-not-exported(${pyStr(snapAny.why ?? null)})`;
        else capture = "ws-no-turn-frame";
      }
      const faults: string[] = bt ? ((bt.capture || {}).faultsAtDecision ?? []) : [];
      // the press for THIS decision: the pick-executed event nearest in time to the decision's answer rows
      const ansTs = ans.map((r) => r.ts).filter(truthy) as number[];
      let pickEv: any = null;
      if (ansTs.length && picks.length) {
        const t0 = Math.min(...ansTs);
        const cands = picks.filter((e) => isNum(e.at) && -2000 <= e.at - t0 && e.at - t0 <= 60000);
        pickEv = cands.length ? cands.reduce((best, e) => (Math.abs(e.at - t0) < Math.abs(best.at - t0) ? e : best)) : null;
      }
      if (pickEv === null && n < picks.length && !ansTs.length) pickEv = picks[n];
      let outEv: any = null;
      if (pickEv) {
        const later = outcomes.filter((e) => isNum(e.at) && 0 <= e.at - (pickEv.at || 0) && e.at - (pickEv.at || 0) <= 15000);
        outEv = later.length ? later.reduce((best, e) => (e.at - pickEv.at < best.at - pickEv.at ? e : best)) : null;
      }
      let followed: boolean | null = null;
      for (const pk of thenPicks.length ? thenPicks : [thenPick]) {
        const m = heroActionMatches(pk, a);
        if (m) { followed = true; break; }
        if (m === false) followed = false;
      }
      let execState: string;
      if (pickEv) execState = `executed:${pyStr(pickEv.source ?? null)}`;
      else if (n < refused.length) execState = "refused";
      else if (autoOn && thenOk) execState = "MANUAL-OR-MISSED (auto armed, answer on panel, no press recorded)";
      else if (autoOn) execState = "auto armed, no answer";
      else execState = "manual session";
      const now: Row | null = bt ? bt.now ?? null : null;
      const nowReason = pyStr(now?.reason ?? "");
      const refusalOk = () => truthy(now!.correctRefusal) || faults.length > 0 || unsolvable(now!);
      let verdict: string;
      if (bt === null) verdict = "NOT-REPLAYED";
      else if (!now!.ok && (nowReason.startsWith("skipped") || nowReason.includes("GTOW_RESERVE") || nowReason.includes("GTOW_BLOCK"))) verdict = "SKIPPED(cloud budget)";
      else if (!now!.ok && String(now!.bucket ?? "").startsWith("infra/")) verdict = "UNVERIFIED(infra)";
      else if (thenOk === null) verdict = "NEVER-ASKED";
      else if (thenOk && now!.ok) verdict = "OK";
      else if (thenOk && !now!.ok) verdict = refusalOk() ? "CORRECT-REFUSAL" : "BROKE";
      else if (!thenOk && now!.ok) verdict = "FIXED";
      else verdict = !refusalOk() ? `STILL(${pyStr(now!.bucket ?? null)})` : "CORRECT-REFUSAL";
      rows.push({
        dbId: rowid, idx: i, clientHandId: chid, session: sid, test_stake: !!(sess && sess.test),
        playedAt: played, stakes, street: a.street ?? null, heroPos: (d.positions || {})[pyStr(d.heroSeatId ?? null)] ?? null,
        seats: Object.keys(d.positions || {}).length, heroCards: (d.heroCards || []).join(" "),
        hero_action: `${pyStr(a.type ?? null)}${a.amount === null || a.amount === undefined ? "" : " " + pyStr(a.amount)}`,
        line_before: lineOf(acts.slice(0, i)),
        capture_ws: capture, capture_faults: faults.join("; "), lineSource: d.lineSource ?? null, lineUncertain: d.lineUncertain ?? null,
        then_probed: ans.length > 0, then_rows: ans.length, then_ok: thenOk, then_kinds: thenKinds.join(","), then_pick: thenPick,
        then_picks_all: thenPicks.join(" | "), rerolled,
        then_reason: [...ans].reverse().find((r) => truthy(r.fail_reason))?.fail_reason ?? null,
        then_latency_ms: ans.find((r) => truthy(r.text))?.latency_ms ?? null,
        now_ok: now ? now.ok : null, now_decision: now && now.ok ? now.decision ?? null : null,
        now_tier: now && now.ok ? now.tier ?? null : null, now_reason: now && !now.ok ? now.reason ?? null : null,
        now_bucket: now && !now.ok ? now.bucket ?? null : null, now_ms: bt?.ms ?? null, gtow_requests: bt?.req ?? null,
        auto_armed: autoOn, exec: execState, exec_pick: pickEv?.pick ?? null, exec_plan: pickEv ? pyJsonDumps(pickEv.plan ?? null) : null,
        exec_outcome: outEv?.outcome ?? null, exec_outcome_why: outEv?.why ?? null,
        followed_pick: followed, held: held.map((x) => x.why ?? "").join("; ") || null,
        verdict,
      });
    });
  }

  // ---- the table ----
  const csvPath = join(outDir, "verdicts.csv");
  const fields = rows.length ? Object.keys(rows[0]!) : ["dbId"];
  const csv = [fields.join(","), ...rows.map((r) => fields.map((f) => csvCell(r[f])).join(","))].map((l) => l + "\r\n").join("");
  writeFileSync(csvPath, csv, "utf8");

  // ---- summaries, by distinct hand and by street ----
  const tally = (key: (r: Row) => unknown) => {
    const by = new Map<unknown, Map<string, number>>(), hands = new Map<unknown, Map<string, Set<number>>>();
    for (const r of rows) {
      const k = key(r);
      if (!by.has(k)) { by.set(k, new Map()); hands.set(k, new Map()); }
      by.get(k)!.set(r.verdict, (by.get(k)!.get(r.verdict) ?? 0) + 1);
      if (!hands.get(k)!.has(r.verdict)) hands.get(k)!.set(r.verdict, new Set());
      hands.get(k)!.get(r.verdict)!.add(r.dbId);
    }
    // Maps keep Python's keys (a None street is "null" in the JSON, None in a repr) and its insertion order
    return new Map([...by].map(([k, v]) => [k, { decisions: v, hands: new Map([...hands.get(k)!].map(([vk, vs]) => [vk, vs.size])) }]));
  };
  const still = rows.filter((r) => r.verdict.startsWith("STILL"));
  const stillBuckets = [...new Set(still.map((r) => r.now_bucket))];
  const tuple = (...xs: unknown[]) => xs;
  const summary: Row = {
    decisions: rows.length, hands: new Set(rows.map((r) => r.dbId)).size,
    verdicts: counter(rows.map((r) => r.verdict)),
    verdicts_by_hand: new Map(),
    by_street: tally((r) => r.street),
    still_by_bucket: counter(still.map((r) => r.now_bucket)),
    // Python iterated a SET of buckets here, so its key order was never stable between runs; first-seen order here
    still_hands_by_bucket: new Map(stillBuckets.map((b) => [b, [...new Set(still.filter((r) => r.now_bucket === b).map((r) => r.dbId as number))].sort((x, y) => x - y)])),
    capture_ws: counter(rows.map((r) => String(r.capture_ws).split("(")[0])),
    capture_faults_hands: new Set(rows.filter((r) => r.capture_faults).map((r) => r.dbId)).size,
    then: { probed: rows.filter((r) => r.then_probed).length, answered: rows.filter((r) => r.then_ok).length,
            never_probed: rows.filter((r) => !r.then_probed).length },
    now: { answered: rows.filter((r) => r.now_ok).length, refused: rows.filter((r) => r.now_ok === false).length,
           not_replayed: rows.filter((r) => r.now_ok === null || r.now_ok === undefined).length },
    exec: counter(rows.map((r) => String(r.exec).split(" (")[0])),
    exec_outcomes: counter(rows.filter((r) => r.exec_outcome).map((r) => r.exec_outcome)),
    followed_pick: counter(rows.filter((r) => r.then_ok).map((r) => pyStr(r.followed_pick))),
    rerolled_live: { decisions: rows.filter((r) => r.rerolled).length, hands: new Set(rows.filter((r) => r.rerolled).map((r) => r.dbId)).size,
                     examples: rows.filter((r) => r.rerolled).map((r) => tuple(r.dbId, r.idx, r.then_picks_all)).slice(0, 12) },
    not_followed: rows.filter((r) => r.followed_pick === false).map((r) => tuple(r.dbId, r.idx, r.street, r.then_picks_all, r.hero_action, String(r.exec).split(" (")[0], r.exec_outcome)),
    manual_or_missed_under_auto: rows.filter((r) => String(r.exec).startsWith("MANUAL")).map((r) => tuple(r.dbId, r.idx, r.street, r.then_pick, r.hero_action)),
    pick_disagreement_then_vs_now: rows.filter((r) => r.then_ok && r.now_ok && String(r.then_pick || "").toLowerCase() !== String(r.now_decision || "").toLowerCase()).length,
    gtow_requests_spent: rows.reduce((s, r) => s + (r.gtow_requests || 0), 0),
  };
  const vh = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!vh.has(r.verdict)) vh.set(r.verdict, new Set());
    vh.get(r.verdict)!.add(r.dbId);
  }
  summary.verdicts_by_hand = new Map([...vh].map(([k, v]) => [k, v.size]));
  writeFileSync(join(outDir, "summary.json"), pyJsonDumps(summary, { indent: 1 }), "utf8");

  // md prints Python reprs: the example lists are lists of TUPLES
  const tup = (xs: unknown[][]) => xs.map((x) => new PyTuple(x));
  const byDesc = (m: Map<any, number>) => [...m].sort((a, b) => b[1] - a[1]);
  const md = [`# Hardening verdicts — ${summary.decisions} hero decisions in ${summary.hands} hands`, "",
              "| verdict | decisions | distinct hands |", "|---|---|---|"];
  for (const [k, v] of byDesc(summary.verdicts)) md.push(`| ${k} | ${v} | ${summary.verdicts_by_hand.get(k) ?? 0} |`);
  md.push("", "## By street (decisions → verdict)", "");
  for (const st of ["preflop", "flop", "turn", "river"]) {
    const t = summary.by_street.get(st);
    if (t) md.push(`- **${st}**: ` + byDesc(t.decisions).map(([k, v]) => `${k} ${v}`).join(", "));
  }
  md.push("", "## Still failing, by root-cause class (distinct hands)", "");
  for (const [b, hs] of [...(summary.still_hands_by_bucket as Map<unknown, number[]>)].sort((x, y) => y[1].length - x[1].length)) {
    md.push(`- ${pyStr(b)}: ${hs.length} hands — dbIds ${pyRepr(hs.slice(0, 20))}${hs.length > 20 ? " …" : ""}`);
  }
  md.push("", "## Capture (WS-only snapshot vs archive at hero's turn)", "",
          ...byDesc(summary.capture_ws).map(([k, v]) => `- ${k}: ${v}`),
          "", "## Execution", "", ...[...(summary.exec as Map<string, number>)].map(([k, v]) => `- ${k}: ${v}`),
          `- outcomes: ${pyRepr(summary.exec_outcomes)}`, `- hero followed the pick (answered decisions): ${pyRepr(summary.followed_pick)}`,
          `- manual-or-missed under auto: ${summary.manual_or_missed_under_auto.length} → ${pyRepr(tup(summary.manual_or_missed_under_auto.slice(0, 15)))}`,
          `- RE-ROLLED LIVE (more than one distinct pick shown for one decision): ${summary.rerolled_live.decisions} decisions in ${summary.rerolled_live.hands} hands — ${pyRepr(tup(summary.rerolled_live.examples.slice(0, 6)))}`,
          `- hero did NOT follow any shown pick: ${summary.not_followed.length} → ${pyRepr(tup(summary.not_followed.slice(0, 12)))}`,
          `- then-vs-now pick disagreement (both answered; rolls differ on mixed spots): ${summary.pick_disagreement_then_vs_now}`,
          `- GTO Wizard requests spent by the replay so far: ${summary.gtow_requests_spent}`, "");
  writeFileSync(join(outDir, "summary.md"), md.join("\n"), "utf8");
  console.log(md.join("\n"));
  console.log(`\n-> ${csvPath}`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
