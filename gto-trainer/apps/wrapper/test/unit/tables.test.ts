/**
 * Port of tests/test_tables.py — which window is whose when four tables share one browser: pin() claims, never
 * borrows a lost window, stale claims expire, a slot on the lobby never steals a seated slot's table; a claim is
 * not presence; the press lock (waits, then presses anyway; breaks a stale holder); the client/panel rectangles;
 * physical → DIP on a mixed-DPI desktop; and the fullscreen policy.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realTime, time } from "../../src/clock";
import { C } from "../../src/config";
import * as tables from "../../src/tables";
import { wantFullscreen, winSeams } from "../../src/windows";
import { checker, J, scratchDirs } from "./helpers";

const IS_TABLE = (u: string) => {
  const low = u.toLowerCase();
  return low.includes("poker-game") ? 1 : low.includes("ignition") ? 2 : null;
};
const T = [{ id: "A", url: "https://ignition/static/poker-game/?t=1" }, { id: "B", url: "https://ignition/static/poker-game/?t=2" },
           { id: "C", url: "https://ignition/static/poker-game/?t=3" }, { id: "D", url: "https://ignition/static/poker-game/?t=4" },
           { id: "P", url: "http://127.0.0.1:7700/panel" }];

test("which window is whose, when four tables share one browser", async () => {
  const { fails, check } = checker();
  const tmp = scratchDirs("tables-test-");
  realTime();
  const claimDir = join(tmp, "data", "tables");
  const claims = () => (existsSync(claimDir) ? readdirSync(claimDir).filter((f) => f.endsWith(".json")) : []);
  const reset = () => { for (const f of claims()) rmSync(join(claimDir, f)); };
  const env0 = Object.fromEntries(["TABLE_SLOT", "TABLE_COUNT"].map((k) => [k, process.env[k]]));
  const id = (x: any) => (x || {}).id ?? null;
  try {
    for (const [raw, want] of [["", null], ["1", 1], ["4", 4], ["0", null], ["5", null], ["x", null]] as [string, number | null][]) {
      if (raw) process.env.TABLE_SLOT = raw;
      else delete process.env.TABLE_SLOT;
      check(`TABLE_SLOT='${raw}' → ${want}`, tables.slot() === want, String(tables.slot()));
    }
    delete process.env.TABLE_SLOT;

    reset();
    check("takes the first match", id(tables.pin(T, IS_TABLE, null)) === "A");
    check("  ... and writes no claim", !claims().length, J(claims()));
    check("no candidates → None", tables.pin([T[4]!], IS_TABLE, null) === null);

    reset();
    const got = [1, 2, 3, 4].map((n) => id(tables.pin(T, IS_TABLE, n)));
    check("four slots take four different windows", new Set(got).size === 4 && !got.includes(null), J(got));
    check("  ... and each wrote a claim", claims().length === 4);
    const shuffled = [T[2]!, T[0]!, T[3]!, T[1]!, T[4]!];
    check("a claim survives the target list being reordered", id(tables.pin(shuffled, IS_TABLE, 1)) === got[0]);
    check("  ... for every slot", J([1, 2, 3, 4].map((n) => id(tables.pin(shuffled, IS_TABLE, n)))) === J(got));

    reset();
    tables.pin(T, IS_TABLE, 1);
    tables.pin(T, IS_TABLE, 2);
    const onlyA = [T[0]!, T[4]!];
    check("slot 2 gets None rather than slot 1's window", tables.pin(onlyA, IS_TABLE, 2) === null);
    check("  ... and slot 1 still has its own", id(tables.pin(onlyA, IS_TABLE, 1)) === "A");

    reset();
    tables.pin(T, IS_TABLE, 1);
    const stale = { ...tables.readClaims().get(1), at: time() - tables.CLAIM_TTL_S - 5 };
    writeFileSync(join(claimDir, "1.json"), JSON.stringify(stale));
    check("a stale claim is not a holding", tables.takenByOthers(2).size === 0, J([...tables.takenByOthers(2)]));
    check("  ... so another slot may take that window", id(tables.pin([T[0]!, T[4]!], IS_TABLE, 2)) === "A");
    check("a fresh claim IS a holding", J([...tables.takenByOthers(1)]) === J(["A"]), J([...tables.takenByOthers(1)]));

    reset();
    tables.pin(T, IS_TABLE, 1);
    tables.release(1);
    check("a released window is free at once", tables.takenByOthers(2).size === 0);

    reset();
    const LOBBY_1 = { id: "A", url: "https://ignition.eu/poker/lobby" };
    const TABLE_2 = { id: "B", url: "https://ignition.eu/static/poker-game/?t=2" };
    const mixed = [TABLE_2, LOBBY_1, T[4]!];
    check("slot 1 claims the lobby window it is on", id(tables.pin([LOBBY_1, T[4]!], IS_TABLE, 1)) === "A");
    check("slot 2 claims the table window", id(tables.pin(mixed, IS_TABLE, 2)) === "B");
    check("slot 1 KEEPS its lobby even though a table page ranks higher", id(tables.pin(mixed, IS_TABLE, 1)) === "A");
    check("  ... and slot 2 still has the table", id(tables.pin(mixed, IS_TABLE, 2)) === "B");
    const SEATED_1 = { id: "A", url: "https://ignition.eu/static/poker-game/?t=1" };
    check("a claim follows its window from lobby to table", id(tables.pin([SEATED_1, TABLE_2, T[4]!], IS_TABLE, 1)) === "A");

    reset();
    check("a table page is preferred to a lobby page on a FIRST claim", id(tables.pin([LOBBY_1, TABLE_2], IS_TABLE, 1)) === "B");
    reset();
    check("  ... and with no slot at all", id(tables.pin([LOBBY_1, TABLE_2], IS_TABLE, null)) === "B");
    check("the panel is never a candidate", tables.pin([T[4]!], IS_TABLE, null) === null);

    // a claim is not presence
    reset();
    delete process.env.TABLE_SLOT;
    tables.pin(T, IS_TABLE, 1, { panelPort: 7700 });
    tables.pin(T, IS_TABLE, 2, { panelPort: 7710 });
    check("two claims are written", claims().length === 2, J(claims()));
    check("  ... and NOTHING is present because of them", J(tables.registry()) === "[]" && J(tables.peers()) === "[]", J(tables.registry()));

    // the press lock
    reset();
    const lockFile = join(claimDir, "press.lock");
    delete process.env.TABLE_SLOT;
    let lk = await tables.pressLock();
    check("single table: no lock, no file", !existsSync(lockFile) && lk.waited === 0);
    lk.release();
    process.env.TABLE_SLOT = "2";
    lk = await tables.pressLock();
    check("multi-table: the lock is held", existsSync(lockFile));
    check("  ... uncontended, so no wait", lk.waited < 0.5, String(lk.waited));
    lk.release();
    check("  ... and released on the way out", !existsSync(lockFile));
    const held = await tables.pressLock();
    const t0 = performance.now();
    lk = await tables.pressLock(0.2);
    const waited = (performance.now() - t0) / 1000;
    check("a contended press waits", waited >= 0.15 && waited < 1.5, waited.toFixed(2));
    check("  ... then presses anyway rather than missing the decision", lk.forced === true);
    lk.release();
    held.release();
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: time() - tables.PRESS_TTL_S - 1 }));
    lk = await tables.pressLock(1.0);
    check("a stale holder is broken, not waited on", lk.forced === false && lk.waited < 0.5, String(lk.waited));
    lk.release();
    process.env.TABLE_SLOT = "1";
    (await tables.pressLock()).release();
    lk = await tables.pressLock(0.2);
    check("sequential locks do not block each other", lk.forced === false);
    lk.release();
    delete process.env.TABLE_SLOT;

    // layout
    let EXT = { x: 2880, y: 0, w: 2560, h: 1504, primary: false };
    const LAP = { x: 0, y: 0, w: 2880, h: 1704, primary: true };
    check("table_rect is gone, not merely unused", !("tableRect" in tables));
    const one = tables.clientRect(1, EXT);
    check("one table keeps the old rectangle", J(one) === J({ x: 2880, y: 0, w: 1792, h: 1504 }), J(one));
    check("  ... with the panel down the strip beside it", J(tables.panelRect(1, 1, EXT, LAP)) === J({ x: 4672, y: 0, w: 768, h: 1504 }));
    for (const n of [2, 4]) {
      check(`${n} tables give the client the WHOLE monitor`, J(tables.clientRect(n, EXT)) === J({ x: 2880, y: 0, w: 2560, h: 1504 }));
    }
    check("  ... which is wider per table than the single-table strip ever was",
          Math.floor(tables.clientRect(2, EXT).w / 2) > Math.floor(tables.clientRect(1, EXT).w / 2));
    check("  ... and it does not spill off the monitor", tables.clientRect(4, EXT).x + tables.clientRect(4, EXT).w === EXT.x + EXT.w);
    const overlaps = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    check("the client and the panels are not on the same pixels", !overlaps(tables.clientRect(2, EXT), tables.panelRect(1, 2, EXT, LAP)));
    check("  ... and the panels never overlap each other", !overlaps(tables.panelRect(1, 2, EXT, LAP), tables.panelRect(2, 2, EXT, LAP)));
    check("panels tile the other screen once there is more than one table", J(tables.panelRect(2, 4, EXT, LAP)) === J(tables.grid(1, 4, LAP)));
    check("  ... and fall back to the table monitor when there is no other", J(tables.panelRect(2, 4, EXT, null)) === J(tables.grid(1, 4, EXT)));
    process.env.TABLE_COUNT = "4";
    check("the count comes from the environment", tables.count() === 4);
    process.env.TABLE_COUNT = "9";
    check("  ... clamped to Ignition's ceiling", tables.count() === tables.MAX_TABLES);
    delete process.env.TABLE_COUNT;
    check("  ... and defaults to one", tables.count() === 1);

    // physical pixels vs Chrome's DIP, on a MIXED-DPI desktop
    const MIX = [{ x: 0, y: 0, w: 2880, h: 1704, scale: 2.0 }, { x: 2880, y: 0, w: 2560, h: 1552, scale: 1.0 }];
    const lay = Object.fromEntries(tables.dipLayout(MIX).map((m: any) => [m.x, m]));
    check("the primary starts at the DIP origin", J([lay[0].dipX, lay[0].dipW]) === J([0, 1440]), J(lay[0]));
    check("the screen to its right starts where the primary's DIP ENDS", J([lay[2880].dipX, lay[2880].dipW]) === J([1440, 2560]), J(lay[2880]));
    const ext2 = { x: 2880, y: 0, w: 2560, h: 1552 };
    const tiles = [0, 1, 2, 3].map((i) => tables.grid(i, 4, ext2));
    const dips = tiles.map((t) => tables.toDip(t, MIX));
    check("a 2x2 of that screen converts to its DIP cells",
          J(dips.map((d) => [d.x, d.y, d.w, d.h])) === J([[1440, 0, 1280, 776], [2720, 0, 1280, 776], [1440, 776, 1280, 776], [2720, 776, 1280, 776]]), J(dips));
    const rightEdge = lay[2880].dipX + lay[2880].dipW;
    check("  ... every tile lands ON the desktop", dips.every((d) => d.x + d.w <= rightEdge));
    check("  ... which the naive divide did not", !tiles.every((t) => Math.round(t.x / 1.0) + t.w <= rightEdge));
    const SAME = [{ x: 0, y: 0, w: 1920, h: 1080, scale: 1.0 }];
    check("one screen at 100% converts to itself", J(tables.toDip({ x: 100, y: 50, w: 800, h: 600 }, SAME)) === J({ x: 100, y: 50, w: 800, h: 600 }));
    check("a rect on no known screen is left alone", J(tables.toDip({ x: 9999, y: 0, w: 10, h: 10 }, SAME)) === J({ x: 9999, y: 0, w: 10, h: 10 }));

    EXT = { x: 2880, y: 0, w: 2560, h: 1552, primary: false };
    const one2 = tables.clientRect(1, EXT), two = tables.clientRect(2, EXT);
    check("one table keeps the 70/30 split", J([one2.w, one2.h]) === J([Math.trunc(2560 * tables.TABLE_FRAC), 1552]), J(one2));
    check("two tables take the monitor whole", J([two.x, two.w, two.h]) === J([2880, 2560, 1552]), J(two));
    check("  ... and four do too (the client tiles inside it)", J(tables.clientRect(4, EXT)) === J(two));

    // the fullscreen POLICY
    const mons0 = winSeams.monitors;
    const full0 = C.TABLE_FULLSCREEN;
    const twoScreens = [EXT, { x: 0, y: 0, w: 2880, h: 1704, primary: true }];
    try {
      winSeams.monitors = () => twoScreens;
      C.TABLE_FULLSCREEN = "multi";
      check("one table is never fullscreen (its panel is in the strip beside it)", wantFullscreen(1) === false);
      check("two and four are", wantFullscreen(2) && wantFullscreen(4));
      winSeams.monitors = () => [EXT];
      check("  ... but not on a single-screen desktop — that would cover the panels", wantFullscreen(4) === false);
      C.TABLE_FULLSCREEN = "always";
      check("TABLE_FULLSCREEN=always overrides both", wantFullscreen(1) && wantFullscreen(4));
      C.TABLE_FULLSCREEN = "never";
      winSeams.monitors = () => twoScreens;
      check("TABLE_FULLSCREEN=never overrides the other way", wantFullscreen(4) === false);
    } finally {
      winSeams.monitors = mons0;
      C.TABLE_FULLSCREEN = full0;
    }
  } finally {
    for (const [k, v] of Object.entries(env0)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  expect(fails).toEqual([]);
});
