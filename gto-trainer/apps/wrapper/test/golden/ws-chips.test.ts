/**
 * THE WEBSOCKET CHIP COUNTS (/hand `wsStack` / `wsInFront` / `wsDead`, ignition/ws.ts wsChips — round 3), against the
 * table itself, over every recorded session (tests/golden/corpus reader-session_*). Fields added after the Python
 * recording, so the reader golden compares without them (reader.test.ts POST_RECORDING); this is their own check.
 *
 *   1. THE TABLE'S OWN END OF HAND. CO_RESULT_INFO gives every seat's account once the pot is paid. A seat that FOLDED
 *      is paid nothing and has no bet returned, so its result must equal the chips behind the export says it had —
 *      exactly, in cents; a seat still in at the end may only have more (the pot, a returned bet). Independent of the
 *      reader's own arithmetic: the result frame is never read by it.
 *   2. THE INVARIANT THE API'S CAPTURE GATE READS (utils/repairPostflopRotation lostActionFaults, exact per-seat chips):
 *      at every action frame, for every seat the export covers, stack as dealt − chips behind now − dead blinds = the
 *      chips the exported line's actions put in (a call adds, a post/raise/bet/all-in is the street's total). On a
 *      capture that lost nothing this is zero for every seat — so a non-zero here, on a recorded session, is a live
 *      refusal the gate would make on a good capture. Measured, and required to be zero on every CLEAN hand.
 *      A hand whose money frames came from TWO sockets, or carry the same frame twice running, is the 2026-09-20/21
 *      socket-mixing capture (a single-table wrapper then accepted every socket's frames; recordings 20260921_125219
 *      .. 143059): its event line holds another table's actions or a duplicated raise read as a second one ("raises
 *      to 5" for one raise to 2.5, hand 4919645417). There the disagreement is the gate doing its job — counted and
 *      printed as refusals of corrupt captures, not failures.
 * Only the frames the reader accepted count (the bound table's socket), as in start-stacks.test.ts.
 */
import { expect, test } from "bun:test";
import { S, resetState } from "../../src/state";
import { tapFrame, wsSeams } from "../../src/ignition/ws";
import { handStateIgnition } from "../../src/ignition/hand";
import { scratchDirs } from "../unit/helpers";
import { corpusFiles, readCorpus } from "./lib";

/** Recordings whose frames cannot stand as a reference (start-stacks.test.ts has the same list, and why). */
const CORRUPT: Record<string, string> = {
  "reader-session_20260920_131406.jsonl.gz": "interleaved duplicate streams",
};

function lineChips(actions: any[]): Map<number, number> {
  const per = new Map<string, Map<number, number>>();
  for (const a of actions) {
    if (a.amount == null) continue;
    const m = per.get(a.street) ?? new Map<number, number>();
    per.set(a.street, m);
    m.set(a.seatId, a.type === "call" ? (m.get(a.seatId) ?? 0) + a.amount : Math.max(m.get(a.seatId) ?? 0, a.amount));
  }
  const out = new Map<number, number>();
  for (const m of per.values()) for (const [s, v] of m) out.set(s, (out.get(s) ?? 0) + v);
  return out;
}

test("wsStack against the table's end-of-hand accounts, and dealt − behind = the line's chips, in every recorded session", () => {
  const files = corpusFiles("reader-session_").filter((f) => !/-slot\d/.test(f) && !CORRUPT[f]);
  let endChecked = 0, endHands = 0, ledgerChecked = 0;
  const bad: string[] = [];
  const corruptRefused = new Set<string>();   // hands of a mixed/duplicated stream the rule disagrees on (true refusals)
  const corruptHands = new Set<string>();     // every hand whose stream is mixed or doubled, judged over the WHOLE hand
  const badBy: [string, string][] = [];       // [hand, disagreement] — a hand is clean or corrupt only once it is read
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    for (const file of files) {
      resetState();
      scratchDirs();
      const touched = new Set<number>();   // seats whose money moved some other way this hand (a top-up, a buy-in)
      let handNo = S.handNo;
      const rids = new Set<string>();      // the sockets this hand's money frames came from
      let lastMoney = "", doubled = false;  // the same money frame twice running
      const newHand = () => { handNo = S.handNo; touched.clear(); rids.clear(); lastMoney = ""; doubled = false; };
      for (const r of readCorpus(file)) {
        if (r.type !== "in" || r.kind !== "ws") continue;
        const d = r.d ?? {};
        const ours = r.rid === null || r.rid === undefined || S.tapBound === null || r.rid === S.tapBound;
        if (S.handNo !== handNo) newHand();
        if (ours && ["PLAY_ACCOUNT_CASH_RES", "PLAY_BUYIN_INFO", "PLAY_SEAT_INFO"].includes(d.pid) && typeof d.seat === "number") touched.add(d.seat);
        if (ours && d.pid === "CO_RESULT_INFO" && Array.isArray(d.account) && S.ws.wsAccount?.size) {
          // 1. before the result frame touches anything: the export's chips behind vs what the table paid out
          const h = handStateIgnition();
          if (h?.wsStack) {
            endHands++;
            const folded: Set<number> = S.ws.foldedSeats ?? new Set();
            for (const [seat, bb] of h.wsStack as Map<number, number>) {
              const paid = d.account[seat - 1];
              // 0 = the seat is not in the result (it left); a top-up or buy-in moved the money some other way
              if (typeof paid !== "number" || paid <= 0 || touched.has(seat)) continue;
              const cents = Math.round(bb * S.ws.bb);
              endChecked++;
              if (folded.has(seat) ? paid !== cents : paid < cents) {
                bad.push(`${file} hand ${S.handIds.get(S.handNo)} seat ${seat}: wsStack ${cents}c, the table's result ${paid}c (${folded.has(seat) ? "folded: must be equal" : "in at the end: must not be less"})`);
              }
            }
          }
        }
        tapFrame(d, r.rid ?? null);
        if (!ours || !["CO_SELECT_INFO", "CO_SELECT_SPEED_INFO", "CO_BLIND_INFO"].includes(d.pid)) continue;
        if (S.handNo !== handNo) newHand();
        rids.add(String(r.rid ?? ""));
        const money = JSON.stringify(d);
        if (money === lastMoney) doubled = true;
        lastMoney = money;
        const hk = `${file} ${S.handIds.get(S.handNo)}`;
        if (rids.size > 1 || doubled) corruptHands.add(hk);
        // 2. the gate's invariant on the export as it stands after this frame
        const h = handStateIgnition();
        if (!h?.wsStack || !h.startStacks) continue;
        const line = lineChips(h.actions);
        for (const [seat, behind] of h.wsStack as Map<number, number>) {
          const start = (h.startStacks as Map<number, number>).get(seat);
          if (start === undefined) continue;
          ledgerChecked++;
          const dead = (h.wsDead as Map<number, number> | undefined)?.get(seat) ?? 0;
          const diff = start - behind - dead - (line.get(seat) ?? 0);
          // the line's amounts are rounded to 0.01bb and startStacks too: half a hundredth each
          const n = h.actions.filter((a: any) => a.seatId === seat && a.amount != null).length;
          if (Math.abs(diff) > 0.005 * (n + 1) + 1e-9) {
            badBy.push([hk, `${file} hand ${S.handIds.get(S.handNo)} after ${d.pid} seat ${seat}: dealt ${start} − behind ${behind} − dead ${dead} ≠ the line's ${line.get(seat) ?? 0} (off by ${Math.round(diff * 1000) / 1000})`]);
          }
        }
      }
    }
  } finally {
    wsSeams.archiveHand = arch0;
  }
  for (const [hk, b] of badBy) {
    if (corruptHands.has(hk)) corruptRefused.add(hk);
    else bad.push(b);
  }
  console.log(`wsStack vs the table's result: ${endChecked} seat-hands over ${endHands} hands; dealt − behind = the line: ${ledgerChecked} seat-frames (${files.length} recordings), ${bad.length} disagree on clean hands; ` +
    `${corruptRefused.size} hands of a mixed/duplicated stream disagree (the gate refuses them): ${[...corruptRefused].map((x) => x.replace(/^reader-session_|\.jsonl\.gz/g, "")).join(", ")}`);
  expect(endChecked).toBeGreaterThan(100);
  expect(ledgerChecked).toBeGreaterThan(1000);
  if (process.env.WS_CHIPS_DUMP) for (const b of bad) console.log("BAD " + b);
  expect(bad.slice(0, 20)).toEqual([]);
}, 300_000);
