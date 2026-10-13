/**
 * IS THIS WRAPPER RUNNING THE CODE ON DISK (2026-10-03).
 *
 * Launching the wrapper replaces the running instance, so a fresh launch is always the code on disk — but a wrapper
 * left open between sessions keeps the code it started with while fixes are merged, and nothing said so. The stamp is
 * the files this process loaded (the API's services/loadedCode.ts: the import graph from main.ts plus the src/js
 * snippets, which are read once and kept), taken when this module is imported, before the server answers.
 *
 *   GET  /build           this process: commit, booted, stale files, and whether the change is committed
 *   GET  /build/all       the whole install — API, chart server, wrapper tables, supervisors (services/liveStatus.ts)
 *   POST /build/relaunch  start the launcher again; the new instance replaces this one (refused during a session)
 *
 * THE WRAPPER RELAUNCHES ITSELF (2026-10-13). Nothing supervises it, and for ten days "WRAPPER RELAUNCH OWED" was the
 * most common line in the owner's notes: a wrapper left open between sessions ran the code it started with while
 * fixes were merged (on 10-13 :7700 was 6 h and 14 committed files behind). Now the first table's process runs the
 * API's own decision (services/autoRestart.ts) every SELF_UPDATE_TICK_MS, and its "exit" is a QUIET relaunch — the new
 * instance takes over without moving, showing or focusing a window and without opening the table window — when:
 *   - a COMMITTED change to a file it loaded is quiet 20 s, or config/local.env changed (read once at start);
 *   - no session is running, it is the first table, nothing was done on its pages for USER_QUIET_MS;
 *   - the code on disk builds (the boot check), and it relaunched itself no less than RELAUNCH_GAP_MS ago;
 *   - not the test rig (--fake) and not a sandbox without the launcher. WRAPPER_SELF_UPDATE=off reports only.
 * And a session never starts on old code: Start on a behind wrapper relaunches it first (session.ts sessionStart).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AutoRestart } from "../../api/src/services/autoRestart";
import { liveStatus, type LiveStatus, type ServiceBuild } from "../../api/src/services/liveStatus";
import { LoadedCode } from "../../api/src/services/loadedCode";
import { C, DEBUG_DIR } from "./config";
import { REPO } from "./env";
import { log } from "./feed";
import { S } from "./state";
import * as TABLES from "./tables";
import * as W from "./win32";

export const wrapperCode = new LoadedCode({ entry: join(import.meta.dir, "main.ts"), extra: [join(import.meta.dir, "js")] });

export const SELF_UPDATE_TICK_MS = 30_000;
export const USER_QUIET_MS = 2 * 60_000;
export const RELAUNCH_GAP_MS = 5 * 60_000;
/** the launcher's argument that marks a relaunch the wrapper did by itself: no window is moved, shown or opened */
export const QUIET_ARG = "--quiet-relaunch";

/** When a person last DID something on this wrapper's pages (any request but a GET), from server.ts. */
let lastUserActionAt = 0;
/** true while Start asks (behindForStart): Start is itself a click on the page, and a person pressing it is no loop —
 *  neither the click guard nor the relaunch gap holds it */
let forStart = false;
export function noteUserAction(now = Date.now()): void { lastUserActionAt = now; }
/** When a person last did something on these pages (tests). */
export const userActionAt = (): number => lastUserActionAt;

/** config/local.env as main.ts read it at start (the launcher reads it once): a change needs a relaunch too. */
const LOCAL_ENV = join(REPO, "config", "local.env");
const envHash = (): string => { try { return createHash("sha1").update(readFileSync(LOCAL_ENV)).digest("hex"); } catch { return "none"; } };
const envAtStart = envHash();

/** Does this wrapper relaunch itself? The first table of a real install, unless WRAPPER_SELF_UPDATE=off. */
export function selfUpdates(o: { fake?: boolean; slot?: number | null; launcherExists?: boolean; env?: NodeJS.ProcessEnv } = {}): boolean {
  const env = o.env ?? process.env;
  if (/^(off|0|false|no)$/i.test((env.WRAPPER_SELF_UPDATE ?? "").trim())) return false;
  if (o.fake ?? (C.FAKE_RIG || S.fakeMode)) return false;
  if ((o.slot !== undefined ? o.slot : TABLES.slot()) !== null) return false;
  return o.launcherExists ?? existsSync(launcher());
}

/** Why not now, or null — pure, for the tests. */
export function selfUpdateHold(x: { sessionId: string | null; now: number; lastUserActionAt: number; lastRelaunchAt: number }): string | null {
  if (x.sessionId) return `a session is running (${x.sessionId}) — it keeps the code it started with; the wrapper relaunches when it ends`;
  if (x.now - x.lastUserActionAt < USER_QUIET_MS) return `its pages were used ${Math.round((x.now - x.lastUserActionAt) / 1000)} s ago`;
  if (x.now - x.lastRelaunchAt < RELAUNCH_GAP_MS) return `it relaunched itself ${Math.round((x.now - x.lastRelaunchAt) / 1000)} s ago — at most one every ${RELAUNCH_GAP_MS / 60_000} min`;
  return null;
}

/** When this install's wrapper last relaunched itself (in the debug dir beside last-start.txt: it outlives the process). */
const RELAUNCH_MARK = () => join(DEBUG_DIR(), "last-self-relaunch.txt");
function lastSelfRelaunch(): number { try { return Number(readFileSync(RELAUNCH_MARK(), "utf8").trim()) || 0; } catch { return 0; } }

const auto = new AutoRestart({
  code: wrapperCode,
  name: "wrapper",
  supervised: () => selfUpdates(),
  busy: async () => selfUpdateHold({ sessionId: S.session.id ?? null, now: Date.now(), lastUserActionAt: forStart ? 0 : lastUserActionAt, lastRelaunchAt: forStart ? 0 : lastSelfRelaunch() }),
  byHand: "relaunch the Poker Wrapper to load it (its shortcut, or Relaunch on the setup page) — a session in progress keeps the code it started with",
  // the wrapper's "exit" is a quiet relaunch: the new instance replaces this one (app.ts takeover)
  exit: () => quietRelaunch("a committed change to the code it loaded"),
  log,
});

/** Relaunch quietly for `why`; false when it could not start (the decision is then held and tried again). */
function quietRelaunch(why: string): boolean {
  const [code] = relaunch({ quiet: true, why });
  if (code !== 200) return false;
  try { writeFileSync(RELAUNCH_MARK(), String(Date.now())); } catch { /* the gap guard only */ }
  return true;
}

let timer: ReturnType<typeof setInterval> | null = null;
let envChangedAt = 0;
/** Start the self-update tick (app.ts, once the server is up). */
export function startSelfUpdate(): void {
  if (timer || !selfUpdates()) return;
  log(`[build] this wrapper relaunches itself (quietly, between sessions) when a committed change to its code or config/local.env lands`);
  timer = setInterval(() => { void selfUpdateTick(); }, SELF_UPDATE_TICK_MS);
  (timer as { unref?: () => void }).unref?.();
}

async function selfUpdateTick(): Promise<void> {
  try {
    // config/local.env first: the launcher read it once; the code check does not see it (it is not committed code)
    if (envHash() !== envAtStart) {
      envChangedAt ||= Date.now();
      const hold = Date.now() - envChangedAt < 20_000 ? "settling"
        : selfUpdateHold({ sessionId: S.session.id ?? null, now: Date.now(), lastUserActionAt, lastRelaunchAt: lastSelfRelaunch() });
      if (!hold) { log("[build] config/local.env changed since this wrapper started — relaunching quietly to read it"); quietRelaunch("config/local.env changed"); }
      return;
    }
    await auto.tick();
  } catch (e: any) {
    log(`[build] self-update check failed: ${e?.message ?? e}`);
  }
}

/** Is this wrapper behind a committed change it would relaunch for? (session.ts: never start a session on old code) */
export async function behindForStart(): Promise<string | null> {
  if (!selfUpdates()) return null;
  forStart = true;
  try {
    const st = await auto.tick();   // no session yet: the tick may relaunch right here, which is what Start wants
    return st.state === "restarting" ? st.why : null;
  } finally { forStart = false; }
}

export async function buildReply(force = false): Promise<ServiceBuild> {
  const status = wrapperCode.status(force);
  // the self-update tick decides; a wrapper that does not update itself (the rig, an extra table) is asked here
  const a = selfUpdates() && auto.status().checkedAt ? auto.status() : await auto.tick();
  return { ok: true, service: TABLES.slot() !== null ? `wrapper table ${TABLES.slot()}` : "wrapper", ...status, supervised: selfUpdates(), auto: a };
}

export async function buildAll(): Promise<LiveStatus & { ok: true; sessionActive: boolean }> {
  // this wrapper hands in its own line: on a rig or a second site's panel port it is "this one", not the install's :7700
  return { ok: true, sessionActive: !!S.session.rec, ...(await liveStatus({ port: C.PANEL_PORT, build: await buildReply(true) })) };
}

/** The launcher the desktop shortcut runs; a sandboxed copy of the pages (WRAPPER_ROOT, the tests) has none. */
const launcher = () => join(C.ROOT, "run-wrapper.vbs");

/** Start the launcher with this process's own arguments. The new instance asks this one to stand down (app.ts takeover).
 *  `quiet`: the wrapper relaunching itself — the new instance leaves every window as it is (app.ts). */
export function relaunch(o: { quiet?: boolean; why?: string } = {}): [number, Record<string, any>] {
  if (S.session.rec) return [409, { ok: false, why: "a session is running — end it first; it keeps the code it started with" }];
  if (TABLES.slot() !== null) return [409, { ok: false, why: "this is an extra table's process — relaunch the wrapper from its first table" }];
  if (!existsSync(launcher())) return [409, { ok: false, why: `no launcher at ${launcher()}` }];
  const args = [...process.argv.slice(2).filter((a) => a !== QUIET_ARG), ...(o.quiet ? [QUIET_ARG] : [])];
  log(`[build] ${o.quiet ? `relaunching itself quietly (${o.why ?? "new code"})` : "relaunch asked"} — starting ${launcher()} ${args.join(" ")}; the new instance replaces this one`);
  const wscript = join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const pid = W.startDetached(wscript, [launcher(), ...args], { cwd: C.ROOT, hide: true }, log);
  return pid ? [200, { ok: true, relaunching: true }] : [500, { ok: false, why: "the launcher could not be started" }];
}
