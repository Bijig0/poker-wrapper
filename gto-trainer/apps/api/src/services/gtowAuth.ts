/**
 * AN AUTH REFUSAL GETS ONE TOKEN REFRESH AND ONE RETRY OF THE SAME REQUEST (2026-10-08).
 *
 * The core stress re-run (2026-10-08 10:02-10:03Z) got `400 {"code": "VALIDATION_ERROR", "detail": "Invalid API Key"}`
 * on spot-solution polls while the Ultra account's token was being rotated, and the node poll took it for GTO Wizard's
 * verdict on the line: three decisions with no answer (core-srp-bb-002 turn + river, core-srp-pfr-oop-003 river). Live,
 * that is a fold-on-no-answer for a token hiccup. Now every request the answer path sends to GTO Wizard — tree and
 * solution POSTs, node locks, library reads and node polls, preflop and postflop — goes through `sendWithAuthRetry`:
 *
 *   - a reply services/gtowAuthBody calls an auth refusal (a 401; a 400 / 403 whose body speaks of the key, the token,
 *     credentials or authorization) asks the pool for a fresh token (gtowSessions.refreshAfterAuthFailure: the token
 *     another caller already replaced it with, else one CDP read, shared, within the caller's budget) and sends the SAME
 *     request once more with it;
 *   - refused for auth again, or no token in time, the caller fails the request with `authFailedReason` — "GTO Wizard
 *     auth failed twice (token rotation)" — and the decision takes the normal no-answer path. It is never a line
 *     verdict: nothing of it reaches the solve cache (gtowSolveCache.putNode refuses an auth body outright), and the
 *     reason carries GTO Wizard's words without its VALIDATION_ERROR code, which downstream would read as a refusal of
 *     the tree;
 *   - api.log gets one `[gtow-auth]` line per round (account, request kind, the refresh's time, the retry's outcome), the
 *     answer trace a mark, and the request ledger notes the rows (gtow_requests.nt: auth / auth-retry / auth-twice).
 *
 * THE CLOCK: the refresh is a CDP read of the client's token — instant when another caller already has the new one, a
 * passive wait for the client's own traffic (up to 3.5 s) and then a Page.reload otherwise. It is bounded by the
 * caller's budget (a node poll: its deadline less a second for the retry; a POST: GTOW_AUTH_REFRESH_MS, default 6 s),
 * and a refresh slower than AUTH_SLOW_MS is named in the reason and the log line.
 */
import { tmark } from "./answerTrace";
import { AUTH_STATUSES, isAuthFailure, NT_AUTH_RETRY, refusalDetail } from "./gtowAuthBody";
import { gtowSessions, type AuthRefresh, type GtowSessionId } from "./gtowSessions";

/** the longest a POST waits for a fresh token (a node poll is held to its own deadline as well) */
export const authRefreshBudgetMs = (): number => Number(process.env.GTOW_AUTH_REFRESH_MS ?? 6_000);
/** a refresh slower than this is named in the reason ("the token refresh took 4.1 s") */
export const AUTH_SLOW_MS = 2_000;
/** what a node poll keeps back from its deadline for the retry itself */
export const AUTH_RETRY_RESERVE_MS = 1_000;

/** One auth round, as the reason and the log line tell it. */
export interface AuthRound {
  session: GtowSessionId | null;
  kind: string;
  /** the refused request's status and GTO Wizard's words (no code) */
  status: number;
  detail: string;
  refresh: AuthRefresh;
  budgetMs: number;
  /** the retry's status — null when there was no token to retry with */
  retryStatus: number | null;
  /** the retry got past auth (whatever else it answered) */
  recovered: boolean;
}

/** The decision's reason when an auth round did not recover. Begins "GTO Wizard auth failed" (answerLog's failKind). */
export function authFailedReason(a: AuthRound): string {
  const who = a.session ?? "the GTO Wizard session";
  const slow = a.refresh.ms > AUTH_SLOW_MS ? ` · the token refresh took ${(a.refresh.ms / 1000).toFixed(1)} s` : "";
  if (a.retryStatus != null) {
    return `GTO Wizard auth failed twice (token rotation): ${a.kind} ${a.status} "${a.detail}" on ${who}, and the retry with a refreshed token ` +
      `(${a.refresh.same ? "the same token came back" : "a new token"}) was refused too (${a.retryStatus})${slow}`;
  }
  const why = a.refresh.timedOut && a.budgetMs <= 0 ? "no time left on this request's clock for a token refresh"
    : a.refresh.timedOut ? `the token refresh did not finish within ${(a.budgetMs / 1000).toFixed(1)} s`
    : "the token refresh found no token (is the client signed in?)";
  return `GTO Wizard auth failed (token rotation): ${a.kind} ${a.status} "${a.detail}" on ${who}, not retried — ${why}${slow}`;
}

function logRound(a: AuthRound): void {
  const ref = a.refresh.token ? `token refresh ${(a.refresh.ms / 1000).toFixed(1)} s (${a.refresh.same ? "same token back" : "new token"})`
    : a.refresh.timedOut ? `no token within ${(a.budgetMs / 1000).toFixed(1)} s` : `no token (${(a.refresh.ms / 1000).toFixed(1)} s)`;
  const out = a.retryStatus == null ? "not retried" : a.recovered ? `retry HTTP ${a.retryStatus}: recovered` : `retry HTTP ${a.retryStatus}: auth failed twice`;
  const line = `${a.session ?? "?"} ${a.kind} ${a.status} "${a.detail}" -> ${ref} -> ${out}${a.refresh.ms > AUTH_SLOW_MS ? " (slow refresh)" : ""}`;
  console.log(`[gtow-auth] ${line}`);
  tmark(`GTO Wizard auth refusal (${a.kind})`, line);
}

/**
 * Send a request; on an auth refusal, refresh the token once and send the SAME request again (`send(token, true)` — the
 * retry is tagged for the ledger by the caller's send). Returns the response to act on (the retry's when there was one)
 * and, when an auth refusal happened, the round. `auth` set and `auth.recovered` false = the caller fails the request
 * with authFailedReason(auth). A throw from `send` propagates (the caller's network handling stays its own).
 */
export async function sendWithAuthRetry(
  session: GtowSessionId | null,
  kind: string,
  token: string,
  send: (token: string, retry: boolean) => Promise<Response>,
  budgetMs: number = authRefreshBudgetMs(),
): Promise<{ res: Response; auth: AuthRound | null; token: string }> {
  const first = await send(token, false);
  if (!AUTH_STATUSES.has(first.status)) return { res: first, auth: null, token };
  const body = await first.clone().text().catch(() => "");
  if (!isAuthFailure(first.status, body)) return { res: first, auth: null, token };
  const budget = Math.max(0, budgetMs);
  const refresh = await gtowSessions.refreshAfterAuthFailure(session, token, budget);
  const round: AuthRound = { session: refresh.session ?? session, kind, status: first.status, detail: refusalDetail(body), refresh,
    budgetMs: budget, retryStatus: null, recovered: false };
  if (!refresh.token) { logRound(round); return { res: first, auth: round, token }; }
  const again = await send(refresh.token, true);
  round.retryStatus = again.status;
  const againBody = AUTH_STATUSES.has(again.status) ? await again.clone().text().catch(() => "") : "";
  round.recovered = !isAuthFailure(again.status, againBody);
  logRound(round);
  return { res: again, auth: round, token: refresh.token };
}

export { NT_AUTH_RETRY };
