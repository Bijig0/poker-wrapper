/**
 * CoinPoker: several panels, one admin page (launch.py 2026-09-23). Each panel is its own wrapper process attached
 * to one table: the main one on :7700, more on 7720-7739 (tag "#2".., CDP 9340+). The admin page (/admin, served
 * by any panel) finds the panels by probing those ports and moves / opens / ends them through ITS OWN server.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import * as cdp from "./cdp";
import { sleep, time } from "./clock";
import { C } from "./config";
import { log } from "./feed";
import { fetchJson, getJson } from "./http";
import { pyReprStr } from "./py";
import * as SES from "./sessions";
import { CP, S, isCp } from "./state";
import { SITE as CP_SITE, Site as CPSite } from "./sites/coinpoker";
import { ADMIN_PORTS } from "./session";
import { snapPanelToCpTable } from "./windows";

/** Which of these ports something listens on (asked of the OS: a connect to a closed port costs 2 s). */
export function listeningPorts(ports: number[]): Set<number> {
  try {
    return cdp.listeningSet(ports);
  } catch {
    return new Set(ports);
  }
}

export async function panelProbe(port: number, stateLight: () => Promise<Record<string, any>>): Promise<Record<string, any> | null> {
  if (port !== C.PANEL_PORT && !listeningPorts([port]).has(port)) return null;
  let s: Record<string, any>;
  if (port === C.PANEL_PORT) s = await stateLight();
  else {
    const r = await getJson(`http://127.0.0.1:${port}/state?light=1`, 5);
    if (r.ok === false && r.error) return null;
    s = r;
  }
  const t = s.table || {};
  return { port, tag: s.panelTag || (port === 7700 ? "main" : `:${port}`), site: s.site ?? null,
           sessionId: s.sessionId ?? null, attached: (s.coinpoker || {}).attached ?? null,
           table: t.room ?? null, label: t.label ?? null, heroSeated: t.heroSeated ?? null,
           answers: s.studyAnswers ?? null, me: port === C.PANEL_PORT };
}

export async function adminState(stateLight: () => Promise<Record<string, any>>): Promise<Record<string, any>> {
  const ports = [...new Set([...[...listeningPorts(ADMIN_PORTS)].filter((p) => ADMIN_PORTS.includes(p)), C.PANEL_PORT])].sort((a, b) => a - b);
  const panels = (await Promise.all(ports.map((p) => panelProbe(p, stateLight)))).filter((x): x is Record<string, any> => !!x);
  const tables = CP.openTables();
  for (const t of tables) t.panels = panels.filter((x) => x.attached === t.room).map((x) => x.port);
  return { ok: true, tables, panels, client: CP.clientState(), me: C.PANEL_PORT };
}

/** This panel reads another table from now on (the admin page's Move, or the panel's own switch). */
export function cpReattach(room: string | null): [number, Record<string, any>] {
  if (room && !CPSite.openRooms().has(room)) return [409, { ok: false, why: "that table is not open in the CoinPoker client" }];
  CP.attach(room);
  S.study.text = null;
  S.study.pick = null;
  if (S.session.rec) {
    const cfg = { ...(S.session.rec.config || {}), cpTable: room };
    S.session.rec.config = cfg;
    S.sessions.setConfig(S.session.id!, cfg);
    S.sessions.event(S.session.id!, "coinpoker-attach", { room });
  }
  S.cpSnap.room = room;
  setTimeout(() => Object.assign(S.cpSnap, { last: snapPanelToCpTable(), at: time() }), 0);
  log(`[coinpoker] attached to ${pyReprStr(String(room))}`);
  return [200, { ok: true, room, label: room ? CPSite.label(room, null).label : null }];
}

export async function adminPost(port: number, path: string, body: unknown, timeoutS = 30): Promise<[number, Record<string, any>]> {
  try {
    const r = await fetchJson(`http://127.0.0.1:${port}${path}`, { body, timeoutS });
    if (r.status >= 400) return [r.status, r.json ?? { ok: false, why: `HTTP Error ${r.status}: ${r.statusText}` }];
    return [r.status, r.json ?? {}];
  } catch (e: any) {
    return [502, { ok: false, why: `panel :${port} did not answer (${e?.message ?? e})` }];
  }
}

/** A new panel for `room`: another wrapper on the next free admin port, then a session on it. */
export async function adminOpen(room: string, preset: string | null, stateLight: () => Promise<Record<string, any>>): Promise<[number, Record<string, any>]> {
  if (!CPSite.openRooms().has(room)) return [409, { ok: false, why: "that table is not open in the CoinPoker client" }];
  const probePorts = [...new Set([...listeningPorts(ADMIN_PORTS), C.PANEL_PORT])].sort((a, b) => a - b);
  const busy = (await Promise.all(probePorts.map((p) => panelProbe(p, stateLight)))).filter((x) => x && x.attached === room);
  if (busy.length) return [409, { ok: false, why: `a panel is already on that table (${busy[0]!.tag})` }];
  const presets = await SES.presets();
  if (preset && !(preset in presets)) return [409, { ok: false, why: `the mode ${pyReprStr(preset)} is not on offer right now` }];
  const live = listeningPorts(ADMIN_PORTS);
  let port: number | null = null;
  for (let p = 7720; p < 7740; p++) if (!live.has(p)) { port = p; break; }
  if (port === null) return [409, { ok: false, why: "no free panel port (7720-7739 are all in use)" }];
  const tag = `#${port - 7718}`;
  const child = spawn(process.execPath, ["run", join(import.meta.dir, "main.ts"), "--panel-port", String(port), "--cdp-port", String(9340 + port - 7720)],
                      { env: { ...process.env, PANEL_TAG: tag, PANEL_DEFER_WINDOW: "1" }, cwd: C.ROOT, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  let up = false;
  for (let i = 0; i < 60; i++) {
    if (await panelProbe(port, stateLight)) {
      up = true;
      break;
    }
    await sleep(1);
  }
  if (!up) return [504, { ok: false, why: `the new panel on :${port} did not come up` }];
  const rec = S.session.rec && isCp() ? S.session.rec : null;
  const t = CP.openTables().find((x: any) => x.room === room) || {};
  let cfg: Record<string, any>;
  if (preset) cfg = { answers: !!(((presets[preset] || {}).config || {}).answers ?? true) };
  else {
    preset = rec ? rec.preset : "strategy:cp200-hu-equilibrium";
    cfg = { ...((rec || {}).config || { answers: true }) };
  }
  Object.assign(cfg, { site: CP_SITE, cpTable: room });
  delete cfg.panelPort;
  if (t.format) cfg.format = t.format;
  const [code, res] = await adminPost(port, "/session/start", { preset, config: cfg, label: `${t.label || room} (${tag})` }, 60);
  if (res.ok) await adminPost(port, "/panel/open-window", {}, 20);
  else await adminPost(port, "/quit", {}, 5);
  return [res.ok ? 200 : code, { ...res, port, tag }];
}
