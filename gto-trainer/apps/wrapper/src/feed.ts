/** The panel's large-print feed (launch._feed_add): one line, stamped with the wall clock and the hand number. */
import { strftime } from "./clock";
import { keepLast } from "./py";
import { S } from "./state";

export function feedAdd(line: string): void {
  S.feed.push({ t: strftime("%H:%M:%S"), line, hand: S.handNo });
  keepLast(S.feed, 400);
}

/** print(): the wrapper's log (stdout, which main.ts routes to server.log under the hidden launcher). */
export function log(msg: string): void {
  console.log(msg);
}
