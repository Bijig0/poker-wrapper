/**
 * THE HANDS TABLE — one definition for the wrapper (which writes it) and the API (which reads it), so the two cannot
 * drift. A hand's row is born LIVE while it is being played (the wrapper's live write) and finished IN PLACE when the
 * wrapper archives it — the dashboard reads that same row, live or finished (Brady 2026-09-25: "the dashboard reads
 * off the same row that the reader/study answer writes to … so we can get hands in live as well").
 *
 *   client_hand_id  the site's hand number — THE key other tables join on (answers, solves, hand_facts). Rows used to
 *                   be found with `data LIKE '%"clientHandId": "X"%'`, which only worked because of Python's JSON
 *                   separators; the column is backfilled from the JSON once.
 *   status          'live' while the hand is in play, 'done' once archived (every row written before 2026-09-25)
 *   updated_at      ms of the last write (a live row changes; a finished one is final)
 */
import type { Database } from "bun:sqlite";

export const HANDS_DDL = `CREATE TABLE IF NOT EXISTS hands (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  hand_id INTEGER,
  played_at INTEGER,
  stakes TEXT,
  street TEXT,
  result_text TEXT,
  result_amount REAL,
  hero_cards TEXT,
  action_count INTEGER,
  data TEXT NOT NULL,
  client_hand_id TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  updated_at INTEGER
)`;

/** SQL condition for a FINISHED hand — history, analytics, reconciliation and counts want only these. */
export const FINISHED = "status = 'done'";

/** Create the table, or bring an older one up to date (idempotent; cheap once done). */
export function ensureHandsSchema(db: Database): void {
  db.run(HANDS_DDL);
  const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(hands)").all().map((c) => c.name));
  if (!cols.has("client_hand_id")) {
    db.run("ALTER TABLE hands ADD COLUMN client_hand_id TEXT");
    db.run("UPDATE hands SET client_hand_id = json_extract(data, '$.clientHandId') WHERE client_hand_id IS NULL AND json_valid(data)");
  }
  if (!cols.has("status")) db.run("ALTER TABLE hands ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
  if (!cols.has("updated_at")) db.run("ALTER TABLE hands ADD COLUMN updated_at INTEGER");
  db.run("CREATE INDEX IF NOT EXISTS idx_hands_client ON hands(client_hand_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_hands_status ON hands(status, rowid)");
}
