import { Hono } from "hono";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  const p = join(dir, `f${String(seq).padStart(5, "0")}.jpg`);
  if (!existsSync(p)) return c.json({ ok: false, error: "no frame" }, 404);
  return new Response(Bun.file(p), { headers: { "Content-Type": "image/jpeg" } });
});

export default replay;
