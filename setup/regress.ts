/**
 * Regression gate for the Poker Wrapper: one line per check + a summary. Exit 0 = green. (Port of regress.py,
 * 2026-09-24 — the wrapper's tooling has no Python.)
 *
 *   bun setup/regress.ts              full: API tests + typecheck, wrapper tests + typecheck + contract, the headless
 *                                     rig test, and the live smoke (:2000 / :8777 / :7700)
 *   bun setup/regress.ts --quick      skip the rig test
 *   bun setup/regress.ts --publish    what buildPackage.ts --publish requires: no rig test, no live checks
 *
 * Baselines (2026-09-24): API bun test 0 fail; tsc 0 errors outside src/scripts/_* (other sessions' scratch scripts,
 * never shipped); wrapper bun test 0 fail (2 skips); contract 287/287 with the transcript identical. Every Bun here is
 * the one config/env.ps1 resolves — the one the launchers run (PATH's `bun` can be npm's bun.CMD, a different Bun:
 * 1.3.14 drops a statement calling a function named `declare`, which only the launchers' Bun showed). The rig test
 * runs on its own headless rig (:7792), never :7700 / :7701. The live checks need the API and chart-server
 * services ("PokerWrapper API / Charts - <user>") and, for :7700, the Poker Wrapper open.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pyRepr } from "../gto-trainer/apps/wrapper/src/py";
import { apiUrl, chartsUrl, panelUrl } from "../gto-trainer/apps/api/src/services/ports";

const ROOT = resolve(import.meta.dir, "..");
const API = join(ROOT, "gto-trainer", "apps", "api");
const TSW = join(ROOT, "gto-trainer", "apps", "wrapper");
const TSC = join(ROOT, "gto-trainer", "node_modules", "typescript", "bin", "tsc");
const PUBLISH = process.argv.includes("--publish");
const QUICK = process.argv.includes("--quick") || PUBLISH;
const results: [string, boolean, string][] = [];

function findBun(): string {
  if (!process.env.BUN) {
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "config", "env.ps1"), "-EmitCmd"],
                        { encoding: "utf8", timeout: 60_000 });
    const m = /^set "BUN=(.+)"\r?$/m.exec(r.stdout || "");
    if (m && existsSync(m[1]!)) return m[1]!;
  }
  if (process.env.BUN && existsSync(process.env.BUN)) return process.env.BUN;
  return process.execPath;
}
const BUN = findBun();

function rec(name: string, ok: boolean, detail = ""): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} ${detail}`);
}

async function get(url: string, timeoutS = 20, data?: unknown): Promise<any> {
  const r = await fetch(url, {
    method: data === undefined ? "GET" : "POST", signal: AbortSignal.timeout(timeoutS * 1000),
    headers: data === undefined ? {} : { "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`HTTP Error ${r.status}: ${r.statusText}`);
  return r.json();
}

function run(cmd: string[], cwd: string, timeoutS: number, env: NodeJS.ProcessEnv = process.env): [number | null, string] {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8", timeout: timeoutS * 1000, env, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  return [r.status, (r.stdout || "") + (r.stderr || "")];
}
const lastLines = (out: string, n: number) => out.slice(-n);
const fails = (out: string) => out.split(/\r?\n/).filter((l) => l.startsWith("(fail)")).map((l) => l.trim().slice(7, 120));
const tscErrors = (out: string) => out.split(/\r?\n/).filter((l) => l.includes("error TS"));

// 1. API unit tests
try {
  const [, out] = run([BUN, "test"], API, 600);
  const m = /(\d+) pass\s+(?:\d+ skip\s+)?(\d+) fail/.exec(out);
  const f = fails(out);
  rec("api unit tests (bun test)", !!m && m[2] === "0", m ? `${m[1]} pass / ${m[2]} fail` + (f.length ? `: ${f.slice(0, 3).join("; ")}` : "") : lastLines(out, 200));
} catch (e: any) {
  rec("api unit tests (bun test)", false, String(e?.message ?? e));
}

// the one data root (gto-trainer/packages/data-root, 2026-09-25): where every record lives, legacy adoption (rowids,
// watermark, retirement, the mixed-version catch-up), the event tables — both apps' stores depend on it
try {
  const [, out] = run([BUN, "test"], join(ROOT, "gto-trainer", "packages", "data-root"), 120);
  const m = /(\d+) pass\s+(?:\d+ skip\s+)?(\d+) fail/.exec(out);
  const f = fails(out);
  rec("data-root tests (bun test)", !!m && m[2] === "0", m ? `${m[1]} pass / ${m[2]} fail` + (f.length ? `: ${f.slice(0, 3).join("; ")}` : "") : lastLines(out, 200));
} catch (e: any) {
  rec("data-root tests (bun test)", false, String(e?.message ?? e));
}

// the input-mutation gate (2026-09-25): 30 seeds x every table/capture operator through the real answer pipeline,
// offline (GTOW_BLOCK=1, dry postflop). Its own process on purpose: a sweep changes the GTO Wizard session state
// that the poller test reads when both share one `bun test` run. Red = a table state with no solver input.
// Also the chain ledger end to end (2026-09-25, fastSolve.chainLedger.test.ts): each street's ranges computed once
// and reused after, the path "clean"; a restart says "rebuilt" and why — it needs the same chart bake.
// And the miss queue's real-hands rule end to end (2026-09-26, missQueue.realHands.test.ts): a harness decision files
// nothing, the same decision at the table files its chart gaps.
try {
  const [, out] = run([BUN, "test", "src/scripts/mutationHarness.test.ts", "src/scripts/mutationHarness.fixtures.test.ts", "src/scripts/mutation/rangeOracle.test.ts", "src/scripts/mutation/referenceRanges.test.ts", "src/services/fastSolve.chainLedger.test.ts", "src/services/fastSolve.hand4920544353.test.ts", "src/services/missQueue.realHands.test.ts"], API, 900, { ...process.env, MUTATION_GATE: "1", ANSWERS_DB_PATH: ":memory:" });
  const m = /(\d+) pass\s+(?:\d+ skip\s+)?(\d+) fail/.exec(out);
  rec("api input-mutation gate", !!m && m[2] === "0", m ? `${m[1]} pass / ${m[2]} fail` : lastLines(out, 200));
} catch (e: any) {
  rec("api input-mutation gate", false, String(e?.message ?? e));
}
// the post-in gate (2026-09-25): every poster seat x every hero seat, the preflop tree to the 3-bet from the charts —
// a post-in table must answer as the ordinary table (check = limp, call, raise, unacted = ignored) and every pick the
// poller can roll must be a press the strip offers (hero's free option: never FOLD, never CALL). Own process, offline.
try {
  const [, out] = run([BUN, "test", "src/scripts/postInMatrix.test.ts"], API, 900, { ...process.env, MUTATION_GATE: "1", ANSWERS_DB_PATH: ":memory:" });
  const m = /(\d+) pass\s+(?:\d+ skip\s+)?(\d+) fail/.exec(out);
  rec("api post-in gate", !!m && m[2] === "0", m ? `${m[1]} pass / ${m[2]} fail` : lastLines(out, 200));
} catch (e: any) {
  rec("api post-in gate", false, String(e?.message ?? e));
}
// 2. API typecheck — errors in src/scripts/_* are scratch scripts (not shipped, not ours to fix here)
try {
  const [, out] = run([BUN, TSC, "--noEmit", "-p", "."], API, 600);
  const errs = tscErrors(out);
  const real = errs.filter((l) => !/^src[\\/]scripts[\\/]_/.test(l));
  rec("api typecheck (tsc)", !real.length, `${real.length} errors` + (real.length ? `: ${real[0]!.slice(0, 120)}` : "")
      + (errs.length > real.length ? ` (+${errs.length - real.length} in scratch src/scripts/_*)` : ""));
} catch (e: any) {
  rec("api typecheck (tsc)", false, String(e?.message ?? e));
}

// 3. the wrapper (gto-trainer/apps/wrapper): unit tests + the fuzzer + the goldens, its typecheck, and the HTTP
//    contract replayed against a headless instance on free ports of its own with temp state (runner.ts: runs from
//    several checkouts at once used to kill each other on the old fixed :7791) — never :7700 / :7701
try {
  const [, out] = run([BUN, "test"], TSW, 900);
  const m = /(\d+) pass\s+(?:(\d+) skip\s+)?(\d+) fail/.exec(out);
  const f = fails(out);
  rec("wrapper tests (bun test)", !!m && m[3] === "0", m ? `${m[1]} pass / ${m[3]} fail` + (f.length ? `: ${f.slice(0, 3).join("; ")}` : "") : lastLines(out, 200));
} catch (e: any) {
  rec("wrapper tests (bun test)", false, String(e?.message ?? e));
}
try {
  const [code, out] = run([BUN, TSC, "--noEmit", "-p", "."], TSW, 600);
  const errs = tscErrors(out);
  rec("wrapper typecheck (tsc)", code === 0 && !errs.length, `${errs.length} errors` + (errs.length ? `: ${errs[0]!.slice(0, 120)}` : ""));
} catch (e: any) {
  rec("wrapper typecheck (tsc)", false, String(e?.message ?? e));
}
try {
  const [code, out] = run([BUN, "run", "test/contract/runner.ts"], TSW, 600);
  const m = /ts: (\d+)\/(\d+) assertions passed/.exec(out);
  const ident = out.includes("transcript identical");
  // which assertion / step: the runner's own FAIL and DIFF lines (a bare "286/287" sends you to re-run it)
  const why = out.split(/\r?\n/).filter((l) => /^ {2}(FAIL|DIFF) /.test(l)).slice(0, 3).map((l) => l.trim().slice(0, 160));
  rec("wrapper contract", code === 0 && !!m && ident, m ? `${m[1]}/${m[2]} assertions, transcript ${ident ? "identical" : "DIFFERS"}`
      + (why.length ? `: ${why.join("; ")}` : "") : lastLines(out, 200));
} catch (e: any) {
  rec("wrapper contract", false, String(e?.message ?? e));
}

if (!QUICK) {
  // the end-to-end rig: pick -> relay -> the fake table's own click record, on a headless rig of its OWN (panel
  // :7792, CDP :9392, its own profile) — it never touches :7700 or Brady's :7701 rig, and no window opens
  try {
    const [code, out] = run([BUN, "test", "test/unit/pick-relay-rig.test.ts"], TSW, 300, { ...process.env, WRAPPER_RIG_TEST: "1" });
    const m = /(\d+) pass\s+(?:(\d+) skip\s+)?(\d+) fail/.exec(out);
    rec("wrapper rig (pick -> relay)", code === 0 && !!m && m[3] === "0" && m[1] === "1", m ? `${m[1]} pass / ${m[3]} fail` : lastLines(out, 200));
  } catch (e: any) {
    rec("wrapper rig (pick -> relay)", false, String(e?.message ?? e));
  }
}

// 4. live smoke
if (!PUBLISH) {
  try {
    const j = await get(`${apiUrl()}/api/dashboard/sources/strategies`);
    const st = new Map<string, string>(j.strategies.map((s: any) => [s.id, s.status]));
    const ok = ["ign25-zone-3max-exploit", "ign200-zone-3max-equilibrium", "ign200-ring-6max-equilibrium", "cp200-hu-equilibrium"]
      .every((k) => ["ok", "drift"].includes(st.get(k) ?? ""));
    rec("api :2000 strategies", ok, [...st].map(([k, v]) => `${k.split("-")[0]}:${v}`).join(" "));
  } catch (e: any) {
    rec("api :2000 strategies", false, String(e?.message ?? e));
  }
  try {
    const n = await get(`${chartsUrl()}/api/preflop/node?source=hrc_hu_cp200a_d100_o2_5_3b9&line=`, 90);
    rec("chart server :8777 node", !!n.ok, `root ${n.pos ?? "None"} ${pyRepr((n.actions || []).map((a: any) => a.token))}`);
  } catch (e: any) {
    rec("chart server :8777 node", false, String(e?.message ?? e));
  }
  try {
    const s = await get(`${panelUrl()}/state?light=1`);
    rec("wrapper :7700 /state", "site" in s && "panelVersion" in s, `site ${s.site ?? "None"} session ${s.sessionId ?? "None"}`);
    for (const [site, preset, cfg] of [["ignition", "strategy:ign200-ring-6max-equilibrium", { format: "ign-ring-NL200-6" }],
                                       ["coinpoker", "strategy:cp200-hu-equilibrium", { format: "cp-hu-NL200", recording: false }]] as const) {
      const pf = await get(`${panelUrl()}/session/preflight`, 60, { preset, config: { site, ...cfg } });
      // environment, not regressions: the Ignition profile, the live connection speed (netcheck), and the CoinPoker
      // attached table (none is picked by this call; the setup page picks one)
      const hard = pf.checks.filter((c: any) => c.required && !c.ok && !["profile", "net", "cp-table"].includes(c.id)).map((c: any) => c.label);
      rec(`wrapper preflight ${site}`, !hard.length, `${pf.checks.length} checks; blocking: ${hard.length ? pyRepr(hard) : "none"}`);
    }
  } catch (e: any) {
    rec("wrapper :7700 (open the Poker Wrapper)", false, String(e?.message ?? e));
  }
  try {
    const [, out] = run([BUN, "src/scripts/cpHuSmoke.ts"], API, 300);
    const ans = [...out.matchAll(/hrc-hu-preflop\/chart-hu .* -> pick (\S+)/g)].map((m) => m[1]!);
    rec("coinpoker HU preflop smoke", ans.length === 4 && out.includes("refused"), `${ans.length}/4 answered: ${pyRepr(ans)}`);
  } catch (e: any) {
    rec("coinpoker HU preflop smoke", false, String(e?.message ?? e));
  }
}

const bad = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(`\n${bad.length ? "FAILURES: " + bad.join(", ") : "ALL GREEN"}  (${new Date().toTimeString().slice(0, 8)})`);
process.exit(bad.length ? 1 : 0);
