/**
 * Port of tests/test_pick_relay_rig.py — pick → relay on a fake-table rig: the pick fires the right control, the
 * typed size reaches the client's bet field, a clamped size is refused, a stale / wrong-hand pick is refused, an
 * unconfirmed press ends UNKNOWN after one retry, and auto-execute fires once.
 *
 * The Python test drove the Study Tool rig on :7701. This one starts a rig of its OWN — a headless TS wrapper on
 * :7792 with its own headless browser on CDP :9392 and its own profile — so it never touches :7700 / :7701 or a
 * window on screen. It is opt-in (it launches a browser): WRAPPER_RIG_TEST=1 bun test, or point WRAPPER_URL at a
 * rig you started yourself.
 */
import { spawn, type Subprocess } from "bun";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checker } from "./helpers";

const REPO = resolve(import.meta.dir, "../../../../..");
const WRAPPER = join(REPO, "ignition-study-wrapper");
const FIXTURES = join(WRAPPER, "tests", "fixtures");
const OWN = !process.env.WRAPPER_URL;
const PANEL = 7792, CDP = 9392;
const BASE = process.env.WRAPPER_URL || `http://127.0.0.1:${PANEL}`;
const ENABLED = !!process.env.WRAPPER_URL || process.env.WRAPPER_RIG_TEST === "1";

async function req(path: string, body?: unknown, timeoutS = 15): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutS * 1000);
  try {
    const r = await fetch(BASE + path, {
      method: body === undefined ? "GET" : "POST", signal: ctl.signal,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await r.text();
    try {
      return JSON.parse(raw || "{}");
    } catch {
      return { ok: false, error: `HTTP ${r.status}: ${raw.slice(0, 200)}` };
    }
  } finally {
    clearTimeout(t);
  }
}
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const J = (x: unknown) => JSON.stringify(x);

test.skipIf(!ENABLED)("pick → relay on the fake-table rig", async () => {
  const { fails, check } = checker();
  let proc: Subprocess | null = null;
  if (OWN) {
    proc = spawn({
      cmd: [process.execPath, "run", join(REPO, "gto-trainer", "apps", "wrapper", "src", "main.ts"), "--panel-port", String(PANEL), "--cdp-port", String(CDP), "--fake"],
      env: { ...(process.env as Record<string, string>), WRAPPER_HEADLESS: "1", PROFILE_SUFFIX: "-rigtest", FAKE_TABLE: "1",
             PANEL_PORT: String(PANEL), CDP_PORT: String(CDP), TABLE_SLOT: "", TABLE_COUNT: "" },
      cwd: WRAPPER, stdout: "ignore", stderr: "ignore",
    });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try {
        up = !!(await req("/state?light=1", undefined, 3)).connected;
      } catch {}
      if (!up) await sleep(0.5);
    }
    if (!up) throw new Error("the rig did not come up");
  }
  const load = async (fixture: string) => {
    const fx = JSON.parse(readFileSync(join(FIXTURES, fixture), "utf8"));
    const r = await req("/faketable/load", fx.spec);
    if (!r.ok) throw new Error(J(r));
    await sleep(1.6);
    const h = (await req("/hand")).hand;
    if (!h) throw new Error("no hand exported");
    return h;
  };
  const push = async (pick: string, h: any, o: { handId?: number; street?: string; n?: number } = {}) => {
    const key = J([o.street ?? h.street, h.board, h.heroCards, h.currentNode.toCall, o.n ?? h.actions.length]);
    await req("/panel/answer", { text: `${String(h.street).toUpperCase()} — ${pick} 100%`, pick, roll: null, decisionKey: key, handId: o.handId ?? h.handId });
  };
  const lastclick = async () => (await req("/faketable/lastclick")).click ?? null;
  const waitState = async (pred: (s: any) => boolean, secs = 3.0) => {
    const end = Date.now() + secs * 1000;
    let s: any = null;
    while (Date.now() < end) {
      s = await req("/state?light=1");
      if (pred(s)) return s;
      await sleep(0.25);
    }
    return s;
  };
  try {
    const st = await req("/state?light=1");
    if (!(st.fakeRig || st.fakeTable)) throw new Error(`${BASE} is not the test rig (fakeRig false)`);
    await req("/study-answers", { on: true, mode: "chart" });
    await req("/study-auto", { auto: false });

    // 0. told vs did, on the live loop
    let h = await load("preflop-hero-3bet-field-reset.json");
    await push("Raise 10.5", h);
    let s = await waitState((x) => (x.pickReady || {}).ok);
    check("pickReady for the sized raise", (s.pickReady || {}).ok === true, J(s.pickReady));
    let r = await req("/act/pick", {});
    check("/act/pick sends the raise", r.ok === true, J(r));
    check("  ... and it is PENDING, not done", r.outcome === "pending", J(r));
    let c = await lastclick();
    check("  ... the client confirmed its own 4, not the typed 10.5", String((c || {}).betValue) === "4", J(c));
    s = await waitState((x) => ![null, undefined, "pending"].includes((x.lastExec || {}).outcome), 15);
    const ex = s.lastExec || {};
    check("an unconfirmed press ends UNKNOWN, never 'executed'", ex.outcome === "unknown", J(ex));
    check("  ... after exactly one retry", ex.attempts === 2, J(ex));

    // 1. fold
    h = await load("flop-hero-facing-bet.json");
    await push("Fold", h);
    s = await waitState((x) => (x.pickReady || {}).ok);
    check("pickReady after the push", (s.pickReady || {}).ok === true, J(s.pickReady));
    check("state says practice table", s.practice === true);
    r = await req("/act/pick", {});
    check("/act/pick ok", r.ok === true, J(r));
    c = await lastclick();
    check("foldButton fired", (c || {}).qa === "foldButton", J(c));
    const r2 = await req("/act/pick", {});
    check("second press refused (already executed)", !r2.ok && String(r2.reason || "").includes("already"), J(r2));
    check("lastExec on /state", ((await req("/state?light=1")).lastExec || {}).pick === "Fold");

    // 2. sized raise
    h = await load("flop-hero-facing-bet.json");
    await push("Raise 70", h);
    await waitState((x) => (x.pickReady || {}).ok);
    r = await req("/act/pick", {});
    check("/act/pick ok (raise to 70)", r.ok === true, J(r));
    c = await lastclick();
    check("raiseButton fired", (c || {}).qa === "raiseButton", J(c));
    check("bet field held 70 at the press", ["70", "70.0"].includes(String((c || {}).betValue)), J(c));

    // 3. a clamped size is refused, nothing pressed
    h = await load("flop-hero-facing-bet.json");
    let before = await lastclick();
    await push("Raise 30", h);
    await waitState((x) => (x.pickReady || {}).ok);
    r = await req("/act/pick", {});
    check("refused with the clamp reason", !r.ok && J(r).includes("clamp"), J(r));
    check("nothing was pressed", J(await lastclick()) === J(before), J(await lastclick()));
    check("not marked executed (a retry would be allowed)", !String(((await req("/state?light=1")).pickReady || {}).reason || "").includes("already"));

    // 4. guards
    h = await load("flop-hero-facing-bet.json");
    await push("Fold", h, { handId: h.handId - 1 });
    s = await req("/state?light=1");
    check("wrong hand id refused", !(s.pickReady || {}).ok && String((s.pickReady || {}).reason || "").includes("hand #"), J(s.pickReady));
    await push("Fold", h, { n: h.actions.length + 1 });
    s = await req("/state?light=1");
    check("moved-on action count refused", String((s.pickReady || {}).reason || "").includes("actions"), J(s.pickReady));
    await push("Fold", h);
    await sleep(3.3);
    s = await req("/state?light=1");
    check("stale pick (no keep-alive) refused", String((s.pickReady || {}).reason || "").includes("stale"), J(s.pickReady));

    // 5. auto
    h = await load("flop-hero-facing-bet.json");
    const a = await req("/study-auto", { auto: true });
    check("auto arms on the fake table", a.ok === true && a.auto === true, J(a));
    before = await lastclick();
    await push("Call", h);
    s = await waitState((x) => (x.lastExec || {}).source === "auto" && (x.lastExec || {}).pick === "Call", 4);
    c = await lastclick();
    check("auto fired the call", (c || {}).qa === "callButton" && J(c) !== J(before), J(c));
    check("lastExec says auto", (s.lastExec || {}).source === "auto", J(s.lastExec));
    await push("Call", h);
    await sleep(1.0);
    check("auto did not fire again on the keep-alive", J(await lastclick()) === J(c), J(await lastclick()));

    // 6. answers off blanks everything
    await req("/study-auto", { auto: false });
    await req("/study-answers", { on: false });
    s = await req("/state?light=1");
    check("answers off → pick not ready", String((s.pickReady || {}).reason || "").includes("off"));
    check("auto disarmed", s.studyAuto === false);
  } finally {
    if (proc) {
      try { await req("/quit", {}, 3); } catch {}
      await sleep(0.8);
      try {
        const v: any = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise<void>((res) => {
          ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); setTimeout(res, 500); };
          ws.onerror = () => res();
        });
      } catch {}
      try { proc.kill(); } catch {}
    }
  }
  expect(fails).toEqual([]);
}, 180_000);
