/**
 * THE PANEL SERVER — every route launch.py's Handler served, on Hono. Same paths, same status codes, same JSON
 * (json.dumps' text: ", " / ": " separators, \uXXXX escapes), the no-store header, same pages read
 * from ignition-study-wrapper/. POST bodies are parsed through the zod contract (src/contract.ts). CORS is NOT "*" any
 * more: a foreign page is refused (ALLOWED_ORIGIN below).
 *
 * A handler that throws answers 500 with {"ok": false, "error": "<Type>: <message>"} — JSON, because every page
 * reads replies with .json().
 */
import { Hono, type Context } from "hono";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import * as A from "./auth";
import * as BAL from "./balances";
import * as cdp from "./cdp";
import { time } from "./clock";
import { C, DEBUG_DIR, wsDumpPath } from "./config";
import { Body } from "./contract";
import * as faketable from "./faketable";
import { log } from "./feed";
import * as W from "./win32";
import * as F from "./formats";
import { fmtFixed, pyInt, pyJsonDumps, pyRepr, pyStr, truthy } from "./py";
import * as SES from "./sessions";
import { CGG, CP, S, isCgg, isClientSite, isCp, seams } from "./state";
import * as TABLES from "./tables";
import { FORMATS as CP_FORMATS } from "./sites/coinpoker";
import { FORMATS as CGG_FORMATS } from "./sites/clubgg";
import { history } from "./archive";
import { mySel, slotted } from "./ignition/dom";
import { handState } from "./ignition/hand";
import { fetchHandHistory, listHandHistory } from "./ignition/handHistory";
import { tableState } from "./ignition/reader";
import { recFrame, recLog, recordings, saveNote, setDebug } from "./ignition/recorder";
import { act, executePick, raiseTo, requestSolve, setAuto } from "./relay";
import { topUpProbeSecond, topUpRead, topUpRun } from "./topup";
import * as SESSION from "./session";
import { adminOpen, adminPost, adminState, cpReattach } from "./admin";
import { domDump, shot, state, toolShell } from "./view";
import { applyLayout, dpiAt, monitors, panelHwnd, slotTitle, targetArea, wantFullscreen } from "./windows";
import { livePort, rewritePorts } from "../../api/src/services/ports";

const HEADERS = { "Cache-Control": "no-store" };

/**
 * WHO MAY DRIVE THIS WRAPPER FROM A BROWSER (2026-09-25 audit). Every reply used to carry
 * `Access-Control-Allow-Origin: *` and every POST body was parsed whatever its content type, so ANY web page open in
 * any browser on this machine could read /state (hero's cards) and POST /act, /study-auto {allowRealMoney}, /topup/now.
 * CORS alone would not stop that — a browser still SENDS a cross-origin form POST, it only hides the reply — but a
 * browser always stamps such a request with its Origin, and server-side callers (the study API, curl) send none. So:
 * a request whose Origin is not a local panel or the study API is refused before any handler runs, and the CORS header
 * names only those origins. (A DNS-rebinding page arrives with its own hostname as Origin and is refused the same way.)
 */
// the install's API port (+1, +2 for a verify API beside it) and its hundred panel ports (main + extra tables + a test rig)
const ORIGIN_PORTS = [livePort("api"), livePort("api") + 1, livePort("api") + 2, ...Array.from({ length: 100 }, (_, i) => livePort("panel") + i)];
export const ALLOWED_ORIGIN = new RegExp(`^http:\\/\\/(127\\.0\\.0\\.1|localhost)(:(${ORIGIN_PORTS.join("|")}))?$`);
const originAllowed = (o: string | undefined): boolean => !o || ALLOWED_ORIGIN.test(o);

function send(code: number, ctype: string, body: string | Uint8Array): Response {
  return new Response(body as BodyInit, { status: code, headers: { "Content-Type": ctype, ...HEADERS } });
}
const json = (code: number, v: unknown) => send(code, "application/json", pyJsonDumps(v));
const html = (b: string | Uint8Array) => send(200, "text/html; charset=utf-8", b);
const text404 = (msg = "not found") => send(404, "text/plain", msg);
const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });
// pages: their ":2000"-style addresses become this install's ports (api services/ports.ts rewritePorts; a no-op by default)
const page = (name: string) => rewritePorts(readFileSync(join(C.ROOT, name), "utf8"));

/** The query string exactly as Python split it: everything after the first '?'. */
const queryOf = (c: Context) => {
  const u = c.req.url;
  const i = u.indexOf("?");
  return i < 0 ? "" : u.slice(i + 1);
};
const qparam = (q: string, name: string) => q.split("&").find((v) => v.startsWith(`${name}=`))?.split("=").slice(1).join("=");

/** json.loads(body or "{}"), then the contract's schema. */
async function body<T extends z.ZodTypeAny>(c: Context, schema: T, emptyIsObject = true): Promise<z.infer<T>> {
  const raw = await c.req.text();
  const v = raw ? JSON.parse(raw) : emptyIsObject ? {} : {};
  const r = schema.safeParse(v);
  if (!r.success) {
    const kind = Array.isArray(v) ? "list" : v === null ? "NoneType" : typeof v === "object" ? "dict" : typeof v === "string" ? "str" : typeof v;
    throw Object.assign(new Error(`'${kind}' object has no attribute 'get'`), { name: "AttributeError" });
  }
  return r.data;
}

const stateLight = () => state(true);
const layout = () => applyLayout(seams.ignitionTarget);

export function buildApp(): Hono {
  const app = new Hono();

  // SLOW REQUESTS, LOGGED (2026-09-24): the study API reads /state with a 3 s budget; a reply that takes long is a
  // lost or late answer, and this says which request and how long (wall clock, not the injectable one)
  app.use(async (c, next) => {
    const t0 = performance.now();
    await next();
    const dt = performance.now() - t0;
    if (dt > 400) {
      const u = new URL(c.req.url);
      log(`[slow] ${c.req.method} ${u.pathname}${u.search} ${fmtFixed(dt, 0)} ms -> ${c.res.status}`);
    }
  });
  // refuse a foreign page before any handler can act; name only allowed origins in the CORS header
  app.use(async (c, next) => {
    const origin = c.req.header("origin");
    if (!originAllowed(origin)) {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        log(`[security] refused ${c.req.method} ${new URL(c.req.url).pathname} from origin ${origin}`);
        return json(403, { ok: false, error: `cross-origin request from ${origin} refused` });
      }
      await next();   // a GET still answers (same-origin tools, curl) — without a CORS header the page cannot read it
      return;
    }
    await next();
    if (origin) c.res.headers.set("Access-Control-Allow-Origin", origin);
  });
  app.onError((e: any) => json(500, { ok: false, error: `${e?.name && e.name !== "Error" ? e.name : "Exception"}: ${e?.message ?? e}` }));
  app.notFound(() => text404());
  app.options("*", (c) => {
    const origin = c.req.header("origin");
    if (!origin || !ALLOWED_ORIGIN.test(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  });

  // ------------------------------------------------------------------------------------------ GET
  const panel = () => (!S.session.id && !S.fakeMode ? redirect("/setup") : html(slotTitle(page("panel.html"))));
  app.get("/", panel);
  app.get("/panel", panel);
  app.get("/setup", () => (TABLES.isLeader() ? html(slotTitle(page("setup.html"))) : redirect(`http://127.0.0.1:${TABLES.leaderPort()}/setup`)));
  app.get("/bridge", () => html(page("bridge.html")));
  app.get("/auth/snapshots", () => json(200, { snapshots: A.snapshots() }));
  app.get("/update", async (c) => json(200, await SESSION.updateStatus(queryOf(c).includes("force=1"))));
  app.get("/admin", () => html(page("admin.html")));
  app.get("/admin/state", async () => json(200, await adminState(stateLight)));
  app.get("/coinpoker/tables", () => json(200, { tables: CP.openTables(), attached: CP.pinned, client: CP.clientState() }));
  app.get("/clubgg/tables", () => json(200, { tables: CGG.openTables(), attached: CGG.pinned, client: CGG.clientState(), status: CGG.status }));
  app.get("/formats", async () => json(200, {
    formats: [...F.allFormats(), ...CP_FORMATS, ...CGG_FORMATS], stakes: F.data().stakes,
    detected: (await cdp.available(C.CDP_PORT)) ? await F.detect(C.CDP_PORT) : null,
  }));
  app.get("/auth/profiles", () => {
    const profs = A.profiles();
    for (const pr of profs) {
      const b = BAL.latest(pr.name);
      pr.balance = b ? { amountCents: b.amountCents, at: b.ts, source: b.source } : null;
    }
    return json(200, { profiles: profs });
  });
  app.get("/balance/probe", async () => json(200, await BAL.scrape(C.CDP_PORT)));
  app.get("/balances", (c) => {
    const who = qparam(queryOf(c), "profile");
    return json(200, { balances: BAL.history(who ? decodeURIComponent(who) : null, 200) });
  });
  const routing = () => ({ state: S.router.state, text: S.router.text, steps: S.router.steps, at: S.router.at,
                           format: S.router.format, seats: S.router.seats });
  app.get("/auth/state", async () => {
    const st: any = !S.fakeMode ? await A.pageState(C.CDP_PORT) : { state: "signed-in", detail: "fake table" };
    st.routing = routing();
    return json(200, st);
  });
  app.get("/table/state", async () => {
    const st: any = !S.fakeMode ? await F.windowState(C.CDP_PORT) : { state: "signed-in", cdp: true, url: "faketable", detected: null };
    st.routing = routing();
    return json(200, st);
  });
  app.get("/format/detect", async () => {
    const up = await cdp.available(C.CDP_PORT);
    return json(200, { detected: up ? await F.detect(C.CDP_PORT) : null, cdp: await cdp.available(C.CDP_PORT) });
  });
  app.get("/session/checks", async () => json(200, await SESSION.sessionChecks()));
  // The panel and /setup poll this every 5 s. A healthy catalogue comes from the 30 s cache (a forced refresh here made
  // the API rebuild its strategy catalogue 12 times a minute per open panel); only an unreachable one is re-asked each time.
  app.get("/session", async () => json(200, {
    ok: true, current: S.session.rec, brief: await SESSION.sessionBrief(),
    presets: await SES.presets(!SES.presetsFromApi()), presetsFromApi: SES.presetsFromApi(), catalogueError: SES.presetsError(),
    fakeTable: S.fakeMode,
    lastPreset: (S.sessions.list(1)[0] || {}).preset ?? null,
  }));
  app.get("/sessions", async () => {
    const left = await SESSION.leftovers();
    return json(200, { ok: true, sessions: S.sessions.list(50), open: !S.session.id ? left[0] ?? null : null, openAll: left });
  });
  app.get("/state", async (c) => json(200, await state(queryOf(c).includes("light=1"))));
  app.get("/layout/preview", () => {
    const area = targetArea();
    const mons = monitors().map((m) => ({ ...m, scale: dpiAt(m.x + 10, m.y + 10) / 96.0 }));
    const counts: Record<string, any> = {};
    for (const n of TABLES.TABLE_COUNTS) {
      let rect: any = TABLES.clientRect(n, area as TABLES.Area);
      if (wantFullscreen(n) && area.fw) rect = { ...rect, w: area.fw, h: area.fh };
      const w = TABLES.toDip(rect, mons);
      const cols = n === 1 ? 1 : 2;
      const rows = n <= 2 ? 1 : 2;
      counts[String(n)] = { w: Math.floor(w.w / cols), h: Math.floor(w.h / rows), winW: w.w, winH: w.h, fullscreen: wantFullscreen(n) };
    }
    const win = TABLES.toDip(TABLES.clientRect(TABLES.count(), area as TABLES.Area), mons);
    return json(200, { ok: true, counts, window: { w: win.w, h: win.h },
                       monitor: `${area.w}x${area.h}` + (area.primary ? "" : " (the external screen)") });
  });
  // panelOpen: whether this table's own panel window is on screen — the leader's Tables grid offers a reopen when not
  app.get("/table/presence", () => json(200, { ...TABLES.presenceRecord(C.PANEL_PORT, S.session.id), panelOpen: C.HEADLESS ? null : !!panelHwnd() }));
  app.get("/tables", async () => json(200, await SESSION.tablesOverview(stateLight)));
  app.get("/table", async () => json(200, await tableState()));
  app.get("/faketable", (c) => {
    const want = qparam(queryOf(c), "tables") ?? "1";
    let n = 1;
    try {
      n = pyInt(want);
    } catch {
      n = 1;
    }
    return html(faketable.renderOuter("/faketable/frame?playMode=fun", n));
  });
  app.get("/faketable/frame", (c) => {
    const raw = qparam(queryOf(c), "slot");
    let sl: number | null = null;
    try {
      sl = raw !== undefined ? pyInt(raw) : null;
    } catch {
      sl = null;
    }
    return html(faketable.renderInner(SESSION.fakeSpecFor(sl)));
  });
  app.get("/faketable/assets/*", (c) => {
    const rel = c.req.path.slice("/faketable/assets/".length);
    const got = faketable.asset(rel);
    return got ? send(200, got[1], got[0]) : text404("no asset");
  });
  app.get("/faketable/current", () => json(200, { ok: true, spec: S.fakeMode ? S.faketableSpec : null }));
  app.get("/faketable/fixtures", () => {
    const fdir = join(C.ROOT, "tests", "fixtures");
    const out: any[] = [];
    if (existsSync(fdir)) {
      for (const f of readdirSync(fdir).filter((x) => x.endsWith(".json")).sort()) {
        try {
          out.push({ file: f, fixture: JSON.parse(readFileSync(join(fdir, f), "utf8")) });
        } catch {}
      }
    }
    return json(200, { ok: true, fixtures: out });
  });
  app.get("/sweep-report", () => {
    const rp = join(DEBUG_DIR(), "postflop_sweep_report.html");
    return existsSync(rp) ? html(readFileSync(rp))
      : html("<body style='background:#0d141c;color:#cfe0ef;font:14px system-ui;padding:2em'>no sweep report yet - run: bun src/scripts/makeSolveAuditReport.ts (in gto-trainer/apps/api)</body>");
  });
  app.get("/tool", () => html(toolShell()));
  app.get("/faketable/lastclick", async () => {
    const t = await seams.ignitionTarget();
    let res: any = null;
    if (t && (t.url || "").includes("/faketable")) {
      try {
        res = await cdp.evaluate(t.webSocketDebuggerUrl, slotted(`(() => {__FRAME__
                            const f = __frame(__SLOT__) || document.querySelector('iframe');
                            let w = null; try { w = f && f.contentWindow; } catch (e) {}
                            return (w && w.__lastClick) || window.__lastClick || null;
                        })()`, mySel()), 4);
      } catch {
        res = null;
      }
    }
    return json(200, { ok: true, click: res ?? null });
  });
  app.get("/feed", () => json(200, { lines: S.feed, hand: S.handNo, handIds: S.handIds }));
  app.get("/hand", () => {
    const h = handState();
    return json(200, { ok: h !== null, hand: h });
  });
  app.get("/history", () => json(200, history()));
  app.get("/hh/list", async (c) => {
    const q = queryOf(c);
    return json(200, await listHandHistory(qparam(q, "date") ?? "", { format: qparam(q, "format") }));
  });
  app.get("/hh/:id", async (c) => {
    const q = queryOf(c);
    return json(200, await fetchHandHistory(c.req.param("id"), { format: qparam(q, "format"), refresh: q.includes("refresh=1") }));
  });
  app.get("/debug", () => json(200, { on: S.dbg.on, dir: S.dbg.dir, frames: S.dbg.seq }));
  app.get("/ws-dump", (c) => {
    const m = /n=(\d+)/.exec(queryOf(c));
    const n = Math.min(m ? Number(m[1]) : 200, 3000);
    return json(200, { count: S.wsDump.length, file: wsDumpPath(), lines: n ? S.wsDump.slice(-n) : [...S.wsDump] });
  });
  app.get("/recordings", () => json(200, recordings()));
  app.get("/rec/*", (c) => {
    const parts = c.req.path.split("/");
    if (parts.length === 4 && parts[3] === "log") return json(200, recLog(parts[2]!));
    if (parts.length === 5 && parts[3] === "frame") {
      const digits = parts[4]!.replace(/\D/g, "");
      const got = recFrame(parts[2]!, digits ? Number(digits) : -1);
      return got ? send(200, got[1], got[0]) : text404("no frame");
    }
    return text404();
  });
  app.get("/dom", async () => json(200, await domDump()));
  app.get("/shot", async () => {
    const png = await shot();
    return png ? send(200, "image/png", png) : send(503, "text/plain", "no table page yet");
  });

  // ------------------------------------------------------------------------------------------ POST
  app.post("/act", async (c) => {
    const b = await body(c, Body.act);
    const kind = [...pyStr(b.kind ?? "action")].slice(0, 12).join("");
    // a turn action pressed from the panel goes only to a table showing the hand the panel shows (relay.ts
    // holeCardsRefusal) — refused on a definite mismatch; a human's press is not refused for cards it cannot see
    const hh = handState();
    const guard = b.kind === "raise-to" || kind === "action" ? { cards: hh ? hh.heroCards ?? null : null, strict: false } : {};
    const res = b.kind === "raise-to"
      ? await raiseTo([...pyStr(b.amount ?? "")].slice(0, 12).join(""), false, guard)
      : await act([...pyStr(b.label ?? "")].slice(0, 32).join(""), kind, guard);
    log(`[act] ${pyRepr(b.label || b.amount || null)} -> ${pyRepr(res)}`);
    // offerQa / missing / wrongHand are the relay's own (actuateAllIn reads the strip off a refusal) — not the reply's
    const { offerQa: _qa, missing: _missing, wrongHand: _wrong, ...reply } = res;
    return json(200, reply);
  });
  app.post("/quit", () => {
    SESSION.standDown();
    return send(200, "application/json", '{"ok": true}');
  });
  app.post("/faketable/slot", async (c) => {
    const b = await body(c, Body.faketableSlot);
    if (b.slot === null || b.slot === undefined) return send(400, "application/json", '{"ok": false, "error": "slot required"}');
    const sl = pyInt(b.slot);
    S.faketableSpecs.set(sl, truthy(b.spec) ? (b.spec as any) : faketable.EXAMPLE_SPEC);
    return json(200, { ok: true, slot: sl, slots: [...S.faketableSpecs.keys()].sort((a, b2) => a - b2) });
  });

  app.post("/faketable/load", async (c) => {
    const raw = await c.req.text();
    return json(200, await SESSION.faketableLoad(JSON.parse(raw || "{}")));
  });
  app.post("/faketable/stop", () => json(200, SESSION.faketableStop()));
  app.post("/faketable/fixture", async (c) => {
    const b = await body(c, Body.faketableFixture);
    const name = pyStr(b.name || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    const fx = b.fixture;
    if (!name || !fx || typeof fx !== "object" || Array.isArray(fx)) {
      return send(400, "application/json", '{"ok": false, "error": "name and fixture required"}');
    }
    const fdir = join(C.ROOT, "tests", "fixtures");
    mkdirSync(fdir, { recursive: true });
    const p = join(fdir, `${name}.json`);
    writeFileSync(p, pyJsonDumps(fx, { indent: 2, ensureAscii: false }) + "\n", "utf8");
    log(`[faketable] fixture saved: ${name}.json`);
    return json(200, { ok: true, file: `${name}.json` });
  });
  app.post("/layout", async () => {
    const res = await layout();
    log(`[layout] -> ${pyRepr(res)}`);
    return json(200, res);
  });
  /** The GTO Wizard accounts page's payload, passed through for the panel's meter and the setup page's account picker
   *  (2026-09-27): registry, lights, last-hour / last-day meters, walls. Same origin, so the pages need no API URL. */
  app.get("/session/gtow-accounts", async () => {
    try {
      const r = await fetch(`${SES.API()}/api/gtow/accounts`, { signal: AbortSignal.timeout(12_000) });
      if (r.status >= 400) throw new Error(`HTTP Error ${r.status}: ${r.statusText}`);
      return send(200, "application/json", new Uint8Array(await r.arrayBuffer()));
    } catch (e: any) {
      return json(200, { ok: false, error: `the study API on ${SES.API()} did not answer: ${e?.message ?? e}` });
    }
  });
  app.post("/session/gtow-connect", async (c) => {
    try {
      const raw = await c.req.text();
      const b: any = raw ? JSON.parse(raw) : {};
      // any account id the API reports (not just primary/secondary) — the API decides what it can launch
      const payload = typeof b.source === "string" && /^[\w-]{1,40}$/.test(b.source) ? { source: b.source } : {};
      const r = await fetch(`${SES.API()}/api/dashboard/gtow-connect`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000),
      });
      if (r.status >= 400) throw new Error(`HTTP Error ${r.status}: ${r.statusText}`);
      return send(200, "application/json", new Uint8Array(await r.arrayBuffer()));
    } catch (e: any) {
      return json(200, { ok: false, connected: false, hint: `the study API on ${SES.API()} did not answer: ${e?.message ?? e}` });
    }
  });
  app.post("/tables/close", async (c) => {
    const b = await body(c, Body.tablesClose);
    let want = 0;
    try {
      want = pyInt(b.slot);
    } catch {
      want = 0;
    }
    let res: Record<string, any>;
    if (!TABLES.isLeader()) res = { ok: false, error: `table ${pyStr(TABLES.slot())} does not run the session — close from table ${TABLES.LEADER}` };
    else if (!(want >= 1 && want <= TABLES.MAX_TABLES)) res = { ok: false, error: "slot must be 1-4" };
    else res = await SESSION.closeTable(want, pyStr(b.why || "closed from the panel"));
    return json(res.ok ? 200 : 409, res);
  });
  app.post("/tables/panel", async (c) => {
    const b = await body(c, Body.tablesPanel);
    let want: number | null = null;
    if (b.slot !== undefined && b.slot !== null && b.slot !== "all") {
      try {
        want = pyInt(b.slot);
      } catch {
        want = 0;
      }
      if (!(want >= 1 && want <= TABLES.MAX_TABLES)) return json(400, { ok: false, error: "slot must be 1-4, or omitted for every table" });
    }
    if (!TABLES.isLeader()) return json(409, { ok: false, error: `table ${pyStr(TABLES.slot())} does not run the session — reopen panels from table ${TABLES.LEADER}` });
    const res = await SESSION.reopenPanels(want);
    return json(200, res);
  });
  app.post("/table/stand-down", async (c) => {
    const b = await body(c, Body.standDown);
    return json(200, { ok: true, slot: TABLES.slot(), left: await SESSION.standDownTable(pyStr(b.why || "closed from the panel")) });
  });
  app.post("/auth/profiles", async (c) => {
    const b = await body(c, Body.profile);
    try {
      const row = A.saveProfile(b.name, b.site || "ignition", b.email, (b.password as string) || null, b.rememberMe !== false, truthy(b.trustDevice));
      return json(200, { ok: true, profile: row });
    } catch (e: any) {
      return json(400, { ok: false, error: String(e?.message ?? e) });
    }
  });
  app.post("/auth/profiles/delete", async (c) => {
    const b = await body(c, Body.login);
    return json(200, { ok: A.deleteProfile(pyStr((b as any).name || "")) });
  });
  app.post("/auth/login", async (c) => {
    const b = await body(c, Body.login);
    if (!(await cdp.available(C.CDP_PORT))) return json(200, { ok: false, error: "table window not up" });
    S.router.loginAt = time();
    return json(200, await A.login(pyStr(b.profile || ""), C.CDP_PORT));
  });
  app.post("/auth/code", async (c) => {
    const b = await body(c, Body.code);
    const prof = A.get((b.profile as string) || (((S.session.rec || {}).config) || {}).profile);
    const trust = "trustDevice" in b ? b.trustDevice : (prof || {}).trustDevice ?? false;
    const res = (await cdp.available(C.CDP_PORT))
      ? await A.submitCode(pyStr(b.code || ""), C.CDP_PORT, undefined, undefined, !!trust)
      : { ok: false, error: "table window not up" };
    if (res.ok && S.session.id) S.sessions.event(S.session.id, "code-accepted", {});
    return json(200, res);
  });
  app.post("/table/open", () => {
    void SESSION.openTableWindow().catch((e) => log(`[table] ${e?.message ?? e}`));
    return json(200, { ok: true });
  });

  app.post("/format/reseat", async () => {
    const cfg = S.session.id ? ((S.session.rec || {}).config || {}) : {};
    let res: Record<string, any>;
    const follower = F.followerRefusal("reseat", log);
    if (follower) res = follower;
    else if (!S.session.id) res = { ok: false, error: "no session" };
    else if (!cfg.format) res = { ok: false, error: "the session declared no format" };
    else if (!(await cdp.available(C.CDP_PORT))) res = { ok: false, error: `table window not up (CDP :${C.CDP_PORT})` };
    else {
      S.router.reseat = true;
      SESSION.routerSet("routing", `re-seat requested: going to ${(F.get(cfg.format) || {}).name ?? cfg.format}`, []);
      res = { ok: true };
    }
    return json(res.ok ? 200 : 409, res);
  });
  app.post("/router/retry", async () => {
    let res: Record<string, any>;
    if (!S.session.id) res = { ok: false, error: "no session" };
    else {
      const was = S.router.state;
      const seats = S.router.seats || {};
      const midSeating = !!(seats.leader && (seats.want || 1) > 1 && (seats.have || 0) > 0 && (seats.have || 0) < (seats.want || 1));
      Object.assign(S.router, { steps: [], loginAt: 0.0, snapState: null, loginTries: 0 });
      if (!(await cdp.available(C.CDP_PORT))) {
        void SESSION.openTableWindow();
        SESSION.routerSet("waiting-window", "retry: opening the table window", []);
      } else if (midSeating) {
        SESSION.routerSet("seating", `retry: taking seat ${(seats.have || 0) + 1} of ${seats.want} again`, []);
      } else {
        S.router.reseat = true;
        SESSION.routerSet("routing", `retry requested (was: ${was})`, []);
      }
      if (S.session.id) S.sessions.event(S.session.id, "retry", { was });
      res = { ok: true, was };
    }
    return json(res.ok ? 200 : 409, res);
  });
  app.post("/session/preflight", async (c) => {
    const b = await body(c, Body.preflight);
    const presets = await SES.presets();
    const preset = (b.preset as string) in presets ? (b.preset as string) : Object.keys(presets)[0]!;
    const cfg = await SES.mergedConfig(preset, (b.config as any) ?? null);
    return json(200, await SESSION.preflight(preset, cfg));
  });
  app.post("/session/start", async (c) => {
    const [code, res] = await SESSION.sessionStart(await body(c, Body.sessionStart));
    return json(code, res);
  });
  app.post("/session/join", async (c) => {
    const [code, res] = await SESSION.sessionJoin(await body(c, Body.sessionJoin));
    return json(code, res);
  });
  app.post("/session/leave", async (c) => {
    const [code, res] = SESSION.sessionLeave(await body(c, Body.sessionLeave));
    return json(code, res);
  });
  // another table lost the poker server: the leader ends the session (session.ts maybeEndForDisconnect)
  app.post("/session/disconnected", async (c) => {
    const [code, res] = await SESSION.sessionDisconnected(await body(c, Body.sessionDisconnected));
    return json(code, res);
  });
  // another table's connection check failed: the leader ends the session (session.ts maybeEndForNetDrop)
  app.post("/session/net-drop", async (c) => {
    const [code, res] = await SESSION.sessionNetDrop(await body(c, Body.sessionNetDrop));
    return json(code, res);
  });
  app.post("/session/end", async (c) => {
    const b = await body(c, Body.sessionEnd);
    const wasLive = !!S.session.id && (!b.id || b.id === S.session.id);
    const res = await SESSION.sessionEnd(b);
    if (b.closeOut && res.ok && wasLive && !b.all) res.closeOut = await SESSION.closeOutAfterEnd(((res.session || {}).id) || "");
    return json(200, res);
  });
  app.post("/balance/seed", async (c) => {
    const b = await body(c, Body.balance);
    const prof = pyStr(b.profile || "").trim();
    if (!A.get(prof)) return json(404, { ok: false, error: `no profile ${pyRepr(prof)}` });
    if (BAL.latest(prof)) return json(409, { ok: false, error: `${prof} is already seeded`, seed: BAL.latest(prof) });
    const res: any = await BAL.snapshot(prof, C.CDP_PORT, null, "seed");
    if (res.ok) log(`[balance] ${prof} seeded at ${BAL.fmt(res.amountCents)} cashier` + (res.inPlayCents !== null && res.inPlayCents !== undefined ? ` + ${BAL.fmt(res.inPlayCents)} on the table` : ""));
    return json(res.ok ? 200 : 409, res);
  });
  app.post("/topup/probe", async () => json(200, await topUpRead()));
  app.post("/topup/test-second", async (c) => {
    const b = await body(c, Body.topupSecond);
    if (S.topupLocked) return json(409, { ok: false, reason: "a top-up is already running" });
    S.topupLocked = true;
    try {
      let cents = 0;
      try {
        cents = pyInt(b.cents || 0);
      } catch {
        cents = 0;
      }
      return json(200, await topUpProbeSecond(cents));
    } finally {
      S.topupLocked = false;
    }
  });
  app.post("/topup/now", async () => {
    if (S.topupLocked) return json(409, { ok: false, reason: "a top-up is already running" });
    S.topupLocked = true;
    try {
      return json(200, await topUpRun(true));
    } finally {
      S.topupLocked = false;
    }
  });
  app.post("/balance/reread", async (c) => {
    const b = await body(c, Body.balance);
    const prof = pyStr(b.profile || "").trim();
    if (!A.get(prof)) return json(404, { ok: false, error: `no profile ${pyRepr(prof)}` });
    if (!BAL.latest(prof)) return json(409, { ok: false, error: `${prof} is not seeded yet — seed it first` });
    const res: any = await BAL.snapshot(prof, C.CDP_PORT, S.session.id, "reset");
    if (res.ok) log(`[balance] ${prof} re-read at ${BAL.fmt(res.amountCents)} cashier` + (res.inPlayCents !== null && res.inPlayCents !== undefined ? ` + ${BAL.fmt(res.inPlayCents)} on the table` : ""));
    return json(res.ok ? 200 : 409, res);
  });
  app.post("/session/resume", async () => {
    // a follower joins the leader's session; resuming would TABLES.adopt() it as table 1 — a second lobby driver
    if (!TABLES.isLeader()) {
      return json(409, { ok: false, error: `table ${pyStr(TABLES.slot())} does not resume sessions — it joins table ${TABLES.LEADER}'s (http://127.0.0.1:${TABLES.leaderPort()}/setup)` });
    }
    const rec = S.sessions.openSession();
    if (rec) {
      Object.assign(S.session, { id: rec.id, rec, started: rec.started_at / 1000 });
      await SESSION.applySessionConfig(rec.config);
      S.sessions.event(rec.id, "resumed");
      await SESSION.endOtherOpen(rec.id, "ended: another session was resumed");
      let nRes = 1;
      try {
        nRes = pyInt((rec.config || {}).tables || 1);
      } catch {
        nRes = 1;
      }
      if (isCp()) {
        CP.ensureClient();
        void SESSION.openLeader();
        nRes = 1;
      } else if (isCgg()) nRes = 1;
      else if (nRes > 1) TABLES.adopt(nRes);
      if (!isClientSite()) {
        await SESSION.openTableWindow();
        SESSION.startRouter(rec.config || {}, rec.id);
      }
      if (nRes > 1) void SESSION.openTables(nRes);
    }
    return json(200, { ok: !!rec, session: rec });
  });
  app.post("/study-answers", async (c) => {
    const b = await body(c, Body.studyAnswers);
    const before = S.study.on;
    S.study.on = truthy(b.on);
    if (!S.study.on) S.study.text = null;
    log(`[study] answers ${S.study.on ? "ON" : "off"}`);
    if (S.session.id && before !== S.study.on) S.sessions.event(S.session.id, "study-toggle", { on: S.study.on, hand: S.handNo });
    return json(200, { ok: true, on: S.study.on });
  });
  app.post("/panel/answer", async (c) => {
    const b: any = await body(c, Body.panelAnswer);
    const st = S.study;
    const text = b.text;
    const live = typeof text === "string" && !!text.trim();
    st.text = live ? text : null;
    st.pick = live && typeof b.pick === "string" ? b.pick : null;
    st.roll = live ? b.roll ?? null : null;
    // a note WITHOUT an answer is kept too: it is the poller saying it has stopped asking (currentNote → the panel,
    // and fold-on-no-answer's refusal signal) — dropping it left both blind to a spot that will never be answered
    st.note = typeof b.note === "string" && b.note ? b.note : null;
    st.uncertain = live && typeof b.uncertain === "string" && b.uncertain ? b.uncertain : null;
    st.prov = live ? Object.fromEntries(["band", "strategy", "source", "tier", "chart", "exploitPick", "chartPick"].map((k) => [k, b[k] ?? null])) : null;
    st.decisionKey = live && typeof b.decisionKey === "string" ? b.decisionKey : null;
    st.handId = live && (Number.isInteger(b.handId) || typeof b.handId === "boolean") ? b.handId : null;
    // the decision's stored solve and the client's hand id (2026-09-30): /state's panelAnswerRef, which the side panel
    // fetches the decision's ranges by (the study API's /api/dashboard/live-node)
    st.solveId = live && Number.isInteger(b.solveId) ? b.solveId : null;
    st.clientHandId = live && typeof b.clientHandId === "string" && b.clientHandId ? b.clientHandId : null;
    // THE CHAIN LINE (2026-09-25): the answer's verdict lives and dies with the answer; the session's clean count is
    // kept until the poller sends the next one (every answer carries it)
    const ch = b.chain && typeof b.chain === "object" ? b.chain : null;
    const str = (x: unknown) => (typeof x === "string" && x ? x : null);
    st.chain = live && ch ? { verdict: str(ch.verdict), label: str(ch.label), reason: str(ch.reason) } : null;
    if (ch?.session && typeof ch.session === "object") {
      st.chainSession = { hands: Number(ch.session.hands) || 0, clean: Number(ch.session.clean) || 0,
        rate: typeof ch.session.rate === "number" ? ch.session.rate : null };
    }
    st.at = time();
    return json(200, { ok: true });
  });
  app.post("/update", () => {
    const [code, res] = SESSION.startUpdate();
    return json(code, res);
  });
  app.post("/panel/open-window", async (c) => {
    const b = await body(c, Body.panelOpen);
    const res = SESSION.ensurePanelWindow(pyStr(b.why || "asked over /panel/open-window"));
    if (res.already) return send(200, "application/json", '{"ok": true, "already": true}');
    Object.assign(S.cpFollow, { snapped: null, rect: null });
    return json(res.ok ? 200 : 409, res);
  });
  const cpRoute = (path: string) => app.post(path, async (c) => {
    const raw = await c.req.text();
    const b: any = raw ? Body.adminPanel.parse(JSON.parse(raw)) : {};
    let code: number, res: Record<string, any>;
    if (path === "/coinpoker/attach") [code, res] = cpReattach(b.room ?? null);
    else if (path === "/admin/open") [code, res] = await adminOpen(pyStr(b.room || ""), b.preset || null, stateLight);
    else {
      let port = 0;
      try {
        port = pyInt(b.port || 0);
      } catch {
        port = 0;
      }
      if (!SESSION.ADMIN_PORTS.includes(port)) [code, res] = [400, { ok: false, why: "not a panel port" }];
      else if (path === "/admin/attach") {
        [code, res] = port === C.PANEL_PORT ? cpReattach(b.room ?? null) : await adminPost(port, "/coinpoker/attach", { room: b.room ?? null });
      } else if (b.action === "snap") [code, res] = await adminPost(port, "/layout", {});
      else if (b.action === "end") [code, res] = await adminPost(port, "/session/end", { note: "ended from the admin page", closeOut: true });
      else [code, res] = [400, { ok: false, why: "action must be snap or end" }];
    }
    return json(code, res);
  });
  for (const p of ["/coinpoker/attach", "/admin/attach", "/admin/open", "/admin/panel"]) cpRoute(p);
  app.post("/publish", () => {
    const pub = join(C.ROOT, "..", "setup", "publish.cmd");
    if (SESSION.installedVersion() !== null || !existsSync(pub)) return json(409, { ok: false, why: "not the source checkout" });
    W.startDetached("cmd", ["/c", "start", "Publish Poker Wrapper update", pub], { cwd: join(C.ROOT, ".."), hide: true }, log);
    S.ownerRelease.at = 0.0;
    return json(200, { ok: true });
  });
  app.post("/clubgg/attach", async (c) => {
    const b = await body(c, Body.cggAttach);
    const [code, res] = SESSION.cggReattach(b.key ? pyStr(b.key) : null, b.title ? pyStr(b.title) : null);
    return json(code, res);
  });
  app.post("/sitout", async (c) => {
    const b = await body(c, Body.sitout);
    if (!isCp()) return json(409, { ok: false, why: "sit-out is wired for CoinPoker sessions only" });
    const on = "on" in b ? b.on : true;
    const res = await CP.sitout(truthy(on), truthy(b.all));
    if (S.session.id) S.sessions.event(S.session.id, "sitout", { on, all: truthy(b.all), ok: res.ok ?? null });
    return json(200, res);
  });
  app.post("/act/pick", async () => json(200, await executePick("press")));
  // THE SOLVE BUTTON (on-demand strategies, 2026-09-30): ask the API's poller for an answer to the decision on screen
  app.post("/panel/solve", async () => {
    const res = requestSolve(handState());
    return json(res.ok ? 200 : 409, res);
  });
  app.post("/study-auto", async (c) => {
    const b = await body(c, Body.studyAuto);
    // WHO FLIPPED IT (2026-09-30): an agent's preview browser clicked the live panel's auto label and the event said
    // only {on: false} — a transcript search found it. The panel names itself (`via`, its window's focus/visibility);
    // the headers tell a Claude preview tab, the wrapper's own panel window and a script apart.
    const ua = c.req.header("user-agent") ?? null;
    const by = {
      via: typeof b.via === "string" ? b.via.slice(0, 80) : "http (no via)",
      page: b.page && typeof b.page === "object" ? b.page : null,
      origin: c.req.header("origin") ?? null,
      referer: c.req.header("referer") ?? null,
      ua: ua ? ua.slice(0, 200) : null,
    };
    const res = setAuto(truthy(b.auto), { by,
      allowReal: truthy(b.allowRealMoney), delay: (b.delay as string) ?? null,
      minutes: "minutes" in b ? Number(b.minutes) : null, hands: "hands" in b ? Number(b.hands) : null,
      reason: "reason" in b ? String(b.reason) : null,
      timeBank: "timeBank" in b ? truthy(b.timeBank) : null, topUp: "topUp" in b ? truthy(b.topUp) : null,
    });
    return json(res.ok ? 200 : 409, res);
  });
  app.post("/debug", async (c) => {
    const b = await body(c, Body.debug);
    return json(200, setDebug(truthy(b.on)));
  });
  app.post("/recnote", async (c) => {
    const b = await body(c, Body.recnote);
    return json(200, saveNote(pyStr(b.session ?? ""), pyStr(b.note ?? "")));
  });
  return app;
}

/** Serve on 127.0.0.1:PANEL_PORT; null when the port is held (another instance is starting). */
export function serve(): ReturnType<typeof Bun.serve> | null {
  const app = buildApp();
  for (let i = 0; i < 12; i++) {
    try {
      return Bun.serve({ hostname: "127.0.0.1", port: C.PANEL_PORT, fetch: app.fetch, idleTimeout: 120, reusePort: false });
    } catch {
      Bun.sleepSync(250);
    }
  }
  return null;
}

