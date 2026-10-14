/**
 * THE CARRIED STACKS AT THE DEAL, against the seats' own frames, over every recorded session (tests/golden/corpus
 * reader-session_*). At each hand's deal (CO_CARDTABLE_INFO) ignition/ws.ts dealtCents gives every dealt seat a figure
 * it can: the seat's own first frame (exact), else the figure carried from the table's last word on the seat (the
 * previous hand's CO_RESULT_INFO, a buy, a seat word). By the hand's end most seats have sent a frame, so the carried
 * figure of every such seat must EQUAL the exact one — both are the WebSocket's own cents, a disagreement is a reading
 * bug. The check counts how many dealt seats the deal covered, and requires every carried figure a frame later
 * confirmed to have been right. Only the frames the reader itself accepted count (the bound table's socket), as in
 * start-stacks.test.ts.
 */
import { expect, test } from "bun:test";
import { S, resetState } from "../../src/state";
import { dealtCents, tapFrame, wsSeams } from "../../src/ignition/ws";
import { scratchDirs } from "../unit/helpers";
import { corpusFiles, readCorpus } from "./lib";

/** Recordings whose frames cannot stand as a reference (start-stacks.test.ts has the same list, and why). */
const CORRUPT: Record<string, string> = {
  "reader-session_20260920_131406.jsonl.gz": "interleaved duplicate streams",
};

test("every carried figure at the deal equals the seat's own first frame, in every recorded session", () => {
  const files = corpusFiles("reader-session_").filter((f) => !/-slot\d/.test(f) && !CORRUPT[f]);
  let hands = 0, dealtSeats = 0, covered = 0, carried = 0, confirmed = 0, firstHands = 0;
  const bad: string[] = [];
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    for (const file of files) {
      resetState();
      scratchDirs();
      let atDeal: Map<number, { cents: number; source: string }> | null = null;   // the deal's figures for the hand in progress
      let dealHand = 0;
      const close = (handNo: number, exact: Map<number, number>) => {
        if (!atDeal) return;
        hands++;
        if (![...atDeal.values()].some((v) => v.source !== "frame")) firstHands++;
        for (const [seat, v] of atDeal) {
          covered++;
          if (v.source === "frame") continue;
          carried++;
          const want = exact.get(seat);
          if (want === undefined) continue;                       // the seat never sent a frame (capture ended first)
          confirmed++;
          if (want !== v.cents) bad.push(`${file} hand ${S.handIds.get(handNo) ?? handNo} seat ${seat}: carried ${v.cents} (${v.source}) vs its own frame ${want}`);
        }
        atDeal = null;
      };
      for (const r of readCorpus(file)) {
        if (r.type !== "in" || r.kind !== "ws") continue;
        const d = r.d ?? {};
        const handNo = S.handNo;
        const before = new Map<number, number>(S.ws.startCents ?? []);   // the hand's exact figures, before a new hand empties them
        tapFrame(d, r.rid ?? null);
        if (S.handNo !== handNo) close(handNo, before);           // a hand ended on this frame
        if (d.pid === "CO_CARDTABLE_INFO" && S.handNo && S.ws.dealt?.length && atDeal === null) {
          atDeal = dealtCents();
          dealHand = S.handNo;
          dealtSeats += S.ws.dealt.length;
        }
      }
      close(dealHand, new Map<number, number>(S.ws.startCents ?? []));
    }
  } finally {
    wsSeams.archiveHand = arch0;
  }
  console.log(`stacks at the deal: ${covered}/${dealtSeats} dealt seats covered over ${hands} hands (${firstHands} with nothing carried: the first hand on a socket); ` +
    `${carried} carried, ${confirmed} confirmed by the seat's own frame, ${confirmed - bad.length}/${confirmed} agree (${files.length} recordings)`);
  expect(confirmed).toBeGreaterThan(100);
  expect(bad).toEqual([]);
}, 300_000);
