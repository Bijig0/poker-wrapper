import { describe, expect, it } from "bun:test";
import { FLIGHT_MAX_MS, GtowSessions, ROUTED_MAX_MS, routeInFlightOn, routeWhy } from "./gtowSessions";

/**
 * SOLVES IN FLIGHT FIRST (2026-10-14, hand 4924409679): GTO Wizard queues an account's custom solves, so inside a
 * routing group the account with no solve of ours still running comes before the trailing-hour order.
 */
const pool = (env: Record<string, string | undefined> = {}) => new GtowSessions({ env });

describe("routing by solves in flight", () => {
  it("is on unless GTOW_ROUTE_INFLIGHT says off", () => {
    expect(routeInFlightOn({})).toBe(true);
    expect(routeInFlightOn({ GTOW_ROUTE_INFLIGHT: "on" })).toBe(true);
    expect(routeInFlightOn({ GTOW_ROUTE_INFLIGHT: "off" })).toBe(false);
    expect(routeInFlightOn({ GTOW_ROUTE_INFLIGHT: "0" })).toBe(false);
  });

  it("an account with a solve running goes behind an idle one; its first answered node brings it back", () => {
    const p = pool();
    expect(p.route({ multiway: false })).toEqual(["secondary", "primary"]);       // the preference order, counts level
    p.noteSolvePosted("secondary", "sol-a");
    expect(p.inFlight("secondary")).toBe(1);
    expect(p.route({ multiway: false })).toEqual(["primary", "secondary"]);
    p.noteSolveReady("sol-a");
    expect(p.inFlight("secondary")).toBe(0);
    expect(p.route({ multiway: false })).toEqual(["secondary", "primary"]);
  });

  it("fewer solves running wins when both are busy; ties keep the trailing-hour order", () => {
    const p = pool();
    p.noteSolvePosted("secondary", "s1"); p.noteSolvePosted("secondary", "s2");
    p.noteSolvePosted("primary", "p1");
    expect(p.route({ multiway: false })).toEqual(["primary", "secondary"]);
    p.noteSolvePosted("primary", "p2");
    expect(p.route({ multiway: false })).toEqual(["secondary", "primary"]);
  });

  it("never crosses a routing group: multiway work still goes to the Ultra even while it solves", () => {
    const p = pool();
    p.noteSolvePosted("primary", "p1");
    expect(p.route({ multiway: true })).toEqual(["primary"]);
    expect(p.route({ preflop: true, multiway: false })[0]).toBe("primary");       // preflop's group is the Ultras
  });

  // 2026-10-14, hand 4924571722: the three collapse trees of a 4-way flop were routed within 50 ms; each saw an empty ultra-2
  // (a solve counts only once its POST has returned) and all three queued on it
  it("a tree just routed counts as in flight at once, until its solve is posted, so trees routed in the same instant spread", () => {
    const p = pool();
    const t = Date.now();
    expect(p.route({ multiway: false })).toEqual(["secondary", "primary"]);
    p.noteTreeRouted("secondary", t);
    expect(p.inFlight("secondary", t)).toBe(1);
    expect(p.route({ multiway: false })).toEqual(["primary", "secondary"]);     // the next tree goes to the other account
    p.noteSolvePosted("secondary", "s1", t + 400);                               // the POST came back: the solve replaces the routed tree
    expect(p.inFlight("secondary", t + 400)).toBe(1);
    p.noteSolveReady("s1");
    expect(p.inFlight("secondary", t + 500)).toBe(0);
  });

  it("a routed tree whose POST never came back is forgotten after ROUTED_MAX_MS", () => {
    const p = pool();
    const t = Date.now();
    p.noteTreeRouted("primary", t);
    expect(p.inFlight("primary", t + ROUTED_MAX_MS)).toBe(1);
    expect(p.inFlight("primary", t + ROUTED_MAX_MS + 1)).toBe(0);
  });

  it("idleFor: the accounts a hedge may go to — a live token in hand, not the hung owner, nothing of ours running or routed", () => {
    const p = pool();
    const live = (id: "primary" | "secondary") => { const s = (p as any).sessions.get(id); s.token = "t"; s.tokenExpMs = Date.now() + 3_600_000; };
    expect(p.idleFor({ multiway: false }, ["secondary"])).toEqual([]);           // no token in hand anywhere: nobody
    live("primary"); live("secondary");
    expect(p.idleFor({ multiway: false }, ["secondary"])).toEqual(["primary"]);
    expect(p.idleFor({ multiway: false }, [])).toEqual(["secondary", "primary"]);
    p.noteSolvePosted("primary", "p1");
    expect(p.idleFor({ multiway: false }, ["secondary"])).toEqual([]);
    p.noteSolveReady("p1");
    expect(p.idleFor({ multiway: false }, ["secondary"])).toEqual(["primary"]);
    p.noteTreeRouted("primary");
    expect(p.idleFor({ multiway: false }, ["secondary"])).toEqual([]);
  });

  it("a solve nobody reads stops counting after FLIGHT_MAX_MS", () => {
    const p = pool();
    const t0 = 1_000_000;
    p.noteSolvePosted("secondary", "lost", t0);
    expect(p.inFlight("secondary", t0 + FLIGHT_MAX_MS - 1)).toBe(1);
    expect(p.inFlight("secondary", t0 + FLIGHT_MAX_MS + 1)).toBe(0);
  });

  it("GTOW_ROUTE_INFLIGHT=off: the trailing-hour order alone, as 2026-10-08..14", () => {
    const p = pool({ GTOW_ROUTE_INFLIGHT: "off" });
    p.noteSolvePosted("secondary", "s1");
    expect(p.route({ multiway: false })).toEqual(["secondary", "primary"]);
    expect(p.explainRoute({ multiway: false }).flight).toEqual({ secondary: 0, primary: 0 });
  });

  it("the [gtow-route] reason names the solves in flight and why the idle account took the tree", () => {
    const p = pool();
    p.noteSolvePosted("secondary", "s1");
    const ex = p.explainRoute({ multiway: false });
    const why = routeWhy("primary", ex, ex.ids);
    expect(why).toMatch(/^least-loaded \(no solve of ours running on it\)/);
    expect(why).toMatch(/solves in flight: secondary 1/);
    p.noteSolveReady("s1");
    const ex2 = p.explainRoute({ multiway: false });
    expect(routeWhy("secondary", ex2, ex2.ids)).toMatch(/^least-loaded; trailing hour/);
  });
});
