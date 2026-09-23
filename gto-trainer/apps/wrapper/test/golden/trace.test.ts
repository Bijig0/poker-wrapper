/**
 * GOLDEN: the CDP-driving flows replayed against the page answers the Python recorder scripted
 * (tests/golden/record_trace.py -> corpus/trace.jsonl.gz). The port must make the SAME browser calls, in the same
 * order, and come to the same result, log lines and clock.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as auth from "../../src/auth";
import * as BAL from "../../src/balances";
import * as cdp from "../../src/cdp";
import { realTime, setFakeTime, time } from "../../src/clock";
import * as F from "../../src/formats";
import { canon, firstDiff, normPy, readCorpus } from "./lib";

const TMP = mkdtempSync(join(tmpdir(), "golden-trace-ts-"));
const PASSWORDS: Record<string, string | null> = { brady: "correct horse", nopw: null };
const PROFILES = [
  { name: "brady", site: "ignition", email: "brady@example.com", rememberMe: true, trustDevice: false },
  { name: "nopw", site: "ignition", email: "x@y.z", rememberMe: false },
  { name: "shortmail", site: "ignition", email: "", rememberMe: null },
];

beforeAll(() => {
  process.env.WRAPPER_DATA_DIR = TMP;
  writeFileSync(join(TMP, "profiles.json"), JSON.stringify(PROFILES));
  auth.keyring.get = (_s, u) => PASSWORDS[u] ?? null;
  auth.keyring.set = (_s, u, p) => { PASSWORDS[u] = p; };
  auth.keyring.delete = (_s, u) => { delete PASSWORDS[u]; };
});
afterAll(() => {
  Object.assign(cdp.io, cdp.REAL_IO);
  delete process.env.WRAPPER_DATA_DIR;
  realTime();
});

class Divergence extends Error {}

function replay(calls: any[]) {
  let k = 0;
  const next = (kind: string, payload: unknown) => {
    const want = calls[k];
    const got = normPy(payload);
    if (!want) throw new Divergence(`call #${k}: extra ${kind} ${JSON.stringify(got).slice(0, 300)}`);
    if (want.k !== kind || canon(got) !== canon(want.p)) {
      throw new Divergence(`call #${k}: got ${kind} ${JSON.stringify(got).slice(0, 400)}\n      want ${want.k} ${JSON.stringify(want.p).slice(0, 400)}` +
        (want.k === kind && Array.isArray(want.p) ? `\n      ${firstDiff(got, want.p)}` : ""));
    }
    k++;
    if (want.raise) throw new cdp.CdpError(want.r.msg);
    return want.r;
  };
  Object.assign(cdp.io, {
    evaluateStrict: async (ws: string, js: string) => next("evs", [ws, js]),
    evaluate: async (ws: string, js: string) => next("ev", [ws, js]),
    dispatchClick: async (ws: string, x: number, y: number) => { next("click", [ws, x, y]); },
    pageTargets: async (port: number) => next("targets", [port]),
    available: async (port: number) => next("available", [port]),
    commands: async (ws: string, cs: [string, Record<string, unknown>][]) => { next("cmds", [ws, cs]); return cs.map(() => null); },
  });
  return () => k;
}

const FNS: Record<string, (args: any[], kw: any, log: (m: string) => void) => Promise<unknown>> = {
  "formats.goto": ([fid, bb, port, wait], kw, log) => F.goto(fid, bb, port, wait ?? true, log, !!kw.adding),
  "formats.leave": ([port], _kw, log) => F.leave(port, log),
  "formats.window_state": ([port]) => F.windowState(port),
  "formats.detect": ([port, settle]) => F.detect(port, settle ?? 0),
  "formats.seated_slots": ([port]) => F.seatedSlots(port),
  "formats.to_lobby": ([port], _kw, log) => F.toLobby(port, log),
  "auth.page_state": ([port]) => auth.pageState(port),
  "auth.login": ([name, port], _kw, log) => auth.login(name, port, log),
  "auth.submit_code": ([code, port], kw, log) => auth.submitCode(code, port, log, 20.0, kw.trust_device ?? null),
  "auth.snapshot": async ([port, state], _kw, log) => {
    const p = await auth.snapshot(port, state, log);
    return p ? basename(p) : p;
  },
  "balances.scrape": ([port]) => BAL.scrape(port),
  "balances.in_play": ([port]) => BAL.inPlay(port),
  "balances.snapshot": ([profile, port, sid, phase]) => BAL.snapshot(profile, port, sid, phase),
};

test("golden: CDP-driving flows ask the page the same questions as the Python wrapper", async () => {
  const fails: string[] = [];
  let n = 0;
  for (const rec of readCorpus("trace.jsonl.gz")) {
    n++;
    setFakeTime(rec.t0);
    const consumed = replay(rec.calls);
    const logs: string[] = [];
    let result: unknown;
    try {
      result = normPy(await FNS[rec.fn]!(rec.args, rec.kwargs || {}, (m) => logs.push(m)));
    } catch (e: any) {
      if (e instanceof Divergence) {
        fails.push(`${rec.name}: ${e.message}`);
        continue;
      }
      result = { __error__: `${e?.name}: ${e?.message}` };
    }
    if (consumed() !== rec.calls.length) fails.push(`${rec.name}: made ${consumed()} of ${rec.calls.length} calls`);
    else if (canon(result) !== canon(rec.result)) fails.push(`${rec.name}: result ${firstDiff(result, rec.result)}`);
    else if (canon(logs) !== canon(rec.logs)) fails.push(`${rec.name}: logs ${firstDiff(logs, rec.logs)}`);
    else if (Math.abs(time() - rec.tEnd) > 1e-6) fails.push(`${rec.name}: clock ended at ${time() - rec.t0}, Python ${rec.tEnd - rec.t0}`);
  }
  console.log(`golden trace: ${n - fails.length}/${n} scenarios identical`);
  expect(fails).toEqual([]);
});
