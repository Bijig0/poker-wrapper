/**
 * SIGNING IN AND THE LOBBY ARE THE LEADER'S (session_20260925_134058, server.log 13:40): every table wrapper of a
 * 4-table session ran the router at once on the one client page — "[router] routing: going to NL5 Ring 6-max" 4x,
 * "[goto] client shell is up" 4x, "[router] logging-in: signing in as MKDIR" 4x, two processes typing into the one
 * e-mail field ("fields read back 38/19 and 32/16 chars - retyping"), four LOGIN presses, four login-errors.
 *
 * A follower (table 2-4) that joins — on the leader's invitation (POST /session/join) or by its own adopt poll —
 * must never sign in, never goto, never press anything on the shared page. It waits for the leader, and reports
 * its table once the leader has seated it. Each follower runs in its own process: followerRouterChild.ts says why.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as A from "../../src/auth";
import * as cdp from "../../src/cdp";
import * as F from "../../src/formats";
import { checker, J, scratchDirs } from "./helpers";

function runFollower(how: "join" | "adopt", slot: number): Promise<any> {
  const tmp = mkdtempSync(join(tmpdir(), "follower-router-"));
  mkdirSync(join(tmp, "data"), { recursive: true });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TABLE_SLOT: String(slot), TABLE_COUNT: "4", NODE_ENV: "test", WRAPPER_HEADLESS: "1", PANEL_DEFER_WINDOW: "1",
    WRAPPER_DATA_DIR: join(tmp, "data"), WRAPPER_DEBUG_DIR: join(tmp, "debug"),
    CDP_PORT: "1", PANEL_PORT: String(17700 + 10 * (slot - 1)),          // nowhere: the live client is on :9333
  };
  delete env.FAKE_TABLE;                                                // the rig's router routes nothing — not this test
  delete env.PANEL_TAG;
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["run", join(import.meta.dir, "followerRouterChild.ts"), how], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (b) => { out += b; });
    c.stderr.on("data", (b) => { err += b; });
    const kill = setTimeout(() => c.kill(), 45_000);
    c.on("close", (code) => {
      clearTimeout(kill);
      const last = out.trim().split(/\r?\n/).pop() || "";
      try {
        resolve(JSON.parse(last));
      } catch {
        resolve({ how, slot, crashed: { code, out: out.slice(-600), err: err.slice(-1200) } });
      }
    });
  });
}

test("a follower's join / adopt never signs in, never drives the lobby, never presses the shared page", async () => {
  const { fails, check } = checker();
  const runs = await Promise.all([runFollower("join", 2), runFollower("adopt", 3)]);
  for (const r of runs) {
    const who = `table ${r.slot} (${r.how === "join" ? "the leader's invitation" : "its own adopt poll"})`;
    if (r.crashed) {
      check(`${who}: the child ran`, false, J(r.crashed));
      continue;
    }
    check(`${who}: joined the session`, r.joined.ok === true, J(r.joined));
    check(`${who}: pressed NOTHING on the shared page`, !r.presses.length, J(r.presses.slice(0, 4)));
    const drove = r.log.filter((l: string) => /^\[(auth|goto|seat)\]|^\[router\] (logging-in|routing|seating)/.test(l));
    check(`${who}: never started a sign-in, a goto or a seat`, !drove.length, J(drove.slice(0, 6)));
    check(`  ... and recorded none`, !r.events.some((e: any) => ["login", "route-failed", "seat-failed", "reseat"].includes(e.kind)),
          J(r.events.map((e: any) => e.kind)));
    const R = r.router;
    check(`${who}: client signed out → waits for table 1 to sign in`,
          R["signed-out"].state === "waiting-signin" && /table 1 signs in/.test(R["signed-out"].text), J(R["signed-out"]));
    check(`${who}: signed in, no table → waits for table 1 to seat it`,
          R.lobby.state === "waiting-leader" && R.lobby.text.includes(`table 1 to seat table ${r.slot}`), J(R.lobby));
    check(`${who}: seated by the leader → reports its table`,
          R.seated.state === "done" && R.seated.text.includes("NL5 Ring 6-max"), J(R.seated));
    const routed = r.events.filter((e: any) => e.kind === "routed");
    check(`  ... once, as the leader's seat (not its own)`, routed.length === 1 && routed[0].data.byRouter === false && routed[0].data.slot === r.slot,
          J(routed));
  }
  expect(fails).toEqual([]);
}, 60_000);

test("the lobby drivers themselves refuse in a follower — before asking the page anything", async () => {
  const { fails, check } = checker();
  scratchDirs();
  const io0 = { ...cdp.io };
  const slot0 = process.env.TABLE_SLOT;
  const log0 = console.log;
  console.log = () => {};
  const ASKED: string[] = [];
  // no Ignition page at all: a driver that is let through fails at once ("no table window") instead of waiting
  Object.assign(cdp.io, {
    available: async () => { ASKED.push("available"); return true; },
    pageTargets: async () => { ASKED.push("pageTargets"); return []; },
    evaluate: async () => { ASKED.push("evaluate"); return null; },
    evaluateStrict: async () => { ASKED.push("evaluate"); return null; },
    commands: async () => { ASKED.push("commands"); return []; },
    dispatchClick: async () => { ASKED.push("click"); },
  });
  const drivers = {
    goto: () => F.goto("ign-ring-NL5-6", 100, 1, true, () => {}),
    "goto (adding a seat)": () => F.goto("ign-ring-NL5-6", 100, 1, true, () => {}, true),
    toLobby: () => F.toLobby(1, () => {}),
    login: () => A.login("MKDIR", 1, () => {}),
  };
  try {
    for (const slot of [2, 3, 4]) {
      process.env.TABLE_SLOT = String(slot);
      for (const [name, run] of Object.entries(drivers)) {
        ASKED.length = 0;
        const r = await run();
        check(`table ${slot}: ${name} refuses`, r.ok === false && r.follower === true && /table 1/.test(r.error), J(r));
        check(`  ... without asking the shared page anything`, !ASKED.length, J(ASKED));
      }
    }
    for (const slot of ["1", undefined]) {
      if (slot === undefined) delete process.env.TABLE_SLOT;
      else process.env.TABLE_SLOT = slot;
      for (const [name, run] of Object.entries(drivers)) {
        const r = await run();
        check(`${slot ? "the leader" : "a single table"}: ${name} is not refused as a follower`, !r.follower, J(r));
      }
    }
  } finally {
    Object.assign(cdp.io, io0);
    if (slot0 === undefined) delete process.env.TABLE_SLOT;
    else process.env.TABLE_SLOT = slot0;
    console.log = log0;
  }
  expect(fails).toEqual([]);
});
