/**
 * GOLDEN: every pure-function call the Python recorder made (tests/golden/record_pure.py -> corpus/pure.jsonl.gz),
 * replayed through the TypeScript port. `out` is what Python returned; the port must return the same.
 *
 * FNS maps a recorded function name to the port's implementation, adapted to Python's output shape (snake_case
 * field names where Python returns a dataclass or a dict built with them). A name with no entry yet is counted
 * as PENDING and reported; the final gate (PORT-PLAN.md, phase D) requires none.
 */
import { expect, test } from "bun:test";
import { asRecordedFrame, canon, firstDiff, normPy, readCorpus } from "./lib";
import * as TERMINAL from "../../src/terminal";
import { HandReconciler, bb as rcBb, buttonsUp, makeTick, STREETS } from "../../src/reconcile";
import { FNS_EXTRA } from "./pure-fns";

const verdict = (v: TERMINAL.TerminalVerdict) => ({ terminal: v.terminal, kind: v.kind, why: v.why, final_stack_known: v.finalStackKnown, details: v.details });

export const FNS: Record<string, (args: any[], rec: any) => unknown | Promise<unknown>> = {
  "terminal.is_terminal": ([plan, hand]) => verdict(TERMINAL.isTerminal(plan, hand)),
  "terminal.hero_done": ([hand]) => verdict(TERMINAL.heroDone(hand)),
  "reconcile.bb": ([s]) => rcBb(s),
  "reconcile._buttons_up": ([b]) => buttonsUp(b),
  "reconcile.run": ([ticks], rec) => {
    const rc = new HandReconciler(1);
    const faults: number[] = [];
    const tks = ticks.map((t: any) => makeTick({ seq: t.seq, t: t.t, pot: t.pot, board: t.board, buttons: t.buttons, hero: t.hero,
                                                 seats: new Map(t.seats.map(([n, s]: [number, any]) => [n, s])) }));
    for (const tk of tks) {
      rc.observe(tk);
      faults.push(rc.faults().length);
    }
    rc.finish(tks.length ? tks[tks.length - 1].seq : 0);
    const want = rec.out.played as any[];
    return {
      journal: rc.journal, violations: rc.violations, line: rc.line(), faultsPerTick: faults, revivals: rc.revivals, ended: rc.ended,
      diff: rc.diff(want.map((x: any) => ({ street: typeof x[0] === "number" ? STREETS[x[0]] : x[0], seat: x[1], type: x[2], amount: x[3] }))),
      played: rec.out.played,
    };
  },
  ...FNS_EXTRA,
};

/**
 * SUPERSEDED 2026-09-24: the Python reader ordered a HEADS-UP table's postflop streets from the small blind; the big
 * blind acts first there (the dealer posts the SB). Its recorded reconcile.run inputs were simulated by a fuzzer with
 * the same mistake — tick streams no table deals — and its _line_order_fault never judged heads-up at all, so these
 * outputs record the bug (hand 4920374906). A heads-up table past the flop is covered instead by the fixed fuzzer
 * (fuzz.test.ts) and reader-boundary.test.ts. Decided by the INPUT, never the output, so no other drift can hide here.
 */
function supersededHeadsUp(rec: any): boolean {
  if (rec.fn === "reconcile.run") {
    const dealt = new Set<number>();
    for (const t of rec.args[0]) for (const [n, s] of t.seats) if ((s.cards || 0) > 0) dealt.add(n);
    return dealt.size === 2 && rec.args[0].some((t: any) => t.board >= 3);
  }
  if (rec.fn === "launch._line_order_fault") {
    const rc = rec.args[1];
    const ring = new Set([...rc.dealt, rc.sb, rc.bbs].filter((x: any) => x !== null && x !== undefined));
    return ring.size === 2 && rec.args[0].some((r: any) => r[0] !== "preflop");
  }
  return false;
}

/**
 * SUPERSEDED 2026-09-25 (session "GTO wizard connections list"): the preflight's gtow check lists EVERY GTO Wizard
 * account the API knows — disabled ones included — with `enabled`, `tokenLive`, `trees`, `account` and `accountId`,
 * for the panel's Connection list (the Python recording listed the enabled ones only, without those fields). The
 * output is projected back to the recorded shape — enabled accounts, the recorded keys — so everything else the
 * preflight returns is still compared exactly.
 */
const NEW_GTOW_SESSION_KEYS = ["enabled", "tokenLive", "trees", "account", "accountId"];
function asRecordedPreflight(fn: string, got: any): any {
  if (fn !== "sessions.run_preflight" || !got || !Array.isArray(got.checks)) return got;
  return {
    ...got,
    checks: got.checks.map((c: any) => (c && c.id === "gtow" && Array.isArray(c.sessions)
      ? { ...c, sessions: c.sessions.filter((x: any) => x.enabled !== false).map((x: any) =>
          Object.fromEntries(Object.entries(x).filter(([k]) => !NEW_GTOW_SESSION_KEYS.includes(k)))) }
      : c)),
  };
}

/**
 * SUPERSEDED 2026-09-28 (the ClubGG site, reader only): "Silent play" is offered on ClubGG too, so its `sites` gains
 * "clubgg" (the Python wrapper knew two sites). Projected back by dropping that one site; the rest of every preset is
 * still compared exactly.
 */
function asRecordedPresets(fn: string, got: any): any {
  if (fn !== "sessions.presets" || !got || typeof got !== "object") return got;
  return Object.fromEntries(Object.entries(got).map(([k, p]: [string, any]) =>
    [k, p && Array.isArray(p.sites) ? { ...p, sites: p.sites.filter((x: string) => x !== "clubgg") } : p]));
}

test("golden: pure functions match the Python wrapper", async () => {
  const pending = new Map<string, number>();
  const fails: string[] = [];
  const passed = new Map<string, number>();
  let superseded = 0;
  for (const rec of readCorpus("pure.jsonl.gz")) {
    if (supersededHeadsUp(rec)) {
      superseded++;
      continue;
    }
    const fn = FNS[rec.fn];
    if (!fn) {
      pending.set(rec.fn, (pending.get(rec.fn) || 0) + 1);
      continue;
    }
    let got: unknown;
    try {
      got = normPy(await fn(rec.args, rec));
      // a page snippet is compared with the frame resolver as the recording had it (lib.ts asRecordedFrame)
      if (typeof got === "string") got = asRecordedFrame(got);
      got = asRecordedPreflight(rec.fn, got);
      got = asRecordedPresets(rec.fn, got);
    } catch (e: any) {
      got = { __error__: `${e?.name || "Error"}: ${e?.message || e}` };
    }
    if (canon(got) !== canon(rec.out)) {
      if (fails.length < 25) fails.push(`${rec.fn}(${JSON.stringify(rec.args).slice(0, 200)}): ${firstDiff(got, rec.out)}`);
      else fails.length === 25 && fails.push("…");
    } else {
      passed.set(rec.fn, (passed.get(rec.fn) || 0) + 1);
    }
  }
  const p = [...pending].map(([k, v]) => `${k}×${v}`).join(", ");
  console.log(`golden pure: ${[...passed.values()].reduce((a, b) => a + b, 0)} calls matched across ${passed.size} functions` +
              ` (${superseded} heads-up postflop calls superseded — see supersededHeadsUp)` + (p ? `; PENDING (not ported yet): ${p}` : ""));
  expect(fails).toEqual([]);
// 29k recorded calls: 2-5 s alone, past Bun's 5 s default when other test runs share the CPU (2026-09-26: every call
// matched and the test still failed on the timer) — the same allowance the other replay goldens carry
}, 300_000);
