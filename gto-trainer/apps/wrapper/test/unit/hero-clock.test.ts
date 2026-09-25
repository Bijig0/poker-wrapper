/**
 * heroClockOf: hero's countdown, read from the number under the seat label in hero's seat box. Nodes and box are
 * the recorded ones (debug/session_20260925_044840 frames 1946-1974, hero = displayed seat 3).
 */
import { expect, test } from "bun:test";
import { heroClockOf } from "../../src/ignition/dom";

const me = { seat: 2, num: 3, me: true, box: { x: 445, y: 1287, w: 160, h: 140 } };
const other = [{ text: "1", x: 853, y: 1064, w: 10, h: 20 }, { text: "4", x: 67, y: 1302, w: 10, h: 20 }, { text: "5", x: 67, y: 1064, w: 10, h: 20 }];
const label = { text: "3", x: 460, y: 1378, w: 10, h: 20 };
const d = { seatQa: [me] };

test("hero's clock from the seat box", () => {
  expect(heroClockOf(d, [...other, label, { text: "15", x: 460, y: 1400, w: 16, h: 17 }])).toBe(15);
  expect(heroClockOf(d, [...other, label, { text: "8", x: 468, y: 1416, w: 8, h: 17 }])).toBe(8);
  expect(heroClockOf(d, [...other, label, { text: "3", x: 468, y: 1416, w: 8, h: 17 }])).toBe(3);   // clock == seat label
  expect(heroClockOf(d, [...other, label])).toBe(null);                                              // not on the clock
  expect(heroClockOf(d, [...other, { text: "9", x: 468, y: 1416, w: 8, h: 17 }])).toBe(null);        // no label → no guess
  expect(heroClockOf({ seatQa: [] }, [...other, label])).toBe(null);                                 // hero's seat unknown
});
