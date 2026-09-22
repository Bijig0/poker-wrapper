/**
 * Enumerate real in-tree 6-max preflop lines that leave EXACTLY three players at the flop, each with the
 * probability the chart actually plays it (per-seat reach weights carried through the walk, combo-weighted).
 * Feeds scripts/collapseCalibration.ts, which needs REAL three-way flops, not hand-picked ones.
 */
import { fetchNode6max } from "../services/hrc6maxDb";
import { preflopClosed, preflopPotStack } from "../utils/aiStudyLine/aiStudyLine";

const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
const SOURCE = process.env.SRC ?? "ign200_6max_D100_o2_5";
const MAX_TOKENS = Number(process.env.MAXTOK ?? 9);
const MIN_W = Number(process.env.MINW ?? 2e-4);
const MIN_STACK = Number(process.env.MINSTACK ?? 20);
const WAY = Number(process.env.WAY ?? 3);   // how many players must reach the flop

const RANKS = "AKQJT98765432";
/** The 169 classes in the chart's own order, and how many combos each is worth. */
function classList(): { hand: string; combos: number }[] {
  const out: { hand: string; combos: number }[] = [];
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const a = RANKS[i]!, b = RANKS[j]!;
    if (i === j) out.push({ hand: a + b, combos: 6 });
    else if (i < j) out.push({ hand: a + b + "s", combos: 4 });
    else out.push({ hand: b + a + "o", combos: 12 });
  }
  return out;
}
const CLASSES = classList();
const COMBOS = new Map(CLASSES.map((c) => [c.hand, c.combos]));

function liveAfter(tokens: string[]): string[] {
  let active: string[] = [...SEATS];
  let p = 0;
  for (const tok of tokens) {
    if (active.length < 2) break;
    p = p % active.length;
    const seat = active[p]!;
    if (tok === "F") { active = active.filter((s) => s !== seat); continue; }
    p += 1;
  }
  return active;
}

type Reach = Map<string, Map<string, number>>;   // pos -> hand -> weight in [0,1]
const cloneReach = (r: Reach): Reach => new Map([...r].map(([k, v]) => [k, new Map(v)]));

const out: { tokens: string[]; seats: string[]; pot: number; stack: number; p: number }[] = [];

async function walk(tokens: string[], p: number, reach: Reach): Promise<void> {
  if (tokens.length > MAX_TOKENS || p < MIN_W) return;
  const node = await fetchNode6max(SOURCE, tokens.join("-"));
  if (!node || node === "unreachable") return;
  const live = liveAfter(tokens);
  const closed = preflopClosed(tokens);
  if (node.terminal || live.length < 2 || (closed && live.length === WAY)) {
    if (live.length === WAY && closed) {
      const { pot, stack } = preflopPotStack(tokens, 100);
      if (stack >= MIN_STACK) out.push({ tokens, seats: live, pot, stack, p });
    }
    return;
  }
  const pos = node.pos;
  if (!pos) return;
  const w = reach.get(pos) ?? new Map<string, number>();
  // combo-weighted mass of the acting seat's CURRENT range, and of each action within it
  let mass = 0;
  const byAction = new Map<string, number>();
  for (const c of node.cells) {
    const cw = (w.get(c.hand) ?? 1) * (COMBOS.get(c.hand) ?? 0);
    if (cw <= 0) continue;
    mass += cw;
    for (const [name, f] of Object.entries(c.actions)) byAction.set(name, (byAction.get(name) ?? 0) + (cw * f) / 100);
  }
  if (mass <= 0) return;
  for (const a of node.actions) {
    if (!a.token) continue;
    const branch = (byAction.get(a.action) ?? 0) / mass;
    if (branch <= 0) continue;
    const next = cloneReach(reach);
    const nw = new Map(w);
    for (const c of node.cells) nw.set(c.hand, (w.get(c.hand) ?? 1) * ((c.actions[a.action] ?? 0) / 100));
    next.set(pos, nw);
    await walk([...tokens, a.token], p * branch, next);
  }
}

await walk([], 1, new Map());
out.sort((a, b) => b.p - a.p);
const tot = out.reduce((s, r) => s + r.p, 0);
console.error(`${SOURCE}: ${out.length} ${WAY}-way lines, total probability ${(tot * 100).toFixed(2)}% of all hands`);
for (const r of out) console.log(JSON.stringify(r));
