import { AsyncLocalStorage } from "node:async_hooks";
import type { GtowRequestKind } from "./gtowRequestLog";

/**
 * WHICH HAND A GTO WIZARD REQUEST WAS FOR (2026-09-25, the chain ledger). The request ledger (gtowRequestLog) counted
 * requests per account and per process and nothing else, so "how many requests did this hand cost" had no answer —
 * and that number is exactly what separates a hand that walked the happy path (one tree per street, every earlier
 * street reused) from one that re-built its ranges or re-created a tree. fastSolve opens a scope per call (a live
 * decision, a warm-up, a replay) and every request made inside it — a tree, a solution, a poll — is counted on it.
 *
 * AsyncLocalStorage, like answerTrace: several tables solve at once and each request must land on its own hand. A
 * request another call already had in flight (gtowApi's pending maps) is counted once, by the call that sent it.
 * Outside a scope nothing is counted — scripts and probes are unaffected.
 */
export interface RequestCounts { tree: number; solution: number; poll: number; library: number; other: number; failed: number }

export interface RequestScope {
  /** the hand the call is for (clientHandId, else the wrapper's hand number) */
  handKey: string;
  /** who is asking: "live" (the poller), "warm" (the street warm-up), "replay", … */
  origin: string;
  street: string | null;
  counts: RequestCounts;
}

const als = new AsyncLocalStorage<RequestScope>();

export const emptyCounts = (): RequestCounts => ({ tree: 0, solution: 0, poll: 0, library: 0, other: 0, failed: 0 });
export const totalRequests = (c: RequestCounts): number => c.tree + c.solution + c.poll + c.library + c.other;

/** Run `fn` with every GTO Wizard request it makes counted on a fresh scope; the scope comes back with the result. */
export async function withRequestScope<T>(s: Omit<RequestScope, "counts">, fn: () => Promise<T>): Promise<{ value: T; scope: RequestScope }> {
  const scope: RequestScope = { ...s, counts: emptyCounts() };
  const value = await als.run(scope, fn);
  return { value, scope };
}

export const currentRequestScope = (): RequestScope | undefined => als.getStore();

/** Called by gtowRequestLog for every request that reached GTO Wizard. */
export function countRequest(kind: GtowRequestKind, status: number): void {
  const s = als.getStore();
  if (!s) return;
  s.counts[kind]++;
  if (status === 0 || status >= 400) s.counts.failed++;
}
