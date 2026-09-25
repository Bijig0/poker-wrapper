/**
 * SIT BACK IN (session setup `autoSitBackIn`, off unless chosen — 2026-09-25, Brady: "an option in session setup to
 * sit back in when made to sit out"). A few timed-out decisions and the client sits hero out; on an unattended run
 * the seat then sits there until someone presses I AM BACK. With the option on, the wrapper presses it.
 *
 * It stands aside while the connection guard (netguard.ts) has hero out — that sit-out is deliberate and the guard
 * only ever SAYS when the link is good again — and while any probe in the current stretch was bad. Outside a
 * session it does nothing. Ignition only: CoinPoker's sit-out is a server flag set from the menu (CP.sitout),
 * wired separately.
 *
 * Every press is a `sit-back-in` session event with what it found and did.
 */
import * as cdp from "./cdp";
import { nowMs, time } from "./clock";
import { feedAdd, log } from "./feed";
import { pyRepr, pyStr } from "./py";
import { S, isCp, seams } from "./state";
import * as TABLES from "./tables";
import { js } from "./js";
import { mySel, slotted, type FrameSel } from "./ignition/dom";
import { ensureVisible, pointIsMyTable } from "./relay";

/** Hero must read as sitting out this long before the press (one tick of a redraw is not a sit-out). */
export const SIT_BACK_AFTER_S = 2.0;
/** Between presses while hero still reads as sitting out. */
export const SIT_BACK_RETRY_S = 10.0;
/** Presses per sit-out before it gives up and says so (a press that never takes is not retried forever). */
export const SIT_BACK_TRIES = 3;

/** Finds I AM BACK on one table: {ok, back, seated, x, y}. */
export const sitBackReadJs = (sel: FrameSel = null) => slotted(js("sitback.BACK_READ_JS_TMPL"), sel);

/** Press I AM BACK on OUR table. */
export async function ignitionSitBackIn(): Promise<Record<string, any>> {
  const t = await seams.ignitionTarget();
  if (!t) return { ok: false, why: "poker client not open" };
  const ws = t.webSocketDebuggerUrl;
  const read = sitBackReadJs(mySel());
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(ws, read, 6)) || {};
  } catch (e: any) {
    return { ok: false, why: `table read failed: ${e?.message ?? e}` };
  }
  if (!d.ok) return { ok: false, why: d.reason || "table not readable" };
  if (!d.back) return { ok: false, why: "no I AM BACK button on the table" + (d.seated ? "" : " - not seated") };
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
  return { ok: true, clicked: true };
}

export const sitBackSeams = { press: () => ignitionSitBackIn() };

/** From the feed loop, every tick. */
export async function maybeSitBackIn(): Promise<void> {
  const st = S.study;
  const L = S.liveStatus;
  if (!st.sitBackIn || !S.session.id || S.fakeMode || isCp() || L.hero !== "sitting-out") {
    st.sitBackTurn = null;
    return;
  }
  if (S.net.sitout || S.net.bad > 0) return;   // the connection guard's sit-out is deliberate
  if (L.modal || L.buyPanel) return;           // nothing is pressed through a notice; the next tick looks again
  const now = time();
  const cur = (st.sitBackTurn ??= { since: now, tries: 0, lastTry: 0.0, gaveUp: false });
  if (now - cur.since < SIT_BACK_AFTER_S || cur.gaveUp) return;
  if (cur.tries && now - cur.lastTry < SIT_BACK_RETRY_S) return;
  if (cur.tries >= SIT_BACK_TRIES) {
    cur.gaveUp = true;
    feedAdd(`Still sitting out after ${SIT_BACK_TRIES} I AM BACK presses — press it yourself`);
    if (S.session.id) S.sessions.event(S.session.id, "sit-back-in", { at: nowMs(), hand: S.handNo, ok: false, gaveUp: true, tries: cur.tries });
    return;
  }
  cur.tries += 1;
  cur.lastTry = now;
  const res = await sitBackSeams.press();
  const rec = { at: nowMs(), hand: S.handNo, attempt: cur.tries, satOutS: Math.round((now - cur.since) * 10) / 10,
                ok: !!res.ok, reason: res.ok ? null : res.why ?? null };
  st.lastSitBackIn = rec;
  feedAdd(res.ok ? "Sat out by the table — pressed I AM BACK" : `Sat out by the table — could not press I AM BACK (${pyStr(res.why ?? null)})`);
  log(`[sit-back-in] ${pyRepr(res)}`);
  S.sessions.event(S.session.id, "sit-back-in", rec);
}
