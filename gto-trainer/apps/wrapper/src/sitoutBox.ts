/**
 * TICKING A SIT-OUT BOX ON OUR TABLE — "Sit out next hand" (the connection guard, netguard.ts) and "Sit out next big
 * blind" (the deep-stack reset, stackReset.ts) are two boxes 20 px apart at the table's bottom left, read and pressed
 * the same way (one page snippet, src/js/sitout.READ_JS_TMPL.js, aimed at either label). Reads first; presses only
 * when the box reads unticked, or its state is unreadable and the caller has not pressed it yet (`clickedBefore`).
 *
 * WHY ONE MODULE (2026-10-09). The deep-stack reset's read never found its box on the live client
 * (session_20261009_052537: the label is not a leaf element) and was rewritten — find the label by its text, shown by
 * style, the box through <label for> or a walk-up that refuses a container holding the OTHER label; press by pointer,
 * through the DOM when nothing measures / the page is not rendering / the pointer click did not take. The guard's
 * "Sit out next hand" read had the same leaf-only pattern and the same failure: session_20261008_185314, `[net]
 * sit-out: {'ok': False, 'why': "no 'Sit out next hand' box on the table"}` four times on a connection drop, so hero
 * was never sat out (the session still ended at the hand's end). Worse, its walk-up took the FIRST checkbox in any
 * ancestor, so in a row shared by both labels it could read — or press — the big-blind box for the hand's. Both
 * boxes now go through here.
 *
 * HOW IT PRESSES. First a pointer click at the box (else the label) through CDP Input — the press every pick makes,
 * and those land on a frame Chrome has stopped drawing (session_20261009_052537: every pick of both tables went
 * through while /state said `drawn:false` for 2,000+ s; hit-testing runs on layout, not paint), guarded by
 * ensureVisible and pointIsMyTable. A DOM click (`.click()` on the box, else the label, inside OUR frame only —
 * domClickRefusal) is used when there is no point to press (nothing measures), when the page is not rendering (a
 * parked pointer click never arrives; a DOM click needs no frame), when the point would not land on our table, and
 * once after a pointer click that left the box reading unticked. `pressed` = a click went out; `retry` = nothing went
 * out (the caller may try again later; the deep-stack reset spends no tick on it).
 */
import * as cdp from "./cdp";
import { sleep } from "./clock";
import { js } from "./js";
import { pyStr } from "./py";
import { S, pressBlocked, seams } from "./state";
import * as TABLES from "./tables";
import { framePin, mySel, slotted, type FrameSel } from "./ignition/dom";
import { ensureVisible, pointIsMyTable } from "./relay";

export type SitoutLabel = "Sit out next hand" | "Sit out next big blind";
/** The label beside each (a container holding both is a shared row: its box answers for neither). */
const OTHER: Record<SitoutLabel, string> = {
  "Sit out next hand": "sit out next big blind",
  "Sit out next big blind": "sit out next hand",
};

/** The read of one box on one table: {ok, found, checked (null = unknown), via, shared, back, seated, x, y (null when
 *  nothing measures), on: 'box'|'label'|null, hidden (matches not shown), idleMs (the frame's last draw)}; with
 *  `click`, the same read then a DOM click on the box (or on the label when no box is ours): {..., domClicked |
 *  domClickError}. */
export function sitoutBoxJs(label: SitoutLabel, sel: FrameSel = null, click = false): string {
  return slotted(js("sitout.READ_JS_TMPL"), sel)
    .split("__WANT__").join(label.toLowerCase())
    .split("__OTHER__").join(OTHER[label])
    .split("__CLICK__").join(click ? "true" : "false");
}

/** Why a DOM click may not go to our table now (null = it may): the refusals relay.pointIsMyTable makes before its
 *  point probe — the session lost the server, or (several tables) our frame is not pinned or is gone. The click
 *  snippet then finds OUR frame by its pinned tag (mySel → __frame {tag}) or nothing, never another table's. */
export function domClickRefusal(): string | null {
  const blocked = pressBlocked();
  if (blocked) return blocked;
  if (TABLES.domSlot() === null) return null;
  const pin = framePin();
  if (pin.tag === null) return `table ${pyStr(TABLES.slot())} has not identified its own table in the client yet — refusing`;
  if (pin.lost !== null) return `table ${pyStr(TABLES.slot())}'s own table (the client's tag ${pin.tag}) is gone — refusing`;
  return null;
}

/** Tick `label`'s box on OUR table — idempotent: reads first, presses only when it reads unticked, or its state is
 *  unreadable and `clickedBefore` is false. */
export async function tickSitoutBox(label: SitoutLabel, clickedBefore: boolean): Promise<Record<string, any>> {
  const t = await seams.ignitionTarget();
  if (!t) return { ok: false, retry: true, why: "poker client not open" };
  const ws = t.webSocketDebuggerUrl;
  const read = sitoutBoxJs(label, mySel());
  let d: Record<string, any>;
  try {
    d = (await cdp.evaluate(ws, read, 6)) || {};
  } catch (e: any) {
    return { ok: false, retry: true, why: `table read failed: ${e?.message ?? e}` };
  }
  if (!d.ok) return { ok: false, retry: true, why: d.reason || "table not readable" };
  if (d.back) return { ok: true, state: "already sitting out (I'm back is showing)" };
  if (!d.found) {
    return { ok: false, retry: true, idleMs: d.idleMs ?? null,
             why: `no '${label}' box on the table` + (d.seated ? "" : " - not seated")
               + (d.hidden ? ` (${d.hidden} hidden by style)` : "") };
  }
  if (d.checked === true) return { ok: true, state: "already ticked", via: d.via ?? null };
  if ((d.checked === null || d.checked === undefined) && clickedBefore) {
    return { ok: true, state: "clicked earlier (tick state unreadable)", via: d.via ?? null, shared: !!d.shared, html: d.html ?? null };
  }
  const domNo = domClickRefusal();
  const viaDom = async (): Promise<{ sent: boolean; why?: string; target?: string }> => {
    let c: Record<string, any>;
    try {
      c = (await cdp.evaluate(ws, sitoutBoxJs(label, mySel(), true), 6)) || {};
    } catch (e: any) {
      return { sent: false, why: `DOM click failed: ${e?.message ?? e}` };
    }
    if (!c.found || !c.domClicked) {
      return { sent: false, why: `DOM click did not go out (${pyStr(c.domClickError ?? c.reason ?? (c.found ? null : "the box is gone"))})` };
    }
    return { sent: true, target: String(c.domClicked) };
  };
  let method = "";
  const lk = await TABLES.pressLock();
  try {
    const point = typeof d.x === "number" && typeof d.y === "number" && Number.isFinite(d.x) && Number.isFinite(d.y);
    let noPoint: string | null = point ? null : `nothing to point at (the label measures ${d.w ?? 0} x ${d.h ?? 0})`;
    if (!noPoint) noPoint = await ensureVisible(ws);
    if (!noPoint) {
      const wrong = await pointIsMyTable(ws, d.x, d.y);
      if (wrong && pressBlocked()) return { ok: false, retry: true, why: wrong };
      noPoint = wrong;
    }
    if (!noPoint) {
      try {
        await cdp.dispatchClick(ws, d.x, d.y);
      } catch (e: any) {
        return { ok: false, retry: true, why: `click did not go through: ${e?.message ?? e}` };
      }
      method = `point (${d.on ?? "label"})`;
    } else {
      if (domNo) return { ok: false, retry: true, why: `${noPoint}; no DOM click either: ${domNo}` };
      const r = await viaDom();
      if (!r.sent) return { ok: false, retry: true, why: `${noPoint}; ${r.why}` };
      method = `dom: ${r.target} (${noPoint})`;
    }
  } finally {
    lk.release();
  }
  await sleep(0.4);
  const reread = async (): Promise<Record<string, any>> => {
    try {
      return (await cdp.evaluate(ws, read, 6)) || {};
    } catch {
      return {};
    }
  };
  let after = await reread();
  // a pointer click that left the box reading unticked did not land: once more, through the DOM (it read unticked
  // before and after, so this can only tick it)
  if (after.checked === false && d.checked === false && method.startsWith("point") && !domNo) {
    const lk2 = await TABLES.pressLock();
    let r: { sent: boolean; why?: string; target?: string };
    try {
      r = await viaDom();
    } finally {
      lk2.release();
    }
    if (r.sent) {
      method += ` → dom: ${r.target}`;
      await sleep(0.4);
      after = await reread();
    }
  }
  if (after.checked === false && d.checked === false) {
    return { ok: false, why: "clicked, but the box still reads unticked", clicked: true, pressed: true, method, html: after.html ?? null };
  }
  return { ok: true, clicked: true, pressed: true, method,
           state: after.checked ? "ticked" : "clicked (tick state unreadable - check the table)",
           via: d.via ?? null, shared: !!d.shared, html: after.checked ? null : d.html ?? null };
}

/** The guard's `clickedBefore`: a press this bad stretch already made (netguard.netSitout keeps it on S.net.sitout). */
export const netClickedBefore = (): boolean => !!(S.net.sitout && S.net.sitout.clicked);
