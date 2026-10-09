import type { Database } from "bun:sqlite";
import { yieldToLive } from "./livePriority";
import { deriveOf, readPage, type PagerMessage, type PagerRequest } from "./sqlitePagerWorker";

/**
 * SEED AN IN-MEMORY VIEW OF A TABLE WITHOUT HOLDING THE LOOP (2026-10-09, catalogue-incremental). Pages of `pageSize`
 * rows, keyset-paged by id, handed to `onPage` one at a time with a yield (and the live answers first,
 * livePriority.yieldToLive) between pages:
 *   - "worker": a Bun Worker reads the pages over its own read-only connection (services/sqlitePagerWorker.ts) — the
 *     disk never waits on the loop; the loop pays only each page's clone + apply;
 *   - "loop":   the caller's connection reads each page on the loop (an in-memory test database, or the worker failed).
 * Either way the page size adapts so one slice on the loop stays under `sliceMs` (default 25 ms; the bound asked for is
 * 50). `auto` = the worker for a file, the loop for ":memory:"; a worker that fails falls back to the loop from the last
 * id applied, so a seed always finishes.
 */
export interface PagedSeedOpts extends PagerRequest {
  /** the caller's own connection (the loop mode's reader) */
  db: () => Database;
  onPage: (rows: any[], derived?: unknown[]) => void;
  mode?: "auto" | "worker" | "loop";
  /** the id to start after (0 = the beginning) */
  after?: number;
  /** what runs between two pages (default: one macrotask, then the live answers first) */
  between?: () => Promise<unknown>;
  sliceMs?: number;
  /** how long one worker page may take before the worker is given up (default 60 s) */
  pageTimeoutMs?: number;
}

export interface PagedSeedResult {
  ok: boolean;
  mode: "worker" | "loop" | "worker+loop";
  pages: number;
  rows: number;
  /** wall time of the whole seed */
  ms: number;
  /** the longest single slice the loop spent on one page (read + apply in loop mode; apply in worker mode) */
  maxSliceMs: number;
  error?: string;
}

const defaultBetween = async () => { await new Promise((r) => setTimeout(r, 0)); await yieldToLive(); };
const isMemory = (p: string) => p === ":memory:" || p.startsWith("file::memory:") || p === "";

export async function pagedSeed(o: PagedSeedOpts): Promise<PagedSeedResult> {
  const t0 = performance.now();
  const mode = o.mode ?? "auto";
  const st = { pages: 0, rows: 0, maxSliceMs: 0, after: o.after ?? 0, pageSize: o.pageSize };
  const useWorker = mode === "worker" || (mode === "auto" && !isMemory(o.path) && typeof Worker !== "undefined");
  let error: string | undefined;
  if (useWorker) {
    const r = await viaWorker(o, st);
    if (r.ok) return { ok: true, mode: "worker", pages: st.pages, rows: st.rows, ms: Math.round(performance.now() - t0), maxSliceMs: round1(st.maxSliceMs) };
    error = r.error;
    if (mode === "worker") return { ok: false, mode: "worker", pages: st.pages, rows: st.rows, ms: Math.round(performance.now() - t0), maxSliceMs: round1(st.maxSliceMs), error };
  }
  try {
    await onLoop(o, st);
    return { ok: true, mode: useWorker ? "worker+loop" : "loop", pages: st.pages, rows: st.rows, ms: Math.round(performance.now() - t0), maxSliceMs: round1(st.maxSliceMs), ...(error ? { error } : {}) };
  } catch (e) {
    return { ok: false, mode: useWorker ? "worker+loop" : "loop", pages: st.pages, rows: st.rows, ms: Math.round(performance.now() - t0), maxSliceMs: round1(st.maxSliceMs),
      error: e instanceof Error ? e.message : String(e) };
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;

type SeedState = { pages: number; rows: number; maxSliceMs: number; after: number; pageSize: number };

/** keep a slice under the target: halve the page after a slow one, grow it back (up to the asked size) after a fast one */
function adapt(o: PagedSeedOpts, st: SeedState, sliceMs: number): void {
  const target = o.sliceMs ?? 25;
  if (sliceMs > target && st.pageSize > 25) st.pageSize = Math.max(25, Math.floor(st.pageSize / 2));
  else if (sliceMs < target / 3 && st.pageSize < o.pageSize) st.pageSize = Math.min(o.pageSize, st.pageSize * 2);
}

async function onLoop(o: PagedSeedOpts, st: SeedState): Promise<void> {
  const derive = deriveOf(o);
  const between = o.between ?? defaultBetween;
  for (;;) {
    const s0 = performance.now();
    const page = readPage(o.db(), { ...o, pageSize: st.pageSize }, st.after);
    if (!page.length) return;
    o.onPage(page, derive ? page.map(derive) : undefined);
    const slice = performance.now() - s0;
    st.maxSliceMs = Math.max(st.maxSliceMs, slice);
    st.pages++; st.rows += page.length;
    st.after = Number(page[page.length - 1]!.id);
    adapt(o, st, slice);
    await between();
  }
}

function viaWorker(o: PagedSeedOpts, st: SeedState): Promise<{ ok: boolean; error?: string }> {
  const between = o.between ?? defaultBetween;
  return new Promise((resolve) => {
    let done = false, timer: ReturnType<typeof setTimeout> | null = null;
    let w: Worker;
    try { w = new Worker(new URL("./sqlitePagerWorker.ts", import.meta.url).href); }
    catch (e) { resolve({ ok: false, error: e instanceof Error ? e.message : String(e) }); return; }
    const finish = (r: { ok: boolean; error?: string }) => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      try { w.postMessage({ stop: true }); } catch { /* gone */ }
      try { w.terminate(); } catch { /* gone */ }
      resolve(r);
    };
    const ask = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish({ ok: false, error: `a page took over ${(o.pageTimeoutMs ?? 60_000) / 1000} s` }), o.pageTimeoutMs ?? 60_000);
      w.postMessage({ next: true, pageSize: st.pageSize });
    };
    w.onmessage = (ev: MessageEvent<PagerMessage>) => {
      const m = ev.data;
      if ("error" in m) { finish({ ok: false, error: m.error }); return; }
      if ("done" in m) { finish({ ok: true }); return; }
      const s0 = performance.now();
      try { o.onPage(m.page, m.derived); }
      catch (e) { finish({ ok: false, error: e instanceof Error ? e.message : String(e) }); return; }
      const slice = performance.now() - s0;
      st.maxSliceMs = Math.max(st.maxSliceMs, slice);
      st.pages++; st.rows += m.page.length;
      st.after = m.last;
      adapt(o, st, slice);
      void between().then(() => { if (!done) ask(); });
    };
    w.onerror = (ev: ErrorEvent) => finish({ ok: false, error: ev.message || "worker error" });
    const { db: _db, onPage: _p, between: _b, mode: _m, after: _a, sliceMs: _s, pageTimeoutMs: _t, ...req } = o;
    w.postMessage({ open: req, after: st.after });
    ask();
  });
}
