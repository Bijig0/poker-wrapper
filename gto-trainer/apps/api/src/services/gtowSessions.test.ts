import { describe, expect, it } from "bun:test";
import { GtowSessions, classifyFailure, nextDailyResetMs } from "./gtowSessions";

/** A fresh pool with the default config (secondary first, Elite = heads-up only). */
const pool = () => new GtowSessions();

describe("route", () => {
  it("spends the secondary first on heads-up work", () => {
    expect(pool().route({ multiway: false })).toEqual(["secondary", "primary"]);
  });

  it("sends multiway straight to the primary — Elite's AI cannot take it", () => {
    expect(pool().route({ multiway: true })).toEqual(["primary"]);
  });

  it("treats an unspecified need as heads-up", () => {
    expect(pool().route()).toEqual(["secondary", "primary"]);
  });

  // Brady's rule, 2026-09-21: Elite is for heads-up POSTFLOP; preflop is
  // Ultra's whatever the table size.
  it("sends preflop to the primary first, even heads-up", () => {
    expect(pool().route({ preflop: true, multiway: false })).toEqual(["primary", "secondary"]);
  });

  it("still lets the secondary answer preflop when the primary cannot", () => {
    // the preflop rule is an ORDER, not a capability: Elite solves a heads-up
    // preflop tree fine (measured), so a spent Ultra must not black out preflop
    const p = pool();
    p.noteFailure("primary", 429, "daily limit reached");
    expect(p.route({ preflop: true, multiway: false })).toEqual(["secondary"]);
  });

  it("gives multiway preflop nobody but the primary", () => {
    expect(pool().route({ preflop: true, multiway: true })).toEqual(["primary"]);
  });
});

describe("classifyFailure", () => {
  it("reads an explicit plan refusal as a plan wall", () => {
    expect(classifyFailure(422, "Dynamic/Automatic sizings is currently not supported for 3+ players")).toBe("plan");
    expect(classifyFailure(403, "Your plan does not include this feature")).toBe("plan");
  });

  it("reads Elite's multiway-preflop refusal as a plan wall, not a quota one", () => {
    // the verbatim body, measured 2026-09-21. Read as "quota" it would take
    // the Elite account out of rotation until the next daily reset.
    expect(classifyFailure(403, '{"code": "PREFLOP_MULTIWAY_NOT_ALLOWED", "detail": "Not allowed"}')).toBe("plan");
  });

  it("reads an allowance message as a quota wall", () => {
    expect(classifyFailure(429, "too many requests")).toBe("quota");
    expect(classifyFailure(402, "payment required")).toBe("quota");
    expect(classifyFailure(403, "daily limit exceeded")).toBe("quota");
  });

  it("reads a bare 401 as signed-out", () => {
    expect(classifyFailure(401, "")).toBe("auth");
  });

  it("does not invent a wall out of an ordinary validation error", () => {
    expect(classifyFailure(400, "Invalid board: 'undefined'")).toBeNull();
    expect(classifyFailure(404, "no solution for this spot")).toBeNull();
    expect(classifyFailure(500, "server error")).toBeNull();
  });
});

describe("plan refusals", () => {
  it("record a multiway refusal against the account without walling it", () => {
    const p = pool();
    p.noteFailure("secondary", 403, '{"code": "PREFLOP_MULTIWAY_NOT_ALLOWED", "detail": "Not allowed"}', { multiway: true, preflop: true });
    const st = p.status().find((s) => s.id === "secondary")!;
    expect(st.multiwayRefused).toBe(true);
    expect(st.blockedUntilMs).toBeNull();
    // and its heads-up postflop work is untouched
    expect(p.route({ multiway: false })).toEqual(["secondary", "primary"]);
  });

  it("stop multiway routing to that account but keep its heads-up work", () => {
    const p = pool();
    p.noteFailure("primary", 403, "multiway is not included in your plan", { multiway: true });
    expect(p.route({ multiway: true })).toEqual([]);
    // the account is still perfectly good for heads-up — a plan wall is narrower than a block
    expect(p.route({ multiway: false })).toEqual(["secondary", "primary"]);
  });

  it("are permanent — success on other work does not clear them", () => {
    const p = pool();
    p.noteFailure("primary", 403, "not available on your plan", { multiway: true });
    p.noteSuccess("primary");
    expect(p.route({ multiway: true })).toEqual([]);
  });

  it("are cleared by an explicit reset", () => {
    const p = pool();
    p.noteFailure("primary", 403, "not available on your plan", { multiway: true });
    p.reset("primary");
    expect(p.route({ multiway: true })).toEqual(["primary"]);
  });
});

describe("quota walls", () => {
  it("take the spent account out of rotation and leave the other one working", () => {
    const p = pool();
    p.noteFailure("secondary", 429, "daily limit reached");
    expect(p.route({ multiway: false })).toEqual(["primary"]);
  });

  it("hold until the daily reset, not for a fixed nap", () => {
    const p = pool();
    p.noteFailure("secondary", 429, "daily limit reached");
    const st = p.status().find((s) => s.id === "secondary")!;
    expect(st.blockedKind).toBe("quota");
    expect(st.blockedUntilMs).toBe(nextDailyResetMs());
  });

  it("leave a last-ditch candidate when every session is walled", () => {
    const p = pool();
    p.noteFailure("secondary", 429, "daily limit reached");
    p.noteFailure("primary", 429, "daily limit reached");
    expect(p.route({ multiway: false })).toEqual([]);
    // routeIgnoringBlocks is what bestToken falls back on, so a stale quota
    // guess can never take the whole answer chain down
    expect(p.routeIgnoringBlocks({ multiway: false })).toEqual(["secondary", "primary"]);
  });
});

describe("soft failures", () => {
  it("nap briefly rather than until the daily reset", () => {
    const p = pool();
    p.noteFailure("secondary", 401, "");
    const st = p.status().find((s) => s.id === "secondary")!;
    expect(st.blockedKind).toBe("auth");
    expect(st.blockedUntilMs! - Date.now()).toBeLessThan(2 * 60_000);
  });

  it("clear as soon as work gets through again", () => {
    const p = pool();
    p.noteFailure("secondary", 401, "");
    expect(p.route({ multiway: false })).toEqual(["primary"]);
    p.noteSuccess("secondary");
    expect(p.route({ multiway: false })).toEqual(["secondary", "primary"]);
  });
});

describe("status", () => {
  it("reports both sessions with their plan capability", () => {
    const rows = pool().status();
    expect(rows.map((r) => r.id)).toEqual(["secondary", "primary"]);
    expect(rows.find((r) => r.id === "secondary")!.multiway).toBe(false);
    expect(rows.find((r) => r.id === "primary")!.multiway).toBe(true);
  });

  it("does not claim a session is down when nobody probed it", () => {
    // status() makes no network call, so it cannot tell a client that is not
    // running from one that is running and signed out — saying "down" there
    // told the wrapper's preflight "nothing listening" about a live client.
    for (const r of pool().status()) expect(r.state).toBe("unknown");
  });

  it("counts a plan-refused account as no longer multiway-capable", () => {
    const p = pool();
    p.noteFailure("primary", 403, "not available on your plan", { multiway: true });
    expect(p.status().find((r) => r.id === "primary")!.multiway).toBe(false);
    expect(p.status().find((r) => r.id === "primary")!.multiwayRefused).toBe(true);
  });
});
