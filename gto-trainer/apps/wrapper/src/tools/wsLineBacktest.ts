/**
 * BACKTEST THE PROTOCOL LINE AGAINST IGNITION (2026-09-26, Brady: "backtest … use the Ignition hand history api to
 * check … to ensure the reader is now perfect"). Every hand the tap recorded (debug/ws_dump*.jsonl — exactly the
 * frames ws.ts onGameMsg took, i.e. what S.ws.frames held live) is rebuilt by ignition/wsLine.ts and compared with
 * Ignition's own hand history (the wrapper's cache, data/hand_history/<id>.json — ignition/handHistory.ts).
 *
 * Compared: every action in order with the level it left the seat at, the board, hero's cards, every seat's stack as
 * dealt. One equivalence: a post-in's free check at its own turn is the post itself to Ignition (its history omits
 * it). A hand whose frames run to the end of its dump (the tap closed mid-hand — a session ending) is "capture
 * ended": judged only on what was captured, which must be an exact prefix of Ignition's.
 *
 *   bun src/tools/wsLineBacktest.ts [--last N | --session <sid> | <handId …>] [--verbose]
 *
 * The Ignition parser is the API's (apps/api/src/utils/ignitionHh — pure, type-only imports): one reading of
 * Ignition's record, shared with the API's checker.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIgnitionHh } from "../../../api/src/utils/ignitionHh/ignitionHh";
import { cardKey } from "../ignition/dom";
import { TwinFilter, wsHand } from "../ignition/wsLine";

/** What the live reader keeps (ws.ts keepFrame): a frame delivered twice is one frame (wsLine.TwinFilter). */
function liveFrames(fs: { ts: number; d: Record<string, any> }[]): Record<string, any>[] {
  const f = new TwinFilter();
  return fs.filter((x) => f.keep(x.d, x.ts)).map((x) => x.d);
}

/** How trustworthy the recording of a hand is, independent of the reader: "clean"; "tap-gap" = the tap itself logged
 *  dropping this socket mid-hand (<tap-unbound> / <tap-lost>: the frames never reached the reader — the pre-fix
 *  binder of 2026-09-25 morning unbound the right socket on a lagging screen); "two-writers" = another wrapper wrote
 *  the same file during the hand (before 2026-09-21), so lines were lost and sockets mixed. */
export type Recording = "clean" | "tap-gap" | "two-writers" | "stopped-before-hero";
export type HandFrames = { id: string; source: string; frames: Record<string, any>[]; captureEnded: boolean; writers: number; recording: Recording };

type Stream = { id: string; file: string; rid: string; frames: { ts: number; d: Record<string, any> }[]; captureEnded: boolean; tapGap: boolean };

/** Same frame written by two writers: identical content, stamped within this many seconds of each other. */
const TWIN_S = 0.1;

/**
 * Every hand in the dump files, by Ignition hand id: its frames on its socket from its PLAY_STAGE_INFO to the next.
 *
 * TWO WRITERS, ONE FILE (before 2026-09-21 two wrappers could append to the same ws_dump.jsonl): each frame appears
 * once per writer, and lines were LOST when both appended at the same instant — hand 4919649360 has seat 3's fold only
 * in one writer's copy and seat 4's only in the other's. Each writer stamps a frame with ITS hand counter (`hand`: a
 * PLAY_STAGE_INFO carries the counter of the hand it closes, the frames after it the next), so each copy is read as
 * its own stream, and the copies of one hand on one socket are MERGED: every frame of either, a frame the other writer
 * also wrote (same content within TWIN_S) counted once.
 */
export function dumpHands(files: string[]): Map<string, HandFrames> {
  const streams: Stream[] = [];
  for (const file of files) {
    const cur = new Map<string, Stream>();              // per (socket, writer's hand counter): the hand being read
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }    // a torn line (the same two writers)
      const d = e.data;
      if (d && (d.pid === "<tap-unbound>" || d.pid === "<tap-lost>")) {
        for (const s of cur.values()) if (d.pid === "<tap-lost>" || s.rid === String(d.rid ?? "")) s.tapGap = true;
        continue;
      }
      if (!d || typeof d !== "object" || typeof d.pid !== "string" || d.pid.startsWith("<")) continue;
      const rid = String(e.rid ?? ""), n = Number(e.hand), ts = Number(e.ts) || 0;
      if (d.pid === "PLAY_STAGE_INFO") {
        const id = String(d.stageNo ?? "");
        const open = cur.get(`${rid}|${n}`);
        if (open && open.id === id) continue;            // the end-of-hand repeat
        if (open) { open.captureEnded = false; cur.delete(`${rid}|${n}`); }
        if (!/^\d{10}$/.test(id)) continue;
        const s: Stream = { id, file: file.split(/[\\/]/).pop()!, rid, frames: [{ ts, d }], captureEnded: true, tapGap: false };
        cur.set(`${rid}|${n + 1}`, s);
        streams.push(s);
        continue;
      }
      cur.get(`${rid}|${n}`)?.frames.push({ ts, d });
    }
  }
  // the copies of one hand on one socket in one file are one hand; the same hand in two files, the fuller one
  const groups = new Map<string, Stream[]>();
  for (const s of streams) {
    const k = `${s.id}|${s.file}|${s.rid}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  const out = new Map<string, HandFrames>();
  for (const g of groups.values()) {
    let frames: Record<string, any>[];
    if (g.length === 1) frames = liveFrames(g[0]!.frames);
    else {
      const all = g.flatMap((s, w) => s.frames.map((f) => ({ ...f, w, body: JSON.stringify(f.d) })));
      all.sort((a, b) => a.ts - b.ts);
      const kept: typeof all = [];
      for (const f of all) {
        if (kept.some((k) => k.w !== f.w && k.body === f.body && Math.abs(k.ts - f.ts) <= TWIN_S && !(k as any).twin)) {
          const k = kept.find((k) => k.w !== f.w && k.body === f.body && Math.abs(k.ts - f.ts) <= TWIN_S && !(k as any).twin)!;
          (k as any).twin = true;
          continue;
        }
        kept.push(f);
      }
      frames = kept.map((f) => f.d);
    }
    // another stream in the same file whose time span overlaps this hand's: a second writer (hands on one socket are
    // sequential; since 2026-09-21 each table writes its own file)
    const span = (s: Stream) => [s.frames[0]!.ts, s.frames[s.frames.length - 1]!.ts] as const;
    const a0 = Math.min(...g.map((s) => span(s)[0])), a1 = Math.max(...g.map((s) => span(s)[1]));
    const shared = g.length > 1 || streams.some((o) => !g.includes(o) && o.file === g[0]!.file && span(o)[0] < a1 - 0.5 && span(o)[1] > a0 + 0.5);
    const recording: Recording = shared ? "two-writers" : g.some((s) => s.tapGap) ? "tap-gap" : "clean";
    const h: HandFrames = { id: g[0]!.id, source: `${g[0]!.file}#${g[0]!.rid}`, frames,
                            captureEnded: g.every((s) => s.captureEnded), writers: g.length, recording };
    const prev = out.get(h.id);
    if (!prev || prev.frames.length < h.frames.length) out.set(h.id, h);
  }
  return out;
}

export const defaultDumps = (dir: string) =>
  readdirSync(dir).filter((f) => /^ws_dump(-\d)?\.jsonl(\.1)?$/.test(f)).sort().reverse().map((f) => join(dir, f));

type Act = { street: string; seat: number; kind: string; level: number };
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Ours in comparable terms: the level each action left the seat at; a post-in's free option dropped. */
function oursActs(rows: { seatId: number; type: string; street: string; amount?: number }[]): Act[] {
  const lv = new Map<number, number>(), posted = new Set<number>();
  let street = "preflop", max = 0;
  const out: Act[] = [];
  for (const a of rows) {
    if (a.street !== street) { street = a.street; lv.clear(); max = 0; }
    const prior = lv.get(a.seatId) ?? 0, amt = a.amount ?? 0;
    let kind = a.type, to = prior;
    if (a.type === "post") posted.add(a.seatId);
    if (a.type === "check" && street === "preflop" && posted.has(a.seatId) && prior >= max) continue;
    if (a.type.startsWith("post") || a.type === "call") to = prior + amt;
    else if (a.type === "bet" || a.type === "raise" || a.type === "all-in") to = amt;
    if (a.type === "bet" || a.type === "raise" || a.type === "all-in") kind = to > max ? "aggr" : "call";
    lv.set(a.seatId, to);
    max = Math.max(max, to);
    out.push({ street, seat: a.seatId, kind, level: r2(to) });
  }
  return out;
}

/** Ignition's actions in the same terms (its "Posts chip" is the post-in; "All-in" carries the level for a raise and
 *  the chips added for a call). */
function ignitionActs(g: any): Act[] {
  const lv = new Map<number, number>();
  let street = "preflop", max = 0;
  const out: Act[] = [];
  for (const a of g.actions) {
    if (a.street !== street) { street = a.street; lv.clear(); max = 0; }
    const prior = lv.get(a.seat) ?? 0, amt = a.amountBb ?? 0;
    let kind: string = a.type, to = prior;
    if (a.label === "Posts chip") { kind = "post"; to = prior + amt; }
    else if (a.type === "post-sb" || a.type === "post-bb" || a.type === "call") to = prior + amt;
    else if (a.type === "bet" || a.type === "raise") { to = amt; kind = "aggr"; }
    else if (a.type === "all-in") { to = amt > max ? amt : prior + amt; kind = "aggr"; }
    if (kind === "aggr" && to <= max) kind = "call";
    lv.set(a.seat, to);
    max = Math.max(max, to);
    out.push({ street, seat: a.seat, kind, level: r2(to) });
  }
  return out;
}

const key = (a: Act) => `${a.street.padEnd(7)} s${a.seat} ${a.kind}${a.kind === "fold" || a.kind === "check" ? "" : " " + a.level.toFixed(2)}`;

/** Same action: street, seat, kind, and the level to within a cent's rounding (our BB amounts carry 2 decimals). */
const same = (a: Act, b: Act) => a.street === b.street && a.seat === b.seat && a.kind === b.kind && Math.abs(a.level - b.level) <= 0.015;

function lineDiff(ours: Act[], theirs: Act[]) {
  const o = ours.map(key), t = theirs.map(key);
  const n = o.length, m = t.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = same(ours[i]!, theirs[j]!) ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const lines: string[] = [];
  let i = 0, j = 0, bad = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same(ours[i]!, theirs[j]!)) { lines.push("    " + t[j]); i++; j++; }
    else if (j < m && (i >= n || L[i]![j + 1]! >= L[i + 1]![j]!)) { lines.push("  + " + t[j]); j++; bad++; }
    else { lines.push("  - " + o[i]); i++; bad++; }
  }
  const prefix = n <= m && ours.every((x, k) => same(x, theirs[k]!));
  return { bad, prefix, lines };
}

/** Any /hand line (rows as /hand carries them) against Ignition's record: the action diff only. */
export function lineVsIgnition(rows: { seatId: number; type: string; street: string; amount?: number }[], ignitionBody: unknown) {
  return lineDiff(oursActs(rows), ignitionActs(parseIgnitionHh(ignitionBody) as any));
}

export type Verdict = {
  id: string; source: string;
  verdict: "exact" | "capture-ended" | "wrong" | "recording-gap"; recording: Recording;
  actionDiffs: number; boardOk: boolean; heroOk: boolean; stacksOff: string[]; lines: string[];
};

/** One hand: the protocol line from its frames against Ignition's record (the raw handhistory body). */
export function judge(h: HandFrames, ignitionBody: unknown): Verdict {
  const g: any = parseIgnitionHh(ignitionBody);
  const blind = h.frames.find((d) => d.pid === "CO_BLIND_INFO" && d.btn === 4 && d.bet);
  const bb = Number(blind?.bet) || g.bbCents;
  const p = wsHand(h.frames, bb);
  const d = lineDiff(oursActs(p.actions), ignitionActs(g));
  const boardOurs = p.board.map(cardKey).join(" "), boardIgn = (g.board ?? []).join(" ");
  const heroOk = p.heroCards.map(cardKey).join("") === (g.heroCards ?? []).join("");
  const stacksOff: string[] = [];
  for (const s of g.seats) {
    const ours = p.startCents.get(s.seat);
    if (ours === undefined) { if (!h.captureEnded) stacksOff.push(`s${s.seat} missing (Ignition ${s.startBb}bb)`); continue; }
    if (Math.abs(ours / bb - s.startBb) > 0.01) stacksOff.push(`s${s.seat} ${r2(ours / bb)}bb vs ${s.startBb}bb`);
  }
  // a capture that stopped is harmless only once hero has nothing left to decide: every one of hero's actions in it
  const heroSeat = g.seats.find((s: any) => s.hero)?.seat;
  const heroActs = (xs: Act[]) => xs.filter((a) => a.seat === heroSeat && !a.kind.startsWith("post")).length;
  const heroDone = heroActs(oursActs(p.actions)) >= heroActs(ignitionActs(g));
  let verdict: Verdict["verdict"];
  if (!d.bad && boardOurs === boardIgn && heroOk && !stacksOff.length) verdict = "exact";
  else if (h.captureEnded && d.prefix && boardIgn.startsWith(boardOurs) && heroOk && !stacksOff.length) {
    verdict = heroDone ? "capture-ended" : "recording-gap";
    if (!heroDone && h.recording === "clean") h.recording = "stopped-before-hero";
  } else verdict = h.recording === "clean" ? "wrong" : "recording-gap";
  return { id: h.id, source: h.source, verdict, recording: h.recording, actionDiffs: d.bad, boardOk: boardOurs === boardIgn, heroOk, stacksOff,
           lines: [...(boardOurs === boardIgn ? [] : [`  board: ours ${boardOurs || "—"} · Ignition ${boardIgn || "—"}`]), ...(d.bad ? d.lines : [])] };
}

if (import.meta.main) {
  const { Database } = await import("bun:sqlite");
  const ROOT = join(import.meta.dir, "../../../../..");
  const HH = join(ROOT, "ignition-study-wrapper/data/hand_history");
  const DUMPS = join(ROOT, "ignition-study-wrapper/debug");
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const at = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const db = new Database(join(ROOT, "data/poker.sqlite"), { readonly: true });
  const ignId = "client_hand_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'";
  let ids: string[];
  if (at("--session")) {
    ids = (db.query(`SELECT client_hand_id id FROM hands WHERE status='done' AND ${ignId} AND data LIKE ? GROUP BY client_hand_id ORDER BY MIN(played_at)`).all(`%"sessionId": "${at("--session")}"%`) as any[]).map((r) => r.id);
  } else if (at("--last")) {
    ids = (db.query(`SELECT client_hand_id id FROM hands WHERE status='done' AND ${ignId} GROUP BY client_hand_id ORDER BY MAX(played_at) DESC LIMIT ?`).all(Number(at("--last"))) as any[]).map((r) => r.id).reverse();
  } else ids = args.filter((a) => /^\d{10}$/.test(a));
  const hands = dumpHands(defaultDumps(DUMPS));
  const tally: Record<string, number> = { exact: 0, "capture-ended": 0, wrong: 0, "recording-gap": 0, "no frames": 0, "no Ignition record": 0 };
  const wrong: Verdict[] = [], gaps: Verdict[] = [], ends: Verdict[] = [], noFrames: string[] = [], noRecord: string[] = [];
  for (const id of ids) {
    const h = hands.get(id);
    if (!h) { tally["no frames"]!++; noFrames.push(id); continue; }
    const rec = join(HH, `${id}.json`);
    if (!existsSync(rec)) { tally["no Ignition record"]!++; noRecord.push(id); continue; }
    const v = judge(h, JSON.parse(readFileSync(rec, "utf8")).body);
    tally[v.verdict]!++;
    if (v.verdict === "wrong") wrong.push(v);
    if (v.verdict === "recording-gap") gaps.push(v);
    if (v.verdict === "capture-ended") ends.push(v);
  }
  const judged = tally.exact! + tally["capture-ended"]! + tally.wrong! + tally["recording-gap"]!;
  console.log(`${ids.length} hands · judged ${judged}: exact ${tally.exact} · capture ended mid-hand ${tally["capture-ended"]}`
    + ` · recording gap (frames the reader never got) ${tally["recording-gap"]} · READER WRONG ${tally.wrong}`
    + ` · not judged: no frames ${tally["no frames"]}, no Ignition record ${tally["no Ignition record"]}`);
  for (const v of gaps) console.log(`recording gap (${v.recording}): ${v.id} ${v.source}`);
  if (verbose) for (const v of ends) console.log(`capture ended after hero's last action: ${v.id} ${v.source}`);
  for (const v of wrong) {
    console.log(`\n### ${v.id} (${v.source}) ${v.actionDiffs} action diff(s)${v.heroOk ? "" : " · HERO CARDS"}${v.stacksOff.length ? " · stacks: " + v.stacksOff.join(", ") : ""}`);
    console.log(v.lines.join("\n"));
  }
  if (noRecord.length) console.log(`\nno Ignition record cached (${noRecord.length}): ${noRecord.join(" ")}`);
  if (noFrames.length && verbose) console.log(`\nno frames (${noFrames.length}): ${noFrames.join(" ")}`);
}
