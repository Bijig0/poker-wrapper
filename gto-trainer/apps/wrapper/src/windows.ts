/**
 * WINDOWS — where the table and the panel go (launch.py: monitors, target_area, _wrapper_windows, apply_layout,
 * chrome_window, _place_when_shown, the CoinPoker panel-beside-the-table follow, the leader window).
 *
 * Placement is in PHYSICAL pixels (the process is per-monitor DPI aware — win32.setDpiAware); Chrome's flags and
 * Browser.setWindowBounds speak DIP, converted with tables.toDip / the target monitor's DPI.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { CdpSocket } from "./cdp";
import * as cdp from "./cdp";
import { sleep, time } from "./clock";
import { C } from "./config";
import { log } from "./feed";
import { pyRound } from "./py";
import { CP, S, isCp } from "./state";
import * as TABLES from "./tables";
import * as W from "./win32";
import * as CPA from "./sites/cpActions";
import { isPanelTitle } from "./ignition/dom";

export type Area = { x: number; y: number; w: number; h: number; primary?: boolean; fw?: number; fh?: number };

export function monitors(): Area[] {
  return W.monitors();
}

/** The monitor the app occupies: the EXTERNAL screen whenever one is attached (STUDY_MONITOR overrides). */
export function targetArea(): Area {
  let mons: Area[] = monitors();
  if (!mons.length) mons = [{ x: 0, y: 0, w: 1440, h: 852, primary: true }];
  const want = (process.env.STUDY_MONITOR || "external").toLowerCase();
  const primary = () => mons.find((m) => m.primary) ?? mons[0]!;
  if (want === "primary") return primary();
  if (want === "cursor") {
    try {
      const [x, y] = W.cursorPos();
      for (const m of mons) if (m.x <= x && x < m.x + m.w && m.y <= y && y < m.y + m.h) return m;
    } catch {}
    return primary();
  }
  const ext = mons.filter((m) => !m.primary);
  return ext.length ? ext[0]! : primary();
}

/** The monitor the tables are NOT on — where the panels go once there are several. null on one screen. */
export function otherArea(): Area | null {
  const tgt = targetArea();
  return monitors().find((m) => m.x !== tgt.x || m.y !== tgt.y) ?? null;
}

export function wantFullscreen(n: number): boolean {
  const f = C.TABLE_FULLSCREEN;
  if (["never", "0", "off", "false"].includes(f)) return false;
  if (["always", "1", "on", "true"].includes(f)) return true;
  return n > 1 && otherArea() !== null;
}

/** (table hwnd, panel hwnd) — Brave windows only, matched by title. */
export function wrapperWindows(): [number | null, number | null] {
  const found: [number, string][] = [];
  for (const h of W.enumWindows()) {
    if (!W.isWindowVisible(h)) continue;
    const title = W.windowText(h);
    if (!title) continue;
    const exe = W.processImagePath(W.windowPid(h));
    if (exe.toLowerCase().endsWith("brave.exe") && (title.toLowerCase().includes("ignition") || title.startsWith("Poker Wrapper"))) {
      found.push([h, title]);
    }
  }
  const otherPanel = C.PANEL_TITLE === "Poker Wrapper" ? "Poker Wrapper Tool" : "Poker Wrapper";
  const table = TABLES.slot() !== null ? null
    : found.find(([, t]) => !isPanelTitle(t, C.PANEL_TITLE) && !isPanelTitle(t, otherPanel) && !t.startsWith("Poker Wrapper"))?.[0] ?? null;
  const panel = found.find(([, t]) => isPanelTitle(t, C.PANEL_TITLE))?.[0] ?? null;
  return [table, panel];
}

export const panelHwnd = () => wrapperWindows()[1];

/** Stamp this slot / tag on the page title (a no-op for the single-table setup). */
export function slotTitle(html: Uint8Array): Uint8Array {
  if (!C.SLOT && !C.TAG) return html;
  const base = C.RIG ? "<title>Poker Wrapper Tool" : "<title>Poker Wrapper";
  const suffix = (C.SLOT ? ` ${C.SLOT}` : "") + (C.TAG ? ` ${C.TAG}` : "");
  const text = Buffer.from(html).toString("latin1");
  const i = text.indexOf(base);
  if (i < 0) return html;
  const b = Buffer.from(html);
  const add = Buffer.from(suffix, "utf8");
  return Buffer.concat([b.subarray(0, i + base.length), add, b.subarray(i + base.length)]);
}

export function layoutNote(): Record<string, any> | null {
  return Object.keys(S.layoutLast).length ? S.layoutLast : null;
}

export const dpiAt = (x: number, y: number) => W.dpiAt(x, y);

/** Move the window holding `targetId` to `rect` (PHYSICAL px) by CDP — the only handle that tells four
 *  identically-titled table windows apart. `fullscreen` then fills that monitor. */
export async function setWindowBounds(targetId: string, rect: Area, port: number, fullscreen = false): Promise<Record<string, any> | null> {
  const wsUrl = await cdp.browserWs(port);
  if (!wsUrl) return null;
  const d = TABLES.toDip(rect, monitors().map((m) => ({ ...m, scale: dpiAt(m.x + 10, m.y + 10) / 96.0 })));
  let bounds: Record<string, any> = { left: d.x, top: d.y, width: d.w, height: d.h };
  try {
    const s = await CdpSocket.open(wsUrl, 5);
    try {
      const got = await s.call(1, "Browser.getWindowForTarget", { targetId }, 5);
      const win = got?.result?.windowId ?? null;
      if (win === null) return null;
      const cur = (await s.call(2, "Browser.getWindowBounds", { windowId: win }, 5))?.result?.bounds || {};
      if (fullscreen && cur.windowState === "fullscreen") return { ...bounds, windowState: "fullscreen", unchanged: true };
      s.send(3, "Browser.setWindowBounds", { windowId: win, bounds: { windowState: "normal" } });
      await s.call(4, "Browser.setWindowBounds", { windowId: win, bounds }, 5);
      if (fullscreen) {
        await s.call(5, "Browser.setWindowBounds", { windowId: win, bounds: { windowState: "fullscreen" } }, 5);
        bounds = { ...bounds, windowState: "fullscreen" };
      }
    } finally {
      s.close();
    }
    return bounds;
  } catch (e: any) {
    log(`[layout] setWindowBounds failed for ${targetId.slice(0, 12)}: ${e?.message ?? e}`);
    return null;
  }
}

/** Put the ONE poker client window where it belongs. Leader only. */
export async function placeClientWindow(ignitionTarget: () => Promise<Record<string, any> | null>): Promise<Record<string, any> | null> {
  if (TABLES.slot() !== null && !TABLES.isLeader()) return null;
  const t = await ignitionTarget();
  if (!t || !t.id) return null;
  const n = TABLES.count();
  const rect = TABLES.clientRect(n, targetArea());
  const full = wantFullscreen(n);
  const got = await setWindowBounds(t.id, rect, C.CDP_PORT, full);
  if (got && !got.unchanged) {
    log(`[layout] client window ${got.width}x${got.height} at (${got.left},${got.top}) DIP` + (full ? " — FULLSCREEN on the table monitor" : "")
        + " — the client tiles its own tables inside it");
  }
  return got;
}

/** COINPOKER: put the PANEL beside the table (the table itself is never moved). */
export function snapPanelToCpTable(): Record<string, any> {
  const t = CP.table();
  if (!t) return { ok: false, why: "no CoinPoker table open yet — sit down in the client" };
  const h = CPA.tableWindow(t.room);
  if (!h) return { ok: false, why: "the table's window was not found" };
  if (CPA.cloaked(h)) return { ok: false, why: CPA.OTHER_DESKTOP };
  if (W.isIconic(h)) return { ok: false, why: "the table is minimised — restore it, then press again" };
  const panel = wrapperWindows()[1];
  if (!panel) return { ok: false, why: "the panel window was not found" };
  const r = W.windowRect(h);
  const cx = Math.floor((r.left + r.right) / 2), cy = Math.floor((r.top + r.bottom) / 2);
  const mons = monitors();
  const area = mons.find((m) => m.x <= cx && cx < m.x + m.w && m.y <= cy && cy < m.y + m.h) ?? (mons.length ? mons[0]! : null);
  if (!area) return { ok: false, why: "no monitor found" };
  const p = W.windowRect(panel);
  const curW = p.right - p.left;
  const strip = area.w - Math.trunc(area.w * C.TABLE_FRAC);
  const want = Math.trunc(area.w * 0.18) <= curW && curW <= Math.trunc(area.w * 0.45) ? curW : strip;
  const right = area.x + area.w - r.right;
  const left = r.left - area.x;
  const floor = Math.trunc(area.w * 0.15);
  let side: string, x: number, w: number;
  if (right >= want) [side, x, w] = ["right", r.right, want];
  else if (left >= want) [side, x, w] = ["left", r.left - want, want];
  else if (Math.max(right, left) >= floor) {
    side = right >= left ? "right" : "left";
    w = Math.max(right, left);
    x = side === "right" ? r.right : area.x;
  } else {
    return { ok: false, why: `no room beside the table on its screen — make the table narrower or move it to one side (the panel needs about ${want}px)` };
  }
  let y = Math.max(r.top, area.y);
  let ht = Math.min(r.bottom, area.y + area.h) - y;
  if (ht < Math.trunc(area.h * 0.5)) [y, ht] = [area.y, area.h];
  if (W.isZoomed(panel) || W.isIconic(panel)) W.showWindow(panel, 9);
  W.moveWindow(panel, x, y, w, ht);
  const [, , cw, ch] = CPA.clientRect(h);
  const ratio = ch ? cw / ch : 0;
  const ref = CPA.REF_W / CPA.REF_H;
  const shapeOk = !!ratio && Math.abs(ratio / ref - 1) <= 0.04;
  S.cpSnap.room = t.room;
  return {
    ok: true, side, panel: { x, y, w, h: ht }, table: { room: t.room, client: [cw, ch], shapeOk },
    monitor: area, monitors: mons.length,
    ...(shapeOk ? {} : { note: `the table is ${cw}x${ch}, a different shape from the layout the buttons were measured on (${CPA.REF_W}x${CPA.REF_H}) — if a press is refused, resize the table closer to that shape` }),
  };
}

/** Put this wrapper's two windows where they belong (see tables.ts for the geometry). */
export async function applyLayout(ignitionTarget: () => Promise<Record<string, any> | null>): Promise<Record<string, any>> {
  if (C.HEADLESS) return { ok: false, why: "headless instance: no windows to place" };
  if (isCp()) {
    const snap = snapPanelToCpTable();
    if (snap.ok) return snap;
    const area = targetArea();
    const panel = wrapperWindows()[1];
    if (panel && !CP.table()) {
      if (W.isZoomed(panel) || W.isIconic(panel)) W.showWindow(panel, 9);
      const tableW = Math.trunc(area.w * C.TABLE_FRAC);
      W.moveWindow(panel, area.x + tableW, area.y, area.w - tableW, area.h);
      return { ok: true, monitor: area, monitors: monitors().length, moved: { panel: true }, why: snap.why ?? null };
    }
    return { ...snap, monitor: area, monitors: monitors().length };
  }
  const me = TABLES.slot();
  const n = TABLES.count();
  const area = targetArea();
  const moved: Record<string, boolean> = {};
  if (me !== null) {
    const bounds = await placeClientWindow(ignitionTarget);
    if (bounds) moved.table = true;
    const panel = wrapperWindows()[1];
    if (panel) {
      const r = TABLES.panelRect(me, n, area, otherArea());
      if (W.isZoomed(panel) || W.isIconic(panel)) W.showWindow(panel, 9);
      W.moveWindow(panel, r.x, r.y, r.w, r.h);
      moved.panel = true;
    }
    return { ok: Object.keys(moved).length > 0, monitor: area, slot: me, tables: n, monitors: monitors().length, moved, client: bounds };
  }
  const tableW = Math.trunc(area.w * C.TABLE_FRAC);
  const [table, panel] = wrapperWindows();
  for (const h of [table, panel]) if (h && (W.isZoomed(h) || W.isIconic(h))) W.showWindow(h, 9);
  if (table) {
    W.moveWindow(table, area.x, area.y, tableW, area.h);
    moved.table = true;
  }
  if (panel) {
    W.moveWindow(panel, area.x + tableW, area.y, area.w - tableW, area.h);
    moved.panel = true;
  }
  return { ok: Object.keys(moved).length > 0, monitor: area, monitors: monitors().length, moved };
}

/** Pin a freshly launched browser window to (x, y, w, h) PHYSICAL px once it exists. */
async function placeWhenShown(pid: number, x: number, y: number, w: number, h: number, timeoutS = 20.0): Promise<void> {
  const deadline = time() + timeoutS;
  while (time() < deadline) {
    const hit = W.enumWindows().filter((hw) => W.isWindowVisible(hw) && W.windowPid(hw) === pid && W.windowText(hw));
    if (hit.length) {
      const hw = hit[0]!;
      if (W.isZoomed(hw) || W.isIconic(hw)) W.showWindow(hw, 9);
      W.moveWindow(hw, x, y, w, h);
      const r = W.windowRect(hw);
      log(`[layout] window pinned at (${r.left},${r.top}) ${r.right - r.left}x${r.bottom - r.top} (physical px)`);
      return;
    }
    await sleep(0.25);
  }
  log("[layout] window not found within the timeout — left where the flags put it");
}

/** One app-mode Chrome/Brave window on its own user-data-dir; x/y/w/h are PHYSICAL px. Detached: the browser
 *  outlives the wrapper, as it did under Python. */
export function chromeWindow(url: string, profile: string, x: number, y: number, w: number, h: number, cdpPort: number | null = null): number | null {
  const scale = dpiAt(x, y) / 96.0;
  const [lx, ly, lw, lh] = [x, y, w, h].map((v) => pyRound(v / scale));
  const args = [`--app=${url}`, `--user-data-dir=${join(C.ROOT, profile)}`,
                `--window-position=${lx},${ly}`, `--window-size=${lw},${lh}`, "--no-first-run", "--no-default-browser-check"];
  if (cdpPort) args.splice(1, 0, `--remote-debugging-port=${cdpPort}`);
  if (C.HEADLESS) args.unshift("--headless=new");
  try {
    const child = spawn(C.CHROME, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    if (!C.HEADLESS && child.pid) void placeWhenShown(child.pid, x, y, w, h);
    return child.pid ?? null;
  } catch (e: any) {
    log(`[layout] could not start the browser: ${e?.message ?? e}`);
    return null;
  }
}

/** Stop the app-mode browser running on OUR user-data-dir `profile` (matched on that path only). */
export async function killProfileWindows(profile: string): Promise<number> {
  const path = join(C.ROOT, profile);
  const ps = "$p = '" + path.replaceAll("'", "''") + "'; "
    + "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir=' + $p) } "
    + "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }";
  try {
    const out = await new Promise<string>((resolve) => {
      const c = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
      let buf = "";
      c.stdout.on("data", (d) => (buf += d.toString()));
      const t = setTimeout(() => { try { c.kill(); } catch {} resolve(buf); }, 20000);
      c.on("close", () => { clearTimeout(t); resolve(buf); });
    });
    const pids = out.split(/\s+/).filter((x) => /^\d+$/.test(x.trim()));
    log(`[close-out] ${profile}: stopped ${pids.length} process(es)`);
    return pids.length;
  } catch (e: any) {
    log(`[close-out] could not stop ${profile}: ${e?.message ?? e}`);
    return 0;
  }
}

/** Close the whole app-mode browser behind a CDP port (Browser.close on its browser-level socket). */
export async function closeBrowser(port: number): Promise<boolean> {
  if (!cdp.listening(port)) return false;
  try {
    const wsUrl = await cdp.browserWs(port);
    if (!wsUrl) return false;
    const s = await CdpSocket.open(wsUrl, 4);
    try {
      s.send(1, "Browser.close", {});
      try { await s.wait(1, 2); } catch {}
    } finally {
      s.close();
    }
    return true;
  } catch (e: any) {
    log(`[close-out] Browser.close on :${port} failed: ${e?.message ?? e}`);
    return false;
  }
}

/** The CoinPoker leader window (title "CoinPoker Leader · ..."), if one is up. */
export function leaderHwnd(): number | null {
  for (const h of W.enumWindows()) {
    if (W.isWindowVisible(h) && W.windowText(h).startsWith("CoinPoker Leader")) return h;
  }
  return null;
}

/** THE PANEL FOLLOWS THE TABLE (CoinPoker): a table that moved and then held still gets the panel beside it. */
export async function cpFollowLoop(): Promise<void> {
  for (;;) {
    await sleep(1.0);
    try {
      const f = S.cpFollow;
      const room = CP.pinned;
      if (!(isCp() && S.session.rec && room)) {
        Object.assign(f, { room: null, hwnd: null, rect: null, stable: 0, snapped: null });
        continue;
      }
      if (f.room !== room || !f.hwnd || !W.isWindow(f.hwnd)) {
        Object.assign(f, { room, hwnd: CPA.tableWindow(room), rect: null, stable: 0, snapped: null });
      }
      const h = f.hwnd;
      if (!h || W.isIconic(h) || CPA.cloaked(h)) continue;
      const r = W.windowRect(h);
      const rect = [r.left, r.top, r.right, r.bottom];
      if (JSON.stringify(rect) !== JSON.stringify(f.rect)) {
        Object.assign(f, { rect, stable: 0 });
        continue;
      }
      f.stable += 1;
      if (JSON.stringify(rect) !== JSON.stringify(f.snapped)) {
        const res = snapPanelToCpTable();
        f.snapped = rect;
        Object.assign(S.cpSnap, { last: res, at: time() });
      }
    } catch (e: any) {
      log(`[coinpoker] follow: ${e?.message ?? e}`);
    }
  }
}
