/**
 * Every RUNTIME record the API writes or reads, resolved through the one data root (packages/data-root, see
 * gto-trainer/DATA-ROOT-PLAN.md). Nothing in the API may build a runtime path from `import.meta.dir` any more:
 * that is how hand 973's stored chains ended up in a worktree that was later deleted.
 *
 * Tracked reference artifacts (data/preflop-db.sqlite, resolved-charts.json, mes_postflop.json, strategy_matrix.json,
 * river_lock.json, ledger.json …) are versioned with the code and keep their code-relative paths.
 *
 * Functions, not constants, where the store used to read its env var at construction: tests set the override
 * before constructing (answerLog's preload), and the report must show what was actually opened.
 */
import { dirname, join } from "node:path";
import { dataLayout, describeLayout, splitStores, storePath, storeReport, type DataLayout, type StoreEntry } from "../../../../packages/data-root/dataRoot";
import { adoptionReport, centralDbPath, openStore } from "../../../../packages/data-root/centralDb";

export { adoptionReport, centralDbPath, describeLayout, openStore, splitStores, storeReport, dataLayout };
export type { DataLayout, StoreEntry };

/* EVERY SQLITE STORE DEFAULTS TO THE ONE CENTRAL DATABASE (<root>/poker.sqlite, packages/data-root/centralDb.ts): the
   hands the wrapper writes, the answers the poller writes and the chains the solver stores are rows of one file, so the
   dashboard reads the same row the reader wrote. A store-specific env var still points one store elsewhere (tests). */
const central = () => centralDbPath();

const api = (...p: string[]) => join(dataLayout().api, ...p);

/** The folder holding the API's runtime records (answers.sqlite, solves.sqlite, jobs/ …). */
export const apiDataDir = (): string => dataLayout().api;
/** data/jobs: job logs, poller events, the exit log. */
export const jobsDir = (): string => api("jobs");

export const answersDbPath = (): string => storePath("answers", central(), "ANSWERS_DB_PATH").path;
export const solvesDbPath = (): string => storePath("solves", central(), "SOLVES_DB_PATH").path;
export const gtowRequestsPath = (): string => storePath("gtow-requests", central(), "GTOW_REQUESTS_PATH").path;
export const pollerEventsPath = (): string => storePath("poller-events", central(), "POLLER_EVENTS_PATH").path;
export const exitLogPath = (): string => storePath("exit-log", api("jobs", "exit_reason.log")).path;
export const jobsDbPath = (): string => storePath("jobs", central(), "JOBS_DB_PATH").path;
export const missQueueDbPath = (): string => storePath("miss-queue", central(), "MISS_QUEUE_DB_PATH").path;
export const riverMesDbPath = (): string => storePath("river-mes", central(), "RIVER_MES_DB_PATH").path;
export const riverMesConfigPath = (): string => storePath("river-mes-config", api("river_mes_config.json")).path;
export const mesRiverCacheDir = (): string => storePath("mes-river-cache", api("mes_river_cache")).path;
export const tasksPath = (): string => storePath("tasks", api("tasks.json")).path;
export const fxCachePath = (): string => storePath("fx", api("fx.json")).path;
export const balanceAcksPath = (): string => storePath("balance-acks", api("balance-acks.json")).path;
export const backgroundLockPath = (): string => storePath("background-lock", api("background.lock"), "API_BACKGROUND_LOCK").path;

/** services/hhCheck: each archived hand's verdict against Ignition's own hand history. */
export const hhChecksDbPath = (): string => storePath("hh-checks", central(), "HH_CHECKS_DB_PATH").path;

/** The wrapper's archive, read-only from here. */
export const handsDbPath = (): string => storePath("hands", central(), "HANDS_DB_PATH").path;
/** sessions + balances: the central DB, or — when a test points HANDS_DB_PATH at its own file — beside that file */
export const sessionsDbPath = (): string =>
  storePath("sessions", process.env.HANDS_DB_PATH ? join(dirname(handsDbPath()), "sessions.sqlite") : central(), "SESSIONS_DB_PATH").path;
/** chain-ledger hand facts: the central DB for the API worker; scripts and harnesses keep theirs in memory (they replay
 *  the same hand ids hundreds of times and must never read or leave behind the live worker's facts) */
export const handFactsDbPath = (apiWorker: boolean): string =>
  storePath("hand-facts", apiWorker ? central() : ":memory:", "HAND_FACTS_DB_PATH").path;
export const profilesJsonPath = (): string => storePath("profiles.json", join(dataLayout().wrapper, "profiles.json"), "PROFILES_JSON_PATH").path;
/** The wrapper's debug recordings (one folder per session). */
export const wrapperDebugDir = (): string => storePath("wrapper-debug", dataLayout().wrapperDebug, "IGNITION_DEBUG_DIR").path;

/**
 * A store write that failed — never thrown (a record must not cost an answer), never silent either (2026-09-25 audit:
 * the answer log, the chain store and attach() swallowed every failure, so a SQLITE_BUSY past the timeout, a full disk
 * or a column list another session broke lost rows without a trace). One line per store per minute.
 */
const lastWarn = new Map<string, number>();
export function storeWriteFailed(store: string, e: unknown): void {
  const now = Date.now();
  if (now - (lastWarn.get(store) ?? 0) < 60_000) return;
  lastWarn.set(store, now);
  console.error(`[store] ${store} write failed: ${e instanceof Error ? e.message : String(e)}`);
}

/** Every store above, resolved now — for the start-up line, GET /api/dashboard/storage and the live split guard. */
export function resolveAllStores(): StoreEntry[] {
  for (const f of [centralDbPath, answersDbPath, solvesDbPath, gtowRequestsPath, pollerEventsPath, exitLogPath, jobsDbPath, missQueueDbPath,
    riverMesDbPath, riverMesConfigPath, mesRiverCacheDir, tasksPath, fxCachePath, balanceAcksPath, backgroundLockPath,
    handsDbPath, sessionsDbPath, profilesJsonPath, wrapperDebugDir, hhChecksDbPath]) f();
  return storeReport();
}
