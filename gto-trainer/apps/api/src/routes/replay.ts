import { Hono } from "hono";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

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
const DEBUG_DIR =
  process.env.IGNITION_DEBUG_DIR ??
  join(import.meta.dir, "..", "..", "..", "..", "..", "ignition-study-wrapper", "debug");

const replay = new Hono();

const sessionDir = (name: string): string | null => {
  // Session names are wrapper-generated timestamps; reject anything else so
  // a crafted name can never traverse out of the debug directory.
  if (!/^session_\d{8}_\d{6}$/.test(name)) return null;
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
    .filter((n) => /^session_\d{8}_\d{6}$/.test(n))
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
    ? readdirSync(DEBUG_DIR).filter((n) => /^session_\d{8}_\d{6}$/.test(n)).sort()
    : [];
  for (const name of sessions) {
    const p = join(DEBUG_DIR, name, "log.jsonl");
    if (!existsSync(p)) continue;
    const hasDom = existsSync(join(DEBUG_DIR, name, "dom.jsonl"));
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
        if (hasDom && !hit.hasDom) {
          hit.session = name;
          hit.seq = t.seq ?? -1;
          hit.hasDom = true;
        }
        continue;
      }
      seen.set(id, {
        id, session: name, seq: t.seq ?? -1, shape: shapeKey(t),
        hand: t.hand ?? null, street: streetOf(t.board),
        seats: Object.keys(t.seats).length, heroToAct: !!t.toAct, dupes: 1,
        hasDom,
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
  firstOfShape.sort((a, b) =>
    (Number(b.hasDom) - Number(a.hasDom)) ||
    (shapeCount.get(a.shape)! - shapeCount.get(b.shape)!));
  rest.sort((a, b) => Number(b.hasDom) - Number(a.hasDom));
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

export default replay;
