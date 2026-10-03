/**
 * THE TOP-UP NEED, REPLAYED OFF THE TABLE'S OWN FRAMES (2026-10-04, session_20261003_234358). The frames of a socket
 * dump go through the real reader — tapFrame, the golden harness's entry, or onGameMsg for a dump that changes sockets
 * — with the clock set to each frame's time, and at every point the live wrapper asks, the same question is asked here:
 *  - at the DEAL (hero's cards dealt): topup.ts needFor("deal") — what topUpDealNeed files as `top-up-need`;
 *  - at the first WINDOW of the hand (hero's fold, else the hand's end): needFor("final") — what maybeTopUp decides on.
 * Presses are what the wrapper did: given (the session's `top-up` records), or taken from the dump itself (`fromDump`:
 * every Buy-chips panel hero opened with something to add — PLAY_BUYIN_INFO allowedMax > 0 — is a press of that
 * amount). The OLD rule is replayed beside the new one: a press blocked every window until the SCREEN's receipt (the
 * session's own `top-up-receipt` events, `oldReceiptsMs`) or for 180 s.
 *
 * No DOM, no clock of its own, no network; the caller sandboxes data/ and debug/ (the reader archives and dumps).
 */
import { setFakeTime } from "../clock";
import { S, resetState } from "../state";
import { onGameMsg, tapFrame, wsSeams } from "../ignition/ws";
import { needFor, settlePending } from "../topup";
import type { NeedVerdict } from "../topupNeed";

export interface ReplayPress { atMs: number; amountCents: number; beforeCents: number | null; handKey: string | null; trigger: string | null }

export interface ReplayHand {
  handKey: string;
  handNo: number;
  dealAt: number | null;
  deal: Pick<NeedVerdict, "need" | "known" | "shortCents" | "shortBb" | "stackCents" | "stackSource" | "blockedBy" | "pendingVerdict" | "pendingWhy"> | null;
  window: { at: number; trigger: string; need: boolean; known: boolean; blockedBy: string | null; pendingVerdict: string | null; pressAllowed: boolean; oldBlocked: boolean } | null;
  pressedAt: number[];
  receiptsAt: { at: number; cents: number; source: string }[];
  lost: string[];
}

export interface ReplayOpts {
  /** read each frame through tapFrame (true: the golden harness's path) or onGameMsg with the socket set as bound */
  viaTap?: boolean;
  maxCents?: number | null;
  /** presses: given, or from the dump's own Buy-chips panels */
  presses?: ReplayPress[];
  fromDump?: boolean;
  /** when the session's screen receipts were filed (ms) — for the old rule */
  oldReceiptsMs?: number[];
}

const pick = (v: NeedVerdict) => ({ need: v.need, known: v.known, shortCents: v.shortCents, shortBb: v.shortBb, stackCents: v.stackCents,
                                    stackSource: v.stackSource, blockedBy: v.blockedBy, pendingVerdict: v.pendingVerdict, pendingWhy: v.pendingWhy });

/** Replay `entries` (parsed ws-dump lines, oldest first). Leaves S as the replay left it; the caller resets it. */
export function replayTopUp(entries: Record<string, any>[], opts: ReplayOpts = {}): { hands: ReplayHand[]; events: [string, any][] } {
  const events: [string, any][] = [];
  const hands: ReplayHand[] = [];
  const presses = [...(opts.presses || [])].sort((a, b) => a.atMs - b.atMs);
  const oldRx = opts.oldReceiptsMs || [];
  let pi = 0;
  let seen = 0;
  let cur: ReplayHand | null = null;
  let lastPressMs: number | null = null;
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  const fresh = () => {
    resetState();
    S.session.id = "replay";
    S.sessions = { event: (_sid: string, kind: string, data: any = null) => events.push([kind, data || {}]) } as any;
    Object.assign(S.study, { topUp: true, on: true });
    if (opts.maxCents) S.study.topUpMax = { maxCents: opts.maxCents, bbCents: null, assumed: false };
    cur = null;
    lastPressMs = null;
    seen = events.length;
  };
  const press = (p: ReplayPress) => {
    S.study.lastTopUp = { pressed: true, ok: false, at: p.atMs, pressedAtMs: p.atMs, amountCents: p.amountCents, beforeCents: p.beforeCents,
                          handKey: p.handKey ?? S.handIds.get(S.handNo) ?? null, hand: S.handNo, pressHandNo: S.handNo, trigger: p.trigger };
    lastPressMs = p.atMs;
    cur?.pressedAt.push(p.atMs / 1000);
  };
  // THE OLD RULE: pressed, no screen receipt since, younger than 180 s
  const oldBlocked = (nowMs: number) => lastPressMs !== null && nowMs - lastPressMs < 180_000
    && !oldRx.some((t) => t >= lastPressMs! && t <= nowMs);
  try {
    fresh();
    for (const e of entries) {
      const pid = String(e.pid ?? "");
      if (pid === "<tap-connected>") {
        fresh();
        continue;
      }
      const d = e.data;
      if (!d || typeof d !== "object" || pid.startsWith("<")) continue;
      setFakeTime(Number(e.ts));
      const nowMs = Math.trunc(Number(e.ts) * 1000);
      while (pi < presses.length && presses[pi]!.atMs <= nowMs) press(presses[pi++]!);
      const rec0 = S.study.lastTopUp;
      const had = rec0?.receiptCents ?? null;
      if (opts.viaTap) tapFrame(d, e.rid ?? null);
      else {
        S.tapBound = e.rid ?? null;
        onGameMsg(d);
      }
      const hid = S.handIds.get(S.handNo) || `local-${S.handNo}`;
      if (!cur || cur.handNo !== S.handNo) {
        cur = { handKey: hid, handNo: S.handNo, dealAt: null, deal: null, window: null, pressedAt: [], receiptsAt: [], lost: [] };
        hands.push(cur);
      }
      cur.handKey = hid;
      const rec = S.study.lastTopUp;
      if (rec && rec === rec0 && !had && rec.receiptCents) cur.receiptsAt.push({ at: Number(e.ts), cents: rec.receiptCents, source: rec.receiptSource });
      if (!S.study.topUpMax && S.ws.bbSeen && !S.ws.bbGuessed && S.ws.bb) S.study.topUpMax = { maxCents: 100 * S.ws.bb, bbCents: S.ws.bb, assumed: true };
      // a press the dump shows: the panel opened with something to add (the BUY follows it)
      if (opts.fromDump && d.pid === "PLAY_BUYIN_INFO" && d.type === 1 && d.seat === S.ws.heroSeat && Number(d.allowedMax) > 0) {
        const v = needFor("press");
        press({ atMs: nowMs + 500, amountCents: Number(d.allowedMax), beforeCents: v.stackCents, handKey: hid, trigger: "dump" });
      }
      // THE DEAL: hero's cards dealt
      if (d.pid === "CO_CARDTABLE_INFO" && S.ws.heroDealt && !cur.deal) {
        const v = needFor("deal");
        settlePending(v);
        cur.dealAt = Number(e.ts);
        cur.deal = pick(v);
      }
      // THE FIRST WINDOW: hero's fold, else the hand's end
      const folded = (d.pid === "CO_SELECT_INFO" && d.seat === S.ws.heroSeat && S.ws.heroFolded);
      if (!cur.window && cur.deal && (folded || d.pid === "PLAY_STAGE_END_REQ")) {
        const v = needFor("final");
        if (v.pendingVerdict === "lost") settlePending(v);
        cur.window = { at: Number(e.ts), trigger: folded ? "fold" : "hand-over", need: v.need, known: v.known, blockedBy: v.blockedBy,
                       pendingVerdict: v.pendingVerdict, pressAllowed: v.need && !v.blockedBy, oldBlocked: oldBlocked(nowMs) };
      }
      for (const [k, ev] of events.slice(seen)) {
        if (k === "top-up-lost") cur.lost.push(String(ev.why));
      }
      seen = events.length;
    }
  } finally {
    wsSeams.archiveHand = arch0;
  }
  return { hands: hands.filter((h) => h.deal || h.window || h.pressedAt.length || h.receiptsAt.length), events };
}

/** Parse ws-dump text into entries, oldest first, optionally limited to a time range and one socket. */
export function dumpEntries(text: string, o: { from?: number; to?: number; rid?: string | null } = {}): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.from !== undefined && e.ts < o.from) continue;
    if (o.to !== undefined && e.ts > o.to) continue;
    if (o.rid && e.rid && e.rid !== o.rid) continue;
    out.push(e);
  }
  return out;
}
