/**
 * THE SETUP PAGE COUNTS AS LIVE (2026-10-09, catalogue-incremental). The strategy catalogue's refresh-ahead ran while the
 * wrapper's setup page was open — `cache refresh sources/strategies 8.9 s` 85 s before session_20261009_155740 started,
 * triggered by that page's own polls — because "live" meant only a declared session (services/sessionLive.ts). The minutes
 * before Start are the minutes Brady is about to play: the heavy rebuilds should wait for them exactly as for a session.
 *
 * The signal: the wrapper marks every call it makes to the API on the setup page's behalf with the header
 * `X-Poker-Setup: 1` (or `?from=setup`) — the strategy catalogue it lists the strategies from, the accounts payload it
 * shows the GTO Wizard picker from, the registry its preflight reads. A marked request within SETUP_LIVE_MS (2 min; the
 * page asks at least every 30 s) = the setup page is open. Memory only; the clock is injectable for tests.
 */
import { sessionLive } from "./sessionLive";

export const SETUP_LIVE_MS = 2 * 60_000;
export const SETUP_HEADER = "x-poker-setup";

let lastPollAt = 0;
let clock: () => number = () => Date.now();

/** Does this request come from the setup page (the wrapper's marker header, or ?from=setup)? */
export function isSetupRequest(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): boolean {
  try {
    const h = c.req.header(SETUP_HEADER);
    return (h != null && /^(1|true|yes|setup)$/i.test(h.trim())) || c.req.query("from") === "setup";
  } catch { return false; }
}

/** The setup page asked (one log line when it opens after a quiet spell). */
export function noteSetupPoll(): void {
  const now = clock();
  if (!lastPollAt || now - lastPollAt > SETUP_LIVE_MS) {
    console.log(`[setup-live] the wrapper's setup page is open — catalogue and registry rebuilds are held (the copy they have is served) until ${SETUP_LIVE_MS / 60_000} min after its last poll`);
  }
  lastPollAt = now;
}

/** Note it when the request carries the marker; returns whether it did. */
export function noteIfSetup(c: Parameters<typeof isSetupRequest>[0]): boolean {
  const yes = isSetupRequest(c);
  if (yes) noteSetupPoll();
  return yes;
}

/** Was the setup page polling within the last SETUP_LIVE_MS? */
export function setupOpen(): boolean {
  return lastPollAt > 0 && clock() - lastPollAt <= SETUP_LIVE_MS;
}

/**
 * "Live" for the heavy caches (routes/sources.ts: the strategy catalogue, the registry; the answer log's reseed): a poker
 * session is live — the API's own answer (services/sessionLive.ts, what GET /api/load reports) — OR the setup page is
 * open (a session is about to be declared). Never a throw.
 */
export function liveForCaches(): boolean {
  try { return sessionLive() || setupOpen(); } catch { return false; }
}

export function setupState(): { open: boolean; lastPollAt: number | null } {
  return { open: setupOpen(), lastPollAt: lastPollAt || null };
}

/** Tests: forget the last poll and swap the clock. */
export function __resetSetupLive(nowFn?: () => number): void {
  lastPollAt = 0;
  clock = nowFn ?? (() => Date.now());
}
