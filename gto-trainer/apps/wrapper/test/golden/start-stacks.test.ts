/**
 * THE STACKS AS DEALT, against the table itself, over every recorded session (tests/golden/corpus reader-session_*).
 *
 * Each hand's startStacks (ignition/ws.ts noteAccount: a seat's first account this hand + what it had put in by then)
 * must equal the account the table gave that seat at the end of the PREVIOUS hand (CO_RESULT_INFO, after the pot went
 * out) — for every seat whose money nothing else touched in between. A seat with a top-up, buy-in or seat change
 * since the last hand began (PLAY_ACCOUNT_CASH_RES / PLAY_BUYIN_INFO / PLAY_SEAT_INFO) is left out rather than
 * guessed: a CASH_RES `cash` is the amount asked for, not always the stack that results (a seat at 13625 by its own
 * frames had a CASH_RES of 20000). Only the frames the reader itself accepted count (the bound table's socket).
 * Both sides are the WebSocket's own cents, so a disagreement is a reading bug, not rounding; the screen's seat
 * readings play no part — they are what startStacks replaces (hands 406 / 693 / 702 / 723).
 */
import { expect, test } from "bun:test";
import { S, resetState } from "../../src/state";
import { tapFrame, wsSeams } from "../../src/ignition/ws";
import { scratchDirs } from "../unit/helpers";
import { corpusFiles, readCorpus } from "./lib";

/** Recordings whose frames cannot stand as a reference, and why. */
const CORRUPT: Record<string, string> = {
  // every frame recorded twice and two hands' frames interleaved, with no socket id to tell them apart (a CO_RESULT_INFO
  // lands mid-hand, a seat folds and then calls): the capture-corruption class fixed 2026-09-21. Its hands disagree
  // with ANY reference; the reader golden pins how the reader handles it.
  "reader-session_20260920_131406.jsonl.gz": "interleaved duplicate streams",
};

test("each hand's startStacks is the table's own account from the hand before, in every recorded session", () => {
  const files = corpusFiles("reader-session_").filter((f) => !/-slot\d/.test(f) && !CORRUPT[f]);   // single-table recordings
  let checked = 0, hands = 0;
  const bad: string[] = [];
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    for (const file of files) {
      resetState();
      scratchDirs();
      let result: Map<number, number> | null = null;            // seat → cents at the end of the last hand
      const touched = new Set<number>();                         // seats whose money moved some other way since
      let expectFor: Map<number, number> | null = null;         // the check for the hand in progress
      for (const r of readCorpus(file)) {
        if (r.type !== "in" || r.kind !== "ws") continue;
        const d = r.d ?? {};
        const handNo = S.handNo;
        const before = new Map<number, number>(S.ws.startCents ?? []);
        tapFrame(d, r.rid ?? null);
        const ours = r.rid === null || r.rid === undefined || S.tapBound === null || r.rid === S.tapBound;
        if (ours) {
          if (d.pid === "CO_RESULT_INFO" && Array.isArray(d.account)) {
            result = new Map();
            d.account.forEach((c: number, i: number) => { if (c > 0) result!.set(i + 1, c); });
          } else if (["PLAY_ACCOUNT_CASH_RES", "PLAY_BUYIN_INFO", "PLAY_SEAT_INFO"].includes(d.pid) && typeof d.seat === "number") {
            touched.add(d.seat);
          } else if (d.pid === "CO_TABLE_INFO") {
            // a table snapshot: a (re)join, or Zone moving hero to a new table — the last result was another table's
            expectFor = null;
            result = null;
          }
        }
        if (S.handNo === handNo) continue;
        // a hand ended on this frame: its stacks as dealt against the account the table gave the seat before it
        if (expectFor && before.size) {
          hands++;
          for (const [seat, cents] of before) {
            const want = expectFor.get(seat);
            if (want === undefined) continue;
            checked++;
            if (want !== cents) bad.push(`${file} hand ${S.handIds.get(handNo) ?? handNo} seat ${seat}: startStacks ${cents} vs the table's ${want}`);
          }
        }
        expectFor = result ? new Map([...result].filter(([s]) => !touched.has(s))) : null;
        touched.clear();
        result = null;                                           // the next check needs this hand's own result
      }
    }
  } finally {
    wsSeams.archiveHand = arch0;
  }
  console.log(`startStacks vs the table's account from the hand before: ${checked - bad.length}/${checked} seat-hands agree over ${hands} hands (${files.length} recordings)`);
  expect(checked).toBeGreaterThan(100);
  expect(bad).toEqual([]);
}, 300_000);
