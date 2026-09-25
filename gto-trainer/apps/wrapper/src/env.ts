/**
 * Where things are. The wrapper's PAGES and CONFIG (panel.html, setup.html, formats.json, assets/) are code and stay
 * in <this checkout>/ignition-study-wrapper. Its RECORDS go through the one data root (packages/data-root, see
 * gto-trainer/DATA-ROOT-PLAN.md): hands, sessions and balances are tables of the central poker.sqlite that the API
 * reads the same rows from; profiles.json, hand-history caches, table claims and debug recordings sit in the root's
 * wrapper folders — the main checkout's ignition-study-wrapper/data and /debug unless POKER_DATA_DIR says otherwise.
 * The browsers' --user-data-dir folders (`profiles`) stay beside the pages.
 *
 * Sandboxes: WRAPPER_ROOT (a temp copy of the pages), WRAPPER_DATA_DIR / WRAPPER_DEBUG_DIR / WRAPPER_PROFILE_DIR
 * (tests, the contract suite, replay tools) put the state in that folder instead — hands.db and sessions.sqlite as
 * their own files there, exactly as before — so a sandbox never reads or writes the live records.
 */
import { resolve, join } from "node:path";
import { dataLayout } from "../../../packages/data-root/dataRoot";
import { centralDbPath } from "../../../packages/data-root/centralDb";

export const REPO = resolve(import.meta.dir, "../../../..");

export function paths() {
  const env = process.env;
  const root = env.WRAPPER_ROOT ? resolve(env.WRAPPER_ROOT) : join(REPO, "ignition-study-wrapper");
  const L = dataLayout();
  const data = env.WRAPPER_DATA_DIR ? resolve(env.WRAPPER_DATA_DIR) : env.WRAPPER_ROOT ? join(root, "data") : L.wrapper;
  const debug = env.WRAPPER_DEBUG_DIR ? resolve(env.WRAPPER_DEBUG_DIR) : env.WRAPPER_ROOT ? join(root, "debug") : L.wrapperDebug;
  const profiles = env.WRAPPER_PROFILE_DIR ? resolve(env.WRAPPER_PROFILE_DIR) : root;
  const sandboxed = !!(env.WRAPPER_DATA_DIR || env.WRAPPER_ROOT);
  const central = sandboxed ? null : centralDbPath();
  return {
    repo: REPO, root, data, debug, profiles, assets: join(root, "assets"),
    /** the hands table: the central DB, or <data>/hands.db in a sandbox */
    handsDb: central ?? join(data, "hands.db"),
    /** the sessions + balances tables: the central DB, or <data>/sessions.sqlite in a sandbox */
    sessionsDb: central ?? join(data, "sessions.sqlite"),
  };
}
