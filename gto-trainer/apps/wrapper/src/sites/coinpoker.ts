/**
 * CoinPoker as a Poker Wrapper site. Port of sites/coinpoker.py.
 *
 * Ignition is read through its web client (CDP + the game's WebSocket). CoinPoker cannot be: each table is a
 * separate Unity program with no DOM. What it does have is a log — the lobby writes every server message a table
 * receives to %APPDATA%/CoinPoker/logs/main.log — so the reader is cpFeed (a tail of that file) and the presses
 * are cpActions (real input on the Unity window, read back by OCR before and confirmed from the log after).
 *
 * AUTO-EXECUTE HERE IS PRACTICE-ONLY BY DEFAULT: cpActions refuses `auto` unless the server said the table is
 * practice chips (coinType 2), or relay passes `allowReal` because a bounded real-money test allowance is live.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { time } from "../clock";
import { fmtFixed, fmtG, pyFloatStr, pyRepr, pyRound, truthy } from "../py";
import * as W from "../win32";
import * as actions from "./cpActions";
import * as feed from "./cpFeed";

export const SITE = "coinpoker";

/** Where the CoinPoker client is: CP_EXE, then the usual install folders (machine-wide or per-user). */
function findExe(): string {
  const cands: string[] = process.env.CP_EXE ? [process.env.CP_EXE] : [];
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], join(process.env.LOCALAPPDATA || "", "Programs")]) {
    if (base) cands.push(join(base, "CoinPoker", "CoinPoker.exe"));
  }
  return cands.find((c) => existsSync(c) && statSync(c).isFile()) ?? cands[0] ?? "CoinPoker.exe";
}

export const EXE = findExe();
export const CDP_PORT = 9235;
export const LOG_STALE_S = 120;

const fmtDoc = (sb: number, bb: number, ante: number | null) =>
  `₮${fmtG(sb)}/₮${fmtG(bb)} heads-up, ` + (ante ? `ante ${fmtG(ante)}bb/player` : ante === 0 ? "no ante" : "ante not yet read off a table");

export const FORMATS: any[] = [
  ...([[10, 0.05, 0.1, 0], [25, 0.1, 0.25, null], [50, 0.25, 0.5, null], [100, 0.5, 1.0, null], [200, 1.0, 2.0, 0.2]] as const)
    .map(([n, sb, bb, ante]) => ({
      id: `cp-hu-NL${n}`, site: SITE, gameType: "hu", stake: `NL${n}`, seats: 2, name: `CoinPoker NL${n} Heads-Up`,
      sb, bb, anteBb: ante, currency: "USDT", _doc: fmtDoc(sb, bb, ante),
    })),
  ...([[10, 0.05, 0.1], [25, 0.1, 0.25], [50, 0.25, 0.5], [100, 0.5, 1.0]] as const).map(([n, sb, bb]) => ({
    id: `cp-ring-NL${n}-6`, site: SITE, gameType: "ring", stake: `NL${n}`, seats: 6, name: `CoinPoker NL${n} 6-max`,
    sb, bb, currency: "USDT", _doc: `₮${fmtG(sb)}/₮${fmtG(bb)} 6-max ring (the ANTE tables add 16% of a bb)`,
  })),
  { id: "cp-practice", site: SITE, gameType: "practice", stake: null, seats: 6, name: "CoinPoker Practice", bb: null,
    currency: "practice chips",
    _doc: "Practice Games tab — play chips (Claim Chips = 500K a day); the only tables auto-execute arms on" },
];

type Proc = { pid: number; cmdline: string[] };

/** Every CoinPoker.exe with its command line (psutil.process_iter(["name", "cmdline"])). */
function coinpokerProcs(): Proc[] {
  const out: Proc[] = [];
  for (const p of W.listProcesses()) {
    if (p.name.toLowerCase() !== "coinpoker.exe") continue;
    out.push({ pid: p.pid, cmdline: W.processCmdline(p.pid) || [] });
  }
  return out;
}

export class Site {
  id = SITE;
  feed: feed.Feed | null = null;
  error: string | null = null;
  private running = false;
  private onLine: ((room: string, line: string) => void) | null = null;
  private onFinished: ((room: feed.Room, h: feed.Hand) => void) | null = null;
  /** THE ATTACHED TABLE: while set, the wrapper reads that table and no other (null = the most recently active). */
  pinned: string | null = null;

  attach(room: string | null | undefined): void {
    this.pinned = room || null;
  }

  /** The tables OPEN in the client right now — each its own CoinPoker.exe started with roomName=<room>. */
  static openRooms(): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of coinpokerProcs()) {
      const room = p.cmdline.find((a) => a.startsWith("roomName="))?.slice("roomName=".length);
      if (room) out.set(room, p.pid);
    }
    return out;
  }

  /** The FORMATS id this table is, from its roomProperties (size, big blind, practice chips). */
  static formatFor(props: Record<string, any> | null | undefined): string | null {
    if (!props || !Object.keys(props).length) return null;
    if (props.coinType === 2) return "cp-practice";
    const size = props.maxSize ?? null, bb = props.bigBlind ?? null;
    const kind = size === 2 ? "hu" : size === 6 ? "ring" : null;
    return FORMATS.find((f) => f.gameType === kind && f.bb !== null && f.bb !== undefined && bb !== null && Math.abs(f.bb - bb) < 1e-9)?.id ?? null;
  }

  /** A table as a person reads it ("NL HU 0.10-0.25 · ante 0.04"), and the room's number. */
  static label(room: string, props: Record<string, any> | null | undefined): { label: string; number: string | null } {
    const p = props || {};
    const amt = (x: number) => (x < 1 ? fmtFixed(x, 2) : fmtG(x));
    const game = room.toUpperCase().includes("PLO") ? "PLO" : "NL";
    const size = p.maxSize ?? null;
    const kind = size === 2 ? "HU" : truthy(size) ? `${size}-max` : null;
    const sb = p.smallBlind ?? null, bb = p.bigBlind ?? null, ante = p.ante ?? null;
    let text: string;
    if (sb !== null && bb !== null) {
      text = [game, kind, `${amt(sb)}-${amt(bb)}`].filter((x) => truthy(x)).join(" ");
      if (truthy(ante)) text += ` · ante ${amt(ante)}`;
    } else {
      const m = /\b(NL|PLO)\s*(HU|\d-max)?\s*([\d.]+-[\d.]+)/i.exec(room);
      text = m ? [m[1]!.toUpperCase(), m[2], m[3]].filter((x) => truthy(x)).join(" ") : room.replace(/\s*\d{5,}$/, "");
      if (m && room.toUpperCase().includes("ANTE")) text += " · ante";
    }
    const num = /(\d{5,})\s*$/.exec(room);
    return { label: text, number: num ? num[1]! : null };
  }

  /** What the setup page lists to attach to: every open table, with what its log has said about it. */
  openTables(): any[] {
    const rooms = Site.openRooms();
    const known = this.feed ? this.feed.rooms : new Map<string, feed.Room>();
    const out: any[] = [];
    for (const name of rooms.keys()) {
      const r = known.get(name);
      const p = r ? r.props : {};
      const seated = r ? [...r.seats.values()].map((s) => s.name) : [];
      out.push({
        room: name, ...Site.label(name, p), attached: name === this.pinned,
        practice: !!(r && r.practice), coinType: p.coinType ?? null,
        sb: p.smallBlind ?? null, bb: p.bigBlind ?? null, ante: p.ante ?? null,
        maxSize: p.maxSize ?? null, players: seated.length,
        heroSeated: !!feed.hero.name && seated.includes(feed.hero.name),
        lastEventAgo: r && r.touched ? pyRound(time() - r.touched, 1) : null,
        format: Site.formatFor(p),
      });
    }
    out.sort((a, b) => (Number(!a.heroSeated) - Number(!b.heroSeated))
      || ((a.lastEventAgo ?? 1e9) - (b.lastEventAgo ?? 1e9)));
    return out;
  }

  // ---- the reader loop ----
  /** Tail the log (a file read every 150 ms) for the life of the process; the callbacks decide what matters. */
  start(onLine: ((room: string, line: string) => void) | null = null, onFinished: ((room: feed.Room, h: feed.Hand) => void) | null = null): void {
    this.onLine = onLine;
    this.onFinished = onFinished;
    if (this.running) return;
    this.running = true;
    const tick = () => {
      try {
        if (this.feed === null) this.feed = new feed.Feed();
        const lines = this.feed.poll();
        const done = this.feed.drainFinished();
        for (const [room, line] of lines) this.onLine?.(room, line);
        for (const [room, h] of done) this.onFinished?.(room, h);
        this.error = null;
      } catch (e: any) {
        this.error = `${e?.name || "Error"}: ${e?.message || e}`;
      }
      setTimeout(tick, 150);
    };
    setTimeout(tick, 0);
  }

  // ---- what the wrapper reads ----
  roomNow(): feed.Room | null {
    const f = this.feed;
    if (this.pinned) {
      const r = f ? f.rooms.get(this.pinned) : undefined;
      return r && !r.closed ? r : null;
    }
    const r = f ? f.active() : null;
    return r && time() - r.touched < LOG_STALE_S ? r : null;
  }

  rooms(): Map<string, feed.Room> {
    return this.feed ? new Map(this.feed.rooms) : new Map();
  }

  /** The active table's hand, ParsedHand-shaped, or null between hands. */
  hand(): Record<string, any> | null {
    const r = this.roomNow();
    return r ? Site.decorate(feed.exportHand(r)) : null;
  }

  handOf(room: feed.Room): () => Record<string, any> | null {
    return () => Site.decorate(feed.exportHand(room));
  }

  static decorate(h: Record<string, any> | null): Record<string, any> | null {
    if (h !== null && !("tableSlot" in h)) h.tableSlot = null;
    return h;
  }

  /** A finished hand (from drainFinished) as a ParsedHand. */
  exportFinished(room: feed.Room, h: feed.Hand): Record<string, any> | null {
    const save = room.hand;
    room.hand = { ...h, done: false };
    try {
      return Site.decorate(feed.exportHand(room));
    } finally {
      room.hand = save;
    }
  }

  table(): Record<string, any> | null {
    const r = this.roomNow();
    if (!r) return null;
    const heroSeat = [...r.seats.values()].find((s) => s.name === feed.hero.name) ?? null;
    const heroSid = [...r.seats].find(([, s]) => s.name === feed.hero.name)?.[0] ?? null;
    // DEALT IN = NOT SITTING OUT (2026-09-24): the sit-out boxes are about the NEXT hand; while hero holds cards in
    // a live hand he is playing it; between hands (or not dealt in) the boxes still mean sitting out.
    const live = r.hand && !r.hand.done ? r.hand : null;
    const dealtIn = !!(live && heroSid !== null && (live.dealt || []).includes(heroSid));
    const flagged = truthy(r.sitout.sitOutNextHand) || truthy(r.sitout.sitOutAll) || r.status.get(feed.hero.name) === "Sitout";
    const rake: Record<string, any> = {};
    for (const k of ["rake", "rakeHeadsUp", "rakeCap", "isPotRakePf"]) if (k in r.props) rake[k] = r.props[k];
    return {
      room: r.name, ...Site.label(r.name, r.props), lastEventAgo: pyRound(time() - r.touched, 1),
      seats: Object.fromEntries([...r.seats].map(([k, v]) => [String(k), { ...v }])),
      heroSeated: heroSeat !== null,
      heroSittingOut: flagged && !dealtIn,
      heroSitOutPending: flagged && dealtIn,
      sitOut: { ...r.sitout }, practice: r.practice, coinType: r.coinType,
      rake: Object.keys(rake).length ? rake : null,
      lastHand: (r.last || ({} as any)).id ?? null,
    };
  }

  practice(): boolean {
    const r = this.roomNow();
    return !!(r && r.practice);
  }

  /** In the /state snapshot vocabulary: in-hand / sitting-out / not-in-hand. */
  heroStatus(): string | null {
    const t = this.table();
    if (!t) return null;
    if (t.heroSittingOut) return "sitting-out";
    return t.heroSeated ? "in-hand" : "not-in-hand";
  }

  // ---- presses ----
  /** A study pick's plan as a press on the Unity table: {ok, reason?, clicked?, kind?}. */
  async actuate(plan: Record<string, any>, opts: { auto?: boolean; allowReal?: boolean } = {}): Promise<Record<string, any>> {
    const auto = !!opts.auto;
    const allowReal = !!opts.allowReal;
    const r = this.roomNow();
    if (!r) return { ok: false, reason: "no CoinPoker table in the log" };
    const get = this.handOf(r);
    const h = get();
    if (!h) return { ok: false, reason: "no live hand" };
    const bb = Number(h.bb || 0);
    const heroSeat = h.heroSeatId;
    const stacks = h.stacks instanceof Map ? h.stacks : new Map(Object.entries(h.stacks || {}).map(([k, v]) => [Number(k), v]));
    const committed = h.committed instanceof Map ? h.committed : new Map(Object.entries(h.committed || {}).map(([k, v]) => [Number(k), v]));
    const totalBb = (Number(stacks.get(heroSeat)) || 0) + (Number(committed.get(heroSeat)) || 0);
    const total = bb ? pyRound(totalBb * bb, 4) : null;
    let res: Record<string, any>;
    if (plan.kind === "raise-to") {
      let amtBb: number;
      try {
        amtBb = Number.parseFloat(plan.amount);
        if (Number.isNaN(amtBb)) throw new Error();
      } catch {
        return { ok: false, reason: `unreadable size ${pyRepr(plan.amount ?? null)}` };
      }
      const amount = bb >= 0.05 ? pyRound(amtBb * bb, 2) : pyRound(amtBb * bb);
      if (total && amount >= total * 0.999) res = await actions.act(r, get, "allin", total, { auto, allowReal });
      else res = await actions.act(r, get, plan.verb || "raise", amount, { auto, allowReal });
    } else {
      const label = plan.label === "all-in" ? "allin" : plan.label;
      res = await actions.act(r, get, label, label === "allin" ? total : null, { auto, allowReal });
    }
    const out: Record<string, any> = { ok: !!res.ok, clicked: res.label ?? null, kind: "coinpoker", result: res };
    if (!res.ok) out.reason = res.why ?? null;
    return out;
  }

  async sitout(on: boolean, every = false): Promise<Record<string, any>> {
    const r = this.roomNow();
    if (!r) return { ok: false, why: "no CoinPoker table in the log" };
    if (![...r.seats.values()].some((s) => s.name === feed.hero.name)) {
      return { ok: false, why: `you are not seated at ${r.name} (observing) — nothing to sit out of` };
    }
    return actions.setSitout(r, on, every ? "sitOutAll" : "sitOutNextHand");
  }

  // ---- the client ----
  static lobbyProcs(): Proc[] {
    return coinpokerProcs().filter((p) => {
      const cl = p.cmdline;
      return !(cl.some((a) => a.startsWith("--type=")) || (cl.length ? cl[0]! : "").toLowerCase().includes("unity-resources"));
    });
  }

  clientState(): Record<string, any> {
    const procs = Site.lobbyProcs();
    const cmd = procs.length ? procs[0]!.cmdline.join(" ") : "";
    const log = feed.LOG();
    const exists = existsSync(log);
    return {
      running: procs.length > 0, cdp: cmd.includes(`--remote-debugging-port=${CDP_PORT}`), log, logExists: exists,
      logAgeS: exists ? pyRound(time() - statSync(log).mtimeMs / 1000, 1) : null,
    };
  }

  /** Start the client if it is not running (DETACHED: its tables must outlive this wrapper). */
  ensureClient(): Record<string, any> {
    const st = this.clientState();
    if (st.running) return { ok: true, started: false, ...st };
    if (!existsSync(EXE)) return { ok: false, started: false, error: `CoinPoker not installed at ${EXE}`, ...st };
    // W.spawnDetached: the client outlives us, so it must not inherit the panel port's listening socket
    // (the logger is imported lazily: feed -> state -> this module is an import cycle at load time)
    W.startDetached(EXE, [`--remote-debugging-port=${CDP_PORT}`, "--remote-allow-origins=*"], { cwd: dirname(EXE) },
                    (m) => void import("../feed").then((f) => f.log(m)));
    return { ok: true, started: true, ...st };
  }

  /** The CoinPoker rows of the setup page's preflight; `room` = the table the session attaches to. */
  preflight(room: string | null = null): any[] {
    const st = this.clientState();
    const t = room ? this.openTables().find((x) => x.room === room) ?? null : null;
    return [
      { id: "cp-client", label: "CoinPoker client", required: true, ok: st.running,
        detail: st.running ? "running" + (st.cdp ? ` · lobby DevTools on :${CDP_PORT}` : " (without the DevTools port — fine; only the lobby uses it)")
          : "not running — open CoinPoker and join a table" },
      { id: "cp-log", label: "CoinPoker table log readable", required: true, ok: st.logExists,
        detail: st.logExists ? `${st.log} · last written ${st.logAgeS === null ? "None" : pyFloatStr(st.logAgeS)} s ago` : `${st.log} does not exist — has the client ever run on this machine?` },
      { id: "cp-table", label: "Attached table", required: true, ok: !!t,
        detail: t ? `${t.label} · ${t.practice ? "PRACTICE chips" : t.coinType === 1 ? "REAL MONEY" : "type not logged yet"}`
          + (t.heroSeated ? " · you are seated" : " · not seated (the wrapper reads it; sit down to get answers)")
          : room ? `${Site.label(room, null).label} is no longer open in the client — pick another`
          : "pick the table to attach to (join one in the CoinPoker client first)" },
    ];
  }
}
