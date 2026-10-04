import { describe, expect, test } from "bun:test";
import { record4920544353 } from "./fixtures";
import { headerTime, ignitionRecordToText, type IgnitionRecordBody } from "./ignitionText";

const text = ignitionRecordToText("4920544353", "cash", record4920544353 as IgnitionRecordBody);
const lines = text.split("\n");

describe("ignitionRecordToText (hand 4920544353)", () => {
  test("header: hand number, table, Ignition's own clock on the local day", () => {
    expect(lines[0]).toBe("Ignition Hand #4920544353 TBL#37857592 HOLDEM No Limit - 2026-09-25 03:05:05");
  });

  test("seats in seat order with the starting stack; hero keeps its [ME]", () => {
    expect(lines.slice(1, 7)).toEqual([
      "Seat 1: Small Blind ($2.62 in chips)",
      "Seat 2: Big Blind ($1.70 in chips)",
      "Seat 3: UTG ($5.22 in chips)",
      "Seat 4: UTG+1 ($11.33 in chips)",
      "Seat 5: UTG+2 [ME] ($5 in chips)",
      "Seat 6: Dealer ($1.71 in chips)",
    ]);
  });

  test("only known hole cards are dealt; no empty brackets anywhere", () => {
    expect(lines).toContain("UTG+2  [ME] : Card dealt to a spot [Kd Jh] ");
    expect(lines.filter((l) => l.includes("Card dealt to a spot"))).toHaveLength(1);
    expect(text).not.toContain("[]");
  });

  test("a raise prints the chips added and the total raised to", () => {
    expect(lines).toContain("UTG+2  [ME] : Raises $0.13 to $0.13");
    expect(lines).toContain("Dealer : Raises $0.50 to $0.50");
    expect(lines).toContain("UTG+2  [ME] : Calls $0.45 ");
  });

  test("streets, the uncalled bet and the result; the hero's table deposit is left out", () => {
    expect(lines).toContain("*** FLOP *** [6s 8h Ks]");
    expect(lines).toContain("*** TURN *** [6s 8h Ks] [Qh]");
    expect(lines).toContain("Dealer : Return uncalled portion of bet $1.08 ");
    expect(lines).toContain("Dealer : Hand result $1.50 ");
    expect(text).not.toContain("Table deposit");
    expect(lines.slice(-4)).toEqual(["*** SUMMARY ***", "Total Pot($1.57)", "Board [6s 8h Ks Qh]", ""]);
  });

  test("one hand, one header", () => {
    expect(lines.filter((l) => l.startsWith("Ignition Hand #"))).toHaveLength(1);
  });
});

describe("raise after chips already in", () => {
  test("a 3-bet from the big blind adds the raise-to minus its blind", () => {
    const body: IgnitionRecordBody = {
      startTime: "2026-10-03T21:04:28Z", tableName: "TBL#1 - $0.02/$0.05 NL - 6P", potSize: "$0.40", communityCards: [],
      players: [{ position: "Big Blind", seat: "1", startEndAmount: "$5/$5.20" }, { position: "Dealer", seat: "2", startEndAmount: "$5/$4.80" }],
      action: [
        { position: "Big Blind", action: "Big blind", data: ["$0.05"], time: "17:04:28" },
        { position: "Dealer", action: "Raises", data: ["$0.12"] },
        { position: "Big Blind", action: "Raises", data: ["$0.40"] },
        { position: "Dealer", action: "All-in(raise)", data: ["$5"] },
      ],
    };
    const l = ignitionRecordToText("1", "cash", body).split("\n");
    expect(l).toContain("Big Blind : Raises $0.35 to $0.40");
    expect(l).toContain("Dealer : All-in(raise) $4.88 to $5");
  });
});

describe("dead button, hand over preflop", () => {
  test("no Set dealer line and no Board line rather than empty brackets", () => {
    const body: IgnitionRecordBody = {
      startTime: "2026-10-03T21:04:28Z", tableName: "TBL#1 - $0.02/$0.05 NL - 6P", potSize: "$0.07", communityCards: ["", "", "", "", ""],
      players: [{ position: "Small Blind", seat: "6", startEndAmount: "$2/$1.98" }, { position: "Big Blind [ME]", seat: "1", startEndAmount: "$5/$5.02" }],
      action: [
        { position: "", action: "Set dealer", data: [], time: "17:04:28" },
        { position: "Small Blind", action: "Small Blind", data: ["$0.02"] },
        { position: "Big Blind  [ME]", action: "Big blind", data: ["$0.05"] },
        { position: "Small Blind", action: "Folds", data: [] },
      ],
    };
    const t = ignitionRecordToText("1", "cash", body);
    expect(t).not.toContain("[]");
    expect(t).not.toContain("Set dealer");
    expect(t).not.toContain("Board");
    expect(t).toContain("Small Blind : Folds \n");
  });
});

describe("headerTime", () => {
  test("Ignition's clock four hours behind UTC lands on the previous day past midnight UTC", () => {
    expect(headerTime("2026-10-04T02:10:00Z", "22:10:00")).toBe("2026-10-03 22:10:00");
  });
  test("no clock: UTC as is", () => {
    expect(headerTime("2026-10-04T02:10:00Z", undefined)).toBe("2026-10-04 02:10:00");
  });
});
