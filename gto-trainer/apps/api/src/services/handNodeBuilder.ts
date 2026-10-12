import dashboard, { enrichSync, handsView, type HandRow } from "../routes/dashboard";
import { asActivity } from "./answerTrace";
import { handNodeStore, handNodesOn, type HandNodeStore } from "./handNodeStore";
import { sessionLive } from "./sessionLive";

/**
 * FILLS THE STORED HAND NODES (services/handNodeStore.ts) so the hand page opens with every node already there
 * (2026-10-12, Brady: "I just want it there immediately"). For every finished hand, newest first, it asks the two routes
 * the page reads — GET /preflop-path (every seat's preflop node along the line) and GET /answer-node&ranges=1 for each of
 * hero's decisions — with `fresh=1`, through the dashboard app itself, so what is kept is exactly what the page would
 * have computed. Then the rows the page served from an older commit are rebuilt.
 *
 * ONLY WHILE NO SESSION IS LIVE (memory: nothing heavy while live) — it stops between two requests the moment one starts,
 * and the hand it was on is picked up again later. At most SLICE_MS of work a tick, one request at a time with a gap
 * between, so a dashboard reader is never queued behind it for long. It never spends GTO Wizard quota: neither route
 * makes a request (the AI preflop path, which can, is never built here), and postflop chains are already stored solves.
 *
 * A chart server that is not reachable leaves the hand unbuilt and pauses the builder for BACKOFF_MS. HAND_NODES=off
 * turns it off with the store.
 */
export const TICK_MS = 20_000;
export const SLICE_MS = 8_000;
export const GAP_MS = 100;
export const BACKOFF_MS = 10 * 60_000;

/** Hero's decisions in a hand: every hero action but the blinds' posts (the hand page's own rule, rlIsDecision). */
export const heroDecisions = (actions: { hero?: boolean; type: string }[]): number[] =>
  actions.map((a, i) => (a.hero && !/^post/.test(a.type) ? i : -1)).filter((i) => i >= 0);

export interface BuilderDeps {
  store: HandNodeStore;
  live: () => boolean;
  /** finished hands, oldest first (null while the view is not seeded) */
  rows: () => HandRow[] | null;
  request: (url: string) => Promise<any>;
  heroIdx: (row: HandRow) => number[] | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export class HandNodeBuilder {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  backoffUntil = 0;
  last: { at: number; hands: number; refreshed: number; ms: number; stoppedBy: string | null } | null = null;

  constructor(private readonly deps: BuilderDeps) {}

  start(everyMs = TICK_MS): void {
    if (this.timer || !handNodesOn()) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      asActivity("timer handNodes", () => this.tick())
        .catch((e) => console.error(`[hand-nodes] ${e?.message ?? e}`))
        .finally(() => { this.busy = false; });
    }, everyMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** One slice: the rows served stale first (someone is reading those hands), then unbuilt hands, newest first. */
  async tick(): Promise<void> {
    const d = this.deps;
    if (d.live() || d.now() < this.backoffUntil) return;
    const t0 = d.now();
    const over = () => d.now() - t0 > SLICE_MS;
    let refreshed = 0, hands = 0, stoppedBy: string | null = null;
    for (const [k, r] of [...d.store.refresh]) {
      if (over()) { stoppedBy = "slice"; break; }
      if (d.live()) { stoppedBy = "live"; break; }
      d.store.refresh.delete(k);
      await d.request(r.url);
      refreshed++;
      await d.sleep(GAP_MS);
    }
    const rows = stoppedBy ? null : d.rows();
    if (rows) {
      const built = d.store.builtIds();
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]!;
        if (built.has(row.rowid)) continue;
        if (over()) { stoppedBy = "slice"; break; }
        const r = await this.buildHand(row);
        if (r === "built") hands++;
        else { stoppedBy = r; break; }
      }
    }
    if (refreshed || hands) this.last = { at: t0, hands, refreshed, ms: d.now() - t0, stoppedBy };
  }

  /** Every node of one hand. "live": a session started (not marked — picked up later); "unreachable": the chart
   *  server is down (not marked, the builder pauses). */
  async buildHand(row: HandRow): Promise<"built" | "live" | "unreachable"> {
    const d = this.deps, id = row.rowid, t0 = d.now();
    const idx = d.heroIdx(row);
    if (!idx) { d.store.markBuilt(id, 0, 1, 0); return "built"; }
    const urls = [`/preflop-path?dbId=${id}&fresh=1`, ...idx.map((i) => `/answer-node?dbId=${id}&upto=${i}&ranges=1&fresh=1`)];
    let ok = 0, failed = 0;
    for (const u of urls) {
      if (d.live()) return "live";
      const j = await d.request(u).catch(() => null);
      if (j?.ok) ok++;
      else {
        if (/not reachable/.test(String(j?.error ?? ""))) { this.backoffUntil = d.now() + BACKOFF_MS; return "unreachable"; }
        failed++;
      }
      await d.sleep(GAP_MS);
    }
    d.store.markBuilt(id, ok, failed, d.now() - t0);
    return "built";
  }
}

/** The API worker's own inputs (scripts/buildHandNodes.ts reuses them without the gaps). */
export const builderDeps: BuilderDeps = {
  store: handNodeStore(),
  live: () => sessionLive(),
  rows: () => handsView.rows(),
  request: async (url) => (await dashboard.request(url)).json(),
  heroIdx: (row) => { const e = enrichSync(row); return e ? heroDecisions(e.hand.actions as any) : null; },
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
};
export const handNodeBuilder = new HandNodeBuilder(builderDeps);
