/**
 * ONE FOLLOWER TABLE IN ITS OWN PROCESS, behind a fake Ignition client at the CDP layer (cdp.io) — the child of
 * follower-router.test.ts. It joins the session the way argv says (`join` = the leader's invitation, POST
 * /session/join; `adopt` = the follower's own poll, maybeSessionAdopt), lets its router run while the page walks
 * signed-out → lobby with no table → our table seated, and prints ONE JSON line: every press it made on the shared
 * page, the router's state in each phase, and what it logged.
 *
 * A process of its own because a router that DOES drive the lobby (the bug) is mid-goto or mid-sign-in when the
 * test ends — 25-75 s waits that would outlive an in-process test and press through whatever cdp.io the next test
 * file installs, or the real one. Here it dies with the process, and CDP_PORT (set by the parent) points nowhere.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as A from "../../src/auth";
import * as cdp from "../../src/cdp";
import { realTime } from "../../src/clock";
import { paths } from "../../src/env";
import * as F from "../../src/formats";
import { maybeSessionAdopt, sessionJoin } from "../../src/session";
import { S, resetState } from "../../src/state";
import * as TABLES from "../../src/tables";

const how = process.argv[2] === "adopt" ? "adopt" : "join";
const SID = "session_20260925_134058";
const CFG = { tables: 4, format: "ign-ring-NL5-6", buyinBb: 100, profile: "MKDIR", answers: false, recording: false };
const me = TABLES.slot()!;

const LINES: string[] = [];
console.log = (...a: unknown[]) => { LINES.push(a.map(String).join(" ")); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// a profile WITH a password: a follower that thought sign-in was its job would get as far as typing
mkdirSync(paths().data, { recursive: true });
writeFileSync(join(paths().data, "profiles.json"),
              JSON.stringify([{ name: "MKDIR", site: "ignition", email: "hero@example.com", rememberMe: true, trustDevice: false }]));
A.keyring.get = () => "not-a-real-password";

// ---- the shared client page ------------------------------------------------------------------------------------
const page = { phase: "signed-out" as "signed-out" | "lobby" | "seated" };
const PRESSES: { phase: string; what: string }[] = [];
const press = (what: string) => { PRESSES.push({ phase: page.phase, what: what.replace(/\s+/g, " ").slice(0, 140) }); };
/** a click, a focus (typing follows), or a navigation of the top document */
const DRIVES = /\.click\(\)|\.focus\(\)|location\.href\s*=(?!=)/;
const PARAMS = { gameType: "NLHE", gameFormat: "ring", seat: "6", playMode: "real", quickSeatSmallBlind: "2", quickSeatBigBlind: "5",
                 quickSeatBuyInAmount: "500", waitForBigBlind: "true", gameTableUrl: "/poker-game/ring", tableName: `Table ${me}`,
                 _title: "NL Hold'em $0.02/$0.05" };

function answer(js: string): any {
  if (DRIVES.test(js)) {
    press(js);
    return null;                                  // the press "finds nothing": whatever drove it gives up quickly
  }
  if (js === F.SIGNED_OUT_JS()) return page.phase === "signed-out";
  if (js === A.STATE_JS()) return page.phase === "signed-out" ? { path: "/poker-lobby", hasLogin: true, errs: [], lobby: false }
                                                            : { path: "/poker-lobby", hasLogin: false, errs: [], lobby: true, seated: page.phase === "seated" };
  if (js === F.SEATED_JS()) return JSON.stringify({ slots: page.phase === "seated" ? [me - 1] : [], tagged: true });
  if (/const SLOT = /.test(js)) return page.phase === "seated" ? { ...PARAMS } : null;   // formats.TABLE_JS_TMPL: our table
  if (js.trim().endsWith("!!L")) return page.phase !== "signed-out";                      // the lobby frame is there
  return null;
}
Object.assign(cdp.io, {
  available: async () => true,
  pageTargets: async () => [{ id: "client", type: "page", url: "https://www.ignitioncasino.uno/poker-lobby", webSocketDebuggerUrl: "ws://fake-client" }],
  allTargetWss: async () => ["ws://fake-client"],
  evaluate: async (_ws: string, js: string) => answer(js),
  evaluateStrict: async (_ws: string, js: string) => answer(js),
  commands: async (_ws: string, cmds: [string, Record<string, unknown>][]) => {
    for (const [m] of cmds) if (/^Input\./.test(m)) press(`CDP ${m}`);
    return cmds.map(() => ({}));
  },
  dispatchClick: async (_ws: string, x: number, y: number) => { press(`CDP click at ${x},${y}`); },
  screenshot: async () => null,
});

// ---- the session store: the one record the leader wrote ----------------------------------------------------------
realTime();
resetState();
const EVENTS: { kind: string; data: any }[] = [];
const REC = { id: SID, preset: "strategy:ign200-ring-6max-equilibrium", config: CFG, events: [] as any[], ended_at: null, started_at: Date.now() };
S.sessions = {
  get: (sid: string) => (sid === SID ? REC : null),
  event: (_sid: string, kind: string, data: any = null) => { EVENTS.push({ kind, data }); },
  openSessions: () => [REC],
  openSession: () => REC,
} as any;

// ---- join, then walk the page -----------------------------------------------------------------------------------
let joined: any;
if (how === "join") {
  const [code, res] = await sessionJoin({ sid: SID, config: CFG });
  joined = { code, ok: res.ok ?? null, error: res.error ?? null };
} else {
  S.adoptCheck.at = 0.0;
  await maybeSessionAdopt();
  joined = { code: S.session.id === SID ? 200 : 0, ok: S.session.id === SID, error: null };
}
const router: Record<string, { state: string; text: string }> = {};
const snap = (phase: string) => { router[phase] = { state: S.router.state, text: S.router.text }; };
await wait(900);                                   // the router's first pass runs 0.1 s after the join
snap("signed-out");
page.phase = "lobby";                              // the leader signed in; nobody has seated this table yet
await wait(2600);                                  // one router pass is 2 s apart
snap("lobby");
page.phase = "seated";                             // the leader seated this table
await wait(2600);
snap("seated");
process.stdout.write(JSON.stringify({ how, slot: me, joined, presses: PRESSES, router, events: EVENTS, log: LINES }) + "\n");
process.exit(0);
