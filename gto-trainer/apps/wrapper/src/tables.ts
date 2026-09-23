/**
 * Which table window this wrapper owns, when up to four share one browser. Port of tables.py.
 *
 * Four tables are four PROCESSES (module-level state that presses buttons with real money must not be shared),
 * sharing ONE browser: one profile, one login, one CDP port. A CLAIM is this slot's chosen Chrome targetId
 * (data/tables/<slot>.json), refreshed on every read; PRESENCE is asked, not remembered: each slot's panel port is
 * known and every wrapper serves /table/presence with its own local facts.
 *
 * SINGLE TABLE IS UNCHANGED: with no TABLE_SLOT there is no claim, no registry and no probing.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { time, sleep } from "./clock";
import { pyRound } from "./py";
import { paths } from "./env";

export const CLAIM_TTL_S = 20.0;
export const MAX_TABLES = 4;
export const TABLE_COUNTS = [1, 2, 4] as const;

const claimDir = () => join(paths().data, "tables");

/** This process's table slot (1-4), or null when it is the only table. */
export function slot(): number | null {
  const raw = process.env.TABLE_SLOT;
  if (!raw) return null;
  const t = raw.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_TABLES ? n : null;
}

const claimPath = (n: number) => join(claimDir(), `${n}.json`);

/** Every slot's claim as written, stale ones included. */
export function readClaims(): Map<number, any> {
  const out = new Map<number, any>();
  try {
    if (!existsSync(claimDir())) return out;
    for (const f of readdirSync(claimDir())) {
      if (!f.endsWith(".json")) continue;
      const stem = f.slice(0, -5);
      if (!/^[+-]?\d+$/.test(stem.trim())) continue;
      try {
        out.set(Number(stem), JSON.parse(readFileSync(join(claimDir(), f), "utf8")));
      } catch {}
    }
  } catch {}
  return out;
}

/** Target ids other LIVE slots hold. Stale claims are not holdings. */
export function takenByOthers(me: number, now?: number): Set<string> {
  const t = now ?? time();
  const out = new Set<string>();
  for (const [n, c] of readClaims()) {
    if (n === me) continue;
    const tid = c?.targetId;
    if (tid && t - (c.at || 0) <= CLAIM_TTL_S) out.add(tid);
  }
  return out;
}

export function writeClaim(me: number, targetId: string, extra: Record<string, unknown> = {}): void {
  try {
    mkdirSync(claimDir(), { recursive: true });
    const rec = { slot: me, targetId, at: time(), pid: process.pid, ...extra };
    const tmp = claimPath(me).replace(/\.json$/, ".tmp");
    writeFileSync(tmp, JSON.stringify(rec), "utf8");
    renameSync(tmp, claimPath(me));
  } catch {}
}

/** Give the window up — on a clean stand-down, so a restart reclaims it at once. */
export function release(me: number): void {
  try {
    rmSync(claimPath(me), { force: true });
  } catch {}
}

/** The target THIS slot owns. `rank(url)` = null (not a candidate) or a preference (lower first). With no slot:
 *  the first-ranked match, no claim written. With a slot: keep the claim, else the best free one, else null. */
export function pin<T extends { url?: string; id?: string }>(targets: T[], rank: (u: string) => number | null,
                                                            me: number | null = null, extra: Record<string, unknown> = {}): T | null {
  const ranked: [number, number, T][] = [];
  targets.forEach((t, i) => {
    const r = rank(t.url || "");
    if (r !== null && r !== undefined) ranked.push([r, i, t]);
  });
  ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cands = ranked.map((x) => x[2]);
  if (me === null) return cands[0] ?? null;
  const mine = readClaims().get(me)?.targetId;
  if (mine) {
    const held = cands.find((t) => t.id === mine);
    if (held) {
      writeClaim(me, mine, extra);
      return held;
    }
  }
  const others = takenByOthers(me);
  const free = cands.find((t) => t.id && !others.has(t.id));
  if (!free) return null;
  writeClaim(me, free.id!, extra);
  return free;
}

// ---- one wrapper presses at a time (four tables are one page; a click is three CDP events) ----
export const PRESS_TTL_S = 5.0;
export const PRESS_WAIT_S = 2.0;
const pressLockPath = () => join(claimDir(), "press.lock");

export type Lock = { waited: number; forced: boolean; release(): void };

const NULL_LOCK: Lock = { waited: 0, forced: false, release() {} };

async function takePressLock(timeoutS: number): Promise<Lock> {
  const start = time();
  let held = false;
  let forced = false;
  for (;;) {
    let took = false;
    try {
      mkdirSync(claimDir(), { recursive: true });
      const fd = openSync(pressLockPath(), "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: time() }));
      } finally {
        closeSync(fd);
      }
      took = true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") took = true;       // a lock we cannot create must not block a press
    }
    if (took) {
      held = true;
      break;
    }
    let holder: number | null = null;
    try {
      holder = JSON.parse(readFileSync(pressLockPath(), "utf8")).at ?? null;
    } catch {}
    if (holder !== null && time() - holder > PRESS_TTL_S) {
      try { unlinkSync(pressLockPath()); } catch {}
      continue;
    }
    if (time() - start >= timeoutS) {
      forced = true;                               // press anyway: a missed press costs a hand
      break;
    }
    await sleep(0.02);
  }
  const lock: Lock = {
    waited: pyRound(time() - start, 3),
    forced,
    release() {
      if (held) {
        try { unlinkSync(pressLockPath()); } catch {}
        held = false;
      }
    },
  };
  return lock;
}

/** Serialize a press against the other tables — a no-op when there is only one. Always release() in a finally. */
export async function pressLock(timeoutS = PRESS_WAIT_S): Promise<Lock> {
  return slot() !== null ? takePressLock(timeoutS) : NULL_LOCK;
}

// ---- where each slot's windows go ----
export const TABLE_FRAC = 0.7;

export type Area = { x: number; y: number; w: number; h: number; [k: string]: unknown };

/** How many tables this run declared (TABLE_COUNT, inherited by spawned slots). */
export function count(): number {
  const raw = process.env.TABLE_COUNT || "1";
  const t = raw.trim();
  if (!/^[+-]?\d+$/.test(t)) return 1;
  const n = Number(t);
  return (TABLE_COUNTS as readonly number[]).includes(n) ? n : Math.max(1, Math.min(MAX_TABLES, n));
}

/** Become table 1 of `n`, or go back to being the only table. */
export function adopt(n: number): number {
  n = (TABLE_COUNTS as readonly number[]).includes(n) ? n : 1;
  process.env.TABLE_COUNT = String(n);
  if (n > 1) {
    process.env.TABLE_SLOT = String(LEADER);
  } else {
    const me = slot();
    if (me !== null) release(me);
    delete process.env.TABLE_SLOT;
  }
  return n;
}

/** Cell `i` (0-based) of an n-cell grid over `area`. Physical pixels. */
export function grid(i: number, n: number, area: Area): { x: number; y: number; w: number; h: number } {
  const cols = n <= 1 ? 1 : 2;
  const rows = n <= 2 ? 1 : 2;
  const cx = ((i % cols) + cols) % cols;
  const cy = Math.floor(i / cols);
  const w = Math.floor(area.w / cols), h = Math.floor(area.h / rows);
  return {
    x: area.x + cx * w, y: area.y + cy * h,
    w: cx === cols - 1 ? area.w - cx * w : w,
    h: cy === rows - 1 ? area.h - cy * h : h,
  };
}

/** Where the ONE poker client window goes: the 70/30 split at one table, the whole monitor at several. */
export function clientRect(n: number, area: Area): { x: number; y: number; w: number; h: number } {
  if (n <= 1) return { x: area.x, y: area.y, w: Math.trunc(area.w * TABLE_FRAC), h: area.h };
  return { x: area.x, y: area.y, w: area.w, h: area.h };
}

/** Where slot `slotN`'s PANEL belongs: the strip beside one table, else a tile on the other screen. */
export function panelRect(slotN: number, n: number, area: Area, other: Area | null): { x: number; y: number; w: number; h: number } {
  if (n <= 1) {
    const tw = Math.trunc(area.w * TABLE_FRAC);
    return { x: area.x + tw, y: area.y, w: area.w - tw, h: area.h };
  }
  return grid(Math.max(1, Math.min(n, slotN)) - 1, n, other || area);
}

// ---- who is in charge ----
export const LEADER = 1;

/** This wrapper's table as an ORDINAL among the client's table frames, or null for the single-table path. */
export function domSlot(me?: number | null): number | null {
  const m = me === undefined ? slot() : me;
  return m === null ? null : m - 1;
}

export function isLeader(): boolean {
  const me = slot();
  return me === null || me === LEADER;
}

export const PANEL_BASE = 7700, PANEL_STEP = 10;
export const PRESENCE_PATH = "/table/presence";
export const PRESENCE_TTL_S = 3.0;
export const PROBE_TIMEOUT_S = 0.8;

export function panelPort(slotN: number, base?: number, step?: number): number {
  return (base ?? PANEL_BASE) + (step ?? PANEL_STEP) * (slotN - 1);
}

export function leaderPort(base?: number, step?: number): number {
  return panelPort(LEADER, base, step);
}

/** Which rig this process belongs to: the live wrapper, or the test rig. */
export function rig(): string {
  return process.env.FAKE_TABLE === "1" ? "fake" : "live";
}

export function presenceRecord(port: number, sid: string | null = null) {
  return { ok: true, slot: slot(), panelPort: port, rig: rig(), pid: process.pid, count: count(), sid, at: time() };
}

export type PresenceRow = { slot: number; panelPort: number; pid?: number; count?: number; sid?: string | null; at: number; me?: boolean };

/** Ask slot `slotN` whether it is up. null = not up, or not who it claims. */
export async function probe(slotN: number, timeoutS = PROBE_TIMEOUT_S): Promise<PresenceRow | null> {
  const port = panelPort(slotN);
  let d: any;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutS * 1000);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${PRESENCE_PATH}`, { signal: ctl.signal });
    d = await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
  if (!d || typeof d !== "object" || d.slot !== slotN || d.rig !== rig()) return null;
  return { slot: slotN, panelPort: port, pid: d.pid, count: d.count, sid: d.sid, at: time() };
}

const presence: { at: number; rows: PresenceRow[]; probing: boolean } = { at: 0.0, rows: [], probing: false };

function selfRow(now: number): PresenceRow {
  const me = slot()!;
  return { slot: me, panelPort: panelPort(me), pid: process.pid, count: count(), at: now, me: true };
}

/** Probe every OTHER slot now, in parallel, and remember what answered. */
export async function refreshPresence(timeoutS = PROBE_TIMEOUT_S): Promise<PresenceRow[]> {
  const me = slot();
  if (me === null) {
    Object.assign(presence, { at: time(), rows: [], probing: false });
    return [];
  }
  const ks: number[] = [];
  for (let k = 1; k <= MAX_TABLES; k++) if (k !== me) ks.push(k);
  const got = await Promise.all(ks.map((k) => probe(k, timeoutS)));
  const rows = got.filter((r): r is PresenceRow => r !== null).sort((a, b) => a.slot - b.slot);
  Object.assign(presence, { at: time(), rows, probing: false });
  return rows;
}

/** Every table of this session and whether it is answering — the strip. NEVER BLOCKS (stale rows refresh
 *  behind it). A declared table that is not answering keeps a row with live: false. */
export function registry(now?: number): any[] {
  const me = slot();
  if (me === null) return [];
  const t = now ?? time();
  const rows = [...presence.rows];
  const at = presence.at;
  if (t - at > PRESENCE_TTL_S && !presence.probing) {
    presence.probing = true;
    refreshPresence().catch(() => { presence.probing = false; });
  }
  const seen = new Map<number, any>();
  for (const r of rows) if (r.slot !== me) seen.set(r.slot, r);
  seen.set(me, selfRow(t));
  const declared = count();
  const out: any[] = [];
  for (let k = 1; k <= MAX_TABLES; k++) {
    const r = seen.get(k);
    if (r) out.push({ ...r, live: true, ageS: pyRound(Math.max(0.0, t - r.at), 1) });
    else if (k <= declared) out.push({ slot: k, panelPort: panelPort(k), live: false, ageS: at ? pyRound(Math.max(0.0, t - at), 1) : null });
  }
  return out;
}

/** The OTHER tables that are up, from the cached snapshot (stale is merely stale here). */
export function peers(now?: number): any[] {
  const me = slot();
  return registry(now).filter((r) => r.live && r.slot !== me);
}

/** The other tables that are up RIGHT NOW — probed, not remembered (every fan-out goes to this list). */
export async function livePeers(timeoutS = PROBE_TIMEOUT_S): Promise<PresenceRow[]> {
  const me = slot();
  if (me === null) return [];
  return (await refreshPresence(timeoutS)).filter((r) => r.slot !== me);
}

// ---- physical pixels vs the browser's ----
export type Mon = Area & { scale?: number | null };

/** Each monitor with its DIP rect alongside its physical one. */
export function dipLayout(mons: Mon[]): any[] {
  const scaleOf = (o: Mon) => Number(o.scale || 1.0) || 1.0;
  return mons.map((m) => {
    const sc = scaleOf(m);
    const left = mons.filter((o) => o.x < m.x);
    const above = mons.filter((o) => o.y < m.y);
    return {
      ...m, scale: sc,
      dipX: left.reduce((s, o) => s + pyRound(o.w / scaleOf(o)), 0),
      dipY: above.reduce((s, o) => s + pyRound(o.h / scaleOf(o)), 0),
      dipW: pyRound(m.w / sc), dipH: pyRound(m.h / sc),
    };
  });
}

/** A PHYSICAL rect as Chrome's DIP rect; unchanged when no monitor contains it. */
export function toDip(rect: { x: number; y: number; w: number; h: number }, mons: Mon[]) {
  const lay = dipLayout(mons);
  const host = lay.find((m) => m.x <= rect.x && rect.x < m.x + m.w && m.y <= rect.y && rect.y < m.y + m.h);
  if (!host) return { ...rect };
  const sc = host.scale;
  return {
    x: host.dipX + pyRound((rect.x - host.x) / sc), y: host.dipY + pyRound((rect.y - host.y) / sc),
    w: pyRound(rect.w / sc), h: pyRound(rect.h / sc),
  };
}
