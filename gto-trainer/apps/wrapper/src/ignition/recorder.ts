/**
 * THE DEBUG RECORDER — each tick's exact screenshot, the raw DOM capture and what the reader made of it
 * (debug/<session>/f00001.jpg, dom.jsonl, log.jsonl). The ground truth for chasing a misread, and the input the
 * golden replays are built from. Recordings are scratch, not archives: the oldest are pruned past
 * DEBUG_BUDGET_MB (never the newest two, never one with a note).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as cdp from "../cdp";
import { strftime, time } from "../clock";
import { C, DEBUG_DIR } from "../config";
import { log } from "../feed";
import { fmtFixed, pyJsonDumps, pyRound } from "../py";
import { S } from "../state";

export function setDebug(on: boolean): Record<string, any> {
  if (on && !S.dbg.on) {
    pruneDebug();
    const sid = S.session.id;
    const name = sid && !existsSync(join(DEBUG_DIR(), sid)) ? sid : strftime("session_%Y%m%d_%H%M%S");
    const d = join(DEBUG_DIR(), name);
    mkdirSync(d, { recursive: true });
    S.dbg = { on: true, dir: d, seq: 0 };
    log(`[debug] recording to ${d}`);
  } else if (!on && S.dbg.on) {
    S.dbg.on = false;
    log(`[debug] stopped — ${S.dbg.seq} frames in ${S.dbg.dir}`);
  }
  return { on: S.dbg.on, dir: S.dbg.dir, frames: S.dbg.seq };
}

/** Screenshot as JPEG, the composited frame as-is. NO clip: a scaled clip relayouts a headed window and strobes
 *  the table the user is playing on. */
async function shotJpeg(ws: string, out: string, quality = 40): Promise<boolean> {
  const data = await cdp.screenshot(ws, { format: "jpeg", quality }, 8);
  if (!data) return false;
  writeFileSync(out, data);
  return true;
}

function dirSize(d: string): number {
  let n = 0;
  for (const f of readdirSync(d, { withFileTypes: true, recursive: true } as any) as any[]) {
    try {
      if (f.isFile()) n += statSync(join(f.parentPath ?? f.path ?? d, f.name)).size;
    } catch {}
  }
  return n;
}

export function pruneDebug(): void {
  const base = DEBUG_DIR();
  if (!existsSync(base)) return;
  const sess = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("session_")).map((d) => d.name).sort();
  let total = sess.reduce((s, d) => s + dirSize(join(base, d)), 0);
  const budget = C.DEBUG_BUDGET_MB * 1024 * 1024;
  for (const d of sess.slice(0, -2)) {
    if (total <= budget) break;
    if (existsSync(join(base, d, "note.txt"))) continue;
    const sz = dirSize(join(base, d));
    try {
      rmSync(join(base, d), { recursive: true, force: true });
      total -= sz;
      log(`[debug] pruned ${d} (${fmtFixed(sz / 1e6, 0)} MB) to stay under ${C.DEBUG_BUDGET_MB} MB`);
    } catch {}
  }
}

/** The tick's UNPARSED capture, keyed by the same seq as log.jsonl and the frame. */
function dbgDom(seq: number, raw: Record<string, any> | null): boolean {
  if (!raw || !Object.keys(raw).length) return false;
  try {
    appendFileSync(join(S.dbg.dir!, "dom.jsonl"), pyJsonDumps({ seq, ...raw }, { ensureAscii: false }) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function dbgRecord(ws: string, state: Record<string, any>, raw: Record<string, any> | null = null): Promise<void> {
  if (!(S.dbg.on && S.dbg.dir)) return;
  try {
    const seq = S.dbg.seq;
    S.dbg.seq += 1;
    const img = `f${String(seq).padStart(5, "0")}.jpg`;
    try {
      await shotJpeg(ws, join(S.dbg.dir, img));
    } catch {}
    const dom = dbgDom(seq, raw);
    appendFileSync(join(S.dbg.dir, "log.jsonl"),
                   pyJsonDumps({ seq, t: strftime("%H:%M:%S"), ts: pyRound(time(), 2), png: img, dom, ...state }, { ensureAscii: false }) + "\n", "utf8");
  } catch {}
}

/** Saved debug sessions: time range, frame count, captured hand ids, the note. */
export function recordings(): any[] {
  const base = DEBUG_DIR();
  const out: any[] = [];
  if (!existsSync(base)) return out;
  const names = readdirSync(base, { withFileTypes: true }).map((d) => d).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const d of names) {
    if (!d.isDirectory() || !d.name.startsWith("session_")) continue;
    let frames = 0, t0: any = null, t1: any = null;
    const lg = join(base, d.name, "log.jsonl");
    if (existsSync(lg)) {
      try {
        const lines = readFileSync(lg, "utf8").trim().split(/\r?\n/).filter((l) => l !== "");
        frames = lines.length;
        if (lines.length) {
          t0 = JSON.parse(lines[0]!).t ?? null;
          t1 = JSON.parse(lines[lines.length - 1]!).t ?? null;
        }
      } catch {}
    }
    let ids: any = {}, note = "";
    try {
      const hj = join(base, d.name, "hand_ids.json");
      if (existsSync(hj)) ids = JSON.parse(readFileSync(hj, "utf8"));
      const nf = join(base, d.name, "note.txt");
      if (existsSync(nf)) note = readFileSync(nf, "utf8");
    } catch {}
    out.push({ name: d.name, frames, start: t0, end: t1, handIds: ids, note });
  }
  return out;
}

/** Validated path to a recording folder (no traversal). */
export function sessionDir(session: string): string | null {
  if (!/^session_[\d_]+$/.test(session)) return null;
  const d = join(DEBUG_DIR(), session);
  return existsSync(d) && statSync(d).isDirectory() ? d : null;
}

export function recLog(session: string): any[] {
  const d = sessionDir(session);
  if (!d || !existsSync(join(d, "log.jsonl"))) return [];
  const out: any[] = [];
  for (const line of readFileSync(join(d, "log.jsonl"), "utf8").split(/\r?\n/)) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export function recFrame(session: string, seq: number): [Uint8Array, string] | null {
  const d = sessionDir(session);
  if (!d) return null;
  for (const [ext, ctype] of [[".jpg", "image/jpeg"], [".png", "image/png"]] as const) {
    const p = join(d, `f${String(seq).padStart(5, "0")}${ext}`);
    if (existsSync(p)) return [readFileSync(p), ctype];
  }
  return null;
}

export function saveNote(session: string, note: string): Record<string, any> {
  if (!/^session_[\d_]+$/.test(session)) return { ok: false, reason: "bad session name" };
  const d = join(DEBUG_DIR(), session);
  if (!existsSync(d) || !statSync(d).isDirectory()) return { ok: false, reason: "no such session" };
  writeFileSync(join(d, "note.txt"), [...note].slice(0, 4000).join(""), "utf8");
  return { ok: true };
}

/** The hand-id map, written into the recording while it runs. */
export function writeHandIds(): void {
  if (!(S.dbg.on && S.dbg.dir)) return;
  try {
    writeFileSync(join(S.dbg.dir, "hand_ids.json"), pyJsonDumps(S.handIds), "utf8");
  } catch {}
}
