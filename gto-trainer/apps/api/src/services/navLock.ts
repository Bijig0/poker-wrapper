/**
 * Serializes every navigate:true ingest call against the single GTO Wizard
 * CDP connection. There are two independent automatic callers today — the
 * dashboard's client-side "Go live" poll and the backend study poller — and
 * gotoNodeUrl/decideCombo have no locking of their own, so two concurrent
 * navigations race on the same WebSocket (confirmed: wrong node landed,
 * corrupted state).
 *
 * Single-flight, NOT a queue: a second caller arriving while one navigation
 * is in flight is turned away immediately rather than queued. Both callers
 * are polling loops, so a queue would let a backlog of now-stale requests
 * pile up behind one slow navigation, each replaying an outdated hand by the
 * time its turn comes — skip-and-retry-next-tick is strictly better here.
 */
class NavLock {
  private busy = false;

  async run<T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string; skipped: true }> {
    if (this.busy) {
      return { ok: false, error: "Navigation already in progress — skipped.", skipped: true };
    }
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
}

export const navLock = new NavLock();
