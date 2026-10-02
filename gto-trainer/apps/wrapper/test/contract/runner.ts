/**
 * THE HTTP CONTRACT SUITE (2026-09-24).
 *
 *   bun run test/contract/runner.ts [--impl ts]           the wrapper, compared to the recorded transcript
 *   bun run test/contract/runner.ts --record              re-record the transcript (a deliberate change; review the diff)
 *
 * golden-python.json was recorded from the Python wrapper — the specification the TypeScript port was held to —
 * before it was deleted (2026-09-24, the wrapper is TypeScript only). It stays the baseline; `--record` now writes
 * it from the TS wrapper.
 *
 * Starts a wrapper of its OWN — FAKE_TABLE=1, a headless browser (WRAPPER_HEADLESS=1), on two ports the OS
 * hands out free for this run (CONTRACT_PANEL_PORT / CONTRACT_CDP_PORT pin them; a pinned port somebody is already
 * on is refused, never taken over) — so nothing it does can reach :7700 (a live session) or the :7701 test rig,
 * and no window ever appears. Then it drives it exactly the way the panel pages, the study API's poller and the old
 * Python state suite did: authored spots loaded onto the fake table, /hand read back field by field, presses
 * relayed and checked against the page's own click record, a study pick pushed and executed (by a press and by
 * auto-execute, on the fake table), and every read-only route called once.
 *
 * SELF-CONTAINED (2026-09-25). It used to run on fixed ports (:7791 / :9391) with the checkout's own
 * ignition-study-wrapper/{data,debug} and browser profile. Two runs at once — two sessions' gates, from any two
 * checkouts — then killed each other: a wrapper launching on a port REPLACES whatever serves it (app.ts takeover:
 * POST /quit, then terminate), while the new runner's first /state poll had already been answered by the old,
 * dying wrapper, so its first /faketable/load died with ECONNRESET (runner.ts runFixture). And the transcript
 * depended on which checkout ran it: the main checkout's sweep report, debug recordings and Brady's login profile
 * names, and the pages' on-disk line endings. Now each run has its own ports, its own temp state (data, debug and
 * browser profile — WRAPPER_DATA_DIR / WRAPPER_DEBUG_DIR / WRAPPER_PROFILE_DIR, deleted afterwards), and waits for
 * ITS wrapper (the pid on /table/presence), so a worktree, the main checkout and any number of concurrent runs
 * all compare equal. The live data dir (hands.db, sessions.sqlite, the table claims in data/tables) is never touched.
 * The study API (:2000) and chart server (:8777) it reads are a stub too (study-api-stub.json, STUDY_API /
 * HRC3MAX_URL): the live catalogue's content and its 6-to-15 s replies were moving /session, the preflight and the
 * auto pick's outcome from run to run.
 *
 * Two layers of checking:
 *  - ASSERTIONS (the old state suite's expectations, per fixture, from tests/fixtures);
 *  - a TRANSCRIPT of normalised responses compared to golden-python.json step by step (volatile fields — times,
 *    counters, versions — are dropped by `normalise`; this run's ports read as the recording's :7791 / :9391, and
 *    CRLF as LF).
 */
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HandReply, StateReply } from "../../src/contract";
import { CONFIRM_RELABEL_JS } from "../../src/faketable";

const REPO = resolve(import.meta.dir, "../../../../..");
const WRAPPER = join(REPO, "ignition-study-wrapper");
const FIXTURES = join(WRAPPER, "tests", "fixtures");
const GOLDEN = join(import.meta.dir, "golden-python.json");
/** the ports the transcript was recorded on; a run on others is read as if on these (`normalise`) */
const REC_PANEL = 7791, REC_CDP = 9391;
let PANEL = 0, CDP = 0, BASE = "";
/** this run's own state: data/, debug/, profiles/ (the headless browser's --user-data-dir); made by launch() */
let STATE = "";
const LOG = join(import.meta.dir, "contract-ts.log");

const argv = process.argv.slice(2);
const impl = "ts";
if (argv.includes("--impl") && argv[argv.indexOf("--impl") + 1] !== "ts") {
  console.error("only --impl ts: the Python wrapper was deleted on 2026-09-24");
  process.exit(2);
}
const RECORD = argv.includes("--record");
const KEEP = argv.includes("--keep");
const ONLY = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;

type Step = { step: string; value: unknown };
const transcript: Step[] = [];
const failures: string[] = [];
let assertions = 0;

// every /state and /hand reply is also parsed by the zod reply schemas the study API validates with
// (src/contract.ts) — the shared schema is proven against the wrapper on every run (it was checked against the
// Python wrapper too, 43/43, before that was deleted)
let schemaReplies = 0;
function schemaCheck(path: string, json: any) {
  const route = path.split("?")[0];
  const schema = route === "/hand" ? HandReply : route === "/state" ? StateReply : null;
  if (!schema || json == null) return;
  schemaReplies++;
  const r = schema.safeParse(json);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    failures.push(`reply schema ${route}: ${issues}`);
  }
}

function check(label: string, ok: boolean, detail = "") {
  assertions++;
  if (!ok) failures.push(`${label}${detail ? " — " + detail : ""}`);
}
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(label, g === w, `got ${g}, want ${w}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(path: string, body?: unknown, timeoutMs = 20000): Promise<{ status: number; json: any; text: string; type: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      redirect: "manual",
    });
    const type = r.headers.get("content-type") || "";
    const buf = new Uint8Array(await r.arrayBuffer());
    const text = type.startsWith("image/") ? `<${buf.length} bytes>` : new TextDecoder().decode(buf);
    let json: any = null;
    if (type.includes("json")) {
      try { json = JSON.parse(text); } catch { json = { __unparsable__: text.slice(0, 200) }; }
      if (r.status === 200) schemaCheck(path, json);
    }
    return { status: r.status, json, text, type };
  } finally {
    clearTimeout(t);
  }
}

/** Drop what legitimately differs between two runs (clocks, counters, file mtimes, ports of processes). */
const VOLATILE = new Set([
  "at", "t", "ts", "ms", "tookS", "forS", "sentAt", "deadline", "checkedAgo", "checkedAt", "panelVersion",
  "setupVersion", "ageS", "lastEventAgo", "unboundForS", "since", "pid", "wsAt", "startedAt", "elapsedMin",
  "secondsLeft", "wait", "waitedS", "pressWaitedS", "timeBankAt", "topUpAt", "logAgeS",
]);
function normalise(x: any, key = ""): any {
  if (Array.isArray(x)) return x.map((v) => normalise(v, key));
  if (x && typeof x === "object") {
    const out: any = {};
    for (const k of Object.keys(x).sort()) {
      if (VOLATILE.has(k)) continue;
      out[k] = normalise(x[k], k);
    }
    return out;
  }
  if (typeof x === "number") return Math.round(canonPort(x, key) * 1000) / 1000;
  if (typeof x === "string") return canonPorts(x).replace(/\r\n/g, "\n");
  return x;
}
/** This run's ports as the recording's: panel -> 7791, CDP -> 9391, the study API stub -> 2000 (the live API's).
 *  Numbers only under a port-ish key (a stack of 51234 cents stays itself); strings only after a colon. */
function portMap(): Map<number, number> {
  const m = new Map<number, number>([[PANEL, REC_PANEL], [CDP, REC_CDP]]);
  if (apiStub?.port) m.set(apiStub.port, 2000);
  for (const [a, b] of m) if (!a || a === b) m.delete(a);
  return m;
}
function canonPort(n: number, key: string): number {
  if (!/port$/i.test(key) && key !== "me") return n;
  return portMap().get(n) ?? n;
}
function canonPorts(s: string): string {
  const m = portMap();
  if (!m.size) return s;
  return s.replace(new RegExp(`:(${[...m.keys()].join("|")})(?!\\d)`, "g"), (_m, p) => `:${m.get(Number(p))}`);
}
/** Where two normalised values first part: `hand.node.toCall: 1 -> 2` (a 600-character dump rarely reaches it). */
function firstDiff(want: any, got: any, path = ""): string {
  const here = path || "(root)";
  if (JSON.stringify(want) === JSON.stringify(got)) return "";
  const obj = (v: any) => v && typeof v === "object";
  if (obj(want) && obj(got) && Array.isArray(want) === Array.isArray(got)) {
    for (const k of [...new Set([...Object.keys(want), ...Object.keys(got)])]) {
      const d = firstDiff(want[k], got[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
  }
  if (typeof want === "string" && typeof got === "string") {
    let i = 0;
    while (i < want.length && want[i] === got[i]) i++;
    return `${here} at char ${i}: ${JSON.stringify(want.slice(i, i + 60))} -> ${JSON.stringify(got.slice(i, i + 60))}`;
  }
  return `${here}: ${JSON.stringify(want)?.slice(0, 120)} -> ${JSON.stringify(got)?.slice(0, 120)}`;
}
function record(step: string, value: unknown) {
  transcript.push({ step, value: normalise(value) });
}

/** The hand export as the state suite reads it, plus the fields the poller consumes. */
function handView(h: any) {
  if (!h) return null;
  const n = h.currentNode || {};
  return {
    street: h.street, board: h.board, heroSeatId: h.heroSeatId, heroCards: h.heroCards, ended: h.ended,
    actions: h.actions, positions: h.positions, stacks: h.stacks, committed: h.committed, liveSeats: h.liveSeats,
    bbCents: h.bbCents, clientHandId: h.clientHandId, heroFolded: h.heroFolded, heroWon: h.heroWon,
    node: { toActSeatId: n.toActSeatId, toActIsHero: n.toActIsHero, toCall: n.toCall, pot: n.pot },
    heroStatus: h.heroStatus, notToActWhy: h.notToActWhy, lineSource: h.lineSource, lineUncertain: h.lineUncertain,
    buttonsUp: h.buttonsUp,
  };
}
function stateView(s: any) {
  if (!s) return null;
  return {
    connected: s.connected, fakeTable: s.fakeTable, fakeRig: s.fakeRig, site: s.site, studyAnswers: s.studyAnswers,
    sessionId: s.sessionId, practice: s.practice, studyAuto: s.studyAuto, studyAutoDelay: s.studyAutoDelay,
    studyTimeBank: s.studyTimeBank, studyTopUp: s.studyTopUp, panelAnswer: s.panelAnswer, panelNote: s.panelNote,
    pickReady: s.pickReady, lastExec: s.lastExec && { source: s.lastExec.source, pick: s.lastExec.pick, plan: s.lastExec.plan,
      ok: s.lastExec.ok, outcome: s.lastExec.outcome, clicked: s.lastExec.result?.clicked },
    modal: s.modal, snapshot: s.snapshot, topUpWindow: s.topUpWindow, topUpPanelOpen: s.topUpPanelOpen,
    autoAllowance: s.autoAllowance && { granted: s.autoAllowance.granted, live: s.autoAllowance.live },
    autoDeclared: s.autoDeclared, lineUncertain: s.lineUncertain, autoHeld: s.autoHeld && { why: s.autoHeld.why },
    tableSlot: s.tableSlot, panelTag: s.panelTag, cdpPort: s.cdpPort, panelPort: s.panelPort,
    hand: handView(s.hand),
  };
}

// ---------------------------------------------------------------------------------- the process under test
let proc: Subprocess | null = null;

/** The suite's own refusals: printed as a message, without a stack. */
class SuiteError extends Error {}

/** Is anything accepting connections on this port? */
async function listening(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

/** What answers on a port, for the refusal message. */
async function whoIsOn(port: number): Promise<string> {
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) })).json() as any;
  try {
    const p = await get("/table/presence");
    if (p?.pid) return `a Poker Wrapper (pid ${p.pid}, ${p.rig} rig)`;
  } catch {}
  try {
    const v = await get("/json/version");
    if (v?.Browser) return `a browser's DevTools (${v.Browser})`;
  } catch {}
  return "another process";
}

/** Two ports for this run: pinned by CONTRACT_PANEL_PORT / CONTRACT_CDP_PORT (refused if taken), else the OS's. */
async function pickPorts(): Promise<void> {
  const pinned = [process.env.CONTRACT_PANEL_PORT, process.env.CONTRACT_CDP_PORT];
  if (pinned[0] || pinned[1]) {
    PANEL = Number(pinned[0] || REC_PANEL);
    CDP = Number(pinned[1] || REC_CDP);
    for (const [what, port] of [["panel", PANEL], ["CDP", CDP]] as const) {
      if (await listening(port)) {
        throw new SuiteError(`the ${what} port :${port} (CONTRACT_${what === "panel" ? "PANEL" : "CDP"}_PORT) is taken by ${await whoIsOn(port)} — `
          + `another contract run or a leftover. The suite never takes over a port it did not open (a wrapper launching on a `
          + `busy port replaces what is there, and that run dies with ECONNRESET). Wait for it, stop it, or unset the variable `
          + `to run on ports of its own.`);
      }
    }
  } else {
    // hold both listeners open while reading them so the two can never be the same port
    const servers: Server[] = [];
    const ports: number[] = [];
    for (let i = 0; i < 2; i++) {
      const s = createServer();
      await new Promise<void>((res, rej) => { s.once("error", rej); s.listen(0, "127.0.0.1", () => res()); });
      servers.push(s);
      ports.push((s.address() as any).port);
    }
    await Promise.all(servers.map((s) => new Promise((res) => s.close(res))));
    [PANEL, CDP] = ports as [number, number];
  }
  BASE = `http://127.0.0.1:${PANEL}`;
}

/** The study API (:2000) and the chart server (:8777) as the wrapper under test sees them: study-api-stub.json, on a
 *  port of this run's own. The live API made the transcript depend on its catalogue and on its speed — its
 *  /api/dashboard/sources/strategies took 15 s one afternoon (the wrapper gives up at 6 s), /session lost every
 *  strategy preset, and the slow routes pushed the read-only /state past the auto pick's verify deadline. */
const API_STUB = JSON.parse(readFileSync(join(import.meta.dir, "study-api-stub.json"), "utf8"));
const apiUnstubbed = new Set<string>();
let apiStub: ReturnType<typeof Bun.serve> | null = null;
function startApiStub(): string {
  apiStub = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(r) {
      const path = new URL(r.url).pathname;
      switch (path) {
        case "/": return new Response("chart server (contract stub)");  // HRC3MAX_URL, healthCheck's probe
        case "/api/dashboard/config": return Response.json({ ok: true });
        case "/api/dashboard/sources/strategies": return Response.json({ ok: true, strategies: API_STUB.strategies });
        case "/api/dashboard/sources/registry": return Response.json(API_STUB.registry);
        // the chain keeper's light token check (2026-10-03): the registry's own armed.gtow, as the API answers it
        case "/api/dashboard/gtow-token": {
          const g = API_STUB.registry.armed.gtow;
          return Response.json({ ok: true, tokenLive: g.tokenLive, multiwayLive: g.multiwayLive, expiresInMs: g.expiresInMs });
        }
        case "/api/dashboard/gtow-status": return Response.json(API_STUB.gtowStatus);
      }
      apiUnstubbed.add(`${r.method} ${path}`);
      return Response.json({ ok: false, error: "not in the contract suite's study API stub" }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${apiStub.port}`;
}

function launch() {
  const api = startApiStub();
  STATE = mkdtempSync(join(tmpdir(), "wrapper-contract-"));
  for (const d of ["data", "debug", "profiles"]) mkdirSync(join(STATE, d), { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    WRAPPER_HEADLESS: "1", PROFILE_SUFFIX: "-contract", FAKE_TABLE: "1",
    PANEL_PORT: String(PANEL), CDP_PORT: String(CDP),
    WRAPPER_DATA_DIR: join(STATE, "data"), WRAPPER_DEBUG_DIR: join(STATE, "debug"), WRAPPER_PROFILE_DIR: join(STATE, "profiles"),
    STUDY_API: api, HRC3MAX_URL: api,
  };
  delete env.TABLE_SLOT;
  delete env.TABLE_COUNT;
  delete env.PANEL_TAG;
  delete env.WRAPPER_ROOT;      // the pages, formats.json and fixtures are this checkout's
  delete env.WRAPPER_LOG_FILE;  // the log comes back on the pipe, into contract-ts.log
  const cmd = [process.execPath, "run", join(REPO, "gto-trainer", "apps", "wrapper", "src", "main.ts"),
               "--panel-port", String(PANEL), "--cdp-port", String(CDP), "--fake"];
  proc = spawn({ cmd, env, cwd: WRAPPER, stdout: "pipe", stderr: "pipe" });
  writeFileSync(LOG, "");
  for (const s of [proc.stdout, proc.stderr]) {
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of s as any as AsyncIterable<Uint8Array>) {
        try { require("node:fs").appendFileSync(LOG, dec.decode(chunk)); } catch {}
      }
    })();
  }
}

function logTail(n = 15): string {
  try {
    return readFileSync(LOG, "utf8").trimEnd().split(/\r?\n/).slice(-n).map((l) => "    | " + l).join("\n");
  } catch {
    return "";
  }
}

async function closeBrowser() {
  try {
    const v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json() as any;
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise<void>((res) => {
      ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); setTimeout(res, 500); };
      ws.onerror = () => res();
    });
  } catch {}
}

async function stop() {
  if (!BASE) return;
  try { await req("/quit", {}, 3000); } catch {}
  await sleep(800);
  await closeBrowser();
  try { proc?.kill(); } catch {}
  apiStub?.stop(true);
}

/** Delete this run's state; the browser may hold its profile for a moment after Browser.close. */
async function cleanUp() {
  if (!STATE) return;
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(STATE, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
  console.log(`(could not delete ${STATE} — a browser still holds it; safe to delete by hand)`);
}

/** app.ts main()'s last line: past it, the startup is over. main() seeds the fake table (a browser reload) AFTER it
 *  starts serving, so a spot loaded before then was reloaded under the first fixture — its click record wiped
 *  ("relay FOLD fires — got undefined", 2 runs in 3 on a cold browser profile). */
const STARTED = "Ctrl+C stops the panel server";

/** Up = OUR wrapper (its pid on /table/presence) serving with the fake table connected, its startup finished. Never
 *  a reply from anything else on the port: that is how two runs used to kill each other. */
async function waitUp() {
  let other: number | null = null, connected = false;
  for (let i = 0; i < 120; i++) {
    if (proc?.exitCode != null) {
      throw new SuiteError(`the ${impl} wrapper exited (code ${proc.exitCode}) before it came up on :${PANEL} — contract-${impl}.log:\n${logTail()}`);
    }
    try {
      const pid = (await req("/table/presence", undefined, 3000)).json?.pid;
      if (pid === proc?.pid) {
        const r = await req("/state?light=1", undefined, 3000);
        connected = r.status === 200 && !!r.json?.connected;
        if (connected && readFileSync(LOG, "utf8").includes(STARTED)) return r.json;
      } else if (pid) {
        other = pid;
      }
    } catch {}
    await sleep(500);
  }
  throw new SuiteError(`the ${impl} wrapper (pid ${proc?.pid}) did not come up on :${PANEL} `
    + (connected ? `— connected, but its log never said "${STARTED}" (app.ts main() changed its last line?)`
                 : "with the fake table connected")
    + (other ? ` — pid ${other} was answering there instead` : "") + ` — contract-${impl}.log:\n${logTail()}`);
}

async function lastClick(want: string | null): Promise<any> {
  let click: any = {};
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    click = (await req("/faketable/lastclick")).json?.click || {};
    if (want === null || click.qa === want) break;
  }
  return click;
}

// ---------------------------------------------------------------------------------- the suite
async function runFixture(file: string) {
  const fx = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
  if (!fx.spec) return;
  const name = fx.name || file.replace(/\.json$/, "");
  const exp = fx.expect || {};
  const load = await req("/faketable/load", fx.spec);
  check(`${name}: state loaded`, load.json?.ok === true, JSON.stringify(load.json));
  record(`${name}: load`, { ok: load.json?.ok, browser: load.json?.browser });
  await sleep(1500);
  const hand = (await req("/hand")).json?.hand;
  check(`${name}: /hand exports the state`, !!hand);
  record(`${name}: /hand`, handView(hand));
  if (!hand) return;
  const h = exp.hand || {};
  const node = hand.currentNode || {};
  for (const [k, got] of [["street", hand.street], ["board", hand.board], ["heroSeatId", hand.heroSeatId],
                          ["heroCards", hand.heroCards], ["ended", hand.ended]] as const) {
    if (k in h) eq(`${name}: hand.${k}`, got, h[k]);
  }
  if ("actionCount" in h) eq(`${name}: hand.actions length`, (hand.actions || []).length, h.actionCount);
  if ("positions" in h) {
    const norm = (p: any) => Object.fromEntries(Object.entries(p || {}).map(([k, v]) => [String(k), v]).sort());
    eq(`${name}: hand.positions`, norm(hand.positions), norm(h.positions));
  }
  for (const k of ["toActSeatId", "toActIsHero", "toCall"]) if (k in h) eq(`${name}: currentNode.${k}`, node[k], h[k]);
  if ("status" in exp) {
    eq(`${name}: hand.heroStatus`, hand.heroStatus, exp.status);
    const snap = (await req("/state")).json?.snapshot || {};
    eq(`${name}: /state snapshot.status`, snap.status, exp.status);
  }
  if (h.toActIsHero === true) eq(`${name}: hand.notToActWhy`, hand.notToActWhy, null);
  if ("modal" in exp) {
    const st = (await req("/state")).json || {};
    eq(`${name}: /state modal kind`, (st.modal || {}).harmless, exp.modal);
    check(`${name}: pick held while the notice is up`,
      String((st.pickReady || {}).reason || "").includes("notice") || !st.panelAnswer, JSON.stringify(st.pickReady));
  }
  const full = (await req("/state")).json;
  record(`${name}: /state`, stateView(full));
  for (const want of exp.relay || []) {
    const res = (await req("/act", { label: want.label, kind: want.kind || "action" })).json || {};
    record(`${name}: /act ${want.label}`, { ok: res.ok, clicked: res.clicked, kind: res.kind, reason: res.reason, offer: res.offer });
    if (!res.ok) { check(`${name}: relay ${want.label}`, false, `refused: ${res.reason} (offer ${JSON.stringify(res.offer)})`); continue; }
    const click = await lastClick(want.fires);
    eq(`${name}: relay ${want.label} fires`, click.qa, want.fires);
  }
  for (const want of exp.raiseTo || []) {
    const res = (await req("/act", { kind: "raise-to", amount: want.amount })).json || {};
    record(`${name}: raise-to ${want.amount}`, { ok: res.ok, typed: res.typed, reason: res.reason, confirm: res.confirm && { ok: res.confirm.ok, clicked: res.confirm.clicked } });
    if (want.refused) { check(`${name}: raise to ${want.amount} refused`, res.ok === false, JSON.stringify(res)); continue; }
    if (!res.ok) { check(`${name}: raise to ${want.amount}`, false, `refused: ${res.reason}`); continue; }
    const click = await lastClick(want.fires);
    eq(`${name}: raise to ${want.amount} presses ${want.fires}`, click.qa, want.fires);
    if (want.betValue != null) eq(`${name}: the client confirmed ${want.betValue}`, String(click.betValue), String(want.betValue));
  }
  for (const label of exp.refuse || []) {
    const res = (await req("/act", { label, kind: "action" })).json || {};
    record(`${name}: refuse ${label}`, { ok: res.ok, reason: res.reason, offer: res.offer });
    check(`${name}: relay refuses ${label}`, res.ok === false, JSON.stringify(res));
  }
}

/** A study pick, pushed the way the poller pushes it, then executed by a press and by auto-execute. */
async function pickFlow() {
  const fx = JSON.parse(readFileSync(join(FIXTURES, "flop-hero-facing-bet.json"), "utf8"));
  await req("/faketable/load", fx.spec);
  await sleep(1500);
  const hand = (await req("/hand")).json?.hand;
  check("pick: fixture exported", !!hand);
  if (!hand) return;
  const key = JSON.stringify([hand.street, hand.board, hand.heroCards, hand.currentNode?.toCall, (hand.actions || []).length]);
  const on = (await req("/study-answers", { on: true })).json;
  record("pick: answers on", on);
  const push = async (pick: string) => (await req("/panel/answer", {
    text: `${pick} 100%`, pick, decisionKey: key, handId: hand.handId, note: null, strategy: "contract", source: "contract",
  })).json;
  record("pick: push Call", await push("Call"));
  let st = (await req("/state")).json;
  record("pick: /state after push", stateView(st));
  check("pick: answer shown", st?.panelAnswer?.pick === "Call", JSON.stringify(st?.panelAnswer));
  check("pick: ready", st?.pickReady?.ok === true, JSON.stringify(st?.pickReady));
  const ex = (await req("/act/pick", {})).json;
  record("pick: /act/pick", { ok: ex?.ok, source: ex?.source, pick: ex?.pick, plan: ex?.plan, outcome: ex?.outcome, reason: ex?.reason });
  check("pick: executed", ex?.ok === true, JSON.stringify(ex));
  const click = await lastClick("callButton");
  eq("pick: the page's click record", click.qa, "callButton");
  await sleep(600);
  record("pick: push again (same key)", await push("Call"));
  st = (await req("/state")).json;
  record("pick: /state after execute", stateView(st));
  check("pick: once per decision", st?.pickReady?.ok === false && /already executed/.test(st?.pickReady?.reason || ""),
    JSON.stringify(st?.pickReady));
  // unmappable and stale-key picks
  record("pick: push X", await push("X"));
  record("pick: /state X", stateView((await req("/state")).json));
  // AUTO on the fake table (practice): a fresh spot, armed, pushed — the press happens without /act/pick
  await req("/faketable/load", fx.spec);
  await sleep(1500);
  const h2 = (await req("/hand")).json?.hand;
  const key2 = JSON.stringify([h2.street, h2.board, h2.heroCards, h2.currentNode?.toCall, (h2.actions || []).length]);
  const arm = (await req("/study-auto", { auto: true, delay: "instant" })).json;
  record("auto: arm", { ok: arm?.ok, auto: arm?.auto, practice: arm?.practice, delay: arm?.delay, error: arm?.error });
  check("auto: arms on the fake table", arm?.ok === true, JSON.stringify(arm));
  await req("/panel/answer", { text: "Fold 100%", pick: "Fold", decisionKey: key2, handId: h2.handId });
  const c2 = await lastClick("foldButton");
  eq("auto: fired the pick by itself", c2.qa, "foldButton");
  st = (await req("/state")).json;
  record("auto: /state after", stateView(st));
  // let that press's verification finish before anything else reads /state: the fake table never shows hero's fold,
  // so it re-presses once 2.5 s on and settles "unknown" 2.5 s after that (relay.ts maybeVerifyExec). The read-only
  // pass used to catch it pending or settled depending on how long the routes in between took.
  for (let i = 0; i < 60 && (await req("/state?light=1")).json?.lastExec?.outcome === "pending"; i++) await sleep(250);
  const off = (await req("/study-auto", { auto: false })).json;
  record("auto: disarm", { ok: off?.ok, auto: off?.auto });
  record("pick: answers off", (await req("/study-answers", { on: false })).json);
}

async function readOnly() {
  const html = ["/panel", "/setup", "/admin", "/bridge", "/tool", "/faketable", "/faketable?tables=2", "/faketable?tables=4",
                "/faketable/frame?playMode=fun", "/faketable/frame?slot=1", "/sweep-report"];
  for (const p of html) {
    const r = await req(p);
    // SUPERSEDED IN PART 2026-09-25: the fake table relabels its confirm ALL-IN at the stack, as the client does
    // (faketable.CONFIRM_RELABEL_JS); the recording predates it, so its pages are compared with that block removed
    const body = p.startsWith("/faketable/frame") && typeof r.text === "string" ? r.text.replace(CONFIRM_RELABEL_JS, "") : r.text;
    record(`GET ${p}`, { status: r.status, type: r.type, body });
  }
  const r404 = await req("/no-such-route");
  record("GET /no-such-route", { status: r404.status, body: r404.text });
  const asset = await req("/faketable/assets/cards/hole/Ah.png");
  record("GET asset", { status: asset.status, type: asset.type, body: asset.text });
  const noasset = await req("/faketable/assets/../launch.py");
  record("GET asset traversal", { status: noasset.status });
  const jsonRoutes: [string, (j: any) => unknown][] = [
    ["/hand", (j) => ({ ok: j.ok, hand: handView(j.hand) })],
    ["/feed", (j) => ({ hand: j.hand, lines: (j.lines || []).map((l: any) => l.line).slice(-5) })],
    ["/debug", (j) => j],
    ["/table", (j) => j],
    ["/table/presence", (j) => ({ ok: j.ok, slot: j.slot, panelPort: j.panelPort, rig: j.rig, count: j.count, sid: j.sid })],
    ["/tables", (j) => ({ ok: j.ok, slot: j.slot, declared: j.declared, wanted: j.wanted, closed: j.closed, n: (j.tables || []).length })],
    ["/faketable/current", (j) => j],
    ["/faketable/fixtures", (j) => ({ ok: j.ok, files: (j.fixtures || []).map((f: any) => f.file) })],
    ["/formats", (j) => ({ formats: (j.formats || []).map((f: any) => f.id), stakes: j.stakes, detected: j.detected })],
    ["/coinpoker/tables", (j) => ({ attached: j.attached, hasClient: typeof j.client === "object" })],
    ["/history", (j) => ({ hasCount: typeof j.count === "number", hasHands: Array.isArray(j.hands) })],
    ["/recordings", (j) => ({ isList: Array.isArray(j), n: j.length })],
    ["/ws-dump?n=3", (j) => ({ hasCount: typeof j.count === "number", lines: (j.lines || []).length <= 3 })],
    ["/session", (j) => ({ ok: j.ok, current: j.current, fakeTable: j.fakeTable, presetKeys: Object.keys(j.presets || {}).sort() })],
    ["/sessions", (j) => ({ ok: j.ok, isList: Array.isArray(j.sessions) })],
    ["/auth/profiles", (j) => ({ names: (j.profiles || []).map((p: any) => [p.name, p.hasPassword]) })],
    ["/auth/snapshots", (j) => ({ isList: Array.isArray(j.snapshots) })],
    ["/auth/state", (j) => ({ state: j.state, routing: j.routing && { state: j.routing.state } })],
    ["/table/state", (j) => ({ state: j.state, url: j.url, routing: j.routing && { state: j.routing.state } })],
    ["/format/detect", (j) => j],
    ["/layout/preview", (j) => ({ ok: j.ok, counts: Object.keys(j.counts || {}) })],
    ["/session/checks", (j) => ({ ok: j.ok, ids: (j.checks || []).map((c: any) => c.id) })],
    ["/balances", (j) => ({ isList: Array.isArray(j.balances) })],
    ["/admin/state", (j) => ({ ok: j.ok, me: j.me, isList: Array.isArray(j.tables) })],
    ["/state", (j) => stateView(j)],
    ["/state?light=1", (j) => stateView(j)],
  ];
  for (const [p, view] of jsonRoutes) {
    const r = await req(p, undefined, 30000);
    check(`GET ${p} is JSON 200`, r.status === 200 && r.json != null, `${r.status} ${r.text.slice(0, 120)}`);
    record(`GET ${p}`, { status: r.status, view: r.json ? view(r.json) : null });
  }
  const shot = await req("/shot");
  record("GET /shot", { status: shot.status, type: shot.type });
  const posts: [string, unknown][] = [
    ["/sitout", {}], ["/coinpoker/attach", { room: "no such table" }], ["/admin/panel", { port: 1, action: "snap" }],
    ["/admin/panel", { port: 7700, action: "dance" }], ["/admin/open", { room: "no such table" }], ["/session/end", {}],
    ["/faketable/slot", {}], ["/faketable/fixture", { name: "" }], ["/tables/close", { slot: 9 }],
    ["/topup/probe", {}], ["/debug", { on: false }], ["/layout", {}], ["/nope", {}], ["/update", {}],
    ["/act", { label: "dance", kind: "action" }], ["/act", { kind: "raise-to", amount: "abc" }],
    ["/study-auto", { auto: false }], ["/study-answers", { on: false }], ["/panel/answer", { text: "" }],
    ["/format/reseat", {}], ["/router/retry", {}]
  ];
  for (const [p, body] of posts) {
    const r = await req(p, body, 30000);
    record(`POST ${p} ${JSON.stringify(body)}`, { status: r.status, json: r.json, text: r.json ? undefined : r.text.slice(0, 80) });
  }
  const pf = await req("/session/preflight", { preset: "test-rig", config: {} }, 60000);
  record("POST /session/preflight test-rig", { status: pf.status, ok: pf.json?.ok, ids: (pf.json?.checks || []).map((c: any) => [c.id, c.required]) });
}

async function main() {
  const t0 = Date.now();
  await pickPorts();
  launch();
  try {
    await waitUp();
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      if (ONLY && !f.includes(ONLY)) continue;
      await runFixture(f);
    }
    if (!ONLY || ONLY === "pick") await pickFlow();
    if (!ONLY || ONLY === "read") await readOnly();
    await req("/faketable/stop", {});
  } finally {
    if (!KEEP) await stop();
  }
  // the wrapper is this process's child and goes with it; what --keep leaves is its browser and state
  if (KEEP) console.log(`kept: the headless browser (CDP :${CDP}) and the state in ${STATE}`);
  else await cleanUp();
  if (apiUnstubbed.size) console.log(`study API calls the stub does not answer (404): ${[...apiUnstubbed].sort().join(", ")}`);
  const schemaFails = failures.filter((f) => f.startsWith("reply schema ")).length;
  console.log(`${impl}: ${assertions - (failures.length - schemaFails)}/${assertions} assertions passed, ${transcript.length} transcript steps, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(`${impl}: ${schemaReplies - schemaFails}/${schemaReplies} /state + /hand replies match the reply schemas (src/contract.ts)`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  let diffs = 0;
  if (RECORD) {
    writeFileSync(GOLDEN, JSON.stringify(transcript, null, 1));
    console.log(`recorded ${GOLDEN}`);
  } else if (existsSync(GOLDEN)) {
    const want: Step[] = JSON.parse(readFileSync(GOLDEN, "utf8"));
    // normalised again: a recording made before a normalisation rule (CRLF pages, say) still compares
    const byStep = new Map(want.map((s) => [s.step, normalise(s.value)]));
    for (const s of transcript) {
      if (!byStep.has(s.step)) { console.log(`  NEW  ${s.step}`); continue; }
      const a = JSON.stringify(s.value), b = JSON.stringify(byStep.get(s.step));
      if (a !== b) {
        diffs++;
        console.log(`  DIFF ${s.step}  (first at ${firstDiff(byStep.get(s.step), s.value)})\n       want ${b.slice(0, 600)}\n       got  ${a.slice(0, 600)}`);
      }
    }
    for (const s of want) if (!transcript.some((t) => t.step === s.step) && (!ONLY)) { diffs++; console.log(`  MISSING ${s.step}`); }
    console.log(diffs ? `${diffs} transcript differences from the Python recording` : "transcript identical to the Python recording");
  }
  process.exit(failures.length || diffs ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e instanceof SuiteError ? `error: ${e.message}` : e);
  await stop();
  await cleanUp();
  process.exit(2);
});
