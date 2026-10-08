/**
 * AN AUTH FAILURE IS NOT A VERDICT ON THE LINE (2026-10-08) — the pure half: which GTO Wizard replies say "this token"
 * rather than "this query". No imports, so the solve cache, the request ledger and the session pool can all ask it.
 *
 * Why: the core stress re-run (2026-10-08 10:02-10:03Z, origin stress500-core) got
 *   400 {"code": "VALIDATION_ERROR", "detail": "Invalid API Key", "data": {"detail": "Invalid API Key"}}
 * on spot-solution polls while the Ultra account's token was being rotated — the tree and solution POSTs on either side
 * of it answered 200/201 with the same token, and the same solve's root answered 200 twelve seconds later. The node poll
 * read every 400 as GTO Wizard's deterministic verdict on the line (NODE_DOES_NOT_EXIST, "Incorrect actions") and gave
 * the decision up: three decisions with no answer. The code is VALIDATION_ERROR, so the solve cache's own refusal test
 * (DETERMINISTIC_REFUSAL) matched it too — only the postflop poll's habit of never storing a 400 kept it out of the store.
 *
 * The bodies the line refusals really carry (the live solve cache's 411 stored refusals, 2026-10-08): 400
 * NODE_DOES_NOT_EXIST "The node in the actions doesn't exists", 400 VALIDATION_ERROR "Incorrect actions", 422
 * VALIDATION_ERROR "Engine validation failed" / "Preflop: Only effective stacks up to 250bb are supported". None of them
 * speaks of a key, a token, credentials or authorization, which is what this tests.
 */

/** the words of an auth refusal (GTO Wizard's own "Invalid API Key", and the usual DRF / JWT phrasings) */
export const AUTH_FAILURE_BODY =
  /invalid api key|invalid (?:access )?token|token (?:is )?(?:invalid|expired|not valid)|token_not_valid|expired token|signature (?:has )?expired|not[_ ]authenticated|authentication credentials|unauthori[sz]ed/i;

/** the statuses an auth refusal comes with: a 401 always is one; a 400 or 403 is one when its body says so */
export const AUTH_STATUSES: ReadonlySet<number> = new Set([400, 401, 403]);

/** True when GTO Wizard refused the request's TOKEN, not its query — never a fact about a tree or a line. */
export function isAuthFailure(status: number, body: string | null | undefined): boolean {
  if (status === 401) return true;
  if (!AUTH_STATUSES.has(status)) return false;
  return AUTH_FAILURE_BODY.test(body ?? "");
}

/** GTO Wizard's words for a refusal, without its code: `detail` (or `data.detail`), else the body's start. The code is
 *  left out on purpose — "VALIDATION_ERROR" in a reason would read as a refusal of the tree downstream. */
export function refusalDetail(body: string | null | undefined): string {
  const b = (body ?? "").trim();
  try {
    const j = JSON.parse(b);
    const d = typeof j?.detail === "string" ? j.detail : typeof j?.data?.detail === "string" ? j.data.detail : null;
    if (d) return d.slice(0, 80);
  } catch { /* not JSON */ }
  return b.replace(/VALIDATION_ERROR|NODE_DOES_NOT_EXIST/g, "").slice(0, 80) || "(no body)";
}

/** The request ledger's note on a row (gtow_requests.nt). The status stays what GTO Wizard sent; the note says what it
 *  was: `auth` an auth refusal, `auth-retry` the same request sent again after the token refresh and NOT refused for
 *  auth (whatever else it answered), `auth-twice` that retry refused for auth again. Auth refusals = auth + auth-twice. */
export const NT_AUTH = "auth";
export const NT_AUTH_RETRY = "auth-retry";
export const NT_AUTH_TWICE = "auth-twice";

/** The ledger note for one response: what the caller tagged it (`auth-retry` on the retry) and whether it was refused
 *  for auth. */
export function authNote(status: number, body: string | null | undefined, tagged?: string | null): string | null {
  const refused = isAuthFailure(status, body);
  if (tagged === NT_AUTH_RETRY) return refused ? NT_AUTH_TWICE : NT_AUTH_RETRY;
  return refused ? NT_AUTH : tagged ?? null;
}
