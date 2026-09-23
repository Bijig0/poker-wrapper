/**
 * Port of tests/test_seating.py and tests/test_session_events.py.
 *
 *  - Taking the session's seats: exactly one per step, stops when it has them all, stops on a seat that will not
 *    take, believes the client's count over goto's word; a closed table stops being asked for (in memory AND in
 *    the session record), a close never forfeits a hand, and a count that FALLS after being reached is a table
 *    closed by hand.
 *  - Concurrent appends to one session's event log lose nothing — four PROCESSES (the tables are processes).
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cdp from "../../src/cdp";
import { SessionStore } from "../../src/sessions";
import { S, resetState } from "../../src/state";
import { honourClosedTables, maybeStandDown, seatNextTable, sessionSeams, standDownTable, tablesClosed, tablesWanted } from "../../src/session";
import { checker, J, scratchDirs } from "./helpers";

class Client {
  lobbyCalls = 0;
  gotoCalls = 0;
  constructor(public seated = 0, public failsAt: number | null = null, public lobbyOk = true) {}
  fns() {
    return {
      count: async () => [...Array(this.seated).keys()],
      toLobby: async () => {
        this.lobbyCalls++;
        return this.lobbyOk ? { ok: true } : { ok: false, error: "no Lobby control" };
      },
      goto: async () => this.goto(),
    };
  }
  goto(): Record<string, any> {
    this.gotoCalls++;
    if (this.failsAt === this.seated + 1) return { ok: false, error: "no table at that stake" };
    this.seated++;
    return { ok: true, detected: { name: `table ${this.seated}` } };
  }
}

async function seatUntilDone(want: number, c: Client, limit = 10): Promise<[Record<string, any>, number]> {
  let passes = 0;
  while (passes < limit) {
    passes++;
    const r = await seatNextTable("ign-practice-ring", { tables: want }, want, c.fns());
    if (r.done || !r.ok) return [r, passes];
  }
  return [{ done: false, error: "did not settle" }, passes];
}

test("taking the session's seats", async () => {
  const { fails, check } = checker();
  scratchDirs();
  resetState();
  const log0 = console.log;
  console.log = () => {};
  try {
    for (const want of [1, 2, 4]) {
      const c = new Client(1);
      const [r, passes] = await seatUntilDone(want, c);
      check(`asked for ${want} → ${c.seated} seated`, c.seated === want, `got ${c.seated}`);
      check(`  ... and it stops (done after ${passes} passes)`, r.done === true, J(r));
      check(`  ... taking ${want - 1} extra seats`, c.gotoCalls === want - 1, `goto called ${c.gotoCalls}x`);
    }
    let c = new Client(4);
    let [r] = await seatUntilDone(4, c);
    check("four wanted, four seated → nothing to do", r.done && c.gotoCalls === 0, J(r));
    c = new Client(2);
    r = await seatNextTable("f", { tables: 2 }, 2, c.fns());
    check("two wanted, two seated → no extra seat", r.done && c.gotoCalls === 0, J(r));

    c = new Client(1, 2);
    let passes: number;
    [r, passes] = await seatUntilDone(4, c);
    check("the loop STOPS rather than spinning on it", r.ok === false && passes === 1, `${passes} passes, ${J(r)}`);
    check("  ... and says which table it was", r.seat === 2, String(r.seat));
    check("  ... leaving the tables that did seat", c.seated === 1, String(c.seated));

    c = new Client(1, null, false);
    [r] = await seatUntilDone(2, c);
    check("no Lobby control → the seat is still attempted", c.gotoCalls === 1, `goto called ${c.gotoCalls}x`);
    check("  ... and succeeds", c.seated === 2 && r.done, J(r));

    class Liar extends Client {
      override goto() {
        this.gotoCalls++;
        return { ok: true, detected: {} };
      }
    }
    const liar = new Liar(1);
    [r, passes] = await seatUntilDone(4, liar);
    check("goto claiming success without a seat is caught", r.ok === false && passes === 1, J(r));

    // closing a table STOPS the session asking for it back
    const CFG2 = { tables: 2 }, CFG4 = { tables: 4 };
    const freshClose = (rec: any = null) => {
      S.closedTables.clear();
      S.seating.reached = 0;
      Object.assign(S.session, { id: null, rec, started: 0.0 });
    };
    freshClose();
    check("nothing closed → the session wants what it declared", J([tablesWanted(CFG2), tablesWanted(CFG4)]) === J([2, 4]));
    S.closedTables.add(2);
    check("one closed → it wants one fewer", tablesWanted(CFG2) === 1, String(tablesWanted(CFG2)));
    check("  ... and the seating loop is then finished at one table",
          (await seatNextTable("f", CFG2, tablesWanted(CFG2), new Client(1).fns())).done === true);
    for (const k of [2, 3, 4]) S.closedTables.add(k);
    check("all the extras closed → never below one table", tablesWanted(CFG4) === 1, String(tablesWanted(CFG4)));
    freshClose({ config: { tables: 4 }, events: [{ kind: "table-closed", data: { slot: 3 } }] });
    check("a leader restarted mid-session still honours the close", tablesWanted(CFG4) === 3 && tablesClosed().has(3), J([...tablesClosed()]));

    // a close never forfeits a hand
    const LEFT: string[] = [];
    const leave0 = sessionSeams.leave;
    const avail0 = cdp.io.available;
    sessionSeams.leave = async () => { LEFT.push("left"); return { ok: true }; };
    cdp.io.available = async () => true;
    try {
      S.study.standDownPending = null;
      Object.assign(S.ws, { heroCards: ["Ah", "Ad"], handOver: false, heroFolded: false });
      r = await standDownTable("closed from the panel");
      check("hero holding cards → the table is NOT left yet", r.deferred === true && !LEFT.length, J(r));
      check("  ... and it is remembered", S.study.standDownPending, String(S.study.standDownPending));
      await maybeStandDown();
      check("  ... still not, while the hand is on", !LEFT.length, J(LEFT));
      S.ws.handOver = true;
      await maybeStandDown();
      check("  ... and left the moment the hand is over", J(LEFT) === J(["left"]), J(LEFT));
      await maybeStandDown();
      check("  ... once, not every tick", J(LEFT) === J(["left"]), J(LEFT));
    } finally {
      sessionSeams.leave = leave0;
      cdp.io.available = avail0;
      S.study.standDownPending = null;
      Object.assign(S.ws, { heroCards: [], handOver: false });
    }

    // closed BY HAND is a decision too
    freshClose();
    S.seating.reached = 0;
    check("2 of 4 seated on the way up → still wants 4", honourClosedTables(CFG4, 2) === 4);
    S.seating.reached = 4;
    check("2 of 4 seated AFTER having had 4 → wants 2", honourClosedTables(CFG4, 2) === 2);
    check("  ... and does not keep giving up on the same drop", honourClosedTables(CFG4, 2) === 2 && S.closedTables.size === 2, J([...S.closedTables]));
    check("  ... tables are given up from the end (4, then 3)", J([...S.closedTables].sort()) === J([3, 4]), J([...S.closedTables]));
    freshClose();
  } finally {
    console.log = log0;
  }
  expect(fails).toEqual([]);
});

test("concurrent appends to one session's event log must not lose any", async () => {
  const { fails, check } = checker();
  const tmp = mkdtempSync(join(tmpdir(), "sessev-"));
  const db = join(tmp, "sessions.sqlite");
  const PER = 12, N = 4;
  const store = new SessionStore(db);
  store.start("sid", "test-rig", null, null, {}, {}, {});
  const worker = join(tmp, "worker.ts");
  const sessionsTs = join(import.meta.dir, "..", "..", "src", "sessions.ts").replaceAll("\\", "/");
  writeFileSync(worker, `
import { SessionStore } from "${sessionsTs}";
const st = new SessionStore(${JSON.stringify(db)});
const slot = Number(process.argv[2]);
const at = Number(process.argv[3]);
while (Date.now() / 1000 < at) await Bun.sleep(1);
for (let i = 0; i < ${PER}; i++) st.event("sid", "table-joined", { slot, i });
`);
  const go = Date.now() / 1000 + 1.5;
  const codes = await Promise.all([1, 2, 3, 4].map((slot) => new Promise<number | null>((resolve) => {
    const c = spawn(process.execPath, ["run", worker, String(slot), String(go)], { stdio: "ignore" });
    c.on("close", (code) => resolve(code));
  })));
  check("every worker exited cleanly", codes.every((c) => c === 0), J(codes));
  const ev = store.get("sid").events;
  const joined = ev.filter((e: any) => e.kind === "table-joined");
  check(`all ${N * PER} appends survived`, joined.length === N * PER, `got ${joined.length}`);
  for (let slot = 1; slot <= N; slot++) {
    const mine = joined.filter((e: any) => e.slot === slot).map((e: any) => e.i).sort((a: number, b: number) => a - b);
    check(`  ... slot ${slot} kept all ${PER} of its own`, J(mine) === J([...Array(PER).keys()]), J(mine));
  }
  check("the events stayed valid JSON", Array.isArray(ev) && ev.every((e: any) => "at" in e));
  expect(fails).toEqual([]);
}, 90_000);
