import { describe, it, expect } from "bun:test";
import { buildRangeCompareHtml, shortActionLabel } from "./buildRangeCompareHtml";
import { compareActionRanges, type HandCell } from "../compareActionRanges/compareActionRanges";

const B75 = "Bet 75% (18.75)";
const B50 = "Bet 50% (12.5)";

const cells: HandCell[] = [
  { hand: "AA", actions: { [B75]: 26.2, [B50]: 41 }, inRange: true },
  { hand: "ATo", actions: { [B75]: 86.2, [B50]: 11.5 }, inRange: true },
  { hand: "72o", actions: {}, inRange: false },
];

const input = {
  meta: {
    board: "Ts5h3d",
    position: "SB",
    potLabel: "25",
    url: "https://app.gtowizard.com/solutions?x=1",
    generatedAt: "2026-07-13 12:00",
  },
  a: {
    label: B75,
    rangePct: 49.2,
    combos: 86.81,
    buckets: [{ section: "HANDS", name: "Top pair", pct: 22 }],
  },
  b: {
    label: B50,
    rangePct: 27.9,
    combos: 49.15,
    buckets: [{ section: "HANDS", name: "Top pair", pct: 30.5 }],
  },
  cells,
  cmp: compareActionRanges(cells, B75, B50),
};

describe("shortActionLabel", () => {
  it("drops the bb amount suffix", () => {
    expect(shortActionLabel("Bet 75% (18.75)")).toBe("Bet 75%");
    expect(shortActionLabel("Check")).toBe("Check");
  });
});

describe("buildRangeCompareHtml", () => {
  const html = buildRangeCompareHtml(input);

  it("is a complete standalone document", () => {
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("</html>");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  it("renders all 169 hand cells per grid, three grids", () => {
    expect((html.match(/class="cell/g) ?? []).length).toBe(169 * 3);
    expect(html).toContain(">AKs<");
    expect(html).toContain(">72o<");
  });

  it("shows both actions, board and bucket comparison", () => {
    expect(html).toContain("Bet 75%");
    expect(html).toContain("Bet 50%");
    expect(html).toContain("T♠");
    expect(html).toContain("Top pair");
    expect(html).toContain("86.8 combos");
  });

  it("escapes tooltip content", () => {
    expect(html).toContain("data-tt=\"AA —");
    expect(html).not.toContain("<script>alert");
  });
});
