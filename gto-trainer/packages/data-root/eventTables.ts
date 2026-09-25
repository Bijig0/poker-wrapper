/**
 * The two append-only logs that used to be JSONL files beside the code — now tables of the central poker.sqlite, so
 * an answer's GTO Wizard requests and its poller timeline sit in the same file as the answer and the hand:
 *
 *   gtow_requests   one row per HTTP request any process sent to GTO Wizard (was data/gtow_requests.jsonl)
 *   poller_events   the study poller's per-decision timeline and state changes (was data/jobs/poller-events.jsonl)
 *
 * The legacy files are imported once at start-up (`adoptJsonl`, called from centralDb.adoptAtStartup): the byte
 * offset imported so far is kept in `_poker_adopted_files`, so lines an old-code process appends meanwhile are picked
 * up on the next start, and a fully imported file nothing holds open is renamed `<name>.adopted-<yyyymmdd>`.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";

export const GTOW_REQUESTS_DDL = `CREATE TABLE IF NOT EXISTS gtow_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  s TEXT NOT NULL,
  k TEXT NOT NULL,
  st INTEGER NOT NULL,
  o TEXT NOT NULL,
  h TEXT,
  sr TEXT,
  go TEXT
)`;

export const POLLER_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS poller_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ev TEXT,
  outcome TEXT,
  hand TEXT,
  street TEXT,
  ms INTEGER,
  doc TEXT NOT NULL
)`;

export function ensureEventTables(db: Database): void {
  db.run(GTOW_REQUESTS_DDL);
  db.run("CREATE INDEX IF NOT EXISTS idx_gtow_requests_ts ON gtow_requests(ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_gtow_requests_hand ON gtow_requests(h)");
  db.run(POLLER_EVENTS_DDL);
  db.run("CREATE INDEX IF NOT EXISTS idx_poller_events_ts ON poller_events(ts)");
}

/** One poller event as a row: the few columns worth querying, and the whole event as `doc`. */
export function pollerEventRow(e: Record<string, unknown>): { ts: number; ev: string | null; outcome: string | null; hand: string | null; street: string | null; ms: number | null; doc: string } {
  const str = (v: unknown) => (v == null ? null : String(v));
  return {
    ts: typeof e.ts === "number" ? e.ts : Date.now(),
    ev: str(e.ev), outcome: str(e.outcome), hand: str(e.hand), street: str(e.street),
    ms: typeof e.ms === "number" ? Math.round(e.ms) : null,
    doc: JSON.stringify(e),
  };
}

export interface JsonlSource {
  file: string;
  table: "gtow_requests" | "poller_events";
}

export interface JsonlNote { file: string; table: string; copied: number }

/** Import the new lines of each legacy JSONL log; returns what was copied, what was retired, what failed. */
export function adoptJsonl(db: Database, sources: JsonlSource[], opts: { retire?: boolean; now?: number } = {}):
  { notes: JsonlNote[]; retired: string[]; stillOpen: string[]; errors: string[] } {
  const out = { notes: [] as JsonlNote[], retired: [] as string[], stillOpen: [] as string[], errors: [] as string[] };
  const now = opts.now ?? Date.now();
  ensureEventTables(db);
  db.run("CREATE TABLE IF NOT EXISTS _poker_adopted_files (file TEXT PRIMARY KEY, bytes INTEGER NOT NULL, at INTEGER NOT NULL)");
  for (const src of sources) {
    if (!existsSync(src.file)) continue;
    try {
      const size = statSync(src.file).size;
      const done = db.query<{ bytes: number }, [string]>("SELECT bytes FROM _poker_adopted_files WHERE file = ?").get(src.file)?.bytes ?? 0;
      const from = done > size ? 0 : done;      // the file shrank: it was re-created (old code started again) — read it all
      let copied = 0;
      if (size > from) {
        const text = readFileSync(src.file).subarray(from).toString("utf8");
        const cut = text.lastIndexOf("\n") + 1;   // a line still being written is left for the next start
        const lines = text.slice(0, cut).split("\n").filter(Boolean);
        const insG = db.prepare("INSERT INTO gtow_requests (ts, s, k, st, o, h, sr, go) VALUES (?,?,?,?,?,?,?,?)");
        const insP = db.prepare("INSERT INTO poller_events (ts, ev, outcome, hand, street, ms, doc) VALUES (?,?,?,?,?,?,?)");
        db.transaction(() => {
          for (const l of lines) {
            let o: any;
            try { o = JSON.parse(l); } catch { continue; }   // a torn line from a concurrent writer
            if (src.table === "gtow_requests") {
              if (typeof o?.ts !== "number") continue;
              insG.run(o.ts, String(o.s ?? "unknown"), String(o.k ?? "other"), Number(o.st ?? 0), String(o.o ?? "unknown"), o.h ?? null, o.sr ?? null, o.go ?? null);
            } else {
              const r = pollerEventRow(o ?? {});
              insP.run(r.ts, r.ev, r.outcome, r.hand, r.street, r.ms, r.doc);
            }
            copied++;
          }
          db.run("INSERT INTO _poker_adopted_files (file, bytes, at) VALUES (?, ?, ?) ON CONFLICT(file) DO UPDATE SET bytes = excluded.bytes, at = excluded.at",
            [src.file, from + Buffer.byteLength(text.slice(0, cut), "utf8"), now]);
        }).immediate();
      }
      if (copied) out.notes.push({ file: src.file, table: src.table, copied });
      if (opts.retire) {
        const stamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
        try {
          renameSync(src.file, `${src.file}.adopted-${stamp}`);
          db.run("DELETE FROM _poker_adopted_files WHERE file = ?", [src.file]);   // a re-created file starts from 0
          out.retired.push(src.file);
        } catch {
          out.stillOpen.push(src.file);
        }
      }
    } catch (e) {
      out.errors.push(`${src.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
