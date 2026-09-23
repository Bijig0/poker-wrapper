/**
 * THE CONNECTION GUARD (launch.py 2026-09-22, Brady: "if the connection drops below a threshold, mandatory sit out
 * next hand"). Answers are chains of GTO Wizard requests, so a bad link makes them 25 s late, and on the river not
 * there at all. Every NET_PROBE_EVERY_S while a session that answers runs, netcheck probes the path the answers
 * take; NET_BAD_TO_SITOUT bad probes IN A ROW tick "Sit out next hand" on OUR table. It never sits back in by
 * itself: when the link has been good for NET_GOOD_TO_CLEAR probes it SAYS so.
 */
import * as cdp from "./cdp";
import { sleep, time } from "./clock";
import { C } from "./config";
import { feedAdd, log } from "./feed";
import * as NC from "./netcheck";
import { pyRepr, pyStr } from "./py";
import { CP, S, isCp, seams } from "./state";
import * as TABLES from "./tables";
import { sitoutReadJs } from "./ignition/dom";
import { ensureVisible, pointIsMyTable } from "./relay";

export const NET_BAD_TO_SITOUT = 2;
export const NET_GOOD_TO_CLEAR = 2;

/** Tick "Sit out next hand" on OUR table — idempotent: reads the tick first, clicks only when unticked. */
export async function ignitionSitoutNextHand(): Promise<Record<string, any>> {
  const t = await seams.ignitionTarget();
  if (!t) return { ok: false, why: "poker client not open" };
  const ws = t.webSocketDebuggerUrl;
  const js = sitoutReadJs(TABLES.domSlot());
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(ws, js, 6)) || {};
  } catch (e: any) {
    return { ok: false, why: `table read failed: ${e?.message ?? e}` };
  }
  if (!d.ok) return { ok: false, why: d.reason || "table not readable" };
  if (d.back) return { ok: true, state: "already sitting out (I'm back is showing)" };
  if (!d.found) return { ok: false, why: "no 'Sit out next hand' box on the table" + (d.seated ? "" : " - not seated") };
  if (d.checked === true) return { ok: true, state: "already ticked" };
  if ((d.checked === null || d.checked === undefined) && S.net.sitout && S.net.sitout.clicked) {
    return { ok: true, state: "clicked earlier this bad stretch (tick state unreadable)", html: d.html ?? null };
  }
  const lk = await TABLES.pressLock();
  try {
    const blind = await ensureVisible(ws);
    if (blind) return { ok: false, why: blind };
    const wrong = await pointIsMyTable(ws, d.x, d.y);
    if (wrong) return { ok: false, why: wrong };
    try {
      await cdp.dispatchClick(ws, d.x, d.y);
    } catch (e: any) {
      return { ok: false, why: `click did not go through: ${e?.message ?? e}` };
    }
  } finally {
    lk.release();
  }
  await sleep(0.4);
  let after: Record<string, any> = {};
  try {
    after = (await cdp.evaluate(ws, js, 6)) || {};
  } catch {
    after = {};
  }
  if (after.checked === false && d.checked === false) {
    return { ok: false, why: "clicked, but the box still reads unticked", clicked: true, html: after.html ?? null };
  }
  return { ok: true, clicked: true, state: after.checked ? "ticked" : "clicked (tick state unreadable - check the table)",
           via: d.via ?? null, html: after.checked ? null : d.html ?? null };
}

export function netCompact(p: Record<string, any>): Record<string, any> {
  return Object.fromEntries(["ok", "at", "rttMs", "lostOf10", "warmMedMs", "warmMaxMs"].map((k) => [k, p[k] ?? null]));
}

/** The press a test replaces. */
export const netSeams = { sitout: () => (isCp() ? CP.sitout(true, false) : ignitionSitoutNextHand()) };

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
    if (S.net.sitout && S.net.good >= NET_GOOD_TO_CLEAR) {
      feedAdd("Connection is good again - press I'm back when you are ready");
      if (sid) S.sessions.event(sid, "net-ok", { hand: S.handNo, probe: netCompact(p) });
      S.net.sitout = null;
    }
    return;
  }
  S.net.good = 0;
  S.net.bad += 1;
  if (S.net.bad === 1) feedAdd("Connection slow: " + (p.why || []).join("; ") + " - sitting out if the next check is bad too");
  if (S.net.bad >= NET_BAD_TO_SITOUT) await netSitout(p);
}

export async function netGuard(): Promise<void> {
  await sleep(3 + 7 * ((TABLES.slot() || 1) - 1));
  for (;;) {
    try {
      const cfg = ((S.session.rec || {}).config) || {};
      if (!S.session.id || S.fakeMode || !cfg.answers) {
        Object.assign(S.net, { bad: 0, good: 0, sitout: null });
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
