import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { sessionsDbPath } from "./storePaths";

// the wrapper's sessions.sqlite beside its hands.db, through the one data root (storePaths.ts); a leaf import,
// so the dashboard.ts <-> sessionsStore.ts cycle that once left HANDS_DB undefined at init cannot recur

/**
 * Read side of the wrapper's DECLARED sessions (ignition-study-wrapper/
 * sessions.py writes data/sessions.sqlite next to hands.db). One row per
 * session: preset, config, preflight, the versions of every source in force
 * at Start, the events (mode flips, resume, end) and the closing summary.
 * The dashboard never writes here — the wrapper owns the record.
 */

export interface DeclaredSession {
  id: string;
  startedAt: number;
  endedAt: number | null;
  preset: string | null;
  label: string | null;
  note: string | null;
  config: any;
  preflight: any;
  versions: any;
  events: any[];
  summary: any;
}

const PATH = sessionsDbPath();

const parse = (x: string | null) => { try { return x ? JSON.parse(x) : null; } catch { return null; } };
const rowOf = (r: any): DeclaredSession => ({
  id: r.id, startedAt: r.started_at, endedAt: r.ended_at ?? null, preset: r.preset, label: r.label, note: r.note,
  config: parse(r.config), preflight: parse(r.preflight), versions: parse(r.versions), events: parse(r.events) ?? [], summary: parse(r.summary),
});

function open(): Database | null {
  if (!existsSync(PATH)) return null;
  // the wrapper writes this file while we read it — wait out a held lock rather than throwing
  try { const d = new Database(PATH, { readonly: true }); d.exec("PRAGMA busy_timeout = 5000"); return d; } catch { return null; }
}

export const sessionsStore = {
  path: PATH,
  list(limit = 200): DeclaredSession[] {
    const db = open();
    if (!db) return [];
    try { return db.query<any, [number]>("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?").all(limit).map(rowOf); }
    catch { return []; }
    finally { db.close(); }
  },
  get(id: string): DeclaredSession | null {
    const db = open();
    if (!db) return null;
    try { const r = db.query<any, [string]>("SELECT * FROM sessions WHERE id = ?").get(id); return r ? rowOf(r) : null; }
    catch { return null; }
    finally { db.close(); }
  },
};
