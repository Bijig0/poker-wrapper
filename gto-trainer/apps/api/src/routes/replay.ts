import { Hono } from "hono";
import { readLine, tickToHand, type Tick } from "../feed/tickToHand/tickToHand";
import { fastSolve } from "../services/fastSolve";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { wrapperDebugDir } from "../services/storePaths";

/**
 * Debug-recording replay: serves the wrapper's captured sessions to the
 * dashboard's side-by-side review page.
 *
 * A session is three files keyed by `seq` — fNNNNN.jpg (the frame),
 * log.jsonl (parsed state) and dom.jsonl (raw _TABLE_JS output). The review
 * page draws the frame beside the replica's rendering of the same tick, so
 * the recorded client and the rebuilt table can be compared by eye.
 *
 * Read-only against the wrapper's directory, same as the hands.db routes:
 * the wrapper writes, we serve.
 */
// Since the central data root the wrapper records into <data root>/wrapper-debug; the old
// ignition-study-wrapper/debug path left every hand page "not recorded" (hand 4921874909, 2026-10-01).
// IGNITION_DEBUG_DIR still overrides (storePaths reads it).
const DEBUG_DIR = wrapperDebugDir();

/** Recording folder names: wrapper-generated timestamps, optionally per table (`-slot<N>`) with a same-second
 *  tie suffix (`-2`). Anything else is rejected so a crafted name can never traverse out of DEBUG_DIR. */
const RECORDING_NAME_RE = /^session_\d{8}_\d{6}(?:-slot\d+)?(?:-\d+)?$/;

const replay = new Hono();

const sessionDir = (name: string): string | null => {
  if (!RECORDING_NAME_RE.test(name)) return null;
  const dir = join(DEBUG_DIR, name);
  return existsSync(dir) ? dir : null;
};

const jsonl = (path: string): unknown[] =>
  readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

replay.get("/sessions", (c) => {
  if (!existsSync(DEBUG_DIR)) {
    return c.json({ ok: false, error: `debug dir not found at ${DEBUG_DIR}`, sessions: [] }, 503);
  }
  const sessions = readdirSync(DEBUG_DIR)
    .filter((n) => RECORDING_NAME_RE.test(n))
    .sort()
    .reverse()
    .map((name) => {
      const dir = join(DEBUG_DIR, name);
      const hasDom = existsSync(join(dir, "dom.jsonl"));
      let ticks = 0;
      let note: string | null = null;
      try {
        if (existsSync(join(dir, "log.jsonl")))
          ticks = readFileSync(join(dir, "log.jsonl"), "utf-8").split("\n").filter((l) => l.trim()).length;
        if (existsSync(join(dir, "note.txt")))
          note = readFileSync(join(dir, "note.txt"), "utf-8").slice(0, 200);
      } catch {
        /* a session mid-write is listed with what could be read */
      }
      return { name, ticks, hasDom, note };
    })
    .filter((s) => s.ticks > 0);
  return c.json({ ok: true, sessions });
});

replay.get("/:name/log", (c) => {
  const dir = sessionDir(c.req.param("name"));
  if (!dir) return c.json({ ok: false, error: "no such session" }, 404);
  const p = join(dir, "log.jsonl");
  if (!existsSync(p)) return c.json({ ok: false, error: "no log.jsonl" }, 404);
  return c.json({ ok: true, ticks: jsonl(p) });
});

replay.get("/:name/dom", (c) => {
  const dir = sessionDir(c.req.param("name"));
  if (!dir) return c.json({ ok: false, error: "no such session" }, 404);
  const p = join(dir, "dom.jsonl");
  if (!existsSync(p)) return c.json({ ok: false, error: "no dom.jsonl" }, 404);
  return c.json({ ok: true, ticks: jsonl(p) });
});

replay.get("/:name/frame/:seq", (c) => {
  const dir = sessionDir(c.req.param("name"));
  if (!dir) return c.json({ ok: false, error: "no such session" }, 404);
  const seq = Number(c.req.param("seq"));
  if (!Number.isInteger(seq) || seq < 0) return c.json({ ok: false }, 400);
  // Recordings made before the JPEG switch hold PNGs, and the review queue
  // leads with the oldest sessions — so serving only .jpg left every frame in
  // those broken while the replica rendered fine beside it, which reads as a
  // replica bug rather than a missing file.
  const base = join(dir, `f${String(seq).padStart(5, "0")}`);
  for (const [ext, mime] of [[".jpg", "image/jpeg"], [".png", "image/png"]] as const) {
    if (existsSync(base + ext)) {
      return new Response(Bun.file(base + ext), { headers: { "Content-Type": mime } });
    }
  }
  return c.json({ ok: false, error: "no frame" }, 404);
});

/* ------------------------------------------------------- the review queue */

/**
 * A state's identity is its CONTENT, not where it was recorded: the same table
 * captured twice, or by two sessions, is one thing to review and must keep one
 * id across re-recordings. Provenance (session + seq) rides along so the id
 * still resolves to a frame.
 */
interface QueueItem {
  id: string;
  session: string;
  seq: number;
  shape: string;
  hand: number | null;
  street: string;
  seats: number;
  heroToAct: boolean;
  dupes: number;
  /** Whether this state's session captured the RAW DOM alongside the frame.
   *  Without it a disagreement can only be reported, not traced to the element
   *  that caused it — so a state that has it is worth more of your time. */
  hasDom: boolean;
  /** Whether the capture carries the FULL seatQa the structural reader needs.
   *  Recordings that predate it can only exercise the geometric fallback — a
   *  path that still runs, but not the one the panel takes live. */
  structural: boolean;
}

const streetOf = (board: unknown): string => {
  const n = Array.isArray(board) ? board.length : 0;
  return n >= 5 ? "river" : n === 4 ? "turn" : n === 3 ? "flop" : "preflop";
};

/** The fields a reviewer is actually judging — everything else is noise. */
function contentKey(t: any): string {
  const seats = Object.entries(t.seats ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([n, s]: [string, any]) =>
      `${n}:${s?.stack ?? ""}/${s?.bet ?? ""}/${s?.badge ?? ""}/${s?.cards ?? 0}`);
  return JSON.stringify({
    board: t.board ?? [], hero: t.heroCards ?? [], pot: t.pot ?? null,
    toAct: !!t.toAct, actions: t.actions ?? [], seats,
  });
}

/**
 * A coarse signature of what the state LOOKS like. Two states with the same
 * shape exercise the same rendering and reading paths, so reviewing the second
 * teaches nothing the first did not — the queue leads with one of each.
 */
function shapeKey(t: any): string {
  const seats = Object.values(t.seats ?? {}) as any[];
  const badges = [...new Set(seats.map((s) => s?.badge).filter(Boolean))].sort();
  const bets = seats.filter((s) => s?.bet).length;
  const cards = seats.map((s) => s?.cards ?? 0).sort().join("");
  return [seats.length, streetOf(t.board), t.toAct ? "act" : "wait",
          badges.join("+") || "-", `bet${bets}`, `c${cards}`].join("|");
}

const VERDICT_FILE = join(DEBUG_DIR, "parity-verdicts.json");

interface Verdict {
  reader?: "ok" | "bad" | "unsure";
  replica?: "ok" | "bad" | "unsure";
  note?: string;
  at?: number;
  session?: string;
  seq?: number;
}

function readVerdicts(): Record<string, Verdict> {
  try {
    return existsSync(VERDICT_FILE)
      ? JSON.parse(readFileSync(VERDICT_FILE, "utf-8"))
      : {};
  } catch {
    return {};   // a corrupt file must not take the queue down with it
  }
}

let queueCache: { built: number; items: QueueItem[] } | null = null;

function buildQueue(): QueueItem[] {
  if (queueCache && Date.now() - queueCache.built < 30_000) return queueCache.items;
  const seen = new Map<string, QueueItem>();
  const sessions = existsSync(DEBUG_DIR)
    ? readdirSync(DEBUG_DIR).filter((n) => RECORDING_NAME_RE.test(n)).sort()
    : [];
  for (const name of sessions) {
    const p = join(DEBUG_DIR, name, "log.jsonl");
    if (!existsSync(p)) continue;
    const domPath = join(DEBUG_DIR, name, "dom.jsonl");
    const hasDom = existsSync(domPath);
    // Sniff the first tick: does this capture carry the fields the structural
    // pass reads? Older shapes have seatQa absent, or present without
    // stack/bet, and both fall through to geometry.
    let structural = false;
    if (hasDom) {
      try {
        const first = readFileSync(domPath, "utf-8").split("\n", 1)[0];
        const sq = JSON.parse(first || "{}")?.seatQa;
        structural = Array.isArray(sq) && sq.length > 0 && sq[0]?.stack != null;
      } catch { /* unreadable sniff just means "assume not" */ }
    }
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let t: any;
      try { t = JSON.parse(line); } catch { continue; }
      // A tick with no seats is the table between hands — nothing to judge.
      if (!t.seats || !Object.keys(t.seats).length) continue;
      const key = contentKey(t);
      const id = createHash("sha1").update(key).digest("hex").slice(0, 10);
      const hit = seen.get(id);
      if (hit) {
        hit.dupes++;
        // Keep the occurrence that can be TRACED. The same state captured in
        // an old session (frame only) and a newer one (frame + raw DOM) is one
        // item, and the reviewable copy is the one with the DOM behind it.
        // Prefer the copy that exercises the live reader, then the traceable
        // one. The same state captured in an old session and the new one is a
        // single item, and only the newer copy tests the path that runs.
        if ((structural && !hit.structural) || (hasDom && !hit.hasDom)) {
          hit.session = name;
          hit.seq = t.seq ?? -1;
          hit.hasDom = hasDom || hit.hasDom;
          hit.structural = structural || hit.structural;
        }
        continue;
      }
      seen.set(id, {
        id, session: name, seq: t.seq ?? -1, shape: shapeKey(t),
        hand: t.hand ?? null, street: streetOf(t.board),
        seats: Object.keys(t.seats).length, heroToAct: !!t.toAct, dupes: 1,
        hasDom, structural,
      });
    }
  }
  // Lead with one of each shape, then everything else. Reviewing 900 folds
  // that differ by a stack digit finds nothing the first one did not.
  const items = [...seen.values()];
  const firstOfShape: QueueItem[] = [];
  const rest: QueueItem[] = [];
  const shapesSeen = new Set<string>();
  for (const it of items) {
    if (shapesSeen.has(it.shape)) rest.push(it);
    else { shapesSeen.add(it.shape); firstOfShape.push(it); }
  }
  // Within the leading group, the rarest shapes first: a shape seen once is
  // where a rendering path is least likely to have been exercised.
  const shapeCount = new Map<string, number>();
  for (const it of items) shapeCount.set(it.shape, (shapeCount.get(it.shape) ?? 0) + 1);
  // Diagnosable first, then rarest shape. Ordering purely by rarity led with
  // the oldest sessions — which predate the raw-DOM capture — so the states
  // presented first were the ones a disagreement could least be acted on.
  // Structural first, then traceable, then rarest shape. Ordering by rarity
  // alone led with the oldest sessions, which exercise only the geometric
  // fallback — real defects, but not in the path the panel takes live.
  const rank = (x: QueueItem) => Number(x.structural) * 2 + Number(x.hasDom);
  firstOfShape.sort((a, b) =>
    (rank(b) - rank(a)) ||
    (shapeCount.get(a.shape)! - shapeCount.get(b.shape)!));
  rest.sort((a, b) => rank(b) - rank(a));
  const out = [...firstOfShape, ...rest];
  queueCache = { built: Date.now(), items: out };
  return out;
}

replay.get("/queue", (c) => {
  const items = buildQueue();
  const verdicts = readVerdicts();
  const shapes = new Set(items.map((i) => i.shape));
  return c.json({
    ok: true,
    total: items.length,
    shapes: shapes.size,
    reviewed: Object.keys(verdicts).filter((k) => items.some((i) => i.id === k)).length,
    items,
    verdicts,
  });
});

replay.post("/verdict", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | (Verdict & { id?: string })
    | null;
  if (!body?.id) return c.json({ ok: false, error: "id required" }, 400);
  const all = readVerdicts();
  const { id, ...rest } = body;
  // Merge, so recording a replica verdict does not wipe an existing reader
  // one — the two are judged independently and often in separate passes.
  all[id] = { ...(all[id] ?? {}), ...rest, at: Date.now() };
  try {
    writeFileSync(VERDICT_FILE, JSON.stringify(all, null, 1), "utf-8");
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
  return c.json({ ok: true, id, verdict: all[id] });
});

/**
 * The STUDY ANSWER for one recorded state — the answer the panel would have
 * given at the table, with its provenance.
 *
 * Two questions the review queue could not previously answer: would the tools
 * have said anything here, and if so on what basis? A reader that extracts a
 * state correctly can still be handed to the wrong chart, and nothing in the
 * frame-vs-extract comparison would show it. So this reports the SOURCE (the
 * local preflop charts, the 3-max asymmetric HRC set, or a GTO Wizard AI
 * solve), the cascade TIER within it, and the whole node that was fed in —
 * position, street, board, pot, what hero owes, and the action line.
 *
 * Read-only and side-effect free: fastSolve reads charts and the solver API,
 * and unlike driving the wrapper's parser it archives nothing. (Replaying
 * through the wrapper once wrote thirteen replayed hands into the live
 * hands.db, which is why this path deliberately does not go near it.)
 */
/**
 * The whole hand's feed up to this tick, rebuilt from the per-tick tails.
 *
 * The reader used to record only the last four lines each tick, which cut the
 * blind posts off the top of any hand with more than two actions — and without
 * the small blind there is no button, so no positions and no chart. Successive
 * tails OVERLAP, though, so the hand's story can be stitched back out of them.
 *
 * Merging on the overlap rather than de-duplicating lines: a hand can contain
 * the same line twice ("Seat 1 checks" on the flop and again on the turn), and
 * dropping the repeat would silently rewrite the action.
 */
function mergeTail(acc: string[], tail: string[]): string[] {
  for (let k = Math.min(acc.length, tail.length); k > 0; k--) {
    if (acc.slice(-k).every((v, i) => v === tail[i])) return [...acc, ...tail.slice(k)];
  }
  return [...acc, ...tail];
}

function feedForHand(ticks: Tick[], seq: number, hand: number | undefined): string[] {
  let acc: string[] = [];
  for (const t of ticks) {
    if (t.seq == null || t.seq > seq) break;
    if (t.hand !== hand) continue;
    acc = mergeTail(acc, t.feedTail ?? []);
  }
  return acc;
}

/**
 * The session parsed into HANDS, each hand into NODES — the review's natural
 * shape, derived from the same feed grammar the answer path parses (readLine),
 * so the reviewer's nodes and the solver's hands can never drift apart.
 *
 * Tick correlation falls out of the stitching itself: while merging the
 * per-tick feed tails, the seq at which each feed LINE first appeared is
 * recorded — every node therefore owns the tick (and frame) that first showed
 * it. A hero decision node additionally picks its best ANSWER tick: the first
 * to-act tick at/after the decision that also has hero's two cards (the first
 * to-act tick is often the deal animation, cards not yet rendered).
 */
interface HandNode {
  i: number;
  kind: "action" | "street" | "decision" | "info";
  label: string;
  seat?: number;
  type?: string;
  amount?: number;
  street: string;
  seq: number;
  /** decision nodes: the tick to ask /answer with, and what hero then did. */
  answerSeq?: number;
  heroDid?: string;
}

export interface SessionHand {
  hand: number;
  clientHandId: string | null;
  heroSeat: number | null;
  heroCards: string[];
  firstSeq: number | undefined;
  lastSeq: number | undefined;
  streets: string[];
  decisions: number;
  nodes: HandNode[];
}

const handsCache = new Map<string, { mtimeMs: number; hands: SessionHand[] }>();

/**
 * The session as HANDS, each hand as NODES, parsed from the stitched feed
 * with the same grammar the answer path uses. Cached per session by the
 * log's mtime — a finished recording never changes, the live one grows.
 */
export function parseSessionHands(name: string): SessionHand[] | null {
  const dir = sessionDir(name);
  if (!dir) return null;
  const logPath = join(dir, "log.jsonl");
  if (!existsSync(logPath)) return null;
  const mtimeMs = statSync(logPath).mtimeMs;
  const hit = handsCache.get(name);
  if (hit && hit.mtimeMs === mtimeMs) return hit.hands;
  const ticks = jsonl(logPath) as Tick[];

  const byHand = new Map<number, Tick[]>();
  for (const t of ticks) {
    if (t.hand == null || t.seq == null) continue;
    if (!byHand.has(t.hand)) byHand.set(t.hand, []);
    byHand.get(t.hand)!.push(t);
  }

  const hands = [...byHand.entries()].sort(([a], [b]) => a - b).map(([handNo, hts]) => {
    // stitch, remembering which tick each line FIRST appeared in
    let acc: string[] = [];
    const lineSeq: number[] = [];
    for (const t of hts) {
      const before = acc.length;
      acc = mergeTail(acc, t.feedTail ?? []);
      for (let k = before; k < acc.length; k++) lineSeq[k] = t.seq!;
    }
    const heroSeat = (() => {
      for (const t of hts)
        for (const [n, s] of Object.entries(t.seats ?? {}))
          if ((s as any).hero) return Number(n);
      return null;
    })();
    const heroCards = hts.map((t) => t.heroCards ?? []).find((c) => c.length === 2) ?? [];

    let clientHandId: string | null = null;
    let street = "preflop";
    const nodes: HandNode[] = [];
    acc.forEach((line, k) => {
      const seq = lineSeq[k]!;
      const idM = line.match(/hand id (\d+)/);
      if (idM) { clientHandId = idM[1]!; return; }
      if (/new hand/.test(line)) return;
      const stM = line.match(/^—\s*(FLOP|TURN|RIVER)\s*—/i);
      if (stM) {
        street = stM[1]!.toLowerCase();
        nodes.push({ i: nodes.length, kind: "street", label: line, street, seq });
        return;
      }
      if (line.startsWith("YOUR TURN")) {
        // best answer tick: to-act with cards, at/after this line appeared
        const win = hts.filter((t) => t.seq! >= seq && t.toAct);
        const best = win.find((t) => (t.heroCards?.length ?? 0) === 2) ?? win[0];
        // what hero then did: his next action line after this one
        let heroDid: string | undefined;
        for (let j = k + 1; j < acc.length; j++) {
          const a2 = readLine(acc[j]!);
          if (a2 && heroSeat != null && a2.seat === heroSeat) { heroDid = acc[j]!; break; }
          if (acc[j]!.startsWith("YOUR TURN")) break;
        }
        nodes.push({ i: nodes.length, kind: "decision", label: line, street, seq,
                     answerSeq: best?.seq ?? seq, heroDid });
        return;
      }
      const a = readLine(line);
      if (a) {
        nodes.push({ i: nodes.length, kind: "action", label: line, seat: a.seat,
                     type: a.type, amount: a.amount, street, seq });
        return;
      }
      nodes.push({ i: nodes.length, kind: "info", label: line, street, seq });
    });

    return {
      hand: handNo,
      clientHandId,
      heroSeat,
      heroCards,
      firstSeq: hts[0]!.seq,
      lastSeq: hts[hts.length - 1]!.seq,
      streets: [...new Set(nodes.map((n) => n.street))],
      decisions: nodes.filter((n) => n.kind === "decision").length,
      nodes,
    };
  });

  handsCache.set(name, { mtimeMs, hands });
  return hands;
}

replay.get("/:name/hands", (c) => {
  const hands = parseSessionHands(c.req.param("name"));
  if (!hands) return c.json({ ok: false, error: "no such session (or no log.jsonl)" }, 404);
  return c.json({ ok: true, hands });
});

/** Recorded session names, newest first. */
export function listSessionNames(): string[] {
  if (!existsSync(DEBUG_DIR)) return [];
  return readdirSync(DEBUG_DIR).filter((n) => RECORDING_NAME_RE.test(n)).sort().reverse();
}

export interface HandRecording {
  session: string;
  hand: number;
  firstSeq: number;
  lastSeq: number;
  nodeCount: number;
  /** Hero decision nodes in order — the k-th hero decision of the archived hand is decisions[k]. */
  decisions: { nodeIndex: number; street: string; seq: number; answerSeq: number; label: string; heroDid?: string }[];
}

/**
 * Every recorded hand by its site hand id, newest recording first. Until 2026-09-26 a MISS re-scanned every session
 * (a stat of each log per call), and the Sessions list asks once per hand — most hands have no recording, so one page
 * load cost thousands of stats on the answering thread. Now one pass builds the whole index; it is rebuilt when a
 * session log appears or changes (checked at most every REC_INDEX_CHECK_MS), and each session's parse stays cached by
 * mtime, so a rebuild re-reads only the log that grew.
 */
const REC_INDEX_CHECK_MS = 5_000;
let recIndex: { checkedAt: number; key: string; byCid: Map<string, HandRecording> } | null = null;

function recordingIndex(): Map<string, HandRecording> {
  const now = Date.now();
  if (recIndex && now - recIndex.checkedAt < REC_INDEX_CHECK_MS) return recIndex.byCid;
  const names = listSessionNames();
  const key = names.map((name) => {
    const dir = sessionDir(name);
    try { return `${name}:${dir ? statSync(join(dir, "log.jsonl")).mtimeMs : "-"}`; } catch { return `${name}:-`; }
  }).join("|");
  if (recIndex?.key === key) { recIndex.checkedAt = now; return recIndex.byCid; }
  const byCid = new Map<string, HandRecording>();
  for (const name of names) {   // newest first: a hand recorded twice resolves to its newest recording
    for (const h of parseSessionHands(name) ?? []) {
      if (!h.clientHandId || byCid.has(h.clientHandId)) continue;
      byCid.set(h.clientHandId, {
        session: name, hand: h.hand, firstSeq: h.firstSeq ?? 0, lastSeq: h.lastSeq ?? 0, nodeCount: h.nodes.length,
        decisions: h.nodes.filter((n) => n.kind === "decision").map((n) => ({
          nodeIndex: n.i, street: n.street, seq: n.seq, answerSeq: n.answerSeq ?? n.seq, label: n.label, heroDid: n.heroDid,
        })),
      });
    }
  }
  recIndex = { checkedAt: now, key, byCid };
  return byCid;
}

/**
 * Which recording holds this hand (by the site's hand id), and where its
 * hero decisions sit in that recording — the hand detail's "open in Replay
 * Review at this node" link.
 */
export function recordingForHand(clientHandId: string): HandRecording | null {
  return recordingIndex().get(clientHandId) ?? null;
}

/** Hero's seat from the raw capture, for ticks recorded before log.jsonl had it. */
function withHeroFromDom(dir: string, seq: number, tick: Tick): { tick: Tick; note?: string } {
  if (Object.values(tick.seats ?? {}).some((s) => s.hero !== undefined)) return { tick };
  const domPath = join(dir, "dom.jsonl");
  if (!existsSync(domPath)) return { tick };
  // The file is large (tens of MB), so parse only the line that opens with
  // this seq rather than every line. The writer is Python's json.dump, which
  // spaces its separators ("seq": 188) — matched loosely so a change of writer
  // cannot silently turn this into "hero was never recorded".
  const head = /^\{\s*"seq"\s*:\s*(\d+)/;
  let raw: any = null;
  for (const line of readFileSync(domPath, "utf-8").split("\n")) {
    const m = head.exec(line);
    if (!m || Number(m[1]) !== seq) continue;
    raw = JSON.parse(line);
    break;
  }
  const me = (raw?.seatQa ?? []).find((s: any) => s.me)?.num;
  if (me == null) return { tick };
  const seats = { ...(tick.seats ?? {}) };
  for (const k of Object.keys(seats)) seats[k] = { ...seats[k], hero: Number(k) === me };
  return {
    tick: { ...tick, seats },
    note: `hero's seat (${me}) was recovered from the raw capture — this recording predates the reader recording it`,
  };
}

replay.get("/:name/answer/:seq", async (c) => {
  const dir = sessionDir(c.req.param("name"));
  if (!dir) return c.json({ ok: false, error: "no such session" }, 404);
  const seq = Number(c.req.param("seq"));

  const logPath = join(dir, "log.jsonl");
  if (!existsSync(logPath)) return c.json({ ok: false, error: "no log.jsonl" }, 404);
  const ticks = jsonl(logPath) as Tick[];
  const tick = ticks.find((t) => t.seq === seq);
  if (!tick) return c.json({ ok: false, error: `no tick at seq ${seq}` }, 404);

  // Stitch the hand's whole story back together (see mergeTail): older
  // recordings kept four lines a tick, which is not enough to reach the blinds.
  const feed = feedForHand(ticks, seq, tick.hand);

  // log.jsonl only began carrying hero's seat once the reader was fixed to
  // record it, but every structural capture has always had it in the RAW dom
  // (seatQa.me, the client's own myPlayerTag). Recovering it from there makes
  // the whole existing corpus answerable instead of stranding it behind a
  // re-recording.
  const grafted = withHeroFromDom(dir, seq, { ...tick, feedTail: feed });
  const { hand, notes, buttonSeat } = tickToHand(grafted.tick);
  if (grafted.note) notes.unshift(grafted.note);
  if (!hand)
    return c.json({ ok: true, seq, solvable: false, notes, buttonSeat, hand: null, solution: null });

  const heroPos = hand.positions[hand.heroSeatId] ?? null;
  const input = {
    heroSeat: hand.heroSeatId,
    heroPos,
    buttonSeat,
    heroCards: hand.heroCards,
    board: hand.board,
    street: hand.street,
    positions: hand.positions,
    stacks: hand.stacks ?? null,
    node: hand.currentNode,
    // The action line as the solver sees it — the thing a chart is chosen by.
    line: hand.actions
      .map((a) => `${hand.positions[a.seatId] ?? `seat ${a.seatId}`} ${a.type}${a.amount != null ? ` ${a.amount}` : ""}`)
      .join(" · "),
  };

  if (!hand.currentNode.toActIsHero)
    return c.json({
      ok: true, seq, solvable: false, hand: input, notes, buttonSeat,
      solution: null, deferred: hand.ended ? "hero is out of the hand" : "not hero's turn",
    });

  try {
    const strat = c.req.query("strategy");
    const solution = await fastSolve(hand, heroPos, {
      heroPos: heroPos ?? undefined,
      ...(strat === "exploit" || strat === "chart" ? { strategy: strat } : {}),
    });
    return c.json({ ok: true, seq, solvable: true, hand: input, notes, buttonSeat, feed, solution });
  } catch (e) {
    return c.json({
      ok: true, seq, solvable: true, hand: input, notes, buttonSeat,
      solution: { ok: false, reason: String((e as Error)?.message ?? e) },
    });
  }
});

export default replay;
