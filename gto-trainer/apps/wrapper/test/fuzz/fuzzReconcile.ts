/**
 * Throw hands at the reader until it breaks (port of the Python tests/fuzz_reconcile.py, 2026-09-24).
 *
 *   bun run test/fuzz/fuzzReconcile.ts [N] [--artefacts=a,b,c] [-v]
 *
 * Random hands are rendered as tick streams by fakeHand.ts — with the artefacts a real Ignition client produces —
 * and the line HandReconciler derives is compared to the line that was actually played. The recordings only show
 * what has already happened to us; this shows what would. Reported per artefact as well as overall: a failure rate
 * that only moves when `increment_first` is on says where to look.
 *
 * The generator draws from CPython's own Mersenne Twister (pyRandom.ts), so seed i deals exactly the hand the
 * Python fuzzer dealt for seed i.
 */
import { pyRound } from "../../src/py";
import { HandReconciler, type Tick } from "../../src/reconcile";
import { ALL_ARTEFACTS, simulate, type Act, type Played, type Script } from "./fakeHand";
import { PyRandom } from "./pyRandom";

const TOL = 0.06;

/**
 * One betting round, played until it CLOSES. A single pass over the seats is not a betting round: a raise puts
 * everyone who has already acted back in, and a generator that does one pass deals hands no table could.
 */
function playRound(street: number, ring: number[], live: number[], committed: Map<number, number>, level: number,
                   rng: PyRandom, actions: Act[], stacks: Map<number, number>): number {
  let acted = new Set<number>();
  let i = 0;
  const owedOf = (s: number) => pyRound(level - (committed.get(s) ?? 0.0), 2);
  const closed = () => live.every((s) => acted.has(s) && owedOf(s) <= TOL);
  for (let guard = 1; guard <= 60; guard++) {
    if (live.length < 2) return level;
    const seat = ring[i % ring.length]!;
    i++;
    if (!live.includes(seat)) continue;
    const owed = owedOf(seat);
    if (acted.has(seat) && owed <= TOL) {
      if (closed()) return level;
      continue;
    }
    const roll = rng.random();
    if (owed > TOL && roll < 0.45) {
      actions.push([street, seat, "fold", null]);
      live.splice(live.indexOf(seat), 1);
      acted.add(seat);
    } else if (owed > TOL && roll < 0.85) {
      actions.push([street, seat, "call", level]);
      committed.set(seat, level);
      acted.add(seat);
    } else if (owed <= TOL && roll < 0.55) {
      actions.push([street, seat, "check", null]);
      acted.add(seat);
    } else {
      const step = street === 0 ? rng.choice([2.0, 2.5, 3.0]) : rng.choice([1.2, 2.5, 5.0]);
      const to = pyRound(street === 0 ? level * step : level + step, 2);
      const headroom = Math.min(...live.map((s) => stacks.get(s)!));
      if (to >= headroom) {                 // keep it off the all-in path
        actions.push([street, seat, owed > TOL ? "call" : "check", owed > TOL ? level : null]);
        if (owed > TOL) committed.set(seat, level);
        acted.add(seat);
      } else {
        actions.push([street, seat, level > TOL ? "raise" : "bet", to]);
        committed.set(seat, to);
        level = to;
        acted = new Set([seat]);
      }
    }
    if (closed()) return level;
  }
  return level;
}

/**
 * A hand the way a table actually deals one. THE RING IS NOT OPTIONAL: the reader works the acting order out from
 * the blinds (preflop after the big blind, postflop from the small blind — heads-up from the big blind — clockwise by
 * displayed seat number), so a
 * generator dealing in another order is not a harder test, it is a wrong one (45% "failures" on the first run).
 */
export function randomScript(rng: PyRandom): Script {
  const n = rng.choice([2, 3, 4, 5, 6]);
  const seats = rng.sample([1, 2, 3, 4, 5, 6], n).sort((a, b) => a - b);
  const stacks = new Map<number, number>();
  for (const s of seats) stacks.set(s, pyRound(rng.choice([100.0, 100.0, 100.0, 57.3, 86.6, 175.5, 40.0]), 1));
  const btn = rng.randrange(n);
  const [sb, bb] = n === 2 ? [seats[btn]!, seats[(btn + 1) % 2]!]     // heads-up: the dealer IS the small blind
                           : [seats[(btn + 1) % n]!, seats[(btn + 2) % n]!];
  const iBb = seats.indexOf(bb);
  const order = [...seats.slice(iBb + 1), ...seats.slice(0, iBb + 1)];   // preflop acts after the big blind
  const hero = rng.choice(seats);
  const actions: Act[] = [];
  const live = [...seats];
  playRound(0, order, live, new Map([[sb, 0.5], [bb, 1.0]]), 1.0, rng, actions, stacks);
  // postflop starts at the small blind — heads-up at the BIG blind (the dealer posts the SB and acts last). This
  // generator dealt heads-up SB-first until 2026-09-24, agreeing with the reader's identical bug (hand 4920374906)
  const first = n === 2 ? bb : sb;
  const iFirst = seats.indexOf(first);
  const ring = [...seats.slice(iFirst), ...seats.slice(0, iFirst)];
  for (const street of [1, 2, 3]) {
    if (live.length < 2) break;
    playRound(street, ring.filter((s) => live.includes(s)), live, new Map(), 0.0, rng, actions, stacks);
  }
  return { stacks, hero, sb, bb, order, actions };
}

/**
 * Could a client actually deal this hand? The generator caps a raise at the SMALLEST live stack, never the actor's
 * own remaining, so it occasionally wagers more than a seat holds — a negative stack no client has drawn. Skipped
 * rather than asserted on: a fuzzer that fails on hands the game cannot produce teaches nothing.
 */
export function playable(script: Script): boolean {
  const spent = new Map<number, number>();
  const streetC = new Map<number, Map<number, number>>();
  for (const [street, seat, kind, amount] of script.actions) {
    if (amount === null) continue;
    if (!streetC.has(street)) streetC.set(street, new Map());
    const cur = streetC.get(street)!;
    cur.set(seat, kind !== "call" ? Math.max(cur.get(seat) ?? 0.0, amount) : amount);
  }
  for (const per of streetC.values()) for (const [seat, v] of per) spent.set(seat, (spent.get(seat) ?? 0.0) + v);
  return [...spent].every(([seat, v]) => v <= (script.stacks.get(seat) ?? 0.0) + 0.01);
}

export const norm = ([street, seat, kind, amount]: Played): Played => [street, seat, kind, amount === null ? null : pyRound(amount, 1)];

export function derived(ticks: Tick[]): Played[] {
  const rc = new HandReconciler(1);
  for (const tk of ticks) rc.observe(tk);
  rc.finish(ticks.length ? ticks[ticks.length - 1]!.seq : 0);
  return rc.line().map((a) => norm([a.street, a.seat, a.type, a.amount ?? null]));
}

const J = (x: unknown) => JSON.stringify(x);

export function firstDivergence(want: Played[], got: Played[]): string {
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    const w = want[i] ?? null, g = got[i] ?? null;
    if (J(w) !== J(g)) return `at #${i}: played ${J(w)}, read ${J(g)}`;
  }
  return "identical";
}

export interface ComboResult { label: string; n: number; bad: number; skipped: number; examples: string[] }

/** Seeds 0..n-1 through one artefact combination. */
export function runCombo(n: number, combo: readonly string[]): ComboResult {
  let bad = 0, skipped = 0;
  const examples: string[] = [];
  for (let i = 0; i < n; i++) {
    const script = randomScript(new PyRandom(i));
    if (!playable(script)) {
      skipped++;
      continue;
    }
    const [ticks, want] = simulate(script, combo, new PyRandom(i));
    if (!ticks.length) continue;
    const w = want.map(norm), g = derived(ticks);
    if (J(w) !== J(g)) {
      bad++;
      if (examples.length < 3) examples.push(`      seed ${i} (${script.stacks.size} seats): ${firstDivergence(w, g)}`);
    }
  }
  const label = !combo.length ? "none" : combo.length === ALL_ARTEFACTS.length && ALL_ARTEFACTS.every((a) => combo.includes(a)) ? "ALL" : combo.join(",");
  return { label, n, bad, skipped, examples };
}

/** The default suite: no artefacts, each artefact alone, and all of them at once. */
export const DEFAULT_COMBOS: (readonly string[])[] = [[], ...ALL_ARTEFACTS.map((a) => [a]), [...ALL_ARTEFACTS]];

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const nums = argv.filter((a) => !a.startsWith("-"));
  const n = nums.length ? Number(nums[0]) : 400;
  const only = argv.find((a) => a.startsWith("--artefacts"));
  const combos = only !== undefined ? [only.split("=").slice(1).join("=").split(",").filter(Boolean)] : DEFAULT_COMBOS;
  let grand = 0;
  for (const combo of combos) {
    const r = runCombo(n, combo);
    grand += r.bad;
    const pct = r.bad ? `   (${((100 * r.bad) / Math.max(1, n - r.skipped)).toFixed(1)}% wrong)` : "";
    console.log(`  ${r.bad ? "BAD" : "ok "} artefacts=${r.label.padEnd(18)} ${n - r.bad - r.skipped}/${n - r.skipped} hands read exactly right${pct}`
                + (r.skipped ? `   [${r.skipped} unplayable, skipped]` : ""));
    if (r.bad && argv.includes("-v")) for (const e of r.examples) console.log(e);
  }
  console.log(grand ? `\n${grand} mismatched hands across the combinations` : "\nall clean");
  process.exit(grand ? 1 : 0);
}
