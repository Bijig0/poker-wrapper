/**
 * /api/gtow/accounts — the GTO Wizard accounts page (2026-09-27; services/gtowAccounts.ts has the why).
 *
 *   GET    /                 every registered account: registry row + live pool state + ledger meters + wall + plan
 *   POST   /                 add or edit an account (the registry row's fields); the pool reloads
 *   DELETE /:id              forget an account
 *   POST   /:id/connect      launch its client if down, then wait for a token
 *   POST   /:id/clear-wall   forget a wall / plan refusal and re-sniff
 *   POST   /:id/probe        ONE request on the account: is the wall really there? (creates its probe solve once)
 *   POST   /:id/info         re-read the plan from the client page now (otherwise cached 10 min)
 *
 * The meters count every process's requests (the ledger is shared), the wall comes from the ledger too (it survives
 * an API restart), the plan comes from the client's own page storage (no request spent). Cheap: two CDP liveness
 * probes and four indexed queries; the dashboard and the wrapper panel may poll it every few seconds.
 */
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gtowApi } from "../services/gtowApi";
import { gtowCdp } from "../services/gtowCdp";
import { gtowRequests, type GtowWindow } from "../services/gtowRequestLog";
import { gtowSessions, type GtowSessionStatus } from "../services/gtowSessions";
import { REPO } from "../services/repoPaths";
import {
  accountInfo, cdpHostTakenBy, cdpPort, launchPlan, loadAccounts, noteAccountFact, probeTreeBody, removeAccount, REQUEST_CAP,
  slugOf, upsertAccount, WALL_MS,
  type GtowAccountEntry, type GtowAccountInfo,
} from "../services/gtowAccounts";

const app = new Hono();
const API_BASE = "https://api.gtowizard.com";

export type AccountLight = "up" | "walled" | "no-token" | "signed-out" | "down" | "off";

export interface AccountView extends GtowAccountEntry {
  live: (GtowSessionStatus & { clientUp?: boolean; browser?: string | null }) | null;
  wall: ReturnType<typeof gtowRequests.wallState>;
  windows: Record<string, GtowWindow>;
  info: GtowAccountInfo | null;
  light: AccountLight;
  lightText: string;
}

function lightOf(a: GtowAccountEntry, s: AccountView["live"], wall: AccountView["wall"], info: GtowAccountInfo | null): { light: AccountLight; text: string } {
  if (!a.enabled) return { light: "off", text: "disabled — takes no work, token kept warm" };
  if (wall.walled || s?.blockedKind === "quota") {
    // relative times: this text is shown by the dashboard AND the wrapper, neither of which wants a UTC stamp
    const since = wall.sinceMs ?? s?.wallSinceMs ?? null;
    const lift = wall.expectedLiftMs ?? s?.blockedUntilMs ?? null;
    return { light: "walled", text: `walled${since ? ` for ${ago(since)}` : ""}${lift ? ` — expected to lift ${until(lift)}` : ""}${wall.leaks ? ` · ${wall.leaks} lone success inside it: probe again` : ""}` };
  }
  if (s?.tokenLive) return { light: "up", text: `connected${s.account ? ` as ${s.account}` : ""}` };
  if (s?.clientUp === false) return { light: "down", text: `nothing listening on ${a.cdpHost}` };
  if (info && !info.signedIn) return { light: "signed-out", text: "client is on the sign-in page — sign in by hand" };
  return { light: "no-token", text: s?.text ?? "no token yet" };
}

const ago = (ms: number) => { const m = Math.round((Date.now() - ms) / 60_000); return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`; };
const until = (ms: number) => { const m = Math.round((ms - Date.now()) / 60_000); return m <= 0 ? "about now" : m < 60 ? `in ${m} min` : `in ${(m / 60).toFixed(1)} h`; };

export async function accountsPayload() {
  const now = Date.now();
  const reg = loadAccounts();
  const [statuses, windows] = await Promise.all([gtowSessions.statusProbed(), Promise.resolve(gtowRequests.windows(now))]);
  const accounts: AccountView[] = await Promise.all(reg.accounts.map(async (a) => {
    const live = (statuses.find((x) => x.id === a.id) as AccountView["live"]) ?? null;
    const wall = gtowRequests.wallState(a.id, now, WALL_MS);
    const info = await accountInfo(a.cdpHost);
    const email = live?.account ?? info?.email ?? a.accountEmail;
    const publicId = live?.accountId ?? info?.publicId ?? a.accountId;
    if ((email && email !== a.accountEmail) || (publicId && publicId !== a.accountId)) noteAccountFact(a.id, { accountEmail: email, accountId: publicId });
    const { light, text } = lightOf(a, live, wall, info);
    return { ...a, accountEmail: email, accountId: publicId, live, wall, windows: windows[a.id] ?? {}, info, light, lightText: text };
  }));
  const sum = (name: string) => {
    let n = 0, x = 0, since: number | null = null;
    for (const w of Object.values(windows)) { const v = w[name]; if (!v) continue; n += v.n; x += v.x429; since = since == null ? v.sinceMs : Math.min(since, v.sinceMs); }
    return { n, x429: x, sinceMs: since, cap: REQUEST_CAP * reg.accounts.filter((a) => a.enabled).length };
  };
  return { ok: true, now, cap: REQUEST_CAP, wallMs: WALL_MS, accounts, combined: { h1: sum("h1"), h24: sum("h24") }, allow: gtowSessions.allowList() };
}

app.get("/", async (c) => c.json(await accountsPayload()));

app.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ ok: false, error: "a JSON body with the account's fields" }, 400);
  if (!String(body.id ?? "").trim() && !String(body.name ?? "").trim()) return c.json({ ok: false, error: "name (or id) is required" }, 400);
  // one DevTools port per client: two accounts on one port would be one window answering as two
  const id = String(body.id ?? "").trim() || slugOf(String(body.name ?? ""));
  if (body.cdpHost) {
    const clash = cdpHostTakenBy(String(body.cdpHost), id);
    if (clash) return c.json({ ok: false, error: `port ${cdpPort(String(body.cdpHost))} is already ${clash.name}'s (${clash.cdpHost}) — every account needs its own` }, 409);
  }
  const saved = upsertAccount(body);
  gtowSessions.reload();
  return c.json({ ...(await accountsPayload()), saved });
});

app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!removeAccount(id)) return c.json({ ok: false, error: `no account '${id}'` }, 404);
  gtowSessions.reload();
  return c.json(await accountsPayload());
});

/** Bring one account's client up and wait for a token — the accounts tab's Connect button. */
app.post("/:id/connect", async (c) => {
  const id = c.req.param("id");
  const cfg = gtowSessions.cfg(id);
  if (!cfg) return c.json({ ok: false, error: `no account '${id}'` }, 404);
  const t0 = Date.now();
  let launch: Record<string, unknown>;
  const entry = loadAccounts().accounts.find((a) => a.id === id);
  if (id === "primary" && entry?.client !== "chrome" && !entry?.exe) {
    // the primary's built-in launcher (its own client detection) — only while the row names no build of its own
    launch = await gtowCdp.launchApp();
  } else if (entry) {
    // the same rule the watchdog follows (services/gtowAccounts.ts launchPlan): a launcher script, else the desktop build,
    // else a Chrome profile of the account's own
    const plan = launchPlan(entry, REPO);
    const env = { ...process.env, ...plan.env };
    const script = plan.kind === "script" ? join(REPO, plan.script!) : plan.kind === "chrome" ? join(REPO, "scripts", "start_gtow_chrome.ps1") : null;
    const cmd = script
      ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Force"]
      : ["powershell", "-NoProfile", "-Command", `Start-Process -FilePath '${plan.exe!.replace(/'/g, "''")}' -ArgumentList '--remote-debugging-port=${plan.port}' -WindowStyle Minimized`];
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env });
    const code = await proc.exited;
    launch = { ok: code === 0, code, needsHuman: code === 3, kind: plan.kind, port: plan.port, out: (await new Response(proc.stdout).text()).trim().slice(-400) };
  } else {
    launch = { ok: false, error: `no account '${id}'` };
  }
  let live = false;
  for (let i = 0; i < 30 && !live; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    live = await gtowApi.forceRefresh(id);
  }
  return c.json({ ...(await accountsPayload()), launch, connected: live, waitedMs: Date.now() - t0 });
});

app.post("/:id/clear-wall", async (c) => {
  const id = c.req.param("id");
  if (!gtowSessions.cfg(id)) return c.json({ ok: false, error: `no account '${id}'` }, 404);
  gtowSessions.reset(id);
  await gtowApi.forceRefresh(id);
  return c.json({ ...(await accountsPayload()), cleared: id });
});

app.post("/:id/info", async (c) => {
  const id = c.req.param("id");
  const a = loadAccounts().accounts.find((x) => x.id === id);
  if (!a) return c.json({ ok: false, error: `no account '${id}'` }, 404);
  await accountInfo(a.cdpHost, { force: true });
  return c.json(await accountsPayload());
});

/**
 * ONE request to learn the truth about a wall (or that there is none): poll the root of a solve this account owns.
 * The solve is created the first time (tree + solution: two more requests, once) and remembered in the registry.
 * A 2xx or a 204 (solving) means the account answers — the pool's block is cleared; a 429 renews it.
 */
app.post("/:id/probe", async (c) => {
  const id = c.req.param("id");
  const a = loadAccounts().accounts.find((x) => x.id === id);
  if (!a) return c.json({ ok: false, error: `no account '${id}'` }, 404);
  const token = await gtowSessions.tokenFor(id, true);
  if (!token) return c.json({ ...(await accountsPayload()), probe: { ok: false, error: "no token — the client is down or signed out" } });
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const poll = async (solId: string) => {
    const q = new URLSearchParams({ custom_solution_id: solId, preflop_actions: "", flop_actions: "", turn_actions: "", river_actions: "", board: "" });
    const r = await gtowRequests.fetch(id, "poll", `${API_BASE}/v4/solutions/spot-solution/?${q}`, { headers: { Authorization: H.Authorization }, signal: AbortSignal.timeout(15_000) }, { pm: "probe", cl: "account-probe" });
    return { status: r.status, body: (await r.text().catch(() => "")).slice(0, 300), retryAfter: r.headers.get("retry-after") };
  };
  let solId = a.probeSolId;
  let spent = 0;
  let res = solId ? (spent++, await poll(solId)) : null;
  if (!res || res.status === 404) {
    // no probe solve yet (or GTO Wizard forgot it): make one — unless the account is walled, which the tree POST says
    const tr = await gtowRequests.fetch(id, "tree", `${API_BASE}/v4/custom-solutions/custom-trees/`, { method: "POST", headers: H, body: JSON.stringify(probeTreeBody()), signal: AbortSignal.timeout(20_000) }, { cl: "account-probe" });
    spent++;
    const trBody = await tr.text().catch(() => "");
    if (tr.status === 429) res = { status: 429, body: trBody.slice(0, 300), retryAfter: tr.headers.get("retry-after") };
    else if (!tr.ok) res = { status: tr.status, body: trBody.slice(0, 300), retryAfter: null };
    else {
      const treeId = JSON.parse(trBody)?.id;
      const so = await gtowRequests.fetch(id, "solution", `${API_BASE}/v4/custom-solutions/`, { method: "POST", headers: H, body: JSON.stringify({ custom_tree_id: treeId, actions: "", board: "" }), signal: AbortSignal.timeout(20_000) }, { cl: "account-probe" });
      spent++;
      const soBody = await so.text().catch(() => "");
      if (so.ok) { solId = String(JSON.parse(soBody)?.id ?? ""); noteAccountFact(id, { probeSolId: solId || null }); res = { status: so.status, body: "", retryAfter: null }; }
      else res = { status: so.status, body: soBody.slice(0, 300), retryAfter: so.headers.get("retry-after") };
    }
  }
  const walled = res.status === 429;
  if (walled) gtowSessions.noteFailure(id, 429, res.body);
  else if (res.status >= 200 && res.status < 300) gtowSessions.noteSuccess(id);
  return c.json({ ...(await accountsPayload()), probe: { ok: !walled, status: res.status, walled, retryAfter: res.retryAfter, body: res.body, requestsSpent: spent } });
});

export default app;
