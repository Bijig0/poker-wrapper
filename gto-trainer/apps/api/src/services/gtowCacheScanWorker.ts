/**
 * THE GTO WIZARD CACHE'S FULL SCANS, OFF THE EVENT LOOP (2026-10-09). gtow-cache.sqlite reached 1.5 GB; counting its
 * rows (COUNT/SUM over gtow_cache_trees and gtow_cache_nodes, the hits JOIN) reads most of the file, and on the live API's
 * thread that was 6–15 s a call, every 10 s while anything polled the accounts page or /gtow-status — the "waiting at
 * 2–20% CPU" freezes of 2026-10-09 (`cache refresh gtow/accounts … solve cache summary 14.9 s`).
 *
 * This runs in a Bun Worker (its own thread) with its OWN read-only connection to the same file, so the live API's loop
 * never waits on it. One message in, one message out:
 *   in:  { path, recent }               out: { ok: true, rows, recent, ms } | { ok: false, error }
 */
import { Database } from "bun:sqlite";

export interface ScanRequest { path: string; recent: number }
export interface ScanRows { trees: number; nodes: number; negatives: number; storedBytes: number }
export interface ScanRecent { tree: string; kind: string; addr: string; status: number; hits: number; lastHitMs: number }
export type ScanReply = { ok: true; rows: ScanRows; recent: ScanRecent[]; ms: number } | { ok: false; error: string };

/** The scan itself (exported for the tests; the worker below is its only live caller). */
export function scanCache(path: string, recent: number): ScanReply {
  const t0 = performance.now();
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const t = db.query<{ n: number; b: number | null }, []>("SELECT COUNT(*) n, SUM(bytes) b FROM gtow_cache_trees").get()!;
    const n = db.query<{ n: number; neg: number | null; b: number | null }, []>("SELECT COUNT(*) n, SUM(status <> 200) neg, SUM(bytes) b FROM gtow_cache_nodes").get()!;
    const rows: ScanRows = { trees: t.n, nodes: n.n, negatives: n.neg ?? 0, storedBytes: (t.b ?? 0) + (n.b ?? 0) };
    const top = recent > 0
      ? db.query<{ key: string; kind: string; addr: string; status: number; hits: number; last_hit_ms: number }, [number]>(
        `SELECT n.key, t.kind, n.addr, n.status, n.hits, n.last_hit_ms FROM gtow_cache_nodes n JOIN gtow_cache_trees t ON t.key = n.key
         WHERE n.hits > 0 ORDER BY n.last_hit_ms DESC LIMIT ?`).all(recent)
        .map((r) => ({ tree: r.key.slice(0, 12), kind: r.kind, addr: r.addr, status: r.status, hits: r.hits, lastHitMs: r.last_hit_ms }))
      : [];
    return { ok: true, rows, recent: top, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

// the worker side: only when this file runs as a Worker (importing it from the tests does nothing)
if (!Bun.isMainThread) {
  const w = globalThis as unknown as { onmessage: ((ev: MessageEvent<ScanRequest>) => void) | null; postMessage: (m: ScanReply) => void };
  w.onmessage = (ev) => { w.postMessage(scanCache(ev.data.path, ev.data.recent)); };
}
