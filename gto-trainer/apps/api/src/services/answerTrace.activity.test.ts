import { describe, expect, it } from "bun:test";
import { activityDuring, trackActivity } from "./answerTrace";

describe("stall lines name what was open (2026-09-26)", () => {
  it("lists requests open across the blocked interval, longest first, and nothing that ended before it", async () => {
    const early = trackActivity("GET /early");
    early();
    await new Promise((r) => setTimeout(r, 30));
    const from = Date.now();
    const heavy = trackActivity("GET /api/dashboard/hands");
    await new Promise((r) => setTimeout(r, 20));
    const probe = trackActivity("POST /api/ingest");
    heavy();
    const to = Date.now();
    const during = activityDuring(from, to);
    probe();
    expect(during.length).toBe(2);
    expect(during[0]).toStartWith("GET /api/dashboard/hands (");
    expect(during[1]).toContain("POST /api/ingest (");
    expect(during[1]).toContain("still open");
    expect(during.join(" ")).not.toContain("/early");
  });
});
