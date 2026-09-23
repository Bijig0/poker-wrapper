/**
 * Port of tests/test_presence.py — which tables are up, and whether the leader can reach them.
 *
 * The test that was missing on 2026-09-21 (a two-table session ran twenty hands with one table answering): presence
 * is ASKED, not remembered, and it is asked of REAL servers here — four Bun servers stand in for four wrappers, on a
 * base port of their own (7860+; :7700 on this machine is a live session with real money on it). The leader's own
 * fan-out has to reach them, and the strip has to show every DECLARED table, answering or not.
 */
import { expect, test } from "bun:test";
import { time } from "../../src/clock";
import * as TABLES from "../../src/tables";
import { fanOut, tablesOverview } from "../../src/session";
import { checker, J } from "./helpers";

const TEST_BASE = 7860, TEST_STEP = 10;

class Wrapper {
  posts: [string, any][] = [];
  probes = 0;
  srv: ReturnType<typeof Bun.serve>;
  answerSlot: number;
  constructor(public slot: number, public o: { rig?: string; sid?: string | null; count?: number; delay?: number; answerSlot?: number; broken?: boolean } = {}) {
    this.answerSlot = o.answerSlot ?? slot;
    const outer = this;
    this.srv = Bun.serve({
      hostname: "127.0.0.1", port: TABLES.panelPort(slot),
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } });
        if (req.method === "POST") {
          let body: any = {};
          try { body = JSON.parse((await req.text()) || "{}"); } catch {}
          outer.posts.push([path, body]);
          return json({ ok: true, slot: outer.slot });
        }
        if (path.startsWith("/state")) {
          return json({ ok: true, tableSlot: outer.slot, sessionId: outer.o.sid ?? null, studyAnswers: !!outer.o.sid, connected: true,
                        hand: { street: "flop", heroCards: ["Ah", "Kd"], currentNode: { toActIsHero: false } }, panelAnswer: null });
        }
        if (path !== TABLES.PRESENCE_PATH) return new Response('{"ok":false}', { status: 404 });
        outer.probes++;
        if (outer.o.delay) await new Promise((r) => setTimeout(r, outer.o.delay! * 1000));
        if (outer.o.broken) return new Response("<html>not json</html>", { headers: { "Content-Type": "application/json" } });
        return json({ ok: true, slot: outer.answerSlot, rig: outer.o.rig ?? "live", panelPort: TABLES.panelPort(outer.slot),
                      pid: 1000 + outer.slot, count: outer.o.count ?? 2, sid: outer.o.sid ?? null, at: time() });
      },
    });
  }
  stop() {
    try { this.srv.stop(true); } catch {}
  }
}

function be(slot: number | null, count = 2, fake = false) {
  if (slot) process.env.TABLE_SLOT = String(slot);
  else delete process.env.TABLE_SLOT;
  process.env.TABLE_COUNT = String(count);
  if (fake) process.env.FAKE_TABLE = "1";
  else delete process.env.FAKE_TABLE;
  TABLES.forgetPresence();
}

test("which tables are up, and whether the leader can reach them", async () => {
  const { fails, check } = checker();
  const env0 = Object.fromEntries(["TABLE_SLOT", "TABLE_COUNT", "FAKE_TABLE"].map((k) => [k, process.env[k]]));
  const base0 = { ...TABLES.portMap };
  Object.assign(TABLES.portMap, { base: TEST_BASE, step: TEST_STEP });
  const live: Wrapper[] = [];
  const log0 = console.log;
  console.log = () => {};
  const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
  try {
    check("slots 1-4 map to base, +10, +20, +30", J([1, 2, 3, 4].map((n) => TABLES.panelPort(n))) === J([0, 1, 2, 3].map((i) => TEST_BASE + 10 * i)));
    check("the leader's port is slot 1's", TABLES.leaderPort() === TABLES.panelPort(1));

    // a single table has no peers and does no I/O
    let watcher = new Wrapper(2);
    live.push(watcher);
    be(null, 1);
    const seenBefore = watcher.probes;
    check("registry is empty", J(TABLES.registry()) === "[]");
    check("peers is empty", J(TABLES.peers()) === "[]");
    check("live_peers is empty", J(await TABLES.livePeers()) === "[]");
    await sleep(0.3);
    check("  ... and nobody was asked anything", watcher.probes === seenBefore, `${watcher.probes - seenBefore} probes`);
    watcher.stop();
    live.splice(live.indexOf(watcher), 1);

    // the wire contract: what a wrapper SERVES is what a probe accepts
    be(3, 2);
    const realBody = TABLES.presenceRecord(TABLES.panelPort(3), "S-live");
    be(1, 2);
    const realSrv = Bun.serve({ hostname: "127.0.0.1", port: TABLES.panelPort(3), fetch: () => new Response(JSON.stringify(realBody)) });
    try {
      const seen = await TABLES.probe(3, 1.0);
      check("a real presence_record() is accepted by a real probe()", seen !== null, J(realBody));
      check("  ... as the right slot, on the right port", seen?.slot === 3 && seen?.panelPort === TABLES.panelPort(3), J(seen));
      check("  ... carrying the session it is on, which is what the strip needs", seen?.sid === "S-live", J(seen));
      check("  ... and it names a rig", ["live", "fake"].includes(realBody.rig), J(realBody));
    } finally {
      realSrv.stop(true);
    }

    // probing: identity is checked, never assumed
    be(1, 2);
    check("nothing listening → None", (await TABLES.probe(2, 0.5)) === null);
    let w2 = new Wrapper(2);
    live.push(w2);
    let got = await TABLES.probe(2, 1.0);
    check("a wrapper answering as slot 2 → found", got?.slot === 2, J(got));
    check("  ... carrying its panel port", got?.panelPort === TABLES.panelPort(2), J(got));
    let w3 = new Wrapper(3, { answerSlot: 1 });
    live.push(w3);
    check("something on slot 3's port answering as slot 1 → rejected", (await TABLES.probe(3, 1.0)) === null);
    let w4 = new Wrapper(4, { broken: true });
    live.push(w4);
    check("an answer that is not JSON → rejected", (await TABLES.probe(4, 1.0)) === null);

    // THE RIG IS PART OF THE IDENTITY
    w2.o.rig = "fake";
    check("a FAKE wrapper is invisible to a live one", (await TABLES.probe(2, 1.0)) === null);
    be(1, 2, true);
    check("  ... and visible to a fake one", (await TABLES.probe(2, 1.0))?.slot === 2);
    be(1, 2);
    w2.o.rig = "live";
    check("  ... and back", (await TABLES.probe(2, 1.0))?.slot === 2);

    // the registry: declared tables that are NOT answering keep their row
    be(1, 4);
    await TABLES.refreshPresence(1.0);
    let reg = Object.fromEntries(TABLES.registry().map((r: any) => [r.slot, r]));
    check("all four declared slots have a row", J(Object.keys(reg).map(Number).sort()) === J([1, 2, 3, 4]), J(Object.keys(reg)));
    check("slot 1 (us) is live", reg[1]?.live === true && reg[1]?.me === true, J(reg[1]));
    check("slot 2 (answering) is live", reg[2]?.live === true, J(reg[2]));
    check("slot 3 (wrong identity) is NOT live", reg[3]?.live === false, J(reg[3]));
    check("  ... and still carries its port so it can be opened", reg[3]?.panelPort === TABLES.panelPort(3));
    be(1, 2);
    await TABLES.refreshPresence(1.0);
    reg = Object.fromEntries(TABLES.registry().map((r: any) => [r.slot, r]));
    check("a session of two shows two rows, not four", J(Object.keys(reg).map(Number).sort()) === J([1, 2]), J(Object.keys(reg)));

    // peers: the others, never ourselves
    check("slot 1 sees exactly [2]", J(TABLES.peers().map((p: any) => p.slot)) === J([2]), J(TABLES.peers()));
    be(2, 2);
    await TABLES.refreshPresence(1.0);
    check("slot 2 does not see itself through its own port", J(TABLES.peers().map((p: any) => p.slot)) === "[]", J(TABLES.peers()));

    // the hot path never waits on a wedged table
    w3.stop();
    live.splice(live.indexOf(w3), 1);
    const w5 = new Wrapper(3, { delay: 5.0 });
    live.push(w5);
    be(1, 4);
    TABLES.forgetPresence();
    let t0 = performance.now();
    for (let i = 0; i < 5; i++) TABLES.registry();
    const lag = (performance.now() - t0) / 1000;
    check(`five registry() calls on an empty, stale snapshot cost ${(lag * 1000).toFixed(0)} ms`, lag < 0.3, `${lag.toFixed(2)}s`);
    check("  ... and they did start the refresh rather than skipping it", TABLES.presence.probing === true || w5.probes > 0, J(TABLES.presence));
    t0 = performance.now();
    const fresh = await TABLES.refreshPresence(0.8);
    const spent = (performance.now() - t0) / 1000;
    check(`a synchronous refresh is bounded by the timeout (${spent.toFixed(1)}s), not by the peer`, spent < 2.5, `${spent.toFixed(2)}s`);
    check("  ... and a wedged table is reported not live, not guessed at",
          fresh.every((r) => r.slot !== 3) && TABLES.registry().find((r: any) => r.slot === 3)?.live === false, J(fresh));
    w5.stop();
    live.splice(live.indexOf(w5), 1);
    w3 = new Wrapper(3);
    live.push(w3);

    // live_peers probes NOW — a stale snapshot is a wrong answer for a fan-out
    be(1, 2);
    await TABLES.refreshPresence(1.0);
    check("both other tables are up to begin with", J(TABLES.peers().map((p: any) => p.slot)) === J([2, 3]), J(TABLES.peers()));
    w2.stop();
    live.splice(live.indexOf(w2), 1);
    check("the cached view still shows the table that just died", TABLES.peers().some((p: any) => p.slot === 2), J(TABLES.peers()));
    check("  ... but live_peers does not", J((await TABLES.livePeers(0.5)).map((p) => p.slot)) === J([3]));
    w2 = new Wrapper(2);
    live.push(w2);
    check("a table that comes up is seen at once, without waiting for the TTL", J((await TABLES.livePeers(1.0)).map((p) => p.slot)) === J([2, 3]));

    // THE REGRESSION: the leader's fan-out actually reaches the tables
    be(1, 4);
    w4.o.broken = false;
    const sent = await fanOut("/session/join", { sid: "S1", config: { tables: 4, answers: true } }, 5);
    check("every live table got the join", J(sent.map((r) => r.slot).sort()) === J([2, 3, 4]), J(sent.map((r) => r.slot)));
    for (const w of [w2, w3, w4]) {
      check(`  ... slot ${w.slot} has it in hand, with the session id`, w.posts.some(([p, b]) => p === "/session/join" && b.sid === "S1"), J(w.posts));
    }

    // the strip shows every DECLARED table, answering or not
    w2.o.sid = "S1";
    w3.o.sid = null;
    w4.stop();
    live.splice(live.indexOf(w4), 1);
    TABLES.forgetPresence();
    await TABLES.refreshPresence(1.0);
    const stub = async () => ({ ok: true, tableSlot: 1, sessionId: "S1", studyAnswers: true, connected: true, hand: {} });
    const view = Object.fromEntries((await tablesOverview(stub)).tables.map((c: any) => [c.slot, c]));
    check("four declared tables → four cards", J(Object.keys(view).map(Number).sort()) === J([1, 2, 3, 4]), J(Object.keys(view)));
    check("the table that joined shows answers ON", view[2]?.answersOn === true, J(view[2]));
    check("the table that did NOT join shows answers OFF — the signal that was missing", view[3]?.reachable === true && view[3]?.answersOn === false, J(view[3]));
    check("the table that never came up is 'not answering', not absent", view[4]?.reachable === false && String(view[4]?.error || "").includes("not running"), J(view[4]));
    w4 = new Wrapper(4);
    live.push(w4);

    for (const w of [w2, w3, w4]) w.posts.length = 0;
    be(null, 1);
    check("a single-table wrapper fans out to nobody (the old behaviour, deliberate)", J(await fanOut("/session/join", { sid: "S2" }, 5)) === "[]");
    check("  ... and nothing received it", [w2, w3, w4].every((w) => !w.posts.length));
  } finally {
    for (const w of live) w.stop();
    Object.assign(TABLES.portMap, base0);
    for (const [k, v] of Object.entries(env0)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    TABLES.forgetPresence();
    console.log = log0;
  }
  expect(fails).toEqual([]);
}, 60_000);
