/**
 * ClubGG as a Poker Wrapper site — THE READER ONLY (2026-09-28): no answers, no presses yet.
 *
 * Ignition is read through its web client (CDP + the game's WebSocket), CoinPoker through its log. ClubGG has
 * neither: one ClubGG.exe (Unity 6, IL2CPP, obfuscated) draws the lobby and every table as its own window
 * (class UnityWndClass, title "<table name> - <sb>/<bb>"), writes no hand events anywhere, talks to its server over
 * one encrypted connection, and ships an anti-tamper module (Plugins/x86_64/Loki.dll). So this reader only LOOKS:
 *
 *   visible? -> copy the table's pixels off the screen -> Windows OCR (lines + boxes) -> cggFrame.parseFrame
 *   -> cggFeed.Room (the hand) -> ParsedHand
 *
 * No injection, no memory reads, no packet capture. PrintWindow answers ClubGG's window with black, so the pixels are
 * a SCREEN COPY: whatever is on top of the table is what gets copied. Every read therefore first checks the table
 * is the window under a grid of points over its whole client area (and not minimised / on another desktop); a
 * covered table is not read — and never recorded — and the panel says what covers it.
 *
 * Recording (the session's "recording" box): read frames are saved as PNG + index.jsonl under <debug>/clubgg/<session>
 * (1 a second, CGG_RECORD_FPS; capped at 4 GB), the format tools/cggReplay.ts replays — the way to hand over hero's
 * hole cards later. Only frames the reader read are saved: a covered table's pixels (someone else's window) never are.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { deflateSync } from "node:zlib";
import { time } from "../clock";
import { DATA_DIR, DEBUG_DIR } from "../config";
import { pyRound } from "../py";
import * as W from "../win32";
import * as feed from "./cggFeed";
import { parseFrame, stakesOf, type Snapshot } from "./cggFrame";
import * as ocr from "./cggOcr";

export const SITE = "clubgg";
export const EXE = join(process.env.ProgramFiles || "C:\\Program Files", "ClubGG", "ClubGG.exe");
/** A read at most every this many ms (one OCR is ~150 ms; the labels stay up ~1-2 s). */
const TICK_MS = 300;
const REC_BUDGET_BYTES = 4 * 1024 ** 3;
/** Recorded frames a second (a 1698x1260 PNG is ~1.5 MB): enough to see every card; CGG_RECORD_FPS for more. */
const REC_FPS = Math.max(0.1, Number(process.env.CGG_RECORD_FPS || "1"));

export const FORMATS: any[] = [
  { id: "cgg-ring", site: SITE, gameType: "ring", stake: null, seats: null, name: "ClubGG ring (any stakes)", bb: null,
    currency: "club chips", _doc: "any ClubGG ring table — the blinds are read off the table window's title" },
  { id: "cgg-hu", site: SITE, gameType: "hu", stake: null, seats: 2, name: "ClubGG heads-up", bb: null,
    currency: "club chips", _doc: "a ClubGG heads-up table" },
];

export type TableWin = { hwnd: number; title: string; pid: number };

let pidCache: { at: number; pids: Set<number> } = { at: 0, pids: new Set() };
function clubggPids(): Set<number> {
  if (time() - pidCache.at < 5) return pidCache.pids;
  const pids = new Set(W.listProcesses().filter((p) => p.name.toLowerCase() === "clubgg.exe").map((p) => p.pid));
  pidCache = { at: time(), pids };
  return pids;
}

/** A table as a person reads it ("NLH 1/2 · NLH 80-200 BP"). */
export function label(title: string): string {
  const st = stakesOf(title);
  const name = title.replace(/\s*-\s*[\d.]+\s*\/\s*[\d.]+(\s*\([\d.]+\))?\s*$/, "").trim();
  return st.sb !== null && st.bb !== null ? `${st.game ?? "NLH"} ${st.sb}/${st.bb}${st.ante ? ` (ante ${st.ante})` : ""} · ${name}` : title;
}

/** A BGRA frame as a PNG (RGB, filter 0, deflate level 1 — fast; a 1698x1260 table is ~1.5 MB). */
export function png(f: { width: number; height: number; bgra: Uint8Array }): Uint8Array {
  const { width: w, height: h, bgra } = f;
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0, o = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      raw[o++] = bgra[i + 2]!;
      raw[o++] = bgra[i + 1]!;
      raw[o++] = bgra[i]!;
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export class Site {
  id = SITE;
  error: string | null = null;
  /** why the last tick read nothing ("covered by Discord.exe", "no table window") — null when it read */
  status: string | null = null;
  rooms = new Map<string, feed.Room>();
  /** THE ATTACHED TABLE: its window handle (as a string) and title — the title re-finds it if the window is reopened */
  pinned: string | null = null;
  pinnedTitle: string | null = null;
  recordDir: string | null = null;
  stats = { reads: 0, covered: 0, lastReadAt: 0, lastOcrMs: 0, lastTickMs: 0, recorded: 0, recordBytes: 0, recordedAt: 0 };
  private running = false;
  private active: string | null = null;
  private onLine: ((room: string, line: string) => void) | null = null;
  private onFinished: ((room: feed.Room, h: feed.Hand) => void) | null = null;

  attach(key: string | null | undefined, title: string | null = null): void {
    this.pinned = key || null;
    this.pinnedTitle = title ?? (key ? Site.tables().find((t) => String(t.hwnd) === key)?.title ?? null : null);
  }

  // ---- the client and its tables ----
  static tables(): TableWin[] {
    const pids = clubggPids();
    if (!pids.size) return [];
    const out: TableWin[] = [];
    for (const h of W.enumWindows()) {
      const pid = W.windowPid(h);
      if (!pids.has(pid) || !W.isWindowVisible(h) || W.className(h) !== "UnityWndClass") continue;
      const title = W.windowText(h);
      if (!title || title === "ClubGG") continue;            // "ClubGG" is the lobby
      out.push({ hwnd: h, title, pid });
    }
    return out;
  }

  /** The table this session reads: the attached one (re-found by title if its window changed), else the only one. */
  target(): TableWin | null {
    const all = Site.tables();
    if (this.pinned) {
      const byKey = all.find((t) => String(t.hwnd) === this.pinned);
      if (byKey) return byKey;
      const byTitle = this.pinnedTitle ? all.filter((t) => t.title === this.pinnedTitle) : [];
      if (byTitle.length === 1) {
        this.pinned = String(byTitle[0]!.hwnd);
        return byTitle[0]!;
      }
      return null;
    }
    return all.length === 1 ? all[0]! : null;
  }

  /** Why the table cannot be read off the screen right now, or null. A grid of 6x5 points over the client area must
   *  all be the table's own window. */
  static coverage(h: number): string | null {
    if (!W.isWindow(h)) return "the table window is gone";
    if (W.isIconic(h)) return "the table window is minimised";
    if (W.cloaked(h)) return "the table window is on another virtual desktop";
    const [x, y, w, hh] = W.clientRect(h);
    if (w < 400 || hh < 300) return `the table window is too small to read (${w}x${hh})`;
    const others = new Map<number, number>();
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 6; i++) {
        const px = x + Math.round(w * (0.04 + 0.92 * i / 5)), py = y + Math.round(hh * (0.06 + 0.9 * j / 4));
        const owner = W.ownerAt(px, py);
        if (owner !== h) others.set(owner, (others.get(owner) ?? 0) + 1);
      }
    }
    if (!others.size) return null;
    const [who] = [...others].sort((a, b) => b[1] - a[1])[0]!;
    let name = "another window";
    try {
      const exe = basename(W.processImagePath(W.windowPid(who)));
      if (exe) name = exe.toLowerCase() === "clubgg.exe" ? "the ClubGG lobby" : exe;
    } catch {}
    return `covered by ${name} — bring the table to the front`;
  }

  /** Every open table for the setup page. */
  openTables(): any[] {
    return Site.tables().map((t) => {
      const room = this.rooms.get(String(t.hwnd));
      const st = stakesOf(t.title);
      const seats = room?.lastSnap?.seats ?? [];
      const [, , w, hh] = W.clientRect(t.hwnd);
      return {
        key: String(t.hwnd), title: t.title, label: label(t.title), attached: String(t.hwnd) === this.pinned,
        sb: st.sb, bb: st.bb, ante: st.ante, game: st.game, width: w, height: hh,
        covered: Site.coverage(t.hwnd), players: seats.length || null,
        heroSeated: !!(feed.hero.name && seats.some((s) => s.name === feed.hero.name)),
        format: "cgg-ring",
      };
    });
  }

  clientState(): Record<string, any> {
    const running = clubggPids().size > 0;
    return { running, exe: EXE, installed: existsSync(EXE), tables: running ? Site.tables().length : 0 };
  }

  // ---- the reader loop ----
  /** Read the attached table every TICK_MS while `shouldRun()` (a ClubGG session is live); idle otherwise. */
  start(onLine: ((room: string, line: string) => void) | null, onFinished: ((room: feed.Room, h: feed.Hand) => void) | null,
        shouldRun: () => boolean): void {
    this.onLine = onLine;
    this.onFinished = onFinished;
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      let wait = 1000;
      const t0 = performance.now();
      try {
        if (shouldRun()) {
          await this.readOnce();
          this.error = null;
          wait = Math.max(30, TICK_MS - (performance.now() - t0));
        } else this.status = null;
      } catch (e: any) {
        this.error = `${e?.name || "Error"}: ${e?.message || e}`;
      }
      this.stats.lastTickMs = Math.round(performance.now() - t0);
      setTimeout(tick, wait);
    };
    setTimeout(tick, 0);
  }

  async readOnce(): Promise<Snapshot | null> {
    const t = this.target();
    if (!t) {
      this.status = this.pinned ? "the attached table is not open in ClubGG" : Site.tables().length > 1 ? "several tables open — attach one on the setup page" : "no ClubGG table window open";
      return null;
    }
    const why = Site.coverage(t.hwnd);
    if (why) {
      this.status = why;
      this.stats.covered++;
      return null;
    }
    const frame = W.captureScreen(t.hwnd);
    if (!frame.ok) {
      this.status = "the screen cannot be copied right now (the workstation is locked?)";
      this.stats.covered++;
      return null;
    }
    // the copy is only good if nothing came over the table while it was taken
    const after = Site.coverage(t.hwnd);
    if (after) {
      this.status = after;
      this.stats.covered++;
      return null;
    }
    const o = await ocr.recognize(frame);
    const snap = parseFrame(frame, o.lines, time());
    const key = String(t.hwnd);
    let room = this.rooms.get(key);
    if (!room) {
      room = new feed.Room(key, t.title);
      this.rooms.set(key, room);
    }
    room.title = t.title;
    const st = stakesOf(t.title);
    room.stakes = { sb: st.sb, bb: st.bb, ante: st.ante };
    const lines = room.apply(snap);
    this.active = key;
    this.status = null;
    Object.assign(this.stats, { reads: this.stats.reads + 1, lastReadAt: time(), lastOcrMs: o.ms });
    for (const l of lines) this.onLine?.(key, l);
    for (const h of room.drainFinished()) {
      this.logHand(room, h);
      this.onFinished?.(room, h);
    }
    if (this.recordDir) this.record(frame, t, snap);
    return snap;
  }

  private record(frame: { width: number; height: number; bgra: Uint8Array }, t: TableWin, snap: Snapshot): void {
    const dir = this.recordDir!;
    if (this.stats.recordBytes > REC_BUDGET_BYTES || snap.t - this.stats.recordedAt < 1 / REC_FPS) return;
    this.stats.recordedAt = snap.t;
    try {
      mkdirSync(dir, { recursive: true });
      const ts = Math.round(snap.t * 1000);
      const file = `${t.hwnd}_${ts}.png`;
      const bytes = png(frame);
      writeFileSync(join(dir, file), bytes);
      appendFileSync(join(dir, "index.jsonl"), JSON.stringify({ ts, hwnd: t.hwnd, title: t.title, file, how: "screen", w: frame.width, h: frame.height }) + "\n");
      this.stats.recorded++;
      this.stats.recordBytes += bytes.length;
      if (this.stats.recordBytes > REC_BUDGET_BYTES) this.onLine?.(String(t.hwnd), `recording stopped at ${Math.round(REC_BUDGET_BYTES / 1024 ** 3)} GB (${dir})`);
    } catch (e: any) {
      this.error = `recording: ${e?.message ?? e}`;
    }
  }

  /** Every finished hand the reader saw, hero's or not, one JSON line — what to check the reader against. */
  private logHand(room: feed.Room, h: feed.Hand): void {
    try {
      const dir = join(DATA_DIR(), "clubgg");
      mkdirSync(dir, { recursive: true });
      const day = new Date(h.t0 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
      const ph = this.exportFinished(room, h);
      appendFileSync(join(dir, `hands-${day}.jsonl`), JSON.stringify({
        id: h.id, table: room.title, t0: h.t0, tEnd: h.tEnd ?? null, sb: h.sb, bb: h.bb, button: h.button, bomb: h.bomb,
        names: Object.fromEntries(h.names), startStacks: Object.fromEntries(h.startStacks), board: h.board,
        actions: h.actions, winners: h.winners, joinedLate: h.joinedLate, uncertain: h.uncertain, lineUncertain: ph?.lineUncertain ?? null,
      }) + "\n");
    } catch {}
  }

  // ---- what the wrapper reads ----
  roomNow(): feed.Room | null {
    const key = this.pinned ?? this.active;
    return key ? this.rooms.get(key) ?? null : null;
  }

  hand(): Record<string, any> | null {
    const r = this.roomNow();
    if (!r || !r.hand || r.hand.done) return null;
    const h = feed.exportHand(r);
    if (h && !("tableSlot" in h)) h.tableSlot = null;
    return h;
  }

  exportFinished(room: feed.Room, h: feed.Hand): Record<string, any> | null {
    const out = feed.exportHand(room, { ...h, done: false });
    if (out && !("tableSlot" in out)) out.tableSlot = null;
    return out;
  }

  table(): Record<string, any> | null {
    const t = this.target();
    const r = this.roomNow();
    if (!t && !r) return null;
    const snap = r?.lastSnap ?? null;
    const seats = snap?.seats ?? [];
    const heroSeat = r?.hand?.hero ?? null;
    return {
      key: t ? String(t.hwnd) : r!.key, title: t?.title ?? r!.title, label: label(t?.title ?? r!.title),
      open: !!t, status: this.status, error: this.error,
      lastReadAgo: this.stats.lastReadAt ? pyRound(time() - this.stats.lastReadAt, 1) : null,
      seats: seats.map((s) => ({ name: s.name, stack: s.stack, bet: s.bet, cards: s.cards, active: s.active })),
      heroSeated: heroSeat !== null || !!(feed.hero.name && seats.some((s) => s.name === feed.hero.name)),
      heroName: feed.hero.name || (heroSeat !== null ? r?.hand?.names.get(heroSeat) ?? null : null),
      heroSittingOut: false,
      practice: false,
      hand: r?.hand && !r.hand.done ? { id: r.hand.id, street: r.hand.street, board: r.hand.board, bomb: r.hand.bomb, actions: r.hand.actions.length } : null,
      lastHand: r?.last?.id ?? null,
      reads: this.stats.reads, covered: this.stats.covered, ocrMs: this.stats.lastOcrMs, tickMs: this.stats.lastTickMs,
      recording: this.recordDir ? { dir: this.recordDir, frames: this.stats.recorded, mb: pyRound(this.stats.recordBytes / 1e6, 0) } : null,
    };
  }

  practice(): boolean {
    return false;
  }

  heroStatus(): string | null {
    const t = this.table();
    if (!t) return null;
    return t.heroSeated ? "in-hand" : "not-in-hand";
  }

  // ---- presses: not wired ----
  async actuate(_plan: Record<string, any>, _opts: { auto?: boolean; allowReal?: boolean } = {}): Promise<Record<string, any>> {
    return { ok: false, reason: "ClubGG presses are not wired — the ClubGG site is the reader only for now", kind: SITE };
  }

  async sitout(_on: boolean, _every = false): Promise<Record<string, any>> {
    return { ok: false, why: "sit-out is not wired for ClubGG (the reader only) — use the table's own menu" };
  }

  /** The ClubGG rows of the setup page's preflight; `key` = the table the session attaches to. */
  preflight(key: string | null = null): any[] {
    const st = this.clientState();
    const all = st.running ? Site.tables() : [];
    const t = key ? all.find((x) => String(x.hwnd) === key) ?? (this.pinnedTitle ? all.find((x) => x.title === this.pinnedTitle) : undefined) : all.length === 1 ? all[0] : undefined;
    const cov = t ? Site.coverage(t.hwnd) : null;
    return [
      { id: "cgg-client", label: "ClubGG client", required: true, ok: st.running,
        detail: st.running ? `running · ${all.length} table window${all.length === 1 ? "" : "s"} open` : st.installed ? "not running — open ClubGG and open a table" : `not installed at ${EXE}` },
      { id: "cgg-table", label: "Attached table", required: true, ok: !!t,
        detail: t ? `${label(t.title)}` : key ? "that table is no longer open in ClubGG — pick another" : all.length > 1 ? "several tables are open — pick the one to read" : "open a table in ClubGG (you do not have to sit)" },
      { id: "cgg-visible", label: "Table on screen, uncovered", required: false, ok: !!t && !cov,
        detail: !t ? "no table attached" : cov ?? "the reader copies the table off the screen: keep it uncovered (the panel beside it, not over it)" },
      { id: "cgg-reader", label: "What the reader does", required: false, ok: true,
        detail: "reads every seat, bet, action, the board and the pot off the screen; no answers and no presses on ClubGG yet" },
    ];
  }
}

/** A recording folder's size so far (to resume the budget). */
export function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    try { n += statSync(join(dir, f)).size; } catch {}
  }
  return n;
}

export const recordingDir = (sid: string) => join(DEBUG_DIR(), "clubgg", sid);
