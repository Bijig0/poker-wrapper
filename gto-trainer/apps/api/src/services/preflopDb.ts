import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { walkPreflopLine, type WalkNode, type WalkRepair } from "../utils/walkPreflopLine/walkPreflopLine";
import { pickWeightedAction, type WeightedPick } from "../utils/pickWeightedAction/pickWeightedAction";

/**
 * Read side of the crawled preflop DB (see scripts/crawlPreflopTree.ts):
 * resolves a live hand's preflop line to a node and hero's strategy there in
 * ~0ms, replacing a 3-8s GTO Wizard navigation for every crawled spot.
 *
 * The DB is written by the crawler concurrently (WAL) — readers here always
 * see the latest committed nodes, so coverage grows while the app runs. A
 * missing file or node simply reports unavailable and the caller falls back
 * to live GTO Wizard navigation.
 */

export interface PreflopAnswer {
  ok: true;
  line: string;
  pos: string;
  repaired: WalkRepair[];
  /** Hero's class strategy at the node (frequencies in %). */
  actions: { action: string; frequency: number }[];
  decision: WeightedPick | null;
  notInRange: boolean;
}

export interface PreflopMiss {
  ok: false;
  reason: string;
  missingAt?: string;
}

interface NodeRow {
  pos: string | null;
  terminal: number;
  actions: string;
  cells: string;
}

class PreflopDb {
  private db: Database | null = null;
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? join(import.meta.dir, "..", "..", "data", "preflop-db.sqlite");
  }

  private open(): Database | null {
    if (this.db) return this.db;
    if (!existsSync(this.path)) return null;
    this.db = new Database(this.path, { readonly: true });
    return this.db;
  }

  /** True once the crawler has stored this tree's root. */
  available(gametype: string, depth: number): boolean {
    return this.getRaw(gametype, depth, "") != null;
  }

  private getRaw(gametype: string, depth: number, line: string): NodeRow | null {
    const db = this.open();
    if (!db) return null;
    return db
      .query<NodeRow, [string, number, string]>(
        "SELECT pos, terminal, actions, cells FROM nodes WHERE gametype=? AND depth=? AND line=?"
      )
      .get(gametype, depth, line);
  }

  /**
   * The full parsed node at a line — acting position, whether it's terminal,
   * the action legend (label ↔ URL token), and every in-range class's action
   * mix (percentages). Used by flop-range reconstruction, which needs each
   * player's per-class continuation frequencies. Null if the node isn't stored.
   */
  rawNode(
    gametype: string,
    depth: number,
    line: string
  ): {
    pos: string | null;
    terminal: boolean;
    actions: { action: string; token: string | null }[];
    cells: { hand: string; actions: Record<string, number> }[];
  } | null {
    const row = this.getRaw(gametype, depth, line);
    if (!row) return null;
    return {
      pos: row.pos,
      terminal: row.terminal === 1,
      actions: JSON.parse(row.actions) as { action: string; token: string | null }[],
      cells: JSON.parse(row.cells) as { hand: string; actions: Record<string, number> }[],
    };
  }

  private getWalkNode(gametype: string, depth: number, line: string): WalkNode | null {
    const row = this.getRaw(gametype, depth, line);
    if (!row) return null;
    const actions = JSON.parse(row.actions) as { action: string; token: string | null }[];
    return { pos: row.pos, terminal: row.terminal === 1, actions };
  }

  /**
   * Resolve a token line to hero's node and strategy. Off-tree sizes are
   * snapped inside the walk (each node's real sizes are local); `heroClass`
   * is the grid class ("AKs"/"TT"/…) or null when hero's cards are unknown.
   */
  answer(gametype: string, depth: number, tokens: string[], heroClass: string | null): PreflopAnswer | PreflopMiss {
    const walk = walkPreflopLine(tokens, (line) => this.getWalkNode(gametype, depth, line));
    if (!walk.ok) return { ok: false, reason: walk.reason, missingAt: walk.missingAt };

    const line = walk.tokens.join("-");
    if (heroClass == null) {
      return { ok: true, line, pos: walk.node.pos!, repaired: walk.repaired, actions: [], decision: null, notInRange: false };
    }
    const row = this.getRaw(gametype, depth, line)!;
    const cells = JSON.parse(row.cells) as { hand: string; actions: Record<string, number> }[];
    const cell = cells.find((c) => c.hand === heroClass);
    const actions = cell
      ? Object.entries(cell.actions).map(([action, frequency]) => ({ action, frequency }))
      : [];
    return {
      ok: true,
      line,
      pos: walk.node.pos!,
      repaired: walk.repaired,
      actions,
      decision: actions.length ? pickWeightedAction(actions) : null,
      notInRange: !cell,
    };
  }
}

export const preflopDb = new PreflopDb();
export { PreflopDb };
