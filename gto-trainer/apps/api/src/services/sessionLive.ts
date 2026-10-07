import { sessionsStore } from "./sessionsStore";
import { liveBusy } from "./livePriority";
import { step } from "./answerTrace";

/**
 * IS A POKER SESSION LIVE — the cheap answer (2026-10-07). Bookkeeping ticks (services/answerReconciler.ts) must not
 * run while hands are being answered, and GET /api/load reports it, so both read THIS: a value in memory, refreshed at
 * most once a minute (or every load-sampler tick, services/machineLoad.ts) by one query on the sessions table — a
 * declared session with no ended_at, the same rule replayGate.ts and the study scripts use. Never on the answer path.
 *
 * A live answer computed within the last minute (services/livePriority.ts) also counts: the table is being played
 * whatever the sessions table says. A store that cannot be read keeps the last value it had.
 */
export const SESSION_LIVE_MAX_AGE_MS = 60_000;
/** an answer this recent means the table is live */
export const LIVE_ANSWER_MS = 60_000;

interface State { id: string | null; checkedAt: number }
let state: State = { id: null, checkedAt: 0 };
let reader: () => string | null | undefined = () => sessionsStore.liveId();
let clock: () => number = () => Date.now();

/** Read the sessions table now (one small query) and remember the answer. */
export function refreshSessionLive(): State {
  const id = step("sessions live read", () => { try { return reader(); } catch { return undefined; } });
  state = { id: id === undefined ? state.id : id, checkedAt: clock() };
  return state;
}

/** Is a session live? Re-reads the table when the remembered answer is older than `maxAgeMs`. */
export function sessionLive(maxAgeMs = SESSION_LIVE_MAX_AGE_MS): boolean {
  if (clock() - state.checkedAt > maxAgeMs) refreshSessionLive();
  return state.id != null || liveBusy(LIVE_ANSWER_MS);
}

/** Memory only — never touches the store (GET /api/load). */
export function sessionLiveCached(): { live: boolean; id: string | null; checkedAt: number | null } {
  return { live: state.id != null || liveBusy(LIVE_ANSWER_MS), id: state.id, checkedAt: state.checkedAt || null };
}

/** Test hook: replace the table read and the clock; forget the remembered answer. */
export function __setSessionLiveReader(fn: () => string | null | undefined, now?: () => number): void {
  reader = fn;
  clock = now ?? (() => Date.now());
  state = { id: null, checkedAt: 0 };
}
