/**
 * THE PRESENCE KEEPER (session setup `keepPresent`, ON unless switched off — Brady 2026-10-09: "when auto execute
 * is doing its thing the laptop isn't marked as idle … just correctly set the state as what it is").
 *
 * Windows calls the machine idle when no keyboard or mouse input has arrived for a few minutes, and on that word it
 * runs Automatic Maintenance (the SSD retrim, Disk Cleanup, the search indexer, component cleanup, chkdsk), the
 * idle-only Defender scan and the idle-triggered updaters. An unattended auto-play session looks exactly like an idle
 * machine. On 2026-10-09 10:38 that burst starved the disk: the study API's event loop blocked 45-56 s at a time,
 * both tables timed out, hero was sat out and removed, the session ended "lost the poker server".
 *
 * So while a session is live this module tells Windows the truth — someone is here: every PRESENCE_EVERY_S it injects
 * ONE mouse event with zero movement (SendInput, MOUSEEVENTF_MOVE with dx = dy = 0). The cursor does not move, no
 * window receives a click or a key, but the last-input clock Windows reads (GetLastInputInfo) restarts, so the
 * machine is never idle for the maintenance scheduler, the screen stays on and the laptop does not sleep. The event
 * goes under the press lock so it can never land between a real-input move and its click (CoinPoker, cpActions.ts).
 * Only the LEADER wrapper sends (one event per machine, not one per table); never in fake mode; off outside a session.
 *
 * What it does NOT do: it does not stop maintenance that is already running, and it does not replace
 * scripts/disable_idle_maintenance.ps1 in the poker repo while this is unproven. First nudge and any failure are a
 * `presence-keeper` session event; the count is on /state (study.presenceCount).
 */
import { nowMs, time } from "./clock";
import { feedAdd, log } from "./feed";
import { S } from "./state";
import * as TABLES from "./tables";
import * as W from "./win32";

/** Seconds between nudges. Windows' idle threshold for maintenance is minutes; the screen-saver minimum is 60 s. */
export const PRESENCE_EVERY_S = 50;
/** Nudges that threw in a row before the keeper gives up for the session and says so. */
export const PRESENCE_MAX_FAILS = 3;

const MOUSEEVENTF_MOVE = 0x0001;

/** The one real-input event: a mouse move of nothing, under the press lock. */
async function nudgeWindows(): Promise<void> {
  const lk = await TABLES.pressLock();
  try {
    W.sendMouseFlags(MOUSEEVENTF_MOVE);
  } finally {
    lk.release();
  }
}

/** Seams for the unit test: the input itself and who the leader is. */
export const presenceSeams = {
  nudge: (): Promise<void> => nudgeWindows(),
  isLeader: (): boolean => TABLES.isLeader(),
};

/** From the feed loop, every tick. */
export async function maybeKeepPresent(): Promise<void> {
  const st = S.study;
  if (!st.keepPresent || !S.session.id || S.fakeMode || st.presenceFails >= PRESENCE_MAX_FAILS) return;
  if (!presenceSeams.isLeader()) return;
  const now = time();
  if (st.presenceAt && now - st.presenceAt < PRESENCE_EVERY_S) return;
  st.presenceAt = now;
  try {
    await presenceSeams.nudge();
    st.presenceCount += 1;
    st.presenceFails = 0;
    if (st.presenceCount === 1) {
      log(`[presence] keeping Windows out of idle: a zero-movement mouse event every ${PRESENCE_EVERY_S} s while the session is live`);
      feedAdd("Presence keeper on — Windows will not call this machine idle while the session runs");
      S.sessions.event(S.session.id, "presence-keeper", { at: nowMs(), hand: S.handNo, ok: true, everyS: PRESENCE_EVERY_S });
    }
  } catch (e: any) {
    st.presenceFails += 1;
    const why = e?.message ?? String(e);
    log(`[presence] nudge failed (${st.presenceFails}/${PRESENCE_MAX_FAILS}): ${why}`);
    if (st.presenceFails >= PRESENCE_MAX_FAILS) {
      feedAdd(`Presence keeper gave up after ${PRESENCE_MAX_FAILS} failures (${why}) — Windows may call the machine idle`);
      S.sessions.event(S.session.id, "presence-keeper", { at: nowMs(), hand: S.handNo, ok: false, gaveUp: true, reason: why });
    }
  }
}
