/**
 * COINPOKER PANELS AND TABLES CLOSE TOGETHER (2026-10-01, Brady): closing a panel closes just it and its table; closing
 * the leader closes them all. Three pieces, each pinned here:
 *   - the profile match that closed the WRONG windows: `.profile-panel` must not match `.profile-panel-t2`;
 *   - cpCloseOut's order: sit out, let the hand finish, end the session, close the table, close the panel, and keep
 *     the process only when it is the main one and the leader window is up;
 *   - the table card's money terms: the rake cap and the ante in table currency and in big blinds.
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime, time } from "../../src/clock";
import { S, resetState } from "../../src/state";
import { usesProfileDir } from "../../src/windows";
import { cpCloseOut, cpCloseSeams } from "../../src/session";
import { cpTermsOf } from "../../src/view";

test("a profile path matches itself only — never a longer profile it is a prefix of", () => {
  const main = "C:\\Users\\Brady\\poker-data\\profiles\\.profile-panel";
  const brave = (dir: string, quoted = false) =>
    `"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --app=http://127.0.0.1:7700/panel ${quoted ? `"--user-data-dir=${dir}"` : `--user-data-dir=${dir}`} --window-position=1,2`;
  expect(usesProfileDir(brave(main), main)).toBe(true);
  expect(usesProfileDir(brave(main + "-t2"), main)).toBe(false);          // panel #2: the bug
  expect(usesProfileDir(brave(main + "-fake"), main)).toBe(false);
  expect(usesProfileDir(brave(main + "-t2"), main + "-t2")).toBe(true);
  expect(usesProfileDir(`brave.exe --type=renderer --user-data-dir=${main}`, main)).toBe(true);   // a child, at the end
  const spaced = "C:\\Users\\A B\\profiles\\.profile-panel";
  expect(usesProfileDir(brave(spaced, true), spaced)).toBe(true);        // quoted whole argument
  expect(usesProfileDir(brave(spaced + "-t3", true), spaced)).toBe(false);
});

function rig(o: { seated?: boolean; handTicks?: number; leaderUp?: boolean; closes?: boolean } = {}) {
  const { seated = true, handTicks = 3, leaderUp = false, closes = true } = o;
  resetState();
  setFakeTime(1_790_760_000);
  const calls: string[] = [];
  let left = handTicks;
  const saved = { ...cpCloseSeams };
  Object.assign(cpCloseSeams, {
    room: () => "31st NL 0.05-0.10 EV-INRIT-(A) 1453386",
    heroSeated: () => seated,
    sitOut: async () => { calls.push("sit out"); return { ok: true }; },
    heroInHand: () => { if (left > 0) { left--; return true; } return false; },
    closeTable: async (room: string) => { calls.push(`close table ${room.slice(-7)}`); return closes; },
    endSession: async (note: string) => { calls.push(`end session (${note})`); S.session.id = null; return { ok: true }; },
    closePanel: async () => { calls.push("close panel"); return 1; },
    leaderUp: () => leaderUp,
    exit: (why: string) => { calls.push(`exit (${why})`); },
  });
  const events: string[] = [];
  S.session.id = "session_test";
  S.sessions = { event: (_sid: string, kind: string) => events.push(kind), end: () => {} } as any;
  const undo = () => { Object.assign(cpCloseSeams, saved); realTime(); resetState(); };
  const done = async () => { for (let i = 0; i < 400 && S.cpClosing; i++) await new Promise((r) => setTimeout(r, 5)); };
  return { calls, events, undo, done };
}

test("close-out order: sit out → the hand finishes → session ends → table closes → panel closes → process ends", async () => {
  const { calls, events, undo, done } = rig({ handTicks: 3 });
  try {
    const t0 = time();
    const r = cpCloseOut("the panel window was closed");
    expect(r.ok).toBe(true);
    expect(S.cpClosing?.why).toBe("the panel window was closed");
    expect(cpCloseOut("again").ok).toBe(false);                            // one close-out at a time
    await done();
    expect(calls).toEqual(["sit out", "end session (ended: the panel window was closed)", "close table 1453386", "close panel", "exit (the panel window was closed)"]);
    expect(time() - t0).toBeGreaterThanOrEqual(3);                         // it waited for the hand (1 s a tick)
    expect(events).toContain("cp-close-out");
    expect(events).toContain("cp-table-closed");
    expect(S.session.id).toBeNull();                                       // the session ended before the table closed
    expect(S.cpClosing).toBeNull();
  } finally {
    undo();
  }
});

test("the main panel's process stays while the leader window is up; not seated = no sit-out press", async () => {
  const { calls, undo, done } = rig({ seated: false, handTicks: 0, leaderUp: true });
  try {
    cpCloseOut("the panel window was closed");
    await done();
    expect(calls).toEqual(["end session (ended: the panel window was closed)", "close table 1453386", "close panel"]);   // no sit-out, no exit
  } finally {
    undo();
  }
});

test("a table the client will not close is reported, and the panel still closes", async () => {
  const { calls, undo, done } = rig({ handTicks: 0, closes: false });
  try {
    cpCloseOut("ended from the leader");
    await done();
    expect(calls).toEqual(["sit out", "end session (ended: ended from the leader)", "close table 1453386", "close panel", "exit (ended from the leader)"]);
  } finally {
    undo();
  }
});

test("the table's money terms: the rake cap and the ante, in table currency and big blinds", () => {
  const rake = { rake: 5, rakeHeadsUp: 5, rakeCap: 0.6, isPotRakePf: true };
  // no ante: the live NL 0.05-0.10 ring table of 2026-10-01
  const none = cpTermsOf({ bb: 0.1, sb: 0.05, ante: 0, anteBb: 0, liveSeats: [1, 2, 3, 4, 5, 6] }, {}, rake);
  expect(none.rake).toEqual({ pct: 5, pctHeadsUp: 5, cap: 0.6, capBb: 6, preflopPots: true });
  expect(none.ante.has).toBe(false);
  expect(none.ante.total).toBe(0);
  // an ante table: 0.02 each at 0.05/0.10 (0.2bb), six dealt; the hand collected 1.2bb
  const ante = cpTermsOf({ bb: 0.1, sb: 0.05, ante: 0.02, anteBb: 1.2, liveSeats: [1, 2, 3, 4, 5, 6] }, {}, rake);
  expect(ante.ante).toEqual({ per: 0.02, perBb: 0.2, total: 0.12, totalBb: 1.2, dealt: 6, has: true });
  // before a hand has collected: per player × dealt
  const early = cpTermsOf({ bb: 0.1, sb: 0.05, ante: 0.02, anteBb: 0, liveSeats: [1, 2, 3, 4, 5] }, {}, rake);
  expect(early.ante.total).toBe(0.1);
  expect(early.ante.totalBb).toBe(1);
  // no hand yet: the table's properties; its ante unknown stays unknown, not zero
  const bare = cpTermsOf(null, { bigBlind: 2, smallBlind: 1 }, null);
  expect(bare.bb).toBe(2);
  expect(bare.ante.has).toBeNull();
  expect(bare.rake).toBeNull();
});
