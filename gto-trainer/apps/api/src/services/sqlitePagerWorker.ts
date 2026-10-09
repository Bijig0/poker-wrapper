/**
 * A KEYSET-PAGED READ OF A SQLITE TABLE, IN A BUN WORKER (2026-10-09, catalogue-incremental). The worker opens its OWN
 * read-only connection, so the disk reads — what froze the live API under IO pressure ("waiting: disk, a lock, or the
 * process not scheduled") — never happen on the API's loop. Pull-based: the main thread asks for each page after it has
 * applied the last one (and after the live answers, services/livePriority.yieldToLive), so pages never pile up and each
 * one costs the loop only its own structured-clone + apply (services/sqlitePager.ts measures that slice).
 *
 *   in:  { open: PagerRequest, after }   then   { next: true, pageSize }  (once per page)   or   { stop: true }
 *   out: { page: rows, derived?: per-row values, last: id }   …   { done: true, pages, rows, readMs }   or   { error }
 *
 * The SQL names `$after` (the last id read) and `$limit`, plus any `params`; every row carries `id`, ascending.
 */
import { Database } from "bun:sqlite";
import { pathCodesOf } from "./answerPathCodes";

export interface PagerRequest {
  path: string;
  sql: string;
  params?: Record<string, string | number | null>;
  pageSize: number;
  /** a per-row value computed here, off the loop, and posted beside the rows */
  derive?: "pathCodes";
}
export type PagerMessage =
  | { page: Record<string, unknown>[]; derived?: unknown[]; last: number }
  | { done: true; pages: number; rows: number; readMs: number }
  | { error: string };

const DERIVE: Record<NonNullable<PagerRequest["derive"]>, (row: any) => unknown> = {
  pathCodes: (row) => pathCodesOf(row),
};

/** The reader both sides use: the worker over its own connection, the on-loop fallback over the caller's. */
export function readPage(db: Database, req: PagerRequest, after: number): Record<string, unknown>[] {
  const bind: Record<string, string | number | null> = { $after: after, $limit: req.pageSize };
  for (const [k, v] of Object.entries(req.params ?? {})) bind[k.startsWith("$") ? k : `$${k}`] = v;
  return db.query(req.sql).all(bind as any) as Record<string, unknown>[];
}

export function deriveOf(req: PagerRequest): ((row: any) => unknown) | null {
  return req.derive ? DERIVE[req.derive] : null;
}

// the worker side: only when this file runs as a Worker (importing it from the main thread or a test does nothing)
if (!Bun.isMainThread) {
  const w = globalThis as unknown as { onmessage: ((ev: MessageEvent<any>) => void) | null; postMessage: (m: PagerMessage) => void; close?: () => void };
  let db: Database | null = null, req: PagerRequest | null = null, after = 0, pages = 0, rows = 0, readMs = 0;
  const end = () => { try { db?.close(); } catch { /* closed */ } db = null; };
  w.onmessage = (ev) => {
    try {
      if (ev.data?.open) {
        req = ev.data.open as PagerRequest;
        db = new Database(req.path, { readonly: true });
        db.exec("PRAGMA busy_timeout = 5000");
        after = Number(ev.data.after ?? 0) || 0;
        return;
      }
      if (ev.data?.stop) { end(); return; }
      if (ev.data?.next && db && req) {
        // the main thread adapts the page size to keep its own slice short (services/sqlitePager.ts)
        if (Number(ev.data.pageSize) > 0) req.pageSize = Number(ev.data.pageSize);
        const t0 = performance.now();
        const page = readPage(db, req, after);
        readMs += performance.now() - t0;
        if (!page.length) { end(); w.postMessage({ done: true, pages, rows, readMs: Math.round(readMs) }); return; }
        pages++; rows += page.length;
        after = Number(page[page.length - 1]!.id);
        const d = deriveOf(req);
        w.postMessage({ page, ...(d ? { derived: page.map(d) } : {}), last: after });
      }
    } catch (e) {
      end();
      w.postMessage({ error: e instanceof Error ? e.message : String(e) });
    }
  };
}
