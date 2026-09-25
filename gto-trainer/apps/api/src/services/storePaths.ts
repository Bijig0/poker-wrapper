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

export { describeLayout, splitStores, storeReport, dataLayout };
export type { DataLayout, StoreEntry };

const api = (...p: string[]) => join(dataLayout().api, ...p);

/** The folder holding the API's runtime records (answers.sqlite, solves.sqlite, jobs/ …). */
export const apiDataDir = (): string => dataLayout().api;
/** data/jobs: job logs, poller events, the exit log. */
export const jobsDir = (): string => api("jobs");

export const answersDbPath = (): string => storePath("answers", api("answers.sqlite"), "ANSWERS_DB_PATH").path;
export const solvesDbPath = (): string => storePath("solves", api("solves.sqlite"), "SOLVES_DB_PATH").path;
export const gtowRequestsPath = (): string => storePath("gtow-requests", api("gtow_requests.jsonl"), "GTOW_REQUESTS_PATH").path;
export const pollerEventsPath = (): string => storePath("poller-events", api("jobs", "poller-events.jsonl")).path;
export const exitLogPath = (): string => storePath("exit-log", api("jobs", "exit_reason.log")).path;
export const jobsDbPath = (): string => storePath("jobs", api("jobs.sqlite")).path;
export const missQueueDbPath = (): string => storePath("miss-queue", api("miss-queue.sqlite")).path;
export const riverMesDbPath = (): string => storePath("river-mes", api("river_mes.sqlite")).path;
export const riverMesConfigPath = (): string => storePath("river-mes-config", api("river_mes_config.json")).path;
export const mesRiverCacheDir = (): string => storePath("mes-river-cache", api("mes_river_cache")).path;
export const tasksPath = (): string => storePath("tasks", api("tasks.json")).path;
export const fxCachePath = (): string => storePath("fx", api("fx.json")).path;
export const balanceAcksPath = (): string => storePath("balance-acks", api("balance-acks.json")).path;
export const backgroundLockPath = (): string => storePath("background-lock", api("background.lock"), "API_BACKGROUND_LOCK").path;

/** The wrapper's archive, read-only from here. */
export const handsDbPath = (): string => storePath("hands.db", join(dataLayout().wrapper, "hands.db"), "HANDS_DB_PATH").path;
export const sessionsDbPath = (): string => storePath("sessions.sqlite", join(dirname(handsDbPath()), "sessions.sqlite"), "SESSIONS_DB_PATH").path;
export const profilesJsonPath = (): string => storePath("profiles.json", join(dirname(handsDbPath()), "profiles.json"), "PROFILES_JSON_PATH").path;
/** The wrapper's debug recordings (one folder per session). */
export const wrapperDebugDir = (): string => storePath("wrapper-debug", dataLayout().wrapperDebug, "IGNITION_DEBUG_DIR").path;

/** Every store above, resolved now — for the start-up line, GET /api/dashboard/storage and the live split guard. */
export function resolveAllStores(): StoreEntry[] {
  for (const f of [answersDbPath, solvesDbPath, gtowRequestsPath, pollerEventsPath, exitLogPath, jobsDbPath, missQueueDbPath,
    riverMesDbPath, riverMesConfigPath, mesRiverCacheDir, tasksPath, fxCachePath, balanceAcksPath, backgroundLockPath,
    handsDbPath, sessionsDbPath, profilesJsonPath, wrapperDebugDir]) f();
  return storeReport();
}
