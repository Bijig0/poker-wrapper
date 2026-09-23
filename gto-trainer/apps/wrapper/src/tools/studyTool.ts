/**
 * One-click launcher for the Poker Wrapper TEST RIG (port of gto-trainer/study-tool.pyw, 2026-09-24).
 *
 *   gto-trainer\study-tool.vbs        (the desktop icon — hidden; progress in ignition-study-wrapper\debug\study-tool.log)
 *
 * Opens the SAME layout the Poker Wrapper opens — table window with the panel beside it — except the table is the
 * local replica. Everything else is the real thing: the same reader, feed, relay and Study Answers pipeline. It is a
 * SEPARATE RIG on its own ports, so a real session can run at the same time and neither can disturb the other:
 *
 *   rig            panel   table CDP   table window
 *   Poker Wrapper   7700     9333      ignitioncasino.eu
 *   Study Tool      7701     9334      the local fake table
 *
 * Also started, because the study tools need them — each ONLY if its port is dead (the StudyAPI / ChartServer
 * scheduled tasks own them normally), so clicking this while things are up just relaunches the rig:
 *   :2000  gto-trainer API   the answer poller lives here, and Replay Review reads recordings through it
 *   :8777  chart server      the asymmetric 3-max HRC corpus — every 3-handed preflop answer is served from it
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { paths } from "../env";

const REPO = paths().repo;
const WRAPPER = join(REPO, "ignition-study-wrapper");
const HERE = join(REPO, "gto-trainer");
const LOG = join(WRAPPER, "debug", "study-tool.log");
const VENV_PY = join(REPO, "aof-model", ".venv", "Scripts", "python.exe");
const CHART_SERVER = join(REPO, "analysis", "pipeline", "solve", "exploit_ui", "server.py");
// the rig's own ports; STUDY_TOOL_PANEL / STUDY_TOOL_CDP move it (a test of this launcher runs on spare ports, headless)
const PANEL = Number(process.env.STUDY_TOOL_PANEL || 7701), CDP = Number(process.env.STUDY_TOOL_CDP || 9334), API = 2000, UI = 2100;
// EVERY 3-handed preflop answer is served from here: without it the panel sits on "solving your spot…" forever
const CHARTS = 8777;
const BUN = process.execPath;

function say(msg: string): void {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    const t = new Date().toTimeString().slice(0, 8);
    appendFileSync(LOG, `${t}  ${msg}\n`, "utf8");
  } catch {}
}

function up(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => { s.destroy(); res(ok); };
    s.setTimeout(600, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function waitFor(port: number, secs = 45): Promise<boolean> {
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) {
    if (await up(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Detached, no console — for the hidden bun wrapper. */
function spawnHidden(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  spawn(cmd, args, { cwd, env, detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/**
 * A server in its own MINIMIZED console (`start /min`): not detached-and-silenced, because a server that fails to
 * boot needs somewhere to say so (and a dev server reading stdin shuts down on a null one).
 */
function spawnServer(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  spawn("cmd.exe", ["/c", "start", '""', "/min", cmd, ...args], { cwd, env, detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/**
 * The API's environment. EXPLOIT_CHART arms the pool-exploit preflop overlay (fastSolve reads it ONCE per process);
 * an API started without it evaluates the 25NL Zone exploit strategy as `unavailable` and nothing says why (seen
 * 2026-09-13). The NL25 exports since the 2026-09-14 cutover, the same pair config/env.ps1 arms for the StudyAPI task.
 */
function apiEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const limp = join(REPO, "analysis", "pipeline", "limp_study");
  const chart = join(limp, "exploit_ranges_nl25.json"), pool = join(limp, "pool_model_nl25.json");
  if (existsSync(chart)) {
    env.EXPLOIT_CHART ??= chart;
    say(`exploit overlay ARMED: ${env.EXPLOIT_CHART}`);
  } else say(`exploit overlay off: ${chart} not found`);
  if (existsSync(pool)) env.POOL_MODEL ??= pool;
  return env;
}

async function main(): Promise<void> {
  say("=== study tool (test rig) launching ===");
  // 1. the API — the answer poller runs inside it. Started first so the panel finds it up.
  if (await up(API)) say(`:${API} api already up`);
  else {
    say(`:${API} api starting`);
    spawnServer(BUN, ["run", "index.ts"], join(HERE, "apps", "api"), apiEnv());
  }
  // 2. the chart corpus, before the rig, so the first spot loaded has somewhere to be solved from. Module mode from
  //    the solve dir, the way .claude/dev-charts.cmd runs it, with six parsed trees resident
  if (await up(CHARTS)) say(`:${CHARTS} chart server already up`);
  else if (existsSync(CHART_SERVER)) {
    say(`:${CHARTS} chart server starting`);
    spawnServer(VENV_PY, ["-m", "exploit_ui.server"], dirname(dirname(CHART_SERVER)),
                { ...process.env, HRC_UI_DOC_CACHE_MAX: process.env.HRC_UI_DOC_CACHE_MAX || "6" });
  } else say(`chart server not found at ${CHART_SERVER} — 3-max answers will not solve`);
  // 3. the old :2100 dashboard — the study pages live on the API (:2000) since 2026-09; only if its folder exists
  const dash = join(HERE, "apps", "dashboard");
  const dashDir = existsSync(dash) && statSync(dash).isDirectory();
  if (await up(UI)) say(`:${UI} dashboard already up`);
  else if (dashDir) {
    say(`:${UI} dashboard starting`);
    spawnServer(BUN, ["run", "dev"], dash);
  } else say(`:${UI} no separate dashboard app (study pages are on :${API}) — skipped`);
  // 4. the rig itself — it replaces whatever serves :7701. The ports travel in ARGV: the takeover scan reads other
  //    processes' command lines to tell one rig from another.
  say(`:${PANEL} ${(await up(PANEL)) ? "test rig already up — relaunching to pick up any changes" : `test rig starting (fake table, CDP :${CDP})`}`);
  spawnHidden(BUN, ["run", join(HERE, "apps", "wrapper", "src", "main.ts"), "--panel-port", String(PANEL), "--cdp-port", String(CDP), "--fake"],
              WRAPPER, { ...process.env, WRAPPER_LOG_FILE: join(WRAPPER, "server.log") });
  if (!(await waitFor(PANEL, 60))) {
    say(`test rig never came up on :${PANEL} — see debug/last-start.txt`);
    return;
  }
  say(`:${PANEL} ready — it opens the table and panel windows itself`);
  if (!(await waitFor(API, 15))) say(`note: api still down on :${API}; Study Answers will report it`);
  if (dashDir && !(await waitFor(UI, 30))) say(`note: dashboard still down on :${UI}; the panel works without it`);
  if (!(await waitFor(CHARTS, 20))) say(`note: chart server still down on :${CHARTS} — 3-handed preflop answers have nothing to solve from and the panel will wait`);
}

try {
  await main();
} catch (e: any) {
  say(`EXC: ${e?.stack ?? e}`);   // hidden: nowhere to print — file it
}
process.exit(0);
