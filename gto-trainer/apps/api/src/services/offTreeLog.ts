import type { Database } from "bun:sqlite";
import { answersDbPath, openStore } from "./storePaths";
import { offTreeFamily, type OffTreeLine } from "./offTree";

/**
 * THE OFF-TREE LOG (2026-09-27): every off-tree villain line met in real play (services/offTree), once per hand and spot,
 * with villain's hole cards filled in when Ignition's hand history shows them (services/hhCheck). What a pool range
 * for node-locking those spots will be built from. Lives in the central database beside the answers (answersDbPath:
 * an in-memory database under bun test).
 */
export interface OffTreeRow {
  key: string; ts: number; clientHandId: string | null; sessionId: string | null; origin: string;
  street: string; board: string; heroPos: string | null; villainPos: string; inPosition: boolean;
  action: string; code: string; betsize: number | null; pot: number; codes: string[];
  nodeFreq: number; maxHand: number; evGapBb: number | null; family: string; villainCards: string | null;
  /** the soft range at the line (services/offTree, since 2026-10-06): soft = carried, log = computed only; null = not
   *  computed (OFFTREE_RANGE=off, or a line logged before) */
  softMode: string | null; softT: number | null; qreCombos: number | null; softCombos: number | null;
}

const DDL = `CREATE TABLE IF NOT EXISTS off_tree_lines (
  key TEXT PRIMARY KEY, ts INTEGER NOT NULL, client_hand_id TEXT, session_id TEXT, origin TEXT NOT NULL,
  street TEXT NOT NULL, board TEXT NOT NULL, hero_pos TEXT, villain_pos TEXT NOT NULL, in_position INTEGER NOT NULL,
  action TEXT NOT NULL, code TEXT NOT NULL, betsize REAL, pot REAL NOT NULL, codes TEXT NOT NULL,
  node_freq REAL NOT NULL, max_hand REAL NOT NULL, ev_gap REAL, family TEXT NOT NULL, villain_cards TEXT);
CREATE INDEX IF NOT EXISTS idx_off_tree_hand ON off_tree_lines(client_hand_id);
CREATE INDEX IF NOT EXISTS idx_off_tree_session ON off_tree_lines(session_id);
CREATE INDEX IF NOT EXISTS idx_off_tree_ts ON off_tree_lines(ts)`;
/** columns added after the table first shipped (2026-10-06, the soft range): added in place on an existing database */
const ADDED: [string, string][] = [["soft_mode", "TEXT"], ["soft_t", "REAL"], ["qre_combos", "REAL"], ["soft_combos", "REAL"]];

const fromRow = (r: any): OffTreeRow => ({
  key: r.key, ts: r.ts, clientHandId: r.client_hand_id, sessionId: r.session_id, origin: r.origin, street: r.street, board: r.board,
  heroPos: r.hero_pos, villainPos: r.villain_pos, inPosition: !!r.in_position, action: r.action, code: r.code, betsize: r.betsize,
  pot: r.pot, codes: JSON.parse(r.codes || "[]"), nodeFreq: r.node_freq, maxHand: r.max_hand, evGapBb: r.ev_gap, family: r.family,
  villainCards: r.villain_cards,
  softMode: r.soft_mode ?? null, softT: r.soft_t ?? null, qreCombos: r.qre_combos ?? null, softCombos: r.soft_combos ?? null,
});

export class OffTreeLog {
  private db: Database | null = null;
  constructor(private readonly path?: string) {}
  private open(): Database {
    if (this.db) return this.db;
    this.db = openStore(this.path ?? answersDbPath());
    this.db.exec(DDL);
    const have = new Set((this.db.query("PRAGMA table_info(off_tree_lines)").all() as { name: string }[]).map((c) => c.name));
    for (const [c, t] of ADDED) if (!have.has(c)) this.db.exec(`ALTER TABLE off_tree_lines ADD COLUMN ${c} ${t}`);
    return this.db;
  }

  /** Log one line; the same spot of the same hand is kept once (first seen). Never throws — logging is not the answer. */
  record(meta: { clientHandId: string | null; wrapperHandId?: number | null; sessionId: string | null; origin: string; board: string; heroPos: string | null; plan?: string | null },
    l: OffTreeLine): void {
    try {
      const hand = meta.clientHandId ?? (meta.wrapperHandId != null ? `w${meta.wrapperHandId}` : null);
      if (!hand) return;
      const board = (meta.board.match(/[2-9TJQKA][cdhs]/gi) ?? []).slice(0, l.street === "flop" ? 3 : l.street === "turn" ? 4 : 5).join("");
      const key = [hand, l.street, l.codes.join("-") || "root", l.seat, meta.plan ?? ""].join("|");
      this.open().query(`INSERT OR IGNORE INTO off_tree_lines (key, ts, client_hand_id, session_id, origin, street, board, hero_pos,
        villain_pos, in_position, action, code, betsize, pot, codes, node_freq, max_hand, ev_gap, family, villain_cards,
        soft_mode, soft_t, qre_combos, soft_combos) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        key, Date.now(), meta.clientHandId, meta.sessionId, meta.origin, l.street, board, meta.heroPos, l.seat, l.inPosition ? 1 : 0,
        l.action, l.code, l.betsize, l.potNode, JSON.stringify(l.codes), l.nodeFreq, l.maxHand, l.evGapBb, offTreeFamily(l, board), null,
        !l.soft ? null : l.soft.softCombos == null ? "not-computable" : l.soft.applied ? "soft" : "log", l.soft?.t ?? null, l.soft?.qreCombos ?? null, l.soft?.softCombos ?? null);
    } catch (e) {
      console.warn(`[off-tree] could not log a line: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Villain's hole cards from Ignition's hand history (hhCheck), onto every line of the hand by his position. */
  fillShown(clientHandId: string, seats: { position: string; cards: string[]; hero?: boolean }[]): number {
    try {
      let n = 0;
      for (const s of seats) {
        if (s.hero || (s.cards ?? []).length !== 2) continue;
        n += this.open().query("UPDATE off_tree_lines SET villain_cards = ? WHERE client_hand_id = ? AND upper(villain_pos) = upper(?) AND villain_cards IS NULL")
          .run(s.cards.join(""), clientHandId, s.position).changes;
      }
      return n;
    } catch { return 0; }
  }

  forHand(clientHandId: string): OffTreeRow[] {
    try { return this.open().query("SELECT * FROM off_tree_lines WHERE client_hand_id = ? ORDER BY ts").all(clientHandId).map(fromRow); } catch { return []; }
  }
  forSession(sessionId: string): OffTreeRow[] {
    try { return this.open().query("SELECT * FROM off_tree_lines WHERE session_id = ? ORDER BY ts").all(sessionId).map(fromRow); } catch { return []; }
  }
  recent(days = 365): OffTreeRow[] {
    try { return this.open().query("SELECT * FROM off_tree_lines WHERE ts >= ? ORDER BY ts").all(Date.now() - days * 86_400_000).map(fromRow); } catch { return []; }
  }

  /** The lines grouped into spot families: how often each came up, and the hands villains showed in it. */
  families(rows: OffTreeRow[]): { family: string; n: number; shown: { hand: string | null; cards: string; action: string }[] }[] {
    const by = new Map<string, { family: string; n: number; shown: { hand: string | null; cards: string; action: string }[] }>();
    for (const r of rows) {
      const f = by.get(r.family) ?? { family: r.family, n: 0, shown: [] };
      f.n++;
      if (r.villainCards) f.shown.push({ hand: r.clientHandId, cards: r.villainCards, action: `${r.villainPos} ${r.action}${r.betsize != null ? ` ${r.betsize}` : ""}` });
      by.set(r.family, f);
    }
    return [...by.values()].sort((a, b) => b.n - a.n);
  }
}

export const offTreeLog = new OffTreeLog();
