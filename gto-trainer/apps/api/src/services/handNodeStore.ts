import type { Database } from "bun:sqlite";
import { gitHead, repoRootOf } from "./loadedCode";
import { handNodesDbPath, openStore, storeWriteFailed } from "./storePaths";

/**
 * THE HAND PAGE'S NODES, STORED (2026-10-12, Brady: "needing to click 'exact node' per thingo when reviewing each hand,
 * and having to wait, I just want it there immediately"). The hand page's Ranges view and its exact-node view are drawn
 * from two routes that rebuild everything on every open: GET /answer-node (one per hero decision — the chart server,
 * the GTO Wizard solve cache, the walk along the line) and GET /preflop-path (every seat's preflop node along the whole
 * line). Their JSON is kept here per hand, so a second open — and, with services/handNodeBuilder.ts filling finished
 * hands while no session is live, the first one too — is a read of one row.
 *
 * What it does NOT keep: the postflop chain solves, already stored whole (services/solveStore.ts, read by GET /solve/:id),
 * and anything that costs GTO Wizard quota (preflop-path&ai=1 is kept only once someone has clicked for it).
 *
 * A row remembers the commit that built it. Served from a different commit it is still served at once — and queued to
 * be built again when the table is quiet, so a fix to these routes reaches the page on the next open. A rebuild never
 * replaces a row that drew a node with one that cannot (a GTO Wizard cache entry pruned since, a chart server down).
 *
 * Its own file beside the central database (like the GTO Wizard cache): ~10-30 KB a hand, rebuildable, and no reason to
 * grow the file every page and backup reads. HAND_NODES_DB_PATH moves it; HAND_NODES=off turns storing and serving off.
 */

const DDL = `CREATE TABLE IF NOT EXISTS hand_nodes (
  db_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  commit_id TEXT,
  built_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  body BLOB NOT NULL,
  PRIMARY KEY (db_id, key)
);
CREATE TABLE IF NOT EXISTS hand_nodes_built (
  db_id INTEGER PRIMARY KEY,
  commit_id TEXT,
  built_at INTEGER NOT NULL,
  nodes INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  ms INTEGER NOT NULL
)`;

export const handNodesOn = (): boolean => !/^off$/i.test(process.env.HAND_NODES?.trim() ?? "");

/** The commit this process loaded (read from .git once, at first use). */
let loaded: string | null | undefined;
export const loadedCommit = (): string | null => (loaded ??= gitHead(repoRootOf(import.meta.path)) ?? null);

/** The stored key of a request to one of the two routes, or null for a request that is not stored. */
export function nodeKeyOf(route: "answer-node" | "preflop-path", q: Record<string, string | undefined>): string | null {
  if (route === "answer-node") {
    const upto = Number(q.upto);
    if (!Number.isInteger(upto) || upto < 0) return null;
    return `answer-node:${upto}${q.answerId ? `:a${Number(q.answerId)}` : ""}${q.ranges === "1" ? ":ranges" : ""}`;
  }
  return q.ai === "1" ? "preflop-path:ai" : "preflop-path";
}

/** Did this response draw something — a node, a view, a walked path — rather than say why it could not? */
export function drewNode(body: any): boolean {
  if (!body || body.ok !== true) return false;
  return !!(body.node || body.view?.hero || body.mes || body.logged?.solveId != null || (Array.isArray(body.steps) && body.steps.length));
}

export interface StoredNode { body: any; commit: string | null; builtAt: number }

export class HandNodeStore {
  private db: Database | null = null;
  private built: Set<number> | null = null;
  readonly path: string;
  /** keys served from an older commit (or without a node) — the builder rebuilds them when the table is quiet */
  readonly refresh = new Map<string, { dbId: number; key: string; url: string }>();

  constructor(path?: string) { this.path = path ?? handNodesDbPath(); }

  private open(): Database {
    if (this.db) return this.db;
    this.db = openStore(this.path);
    this.db.exec(DDL);
    return this.db;
  }

  get(dbId: number, key: string): StoredNode | null {
    try {
      const r = this.open().query<{ body: Uint8Array; commit_id: string | null; built_at: number }, [number, string]>(
        "SELECT body, commit_id, built_at FROM hand_nodes WHERE db_id = ? AND key = ?").get(dbId, key);
      if (!r) return null;
      return { body: JSON.parse(Buffer.from(Bun.gunzipSync(r.body)).toString("utf-8")), commit: r.commit_id, builtAt: r.built_at };
    } catch { return null; }
  }

  /** Keep a response (ok ones only). Returns false when it was not kept: not ok, or it would replace a drawn node
   *  with one that cannot draw. */
  put(dbId: number, key: string, body: any, commit = loadedCommit()): boolean {
    if (!body || body.ok !== true) return false;
    try {
      if (!drewNode(body)) {
        const old = this.get(dbId, key);
        if (old && drewNode(old.body)) return false;
      }
      const blob = Bun.gzipSync(Buffer.from(JSON.stringify(body)));
      this.open().query(
        "INSERT OR REPLACE INTO hand_nodes (db_id, key, commit_id, built_at, bytes, body) VALUES (?,?,?,?,?,?)")
        .run(dbId, key, commit, Date.now(), blob.byteLength, blob);
      return true;
    } catch (e) {
      storeWriteFailed("hand-nodes", e);
      return false;
    }
  }

  /** The hands the builder has been through (in memory after the first read). */
  builtIds(): Set<number> {
    if (this.built) return this.built;
    try {
      this.built = new Set(this.open().query<{ id: number }, []>("SELECT db_id AS id FROM hand_nodes_built").all().map((r) => r.id));
    } catch { this.built = new Set(); }
    return this.built;
  }

  markBuilt(dbId: number, nodes: number, failed: number, ms: number): void {
    try {
      this.open().query("INSERT OR REPLACE INTO hand_nodes_built (db_id, commit_id, built_at, nodes, failed, ms) VALUES (?,?,?,?,?,?)")
        .run(dbId, loadedCommit(), Date.now(), nodes, failed, ms);
      this.builtIds().add(dbId);
    } catch (e) { storeWriteFailed("hand-nodes", e); }
  }

  /** Rows, bytes and hands built — for GET /api/dashboard/hand-nodes. */
  stats(): { rows: number; bytes: number; hands: number; failedHands: number } {
    try {
      const d = this.open();
      const r = d.query<{ n: number; b: number | null }, []>("SELECT count(*) n, sum(bytes) b FROM hand_nodes").get();
      const h = d.query<{ n: number; f: number | null }, []>("SELECT count(*) n, sum(failed > 0) f FROM hand_nodes_built").get();
      return { rows: r?.n ?? 0, bytes: r?.b ?? 0, hands: h?.n ?? 0, failedHands: h?.f ?? 0 };
    } catch { return { rows: 0, bytes: 0, hands: 0, failedHands: 0 }; }
  }
}

let store: HandNodeStore | null = null;
export const handNodeStore = (): HandNodeStore => (store ??= new HandNodeStore());
/** Test hook. */
export const __setHandNodeStore = (s: HandNodeStore | null): void => { store = s; };
