/**
 * THE LIVE ROW (2026-09-25, gto-trainer/DATA-ROOT-PLAN.md): while hero plays a hand its row in the hands table is
 * written as the hand goes (status 'live'), and the archive finishes THAT row — the dashboard reads one row per hand,
 * live or done. A busy database defers the archive to the next loop pass; it never drops the hand.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { S, resetState } from "../../src/state";
import { onGameMsg, wsSeams } from "../../src/ignition/ws";
import { archiveHand, flushPendingArchives, liveHandTick } from "../../src/archive";
import { scratchDirs } from "./helpers";

function deal(): void {
  onGameMsg({ pid: "PLAY_STAGE_INFO", stageNo: "4920500001" });
  onGameMsg({ pid: "CO_DEALER_SEAT", seat: 6 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 1, account: 19900, baseStakes: 0, btn: 2, bet: 100, dead: 0 });
  onGameMsg({ pid: "CO_BLIND_INFO", seat: 2, account: 19800, baseStakes: 0, btn: 4, bet: 200, dead: 0 });
  onGameMsg({ pid: "CO_CARDTABLE_INFO", seat1: [32896, 32896], seat2: [32896, 32896], seat3: [32896, 32896], seat4: [33, 51], seat6: [32896, 32896] });
}

const rows = () => {
  const c = new Database(join(process.env.WRAPPER_DATA_DIR!, "hands.db"), { readonly: true });
  try { return c.query("SELECT rowid, client_hand_id, status, action_count, updated_at FROM hands ORDER BY rowid").all() as any[]; } finally { c.close(); }
};

function playing(body: () => void): void {
  resetState();
  scratchDirs("wrapper-live-");
  const arch0 = wsSeams.archiveHand;
  wsSeams.archiveHand = () => {};
  try {
    S.session.id = null;
    deal();
    Object.assign(S.feedPrev, { seated: true, seats: new Map() });
    body();
  } finally {
    wsSeams.archiveHand = arch0;
  }
}

test("the hand's row is born live, moves with the hand, and the archive finishes the SAME row", () => {
  playing(() => {
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 4096, bet: 0, raise: 500, account: 19500 });   // UTG raises
    liveHandTick();
    let r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ client_hand_id: "4920500001", status: "live" });
    const n0 = r[0].action_count;
    const t0 = r[0].updated_at;

    liveHandTick();                                    // nothing changed: no write
    expect(rows()[0].updated_at).toBe(t0);

    onGameMsg({ pid: "CO_SELECT_INFO", seat: 4, btn: 256, bet: 500, raise: 0, account: 20500 });    // hero calls
    liveHandTick();
    r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].action_count).toBeGreaterThan(n0);

    onGameMsg({ pid: "CO_SELECT_INFO", seat: 6, btn: 1024, bet: 0, raise: 0, account: 30000 });
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 1, btn: 256, bet: 400, raise: 0, account: 19500 });
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 2, btn: 256, bet: 300, raise: 0, account: 19500 });
    archiveHand();
    const done = rows();
    expect(done).toHaveLength(1);                      // finished in place, not a second row
    expect(done[0]).toMatchObject({ rowid: r[0].rowid, client_hand_id: "4920500001", status: "done" });

    liveHandTick();                                    // an archived hand is never turned back into a live row
    expect(rows()[0].status).toBe("done");
  });
});

test("a busy database defers the archive and the next pass writes it — the hand is never dropped", () => {
  playing(() => {
    onGameMsg({ pid: "CO_SELECT_INFO", seat: 3, btn: 4096, bet: 0, raise: 500, account: 19500 });
    liveHandTick();                                    // creates the file and the table
    // another process (the API) holds the write lock for longer than the archive will wait
    const other = new Database(join(process.env.WRAPPER_DATA_DIR!, "hands.db"));
    other.run("PRAGMA busy_timeout = 0");
    other.run("BEGIN IMMEDIATE");
    try {
      archiveHand();
      expect(rows()[0].status).toBe("live");          // not written yet…
    } finally {
      other.run("COMMIT");
      other.close();
    }
    flushPendingArchives();                            // …the loop's next pass writes it
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("done");
  });
});
