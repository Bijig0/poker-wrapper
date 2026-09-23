/**
 * Tier 3 — Study Answers end to end, against a live GTO Wizard (port of tests/answer_suite.py, 2026-09-24).
 *
 *   bun run test/rig/answerSuite.ts [name ...]          (WRAPPER_URL = the test rig, default :7701)
 *
 * Loads each fixture onto the fake table, turns the panel's Study Answers switch on, and drives the REAL poller —
 * the loop that answers while you play — then asserts an answer arrived and the pipeline reported no failure.
 *
 * Deliberately NOT asserted: the pick. rollAction samples the mixed strategy per decision, so the same spot
 * legitimately returns Raise on one run and Fold on the next. A fixture may pin the durable parts instead:
 *   "answer": { "contains": ["Raise"], "maxLatencyMs": 25000, "requireChart": true }
 *
 * Skips cleanly (exit 0) when GTO Wizard is not drivable, so it can sit beside the deterministic tiers. It spends
 * GTO Wizard requests (postflop fixtures) — mind the daily cap.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pyJsonDumps, pyRepr, pyStr } from "../../src/py";
import { API, Case, req, rigCheck, sleep, WRAPPER } from "./rig";

const FIXTURES = resolve(import.meta.dir, "../../../../../ignition-study-wrapper/tests/fixtures");
const GTOW_CDP = "http://127.0.0.1:9222/json/version";
const GTOW_LIST = "http://127.0.0.1:9222/json/list";
const ANSWER_TIMEOUT = 90;     // a cold solve is not fast

/**
 * Is GTO Wizard actually drivable, and if not, why? The debug port answering is not enough: the poller drives a
 * page whose URL contains app.gtowizard.com, and the browser can be up while showing a login screen — then every
 * fixture burns its full timeout before failing with nothing useful to say. Name the actual state instead.
 */
async function gtowState(): Promise<[boolean, string]> {
  try {
    await (await fetch(GTOW_CDP, { signal: AbortSignal.timeout(4000) })).text();
  } catch (e: any) {
    return [false, `debug port 9222 not answering (${e?.message ?? e}) — run scripts/start_gtow_ai.ps1`];
  }
  let targets: any[];
  try {
    targets = JSON.parse((await (await fetch(GTOW_LIST, { signal: AbortSignal.timeout(6000) })).text()) || "[]");
  } catch (e: any) {
    return [false, `debug port up but /json/list unreadable (${e?.message ?? e})`];
  }
  const pages = targets.filter((t) => t.type === "page");
  if (pages.some((t) => String(t.url || "").includes("app.gtowizard.com"))) return [true, "app page found"];
  if (!pages.length) return [false, "no page targets yet — the client is still starting"];
  const where = pages.slice(0, 3).map((t) => String(t.url || "").slice(0, 70)).join(", ");
  return [false, `the client is not on the app — showing: ${where}. Sign in / activate GTO Wizard, then rerun.`];
}

const canon = (x: unknown): string => JSON.stringify(x, (_k, v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);

/**
 * Poll the poller until THIS fixture's answer (or failure) arrives. The poller's status is a running log, not a
 * reply: lastAnswer / lastNavFailure persist until overwritten, so waiting for a merely-truthy value returned the
 * PREVIOUS fixture's answer in milliseconds. Only a value DIFFERENT from the snapshot taken before the load counts.
 */
async function waitForAnswer(deadline: number, before: any): Promise<any> {
  const prevAnswer = before.lastAnswer ?? null;
  const prevNav = canon(before.lastNavFailure || {});
  let last: any = {};
  while (Date.now() < deadline) {
    const st = (await req(`${API}/api/study-poller/status`)) || {};
    last = st;
    if (st.lastAnswer && st.lastAnswer !== prevAnswer) return st;
    const nav = st.lastNavFailure;
    if (nav && nav.reason && canon(nav) !== prevNav) return st;   // a definite failure — stop waiting
    await sleep(1.5);
  }
  return last;
}

async function run(path: string, stem: string): Promise<Case> {
  const fx = JSON.parse(readFileSync(path, "utf8"));
  const c = new Case(fx.name || stem);
  const want = (fx.expect || {}).answer || {};
  // snapshot BEFORE the load: the poller can answer the new state within its first tick
  const before = (await req(`${API}/api/study-poller/status`)) || {};
  if (!("spec" in fx)) throw new Error("KeyError('spec')");   // a recording-only fixture: nothing to load
  const load = await req(`${WRAPPER}/faketable/load`, fx.spec);
  if (!load.ok) {
    c.check(false, "state loaded", pyJsonDumps(load));
    return c;
  }
  await sleep(1.4);
  // the panel switch is the poller's gate; and point the poller at the rig under test (it defaults to the live :7700)
  await req(`${WRAPPER}/study-answers`, { on: true });
  await req(`${API}/api/study-poller/start`, { assistiveUrl: WRAPPER });

  const t0 = Date.now();
  const st = await waitForAnswer(t0 + ANSWER_TIMEOUT * 1000, before);
  const elapsed = Date.now() - t0;
  const text: string | null = st.lastAnswer ?? null;
  const nav = st.lastNavFailure || {};
  c.check(!!text, "an answer was produced",
          `after ${elapsed}ms; navFailure=${pyRepr(nav.reason ?? null)} error=${pyRepr(st.lastError ?? null)} gtow=${pyStr(st.gtoWizardConnected ?? null)}`);
  if (!text) return c;
  c.check(!nav.reason, "no navigation failure", pyStr(nav.reason ?? null));
  c.check(!st.lastError, "no poller error", pyStr(st.lastError ?? null));
  c.check(elapsed <= Math.trunc(want.maxLatencyMs ?? ANSWER_TIMEOUT * 1000), "answer within the latency budget", `${elapsed}ms`);
  for (const sub of want.contains || []) c.check(text.toLowerCase().includes(String(sub).toLowerCase()), `answer mentions ${pyRepr(sub)}`, text.slice(0, 120));
  // the push the panel would actually show, gated by the toggle and the TTL
  const state = (await req(`${WRAPPER}/state`)) || {};
  const pa = state.panelAnswer;
  c.check(!!(pa && pa.text), "answer reached the panel", pa ? pyJsonDumps(pa).slice(0, 160) : "no panelAnswer");
  if (want.requireChart) c.check(!text.toLowerCase().includes("generic"), "solved from a chart, not a generic range", text.slice(0, 120));
  return c;
}

async function main(argv: string[]): Promise<number> {
  const [ok, why] = await gtowState();
  if (!ok) {
    console.log(`SKIPPING Tier 3 — GTO Wizard is not drivable: ${why}`);
    return 0;
  }
  console.log(`GTO Wizard ready (${why})`);
  const bad0 = await rigCheck(WRAPPER);
  if (bad0) {
    console.log(bad0);
    return 2;
  }
  try {
    await req(`${API}/api`);
  } catch (e: any) {
    console.log(`api not reachable (${e?.message ?? e})`);
    return 2;
  }
  const wanted = new Set(argv);
  let files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
  if (wanted.size) {
    files = files.filter((f) => wanted.has(f.replace(/\.json$/, "")) || wanted.has(JSON.parse(readFileSync(join(FIXTURES, f), "utf8")).name));
  }
  const cases: Case[] = [];
  for (const f of files) {
    const stem = f.replace(/\.json$/, "");
    console.log(`\n=== ${stem} ===`);
    let c: Case;
    try {
      c = await run(join(FIXTURES, f), stem);
    } catch (e: any) {
      c = new Case(stem);
      c.check(false, "fixture ran", pyStr(e?.message ?? e));
    }
    cases.push(c);
    for (const k of c.checks) console.log(`  ${k.ok ? "PASS" : "FAIL"}  ${k.label}` + (k.detail ? `   — ${k.detail}` : ""));
  }
  try {
    await req(`${WRAPPER}/study-answers`, { on: false });
    await req(`${API}/api/study-poller/stop`, {});
    await req(`${WRAPPER}/faketable/stop`, {});
  } catch {}
  const bad = cases.filter((c) => c.failed.length);
  const total = cases.reduce((s, c) => s + c.checks.length, 0);
  const failedN = cases.reduce((s, c) => s + c.failed.length, 0);
  console.log(`\n${cases.length - bad.length}/${cases.length} fixtures answered (${total - failedN}/${total} assertions)`);
  if (bad.length) console.log("unanswered / degraded: " + bad.map((c) => c.name).join(", "));
  return bad.length ? 1 : 0;
}

process.exit(await main(process.argv.slice(2)));
