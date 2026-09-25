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
 * Starts a wrapper of its OWN — panel :7791, table CDP :9391, FAKE_TABLE=1, a headless browser on its own
 * profile (WRAPPER_HEADLESS=1, PROFILE_SUFFIX=-contract) — so nothing it does can reach :7700 (a live session)
 * or the :7701 test rig, and no window ever appears. Then it drives it exactly the way the panel pages, the
 * study API's poller and the old Python state suite did: authored spots loaded onto the fake table, /hand read
 * back field by field, presses relayed and checked against the page's own click record, a study pick pushed
 * and executed (by a press and by auto-execute, on the fake table), and every read-only route called once.
 *
 * Two layers of checking:
 *  - ASSERTIONS (the old state suite's expectations, per fixture, from tests/fixtures);
 *  - a TRANSCRIPT of normalised responses compared to golden-python.json step by step (volatile fields — times,
 *    counters, versions — are dropped by `normalise`).
 */
import { spawn, type Subprocess } from "bun";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HandReply, StateReply } from "../../src/contract";
import { CONFIRM_RELABEL_JS } from "../../src/faketable";

const REPO = resolve(import.meta.dir, "../../../../..");
const WRAPPER = join(REPO, "ignition-study-wrapper");
const FIXTURES = join(WRAPPER, "tests", "fixtures");
const GOLDEN = join(import.meta.dir, "golden-python.json");
const PANEL = Number(process.env.CONTRACT_PANEL_PORT || 7791);
const CDP = Number(process.env.CONTRACT_CDP_PORT || 9391);
const BASE = `http://127.0.0.1:${PANEL}`;

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
function normalise(x: any): any {
  if (Array.isArray(x)) return x.map(normalise);
  if (x && typeof x === "object") {
    const out: any = {};
    for (const k of Object.keys(x).sort()) {
      if (VOLATILE.has(k)) continue;
      out[k] = normalise(x[k]);
    }
    return out;
  }
  if (typeof x === "number") return Math.round(x * 1000) / 1000;
  return x;
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

function launch() {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    WRAPPER_HEADLESS: "1", PROFILE_SUFFIX: "-contract", FAKE_TABLE: "1",
    PANEL_PORT: String(PANEL), CDP_PORT: String(CDP),
  };
  delete env.TABLE_SLOT;
  delete env.TABLE_COUNT;
  delete env.PANEL_TAG;
  const cmd = [process.execPath, "run", join(REPO, "gto-trainer", "apps", "wrapper", "src", "main.ts"),
               "--panel-port", String(PANEL), "--cdp-port", String(CDP), "--fake"];
  proc = spawn({ cmd, env, cwd: WRAPPER, stdout: "pipe", stderr: "pipe" });
  const log = join(import.meta.dir, `contract-${impl}.log`);
  writeFileSync(log, "");
  for (const s of [proc.stdout, proc.stderr]) {
    (async () => {
      const dec = new TextDecoder();
      for await (const chunk of s as any as AsyncIterable<Uint8Array>) {
        try { require("node:fs").appendFileSync(log, dec.decode(chunk)); } catch {}
      }
    })();
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
  try { await req("/quit", {}, 3000); } catch {}
  await sleep(800);
  await closeBrowser();
  try { proc?.kill(); } catch {}
}

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await req("/state?light=1", undefined, 3000);
      if (r.status === 200 && r.json?.connected) return r.json;
    } catch {}
    await sleep(500);
  }
  throw new Error(`the ${impl} wrapper did not come up on :${PANEL} with the fake table connected (see contract-${impl}.log)`);
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
    const byStep = new Map(want.map((s) => [s.step, s.value]));
    for (const s of transcript) {
      if (!byStep.has(s.step)) { console.log(`  NEW  ${s.step}`); continue; }
      const a = JSON.stringify(s.value), b = JSON.stringify(byStep.get(s.step));
      if (a !== b) {
        diffs++;
        console.log(`  DIFF ${s.step}\n       want ${b.slice(0, 600)}\n       got  ${a.slice(0, 600)}`);
      }
    }
    for (const s of want) if (!transcript.some((t) => t.step === s.step) && (!ONLY)) { diffs++; console.log(`  MISSING ${s.step}`); }
    console.log(diffs ? `${diffs} transcript differences from the Python recording` : "transcript identical to the Python recording");
  }
  process.exit(failures.length || diffs ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await stop();
  process.exit(2);
});
