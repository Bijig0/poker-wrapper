/**
 * MACHINE LOAD (2026-10-07). The latency audit pinned the answers over the 15 s clock on the study API's event loop
 * freezing while this machine is busy. The API reports it at GET /api/load; the wrapper shows it as a header chip on
 * the live panel (amber warn / red heavy, gone on ok) and as an OPTIONAL "Machine load" preflight row that never
 * blocks a start. Here: the reply read against a stub API (ok / warn / heavy / unreachable / no route / wrong shape),
 * the preflight row end to end through session.preflight, and the panel's + setup page's renderers read straight
 * out of the HTML and run against a stub DOM.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { realTime, setFakeTime } from "../../src/clock";
import { LOAD_ADVICE, loadDeps, loadRow, parseLoad, realFetchLoad } from "../../src/load";
import * as SES from "../../src/sessions";
import { addLoadRow, loadNow, preflight } from "../../src/session";
import { S, resetState } from "../../src/state";
import { scratchDirs } from "./helpers";

const OK = { ok: true, at: 1_790_500_000_000, verdict: "ok", reasons: [],
             loop: { stalls1m: 0, stalls5m: 0, maxMs5m: 40, blockedMs5m: 40, lastStallAt: null },
             machine: { cpuPct: 12, heavy: [] }, sessionLive: false };
const WARN = { ...OK, verdict: "warn", reasons: ["bun test using 70% CPU"],
               machine: { cpuPct: 74, heavy: [{ name: "bun test", pid: 4242, cpuPct: 70 }] } };
const HEAVY = { ...OK, verdict: "heavy", reasons: ["API froze 55 s at 12:17", "bun test using 70% CPU"],
                loop: { stalls1m: 1, stalls5m: 3, maxMs5m: 55_000, blockedMs5m: 61_000, lastStallAt: 1_790_500_000_000 } };

// ---- a study API of our own: /api/load answers whatever `reply` says ------------------------------------------
let reply: { status: number; body: any; delayMs?: number } = { status: 200, body: OK };
let stub: ReturnType<typeof Bun.serve>;
const apiBefore = process.env.STUDY_API;
beforeAll(() => {
  stub = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(r) {
      const path = new URL(r.url).pathname;
      if (path === "/api/load") {
        if (reply.delayMs) await Bun.sleep(reply.delayMs);
        return Response.json(reply.body, { status: reply.status });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  });
  process.env.STUDY_API = `http://127.0.0.1:${stub.port}`;
});
afterAll(() => {
  stub.stop(true);
  if (apiBefore === undefined) delete process.env.STUDY_API;
  else process.env.STUDY_API = apiBefore;
});

describe("reading GET /api/load", () => {
  test("ok / warn / heavy come back with their reasons in one line", async () => {
    reply = { status: 200, body: OK };
    expect(await realFetchLoad()).toEqual({ verdict: "ok", text: "CPU 12%", at: OK.at });     // quiet: the CPU figure
    reply = { status: 200, body: WARN };
    expect((await realFetchLoad())?.text).toBe("bun test using 70% CPU");
    reply = { status: 200, body: HEAVY };
    const h = await realFetchLoad();
    expect(h?.verdict).toBe("heavy");
    expect(h?.text).toBe("API froze 55 s at 12:17 · bun test using 70% CPU");
  });
  test("no reasons from the API: the numbers say it", () => {
    const l = parseLoad({ ...HEAVY, reasons: [], machine: { cpuPct: 90, heavy: [{ name: "tsc", pid: 1, cpuPct: 63.4 }] } });
    expect(l?.text).toMatch(/^API froze up to 55 s in the last 5 min \(last at \d\d:\d\d\) · tsc using 63% CPU$/);
  });
  test("unreachable, no route, an error status, a wrong shape, too slow: null (= no warning, never a throw)", async () => {
    reply = { status: 404, body: { ok: false, error: "not found" } };       // an API older than the route
    expect(await realFetchLoad()).toBeNull();
    reply = { status: 500, body: { ok: false } };
    expect(await realFetchLoad()).toBeNull();
    reply = { status: 200, body: { ok: true, verdict: "melting" } };
    expect(await realFetchLoad()).toBeNull();
    reply = { status: 200, body: WARN, delayMs: 600 };
    expect(await realFetchLoad(0.2)).toBeNull();
    reply = { status: 200, body: OK };
    const was = process.env.STUDY_API;
    process.env.STUDY_API = "http://127.0.0.1:9";                          // nothing listens there
    try { expect(await realFetchLoad(1)).toBeNull(); } finally { process.env.STUDY_API = was; }
  });
});

describe("the preflight's Machine load row", () => {
  test("never required; ok row green, warn amber, heavy red, unmeasured grey — the advice on warn/heavy", () => {
    expect(loadRow({ verdict: "ok", text: "", at: null })).toMatchObject({ id: "load", required: false, ok: true, level: "ok", detail: "quiet" });
    const w = loadRow(parseLoad(WARN));
    expect(w).toMatchObject({ required: false, ok: false, level: "warn" });
    expect(w.detail).toBe(`busy — bun test using 70% CPU · answers may run past the clock: ${LOAD_ADVICE}`);
    const h = loadRow(parseLoad(HEAVY));
    expect(h).toMatchObject({ required: false, ok: false, level: "heavy" });
    expect(h.detail).toStartWith("HEAVY — API froze 55 s at 12:17");
    expect(loadRow(null)).toMatchObject({ required: false, ok: true, level: "unknown" });
  });

  const sdeps = { ...SES.deps };
  const ldeps = { ...loadDeps };
  afterEach(() => { Object.assign(SES.deps, sdeps); Object.assign(loadDeps, ldeps); realTime(); });
  const rig = () => {
    scratchDirs("machine-load-");
    resetState();
    setFakeTime(1_790_500_000);
    S.fakeMode = false;
    SES.deps.fetchStrategies = async () => null;                       // the base presets only
    SES.deps.scrapeCached = async () => ({ ok: false, reason: "no Ignition client on CDP port 9333" });
    SES.deps.latestBalance = () => null;
    SES.deps.netCached = async () => ({ ok: true, detail: "round trip 120 ms · 0/10 lost", rttMs: 120 });
  };
  const REG = { armed: { hrc: { up: true, ms: 3 }, hrc6max: { db: true, trees: 1 }, poller: { running: true } }, cards: [] };
  const CFG = { answers: true, sources: {}, recording: false, budget: {}, site: "ignition", profile: "brady" };

  for (const [name, body, level] of [["ok", OK, "ok"], ["warn", WARN, "warn"], ["heavy", HEAVY, "heavy"], ["unreachable", null, "unknown"]] as const) {
    test(`${name}: the row is there and the start is never blocked by it`, async () => {
      rig();
      if (body) reply = { status: 200, body };
      else loadDeps.fetchLoad = async () => null;
      const pf: any = await preflight("silent", CFG, REG);
      const row = pf.checks.find((c: any) => c.id === "load");
      expect(row).toMatchObject({ label: "Machine load", required: false, level });
      expect(pf.ok).toBe(true);
      expect(pf.blockers).toEqual([]);
    });
  }

  test("a fresh health-loop reading is reused (no second request); a stale one is asked again", async () => {
    rig();
    let asked = 0;
    loadDeps.fetchLoad = async () => { asked++; return parseLoad(OK); };
    Object.assign(S.health, { load: parseLoad(HEAVY), loadAt: 1_790_500_000 - 5 });
    expect((await loadNow())?.verdict).toBe("heavy");
    expect(asked).toBe(0);
    Object.assign(S.health, { loadAt: 1_790_500_000 - 25 });
    expect((await loadNow())?.verdict).toBe("ok");
    expect(asked).toBe(1);
  });

  test("no answers, or the test rig: no row (and no request)", async () => {
    rig();
    let asked = 0;
    loadDeps.fetchLoad = async () => { asked++; return parseLoad(HEAVY); };
    const pf1 = { checks: [] as any[] };
    await addLoadRow(pf1, { answers: false });
    S.fakeMode = true;
    const pf2 = { checks: [] as any[] };
    await addLoadRow(pf2, { answers: true });
    expect([pf1.checks, pf2.checks, asked]).toEqual([[], [], 0]);
  });
});

// ---- the pages' own renderers, run against a stub DOM ----------------------------------------------------------
const PAGES = join(import.meta.dir, "..", "..", "..", "..", "..", "ignition-study-wrapper");
const page = (f: string) => readFileSync(join(PAGES, f), "utf-8").replace(/\r\n/g, "\n");
const fnSrc = (html: string, head: string, close = "\n  }\n") => {
  const start = html.indexOf(head);
  expect(start).toBeGreaterThan(0);
  return html.slice(start, html.indexOf(close, start) + close.length);
};

describe("the panel's load chip", () => {
  const html = page("panel.html");
  const make = () => {
    let writes = 0;
    const chip: any = { dataset: {}, style: { display: "none" }, title: "", className: "",
                        _t: "", get textContent() { return this._t; }, set textContent(v: string) { writes++; this._t = v; } };
    const document = { getElementById: (id: string) => (id === "load-chip" ? chip : null) };
    const renderLoad = new Function("document", `${fnSrc(html, "function renderLoad(l) {")}; return renderLoad;`)(document) as (l: any) => void;
    return { chip, renderLoad, writes: () => writes };
  };
  test("amber on warn, red on heavy, with the reasons; gone on ok and when not measured", () => {
    const { chip, renderLoad } = make();
    renderLoad({ verdict: "warn", text: "bun test using 70% CPU" });
    expect([chip.className, chip.style.display, chip.textContent]).toEqual(["warn", "", "⚠ machine busy · bun test using 70% CPU"]);
    expect(chip.title).toContain("close test runs / wait for the API to settle");
    renderLoad({ verdict: "heavy", text: "API froze 55 s at 12:17 · bun test using 70% CPU" });
    expect([chip.className, chip.textContent]).toEqual(["heavy", "⛔ heavy load · API froze 55 s at 12:17 · bun test using 70% CPU"]);
    renderLoad({ verdict: "ok", text: "" });
    expect([chip.className, chip.style.display, chip.textContent]).toEqual(["", "none", ""]);
    renderLoad({ verdict: "heavy", text: "x" });
    renderLoad(undefined);                                               // /state without health.load: not measured
    expect(chip.style.display).toBe("none");
  });
  test("the same reading again touches nothing (the 1 Hz poll never re-writes the header)", () => {
    const { renderLoad, writes } = make();
    renderLoad({ verdict: "warn", text: "a" });
    renderLoad({ verdict: "warn", text: "a" });
    renderLoad({ verdict: "warn", text: "a" });
    expect(writes()).toBe(1);
  });
  test("a span in a zero-width header slot: not a control, nothing can focus or press it, the row cannot wrap", () => {
    expect(html).toContain('<div id="load-slot"><span id="load-chip" style="display:none"></span></div>');
    expect(html).not.toMatch(/load-chip"\)\.on|load-slot"\)\.on|load-chip[^\n]*tabindex/);
    expect(html).toMatch(/#load-slot \{ flex: 1 1 0; min-width: 0;[^}]*margin-left: -12px; padding-left: 12px; \}/);
    expect(html).toContain("renderLoad(s.health && s.health.load);");
  });
});

describe("the setup page's preflight rows", () => {
  const html = page("setup.html");
  const src = fnSrc(html, "function checkClass(c) {", "\n") + fnSrc(html, "function loadNote(j) {", "\n}\n");
  const { checkClass, loadNote } = new Function(`${src}; return { checkClass, loadNote };`)() as any;
  test("the load row's level picks its colour; every other row is ok / bad as before", () => {
    expect(checkClass(loadRow(parseLoad(WARN)))).toBe("warn");
    expect(checkClass(loadRow(parseLoad(HEAVY)))).toBe("heavy");
    expect(checkClass(loadRow(null))).toBe("unknown");
    expect(checkClass(loadRow(parseLoad(OK)))).toBe("ok");
    expect(checkClass({ id: "net", required: true, ok: false })).toBe("bad");
    expect(checkClass({ id: "api", required: true, ok: true })).toBe("ok");
  });
  test("a start that may go ahead under load says so, without blocking", () => {
    expect(loadNote({ checks: [loadRow(parseLoad(HEAVY))] })).toContain("you can start, but answers may be slow");
    expect(loadNote({ checks: [loadRow(parseLoad(WARN))] })).toContain("busy");
    expect(loadNote({ checks: [loadRow(parseLoad(OK))] })).toBe("");
    expect(loadNote({ checks: [loadRow(null)] })).toBe("");
  });
});
