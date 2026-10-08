/**
 * THE CONNECTION GUARD (launch.py 2026-09-22, Brady: "if the connection drops below a threshold, mandatory sit out
 * next hand"). Answers are chains of GTO Wizard requests, so a bad link makes them 25 s late, and on the river not
 * there at all. Every NET_PROBE_EVERY_S while a session that answers runs, netcheck probes the path the answers
 * take; NET_BAD_TO_SITOUT bad probes IN A ROW tick "Sit out next hand" on OUR table AND END THE SESSION (Brady,
 * 2026-09-25: "do not sit back after a connection drop, just end the session"): S.net.drop is set here, and
 * session.ts maybeEndForNetDrop ends it when the hand in play is over (a follower hands it to the leader). A link
 * that comes back does not undo it, and nothing sits hero back in (sitback.ts stands aside while a drop is noted).
 */
import { sleep, time } from "./clock";
import { C } from "./config";
import { feedAdd, log } from "./feed";
import * as NC from "./netcheck";
import { pyRepr, pyStr } from "./py";
import { CGG, CP, S, isCgg, isCp } from "./state";
import * as TABLES from "./tables";
import { netClickedBefore, tickSitoutBox } from "./sitoutBox";

export const NET_BAD_TO_SITOUT = 2;
export const NET_GOOD_TO_CLEAR = 2;

/** Tick "Sit out next hand" on OUR table — idempotent: reads the tick first, clicks only when unticked (or unreadable
 *  and not pressed this bad stretch). THE READ THAT NEVER FOUND THE BOX (session_20261008_185314, 2026-10-08: four
 *  drops, each `[net] sit-out: {'ok': False, 'why': "no 'Sit out next hand' box on the table"}` — hero was never sat
 *  out; the session ended at the hand's end as before): it looked only at leaf elements, and the client's label is not
 *  one; and its walk-up took the first checkbox in any ancestor, which in a row shared with "Sit out next big blind"
 *  could be that box. Since 2026-10-09 the read and the press are sitoutBox.ts tickSitoutBox — the deep-stack reset's
 *  rewrite (label by its text, shown by style, the box through <label for> or a walk-up that rejects a container
 *  holding the other label, pointer click with a DOM click in our frame as the fallback), aimed at this label. */
export const ignitionSitoutNextHand = (): Promise<Record<string, any>> => tickSitoutBox("Sit out next hand", netClickedBefore());

export function netCompact(p: Record<string, any>): Record<string, any> {
  return Object.fromEntries(["ok", "at", "rttMs", "lostOf10", "warmMedMs", "warmMaxMs"].map((k) => [k, p[k] ?? null]));
}

/** The press a test replaces. */
export const netSeams = { sitout: () => (isCp() ? CP.sitout(true, false) : isCgg() ? CGG.sitout(true, false) : ignitionSitoutNextHand()) };

async function netSitout(probe: Record<string, any>): Promise<Record<string, any>> {
  const res = await netSeams.sitout();
  const first = S.net.sitout === null;
  S.net.sitout = { ...res, at: time(), clicked: res.clicked || !!(S.net.sitout && S.net.sitout.clicked) };
  if (first || res.clicked) {
    const why = (probe.why || []).join("; ") || "connection too slow";
    feedAdd(`CONNECTION TOO SLOW for answers (${why}) - ` + (res.ok ? "sitting out next hand" : `could NOT sit out: ${pyStr(res.why ?? null)} - SIT OUT YOURSELF`));
    log(`[net] sit-out: ${pyRepr(res)}`);
    if (S.session.id) {
      const { html: _h, ...result } = res;
      S.sessions.event(S.session.id, "net-sitout", { hand: S.handNo, probe: netCompact(probe), result });
    }
  }
  return res;
}

/** One probe's consequences. */
export async function netStep(p: Record<string, any>): Promise<void> {
  S.net.last = p;
  S.net.history.push(netCompact(p));
  if (S.net.history.length > 40) S.net.history.shift();
  const sid = S.session.id;
  if (p.ok) {
    S.net.good += 1;
    if (S.net.bad >= NET_BAD_TO_SITOUT && sid) S.sessions.event(sid, "net-recovering", { hand: S.handNo, probe: netCompact(p) });
    S.net.bad = 0;
    if (S.net.sitout && S.net.good === NET_GOOD_TO_CLEAR) {
      // said once; the session still ends (a drop is never undone by the link coming back)
      feedAdd("Connection is good again - the session still ends when this hand is over");
      if (sid) S.sessions.event(sid, "net-ok", { hand: S.handNo, probe: netCompact(p) });
    }
    return;
  }
  S.net.good = 0;
  S.net.bad += 1;
  if (S.net.bad === 1) feedAdd("Connection slow: " + (p.why || []).join("; ") + " - sitting out and ending the session if the next check is bad too");
  if (S.net.bad >= NET_BAD_TO_SITOUT) {
    await netSitout(p);
    netDrop(p);
  }
}

/** The link failed NET_BAD_TO_SITOUT probes in a row during a session: note it once — the session ends. */
function netDrop(p: Record<string, any>): void {
  const sid = S.session.id;
  if (!sid || (S.net.drop && S.net.drop.sid === sid)) return;
  const why = (p.why || []).join("; ") || "connection too slow";
  S.net.drop = { sid, at: time(), why, via: `table ${pyStr(TABLES.slot() ?? 1)}'s connection check`, handled: false };
  feedAdd(`CONNECTION DROPPED (${why}) - the session ends when this hand is over; it will not sit back in`);
  log(`[net] drop: ending session ${sid} at the hand's end (${why})`);
  S.sessions.event(sid, "net-drop", { hand: S.handNo, probe: netCompact(p), slot: TABLES.slot() });
}

export async function netGuard(): Promise<void> {
  await sleep(3 + 7 * ((TABLES.slot() || 1) - 1));
  for (;;) {
    try {
      const cfg = ((S.session.rec || {}).config) || {};
      if (!S.session.id || S.fakeMode || !cfg.answers) {
        Object.assign(S.net, { bad: 0, good: 0, sitout: null, drop: null });
        await sleep(5);
        continue;
      }
      await netStep(await NC.probe());
    } catch (e: any) {
      log(`[net] guard error: ${e?.message ?? e}`);
    }
    await sleep(C.NET_PROBE_EVERY_S);
  }
}
