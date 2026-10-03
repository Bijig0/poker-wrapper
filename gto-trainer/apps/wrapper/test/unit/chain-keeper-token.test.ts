/**
 * THE CHAIN KEEPER ASKS THE LIGHT TOKEN CHECK, AND A SILENT API IS NOT "GTO WIZARD NOT CONNECTED" (Brady, 2026-10-03).
 * Every 20 s per table session.ts ensureAnswerChain asked GET /api/dashboard/sources/registry only for
 * armed.gtow.tokenLive / multiwayLive — the whole mission-control page, 0.1-3 s of the API's event loop a call and
 * 12-79 s on a busy machine. When that fetch gave up the keeper read `{}` as "not connected" and POSTed
 * /api/dashboard/gtow-connect (95 s) at a healthy client. Now: GET /api/dashboard/gtow-token (sessions.ts
 * realFetchGtowToken); no answer = nothing is done; an API older than the wrapper (404) is still asked the registry.
 */
import { expect, test } from "bun:test";
import { realTime, setFakeTime, time } from "../../src/clock";
import { reloadConfig } from "../../src/config";
import { ensureAnswerChain } from "../../src/session";
import * as SES from "../../src/sessions";
import { S, resetState } from "../../src/state";
import { checker, J, scratchDirs } from "./helpers";

type Reply = { status?: number; body?: unknown; delayMs?: number };

/** A study API of this test's own (STUDY_API): what it answers is set per case, every call is recorded. */
function rig() {
  scratchDirs("chain-keeper-");
  reloadConfig();
  resetState();
  setFakeTime(1_790_900_000);
  const calls: string[] = [];
  const answers: { token: Reply; registry: Reply } = { token: { status: 404 }, registry: { status: 404 } };
  const reply = async (a: Reply) => {
    if (a.delayMs) await Bun.sleep(a.delayMs);
    return Response.json(a.body ?? { ok: false }, { status: a.status ?? 200 });
  };
  const api = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(r) {
      const path = new URL(r.url).pathname;
      calls.push(`${r.method} ${path}`);
      switch (path) {
        case "/api/study-poller/start": return Response.json({ ok: true });
        case "/api/dashboard/gtow-token": return reply(answers.token);
        case "/api/dashboard/sources/registry": return reply(answers.registry);
        case "/api/dashboard/gtow-connect": return Response.json({ ok: true, connected: true, text: "1 of 1 sessions live" });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  });
  const api0 = process.env.STUDY_API, deps0 = { ...SES.deps };
  process.env.STUDY_API = `http://127.0.0.1:${api.port}`;
  // the real fetches, on a short fuse: a case that waits out the give-up must not take the keeper's 4 s / 6 s
  SES.deps.fetchGtowToken = () => SES.realFetchGtowToken(0.3);
  SES.deps.fetchRegistry = () => SES.realFetchRegistry(0.3);
  const log0 = console.log;
  const lines: string[] = [];
  console.log = (m: unknown) => { lines.push(String(m)); };
  const count = (what: string) => calls.filter((c) => c === what).length;
  const seen = () => ({
    token: count("GET /api/dashboard/gtow-token"),
    registry: count("GET /api/dashboard/sources/registry"),
    connect: count("POST /api/dashboard/gtow-connect"),
  });
  const later = (s: number) => setFakeTime(time() + s);
  const undo = async () => {
    console.log = log0;
    Object.assign(SES.deps, deps0);
    if (api0 === undefined) delete process.env.STUDY_API;
    else process.env.STUDY_API = api0;
    await api.stop(true);
    realTime();
    resetState();
  };
  return { answers, calls, lines, seen, later, undo };
}

const LIVE = { ok: true, tokenLive: true, multiwayLive: true, expiresInMs: 1_800_000 };

test("a live token: the keeper asks the light route, never the registry, and connects nothing", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { answers, calls, seen, later, undo } = rig();
  try {
    answers.token = { body: LIVE };
    await ensureAnswerChain("keeper");
    eq("the poller is started, then the token is asked — and that is all", calls, ["POST /api/study-poller/start", "GET /api/dashboard/gtow-token"]);
    later(20);
    await ensureAnswerChain("keeper");
    eq("20 s on: the same, no registry and no connect", seen(), { token: 2, registry: 0, connect: 0 });
    eq("  ... and no connect is on record", [S.chain.attempting, S.chain.lastAt, S.chain.lastResult], [false, 0, null]);
  } finally {
    await undo();
  }
  expect(fails).toEqual([]);
});

test("an API that does not answer the token check is not 'GTO Wizard not connected': nothing is connected", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { answers, lines, seen, later, undo } = rig();
  try {
    answers.token = { body: LIVE, delayMs: 900 };  // a stalled event loop: the answer comes after the give-up
    eq("too slow: the fetch says null", await SES.fetchGtowToken(), null);
    await ensureAnswerChain("keeper");
    eq("  ... and the keeper connects nothing", seen().connect, 0);
    answers.token = { status: 500, body: { ok: false, error: "boom" } };
    later(20);
    await ensureAnswerChain("keeper");
    eq("a 500: nothing connected, and the registry is not asked instead", [seen().connect, seen().registry], [0, 0]);
    answers.token = { body: "<html>not json</html>" };
    later(20);
    await ensureAnswerChain("keeper");
    eq("an answer that is not the route's: nothing connected", seen().connect, 0);
    process.env.STUDY_API = "http://127.0.0.1:9";  // nothing listens: the API is down
    later(20);
    await ensureAnswerChain("keeper");
    eq("the API is down: nothing connected", seen().connect, 0);
    eq("  ... and the 2-minute connect allowance is not spent", [S.chain.lastAt, S.chain.lastResult], [0, null]);
    check("  ... and no line says GTO Wizard is not connected", !lines.some((l) => l.includes("not connected")), J(lines));
  } finally {
    await undo();
  }
  expect(fails).toEqual([]);
});

test("a token that is not live: one connect, and not another inside 2 minutes", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { answers, lines, seen, later, undo } = rig();
  try {
    answers.token = { body: { ok: true, tokenLive: false, multiwayLive: false, expiresInMs: null } };
    await ensureAnswerChain("keeper");
    eq("no token: one connect", seen().connect, 1);
    eq("  ... its result is kept for the panel", [S.chain.attempting, S.chain.lastResult?.connected, S.chain.lastResult?.text], [false, true, "1 of 1 sessions live"]);
    check("  ... and the log says why", lines.some((l) => l.includes("GTO Wizard not connected (keeper)")), J(lines));
    later(20);
    await ensureAnswerChain("keeper");
    later(99);
    await ensureAnswerChain("keeper");
    eq("asked again at 20 s and 119 s: still one connect", seen(), { token: 3, registry: 0, connect: 1 });
    later(2);
    await ensureAnswerChain("keeper");
    eq("past 120 s: the next attempt", seen().connect, 2);

    answers.token = { body: { ok: true, tokenLive: true, multiwayLive: false, expiresInMs: 1_800_000 } };
    later(121);
    await ensureAnswerChain("keeper");
    eq("a token but no multiway session: a connect too", seen().connect, 3);
    check("  ... named as such", lines.some((l) => l.includes("has no multiway session")), J(lines));
  } finally {
    await undo();
  }
  expect(fails).toEqual([]);
});

test("an API older than the wrapper (404 on the light route): the registry's armed.gtow, as before", async () => {
  const { fails, check } = checker();
  const eq = (label: string, got: unknown, want: unknown) => check(label, J(got) === J(want), `got ${J(got)}, want ${J(want)}`);
  const { answers, seen, later, undo } = rig();
  const registry = (gtow: unknown) => ({ body: { ok: true, armed: { hrc: { up: true }, gtow } } });
  try {
    answers.token = { status: 404 };
    answers.registry = registry({ tokenLive: true, multiwayLive: true, clientUp: true, sessions: [] });
    eq("the fetch hands back the registry's armed.gtow", (await SES.fetchGtowToken())?.tokenLive, true);
    await ensureAnswerChain("keeper");
    eq("live in the registry: asked there, nothing connected", seen(), { token: 2, registry: 2, connect: 0 });

    answers.registry = registry({ tokenLive: true, clientUp: true });  // a registry that predates the pool: no multiwayLive
    later(20);
    await ensureAnswerChain("keeper");
    eq("no multiwayLive key at all counts as connected", seen().connect, 0);

    answers.registry = { body: { ok: true, armed: { gtow: { tokenLive: true, multiwayLive: true } } }, delayMs: 900 };
    later(20);
    await ensureAnswerChain("keeper");
    eq("the registry does not answer either: nothing connected", seen().connect, 0);

    answers.registry = registry({ tokenLive: false, multiwayLive: false, clientUp: false, sessions: [] });
    later(20);
    await ensureAnswerChain("keeper");
    eq("not live in the registry: one connect", seen().connect, 1);
  } finally {
    await undo();
  }
  expect(fails).toEqual([]);
});
