/**
 * The wrapper's long-running loops (launch.py's threads): the DOM feed loop (0.25 s ticks) with the auto / top-up
 * chain behind each tick, and the WebSocket tap. `feedLoopOnce` is one pass of the feed loop, exported for the
 * golden replay (which drives it tick by tick exactly as the live loop does).
 */
import { time, sleep } from "./clock";
import { feedAdd, log } from "./feed";
import { pyRepr } from "./py";
import { S, seams } from "./state";
import { dumpEvent, tapFrame } from "./ignition/ws";
import { feedTick, maybeFlushEnded } from "./ignition/reader";
import { maybeAutoAct, maybeAutoArm, maybeFoldNoAnswer, maybeTakeTime, maybeVerifyExec } from "./relay";
import { maybeGuardBuyPanel, maybePrefoldTopUp, maybeTopUp, topUpKpiTick } from "./topup";
import { maybeEndForDisconnect, maybeEndForNetDrop, maybeSessionAdopt, maybeSessionOrphaned, maybeStandDown } from "./session";
import { maybeSitBackIn } from "./sitback";
import { liveHandTick } from "./archive";

export const FEED_STALL_TICKS = 8;

const errRepr = (e: any) => `${e?.name && e.name !== "Error" ? e.name : "Exception"}(${pyRepr(String(e?.message ?? e))})`;

/** One pass of the feed loop: the tick, then the flush, then the auto / top-up chain (ORDER IS THE HANDSHAKE:
 *  the pre-action top-up runs before the auto press, whose hold waits on it). */
export async function feedLoopOnce(loop: { fails: number }, onError?: (kind: string, e: any) => void): Promise<void> {
  try {
    await feedTick();
    if (loop.fails) {
      feedAdd("Table reader recovered");
      S.liveStatus.feedStalled = null;
    }
    loop.fails = 0;
  } catch (e: any) {
    // A DEAD READER MUST NOT LOOK LIKE AN IDLE TABLE
    loop.fails += 1;
    if (loop.fails === 1 || loop.fails % 40 === 0) log(`[feed] tick failed (${loop.fails}x): ${errRepr(e)}`);
    if (loop.fails === FEED_STALL_TICKS) {
      S.liveStatus.feedStalled = { since: Math.trunc(time() * 1000), error: errRepr(e).slice(0, 200) };
      S.liveStatus.toAct = false;
      feedAdd(`⚠ table reader failing for ${loop.fails} ticks: ${errRepr(e)}`.slice(0, 160));
      if (S.session.id) {
        try {
          S.sessions.event(S.session.id, "feed-stalled", { hand: S.handNo, error: errRepr(e).slice(0, 200) });
        } catch {}
      }
    }
    onError?.("tick", e);
  }
  // a table that lost the poker server ends the session before anything else in this pass could press
  try {
    await maybeEndForDisconnect();
  } catch (e: any) {
    log(`[disconnect] ${errRepr(e)}`);
  }
  try {
    maybeFlushEnded();
  } catch {}
  try {
    maybeAutoArm();
    await maybePrefoldTopUp();
    await maybeAutoAct();
    await maybeFoldNoAnswer();
    await maybeVerifyExec();
    await maybeTakeTime();
    await maybeEndForNetDrop();
    await maybeSitBackIn();
    await maybeGuardBuyPanel();
    await maybeSessionOrphaned();
    await maybeSessionAdopt();
    await maybeStandDown();
    topUpKpiTick();
    maybeTopUp();
  } catch (e: any) {
    log(`[pick] auto: ${errRepr(e)}`);
    onError?.("chain", e);
  }
  // LAST in the pass, after every press: the hand's live row in the central DB (and any archive a busy DB deferred)
  try {
    liveHandTick();
  } catch {}
}

export async function feedLoop(): Promise<void> {
  const loop = { fails: 0 };
  for (;;) {
    await feedLoopOnce(loop);
    await sleep(0.25);
  }
}

/** Follow the table's WebSocket via CDP, forever, reconnecting as needed. Every reconnect is a blind window —
 *  kept SHORT and made VISIBLE; the DOM diff backfills what was missed. An idle table sends nothing for minutes,
 *  which is NOT a dead socket: the same connection is probed instead of torn down. */
export async function wsTap(): Promise<void> {
  let wasUp = false;
  for (;;) {
    try {
      const t = await seams.ignitionTarget();
      if (!t) {
        await sleep(1);
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        let ws: WebSocket;
        try {
          ws = new WebSocket(t.webSocketDebuggerUrl);
        } catch (e) {
          reject(e);
          return;
        }
        let pingId = 1;
        let last = Date.now();
        let opened = false;
        const openTimer = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} reject(new Error("timed out connecting")); } }, 60_000);
        const idle = setInterval(() => {
          if (Date.now() - last < 60_000) return;
          pingId += 1;
          last = Date.now();
          try {
            ws.send(JSON.stringify({ id: pingId, method: "Network.enable" }));
          } catch {
            try { ws.close(); } catch {}
          }
        }, 5_000);
        ws.onopen = () => {
          opened = true;
          clearTimeout(openTimer);
          ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
          log("[ws] tapped table game protocol");
          dumpEvent("<tap-connected>", { target: t.url || "" });
          if (wasUp) feedAdd("(capture reconnected — DOM backfill covered the gap)");
          wasUp = true;
        };
        ws.onmessage = (ev) => {
          last = Date.now();
          let m: any;
          try {
            m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
          } catch {
            return;
          }
          if (m.method !== "Network.webSocketFrameReceived") return;
          const raw: string = ((m.params || {}).response || {}).payloadData || "";
          let o: any;
          try {
            o = JSON.parse(raw.replace(/^\d+\|/, ""));
          } catch {
            if (raw.length > 4) dumpEvent("<unparsed>", { raw: raw.slice(0, 300) });
            return;
          }
          const d = o && typeof o === "object" && !Array.isArray(o) ? o.data : null;
          if (d && typeof d === "object" && !Array.isArray(d) && d.pid) {
            try {
              tapFrame(d, (m.params || {}).requestId ?? null);
            } catch (e: any) {
              log(`[ws] frame: ${e?.message ?? e}`);
            }
          }
        };
        ws.onclose = () => {
          clearInterval(idle);
          clearTimeout(openTimer);
          reject(new Error("the tap's socket closed"));
        };
        ws.onerror = () => {
          /* onclose follows */
        };
      });
    } catch (ex: any) {
      if (wasUp) {
        dumpEvent("<tap-lost>", { err: String(ex?.message ?? ex).slice(0, 200) });
        wasUp = false;
        feedAdd("(capture connection lost — reconnecting)");
      }
      await sleep(0.5);
    }
  }
}
