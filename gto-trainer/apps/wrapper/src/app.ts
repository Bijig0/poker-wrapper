/**
 * The wrapper's startup, after main.ts has put argv / local.env into the environment (launch.main + _takeover +
 * _main_tail). Order matters and is launch.py's: take over the port, guard the double-click with a mutex, serve,
 * start the loops, then the windows, then (on the test rig) seed the fake table's opening spot.
 */
import { adoptAtStartup } from "../../../packages/data-root/centralDb";
import { describeLayout } from "../../../packages/data-root/dataRoot";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as cdp from "./cdp";
import { sleep, strftime } from "./clock";
import { C, DEBUG_DIR } from "./config";
import { log } from "./feed";
import { fetchJson } from "./http";
import { pyRepr } from "./py";
import { CGG, CP, S, isCgg } from "./state";
import * as TABLES from "./tables";
import * as W from "./win32";
import * as faketable from "./faketable";
import { cggFinished, cggLine, cpFinished, cpLine } from "./archive";
import { portOf } from "./ignition/dom";
import "./ignition/reader";                    // installs the real ignitionTarget seam
import "./relay";                              // installs act / raiseTo / cdpSeq
import { feedLoop, wsTap } from "./loops";
import { chainKeeper, faketableLoad, healthLoop, leaderWatchLoop, leftovers, openTableWindow, panelWatchLoop } from "./session";
import { netGuard } from "./netguard";
import { serve } from "./server";
import { chromeWindow, cpFollowLoop, otherArea, panelHwnd, targetArea } from "./windows";

async function serverAlive(): Promise<boolean> {
  try {
    const r = await fetchJson(`http://127.0.0.1:${C.PANEL_PORT}/state`, { timeoutS: 1.5 });
    return r.status < 400;
  } catch {
    return false;
  }
}

/** Live processes running THIS wrapper on THIS panel port, excluding us and our ancestors (a launcher's parent is
 *  never a sibling). Anything else holding the port — an old build of any kind — is caught by portOwner(). */
function siblingPids(): number[] {
  const me = process.pid;
  let procs: W.Proc[];
  try {
    procs = W.listProcesses();
  } catch {
    return [];
  }
  const anc = new Set(W.ancestors(me, procs));
  const mainTs = resolve(import.meta.dir, "main.ts").toLowerCase();
  const out: number[] = [];
  for (const p of procs) {
    if (p.pid === me || anc.has(p.pid)) continue;
    if (!(p.name || "").toLowerCase().startsWith("bun")) continue;
    const cmd = W.processCmdline(p.pid) || [];
    const hit = cmd.some((a) => {
      let full: string;
      try {
        full = resolve(a).toLowerCase();
      } catch {
        return false;
      }
      return full === mainTs;
    });
    if (!hit || portOf(cmd) !== C.PANEL_PORT) continue;
    out.push(p.pid);
  }
  return out;
}

/** Pid of whatever LISTENS on the panel port, if it isn't us. */
function portOwner(): number | null {
  try {
    const l = W.tcpListeners().find((x) => x.port === C.PANEL_PORT && x.pid && x.pid !== process.pid);
    return l ? l.pid : null;
  } catch {
    return null;
  }
}

/** Replace any previous instance rather than defer to it: ask it to /quit (the hand in flight is archived),
 *  then terminate whatever is still standing. */
async function takeover(): Promise<void> {
  if (await serverAlive()) {
    try {
      await fetchJson(`http://127.0.0.1:${C.PANEL_PORT}/quit`, { method: "POST", body: {}, timeoutS: 3 });
      log("[panel] asked the running instance to stand down");
    } catch {}
    for (let i = 0; i < 24; i++) {
      if (!(await serverAlive())) break;
      await sleep(0.25);
    }
  }
  const stale = new Set(siblingPids());
  const owner = portOwner();
  if (owner !== null) stale.add(owner);
  if (!stale.size) return;
  for (const pid of stale) {
    try {
      W.terminateProcess(pid);
    } catch {}
  }
  for (let i = 0; i < 16; i++) {
    if ([...stale].every((p) => !W.processAlive(p))) break;
    await sleep(0.25);
  }
  log(`[panel] replaced previous instance(s): ${pyRepr([...stale].sort((a, b) => a - b))}`);
}

export async function main(argv: string[]): Promise<void> {
  W.setDpiAware();
  try {
    mkdirSync(DEBUG_DIR(), { recursive: true });
    // run-study.pyw wrote "start (purged N caches)"; there are no caches to purge here, so say WHEN and WHO
    writeFileSync(join(DEBUG_DIR(), "last-start.txt"), `start ${strftime("%Y-%m-%d %H:%M:%S", Date.now() / 1000)} pid=${process.pid} argv=${pyRepr(argv)}\n`, "utf8");
  } catch {}
  await takeover();
  // the central database: fold any legacy per-store files in BEFORE a loop can write (seconds, once — never mid-hand).
  // The fake-table rig never adopts: it must not move the live system's files.
  log(describeLayout());
  if (!C.FAKE_RIG) {
    try {
      adoptAtStartup(log);
    } catch (e: any) {
      log(`[data-root] adoption failed: ${e?.message ?? e}`);
    }
  }
  // The mutex guards the sub-second double-click; port-scoped, so the test rig and a real session coexist.
  const mutex = `IgnitionStudyPanelServer:${C.PANEL_PORT}`;
  const already = W.mutexExists(mutex);
  let srv: ReturnType<typeof serve> = null;
  if (already) {
    log("[panel] another launch is starting up — deferring to it");
  } else {
    W.createMutex(mutex);
    srv = serve();
    if (srv === null) log(`[panel] port :${C.PANEL_PORT} still held — reusing existing server`);
  }
  if (srv) {
    const bg = (name: string, f: () => Promise<void>) => void f().catch((e) => log(`[${name}] stopped: ${e?.message ?? e}`));
    bg("feed", feedLoop);
    bg("ws", wsTap);
    CP.start(cpLine, cpFinished);
    CGG.start(cggLine, cggFinished, () => isCgg() && !!S.session.id);
    bg("health", healthLoop);
    bg("panel-watch", panelWatchLoop);
    bg("leader-watch", leaderWatchLoop);
    bg("cp-follow", cpFollowLoop);
    bg("chain", chainKeeper);
    bg("net", netGuard);
    log(`[panel] serving on http://127.0.0.1:${C.PANEL_PORT}/panel`);
  }
  const area = targetArea();
  const { w, h, x: ax, y: ay } = area;
  const tableW = Math.trunc(w * C.TABLE_FRAC);
  if (S.fakeMode || (await cdp.available(C.CDP_PORT))) {
    try {
      await openTableWindow();
    } catch (e: any) {
      log(`[table] ${e?.message ?? e}`);
    }
  }
  let hwnd: number | null = null;
  if (C.HEADLESS) {
    log("[panel] headless: no panel window");
  } else if ((hwnd = panelHwnd())) {
    const a2 = targetArea();
    W.showWindow(hwnd, 9);
    const r = W.windowRect(hwnd);
    if (!(a2.x <= r.left && r.left < a2.x + a2.w)) {
      const tableUp = S.fakeMode || (await cdp.available(C.CDP_PORT));
      W.moveWindow(hwnd, a2.x + (tableUp ? tableW : 0), a2.y, tableUp ? w - tableW : w, h);
    }
    W.setForegroundWindow(hwnd);
    log("[panel] window already open — brought to front");
  } else if (C.PANEL_DEFER_WINDOW) {
    log("[panel] no window yet — the leader opens it once the session runs");
  } else {
    const sideUrl = S.fakeMode ? `http://127.0.0.1:${C.PANEL_PORT}/tool`
      : TABLES.isLeader() ? `http://127.0.0.1:${C.PANEL_PORT}/setup` : `http://127.0.0.1:${C.PANEL_PORT}/panel`;
    const tableUp = S.fakeMode || (await cdp.available(C.CDP_PORT));
    const me = TABLES.slot(), n = TABLES.count();
    if (me !== null && n > 1) {
      const r = TABLES.panelRect(me, n, area as TABLES.Area, otherArea() as TABLES.Area | null);
      chromeWindow(sideUrl, C.PROFILE_PANEL, r.x, r.y, r.w, r.h);
      log(`[panel] slot ${me}/${n}: panel at (${r.x},${r.y}) ${r.w}x${r.h} — ${sideUrl}`);
    } else if (tableUp) {
      chromeWindow(sideUrl, C.PROFILE_PANEL, ax + tableW, ay, w - tableW, h);
      log(`[panel] window beside table (${w - tableW}x${h}) at ${sideUrl}`);
    } else {
      chromeWindow(sideUrl, C.PROFILE_PANEL, ax, ay, w, h);
      log(`[panel] setup window on the ${area.primary ? "primary" : "secondary"} monitor (${w}x${h}) at ${sideUrl}`);
    }
  }
  // A fresh test rig RENDERS a table; seed the same spot into /hand so Study Answers has a turn to answer.
  if (srv && S.fakeMode) {
    try {
      await faketableLoad(S.faketableSpec || faketable.EXAMPLE_SPEC);
    } catch (e: any) {
      log(`[faketable] could not seed the opening spot: ${e?.message ?? e}`);
    }
  }
  if (!srv) process.exit(0);
  const opened = await leftovers();
  if (opened.length) log(`[session] ${opened.length} left open (${opened.map((r) => r.id).join(", ")}) — resume the newest or end them all on /setup`);
  // the contract suite (test/contract/runner.ts STARTED) waits for this line: the startup, seed included, is over
  log("Ctrl+C stops the panel server (browser windows stay open).");
}
