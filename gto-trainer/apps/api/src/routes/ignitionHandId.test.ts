import { expect, test } from "bun:test";
import { isIgnitionHandId } from "./dashboard";

// 2026-09-25 (7673c54d) the pattern lost its backslash (/^d{10}$/): every real hand number was refused, so the hand
// page's Actual tab, hhAudit and the background hand-history check skipped every hand without a word
test("isIgnitionHandId takes a 10-digit Ignition hand number", () => {
  expect(isIgnitionHandId("4920637334")).toBe(true);
  expect(isIgnitionHandId("dddddddddd")).toBe(false);
  expect(isIgnitionHandId("9000123")).toBe(false);            // State Tester's synthetic ids
  expect(isIgnitionHandId("123456789012345")).toBe(false);    // CoinPoker's are longer
  expect(isIgnitionHandId(null)).toBe(false);
});
