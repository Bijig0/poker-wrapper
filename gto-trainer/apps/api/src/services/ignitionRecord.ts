/**
 * Ignition's own record of a hand, from a running Poker Wrapper (GET /hh/:id runs the client's hand-history lookup
 * inside the logged-in poker page). Every wrapper drives the same client page, so any of them can answer.
 */
import { DEFAULT_LIVE_URL } from "../feed/resolveHand/resolveHand";
import { studyPollers } from "./studyPoller";

/** not-found: Ignition answered and has no such hand (yet). unreachable: no wrapper, client closed, or the network. */
export type RecordResult =
  | { ok: true; body: unknown; fetchedAt: string | null; cached: boolean }
  | { ok: false; reason: "not-found" | "unreachable"; error: string };

/** Registered wrappers first, then the default. localhost costs 2 s per call on Windows, so 127.0.0.1. */
export const wrapperUrls = (registered: string[]): string[] =>
  [...new Set([...registered, DEFAULT_LIVE_URL].map((u) => u.replace("//localhost:", "//127.0.0.1:").replace(/\/+$/, "")))];

/** A refusal is "not found" only when Ignition itself said 404; a fetch that never got an answer is the network. */
export const refusalOf = (rec: { error?: string; tries?: { status?: number }[] }): RecordResult =>
  ({ ok: false, reason: rec.tries?.some((t) => t.status === 404) ? "not-found" : "unreachable", error: rec.error ?? "no hand history" });

const askWrapper = (base: string, id: string, refresh: boolean): Promise<any | null> =>
  fetch(`${base}/hh/${id}${refresh ? "?refresh=1" : ""}`, { signal: AbortSignal.timeout(60_000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

export async function fetchIgnitionRecord(id: string, opts: { refresh?: boolean; wrappers?: string[] } = {}): Promise<RecordResult> {
  const bases = opts.wrappers ?? wrapperUrls(studyPollers.list().map((p) => p.assistiveUrl));
  for (const base of bases) {
    const rec = await askWrapper(base, id, !!opts.refresh);
    if (rec) return rec.ok ? { ok: true, body: rec.body, fetchedAt: rec.fetchedAt ?? null, cached: !!rec.cached } : refusalOf(rec);
  }
  return { ok: false, reason: "unreachable", error: `no Poker Wrapper answered (${bases.join(", ")}) — start it with the Ignition client signed in` };
}
