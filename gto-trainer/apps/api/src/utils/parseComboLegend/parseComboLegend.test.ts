import { describe, expect, it } from "bun:test";
import { parseComboLegend, parseComboLegendRow } from "./parseComboLegend";

describe("parseComboLegendRow", () => {
  it("keeps bet size annotations in the action label", () => {
    expect(parseComboLegendRow("Bet 1.8 (33%) 0.4")).toEqual({
      action: "Bet 1.8 (33%)",
      frequency: 0.4,
    });
    expect(parseComboLegendRow("Allin 97 (1617%) 0.1")).toEqual({
      action: "Allin 97 (1617%)",
      frequency: 0.1,
    });
  });

  it("parses simple actions", () => {
    expect(parseComboLegendRow("Check 99.6")).toEqual({ action: "Check", frequency: 99.6 });
    expect(parseComboLegendRow("Fold 100")).toEqual({ action: "Fold", frequency: 100 });
  });

  it("handles percent-first label formats", () => {
    expect(parseComboLegendRow("Bet 75% (18.75) 12.5")).toEqual({
      action: "Bet 75% (18.75)",
      frequency: 12.5,
    });
  });

  it("returns null for junk", () => {
    expect(parseComboLegendRow("")).toBeNull();
    expect(parseComboLegendRow("Check")).toBeNull(); // no frequency
  });
});

describe("parseComboLegend", () => {
  it("parses and sorts by frequency descending", () => {
    expect(
      parseComboLegend(["Bet 1.8 (33%) 0.4", "Check 99.6"])
    ).toEqual([
      { action: "Check", frequency: 99.6 },
      { action: "Bet 1.8 (33%)", frequency: 0.4 },
    ]);
  });

  it("drops unparseable rows", () => {
    expect(parseComboLegend(["", "Check 50", "garbage"])).toEqual([
      { action: "Check", frequency: 50 },
    ]);
  });
});
