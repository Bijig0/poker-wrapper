/**
 * THE MIX HERO WAS SERVED, PER COMBO (served-strategy narrowing, 2026-10-08 — Brady: "go for it, do the work + merge").
 * Register: services/approximations.ts `retree-consistency` (the same switch, HERO_STREET_AS_ANSWERED).
 *
 * Hero's earlier action on a street narrows his range at his later nodes there (aiChain, retree-consistency): by the
 * node he was ANSWERED on when the walk's plan holds that node (1), else — new here — by the mix he was SERVED for that
 * action (2), else by the walking tree's own strategy (3, only when nothing of the answer is kept). The served mix is
 * the one the live path played from: one tree's node strategy, or the blend over a 4+-way field's collapse plans
 * (fastSolve, class-aligned, blendStrategies) — per combo, the whole menu.
 *
 * WHY (live answer 11381, hand 4922298483, solve 5928): a 4-way turn. Hero SB 2d2h checks (answered on plan
 * merge:CO+BTN, answer 11378), the CO bets 18, the BTN calls, hero RAISES to 73.1 (merge:CO+BTN, answer 11380: RAISE
 * 71.3% for 2d2h); the CO shoves 92.8, the BTN calls — and that decision can only be solved on plan ghost:BTN. No
 * ghost:BTN node answered either earlier action, so both were narrowed by the ghost tree's strategy (CHECK 0.4%, RAISE
 * 13.7% for 2d2h): hero's weight at his node 0.000 — absent, the CALL 100% right by luck. The mix he was served gives
 * 0.10 and 0.71.
 *
 * A decision is keyed by what does not depend on a plan: the hand, the street (0 flop .. 2 river) and hero's action
 * number on it (n: 0 = his first action on the street) — hero is never ghosted or merged, so every plan's line holds
 * his actions in the same order. Kept:
 *   - in memory (this process; the walk's lookup), 4 dp — exactly what the store holds, so a restart serves the same;
 *   - in the reference walk's stored trace (`trace.served`, solves table): the descriptor always, the per-combo
 *     strategies only for a BLEND (a single tree's are its hero node's own, already in the same trace). Measured on
 *     11380-type rows: see the commit.
 * Rows stored before 2026-10-08 carry no `served`: the mix is REBUILT from the decision's stored walks (the rows one
 * fastSolve call saved: same decision key and origin, saved together) with the same blend code (blendWalks) — the 4 dp
 * strategies of the traces in, so equal to the live blend to ~1e-4.
 */
import { solveStore } from "./solveStore";
import { isDurableKey } from "./handFacts";
import { codesOnRef, menuAction, menuByClass } from "./deadMoneyCollapse";
import { alignStrategy, blendStrategies } from "./multiwayCollapse";

const STREETS = ["flop", "turn", "river"] as const;
const r4 = (x: number): number => Math.round((x ?? 0) * 10000) / 10000;

// ── the blend (fastSolve's, shared) ──────────────────────────────────────────────────────────────────────────────
/** One action of a walk's node at hero's decision: its code (GTO Wizard's, else its name), name and per-combo strategy. */
export interface BlendSol { code: string; name?: string | null; strategy: ArrayLike<number> }
export interface BlendOut {
  /** the reference menu (the first walk's codes) */
  codes: string[];
  /** per walk: its codes on the reference menu (codesOnRef) and whether by class — null for the reference itself */
  onRef: ({ map: Map<string, string | null>; byClass: boolean } | null)[];
  /** a walk's action code as the reference menu names it ("<code>?" when it has no counterpart) */
  codeOn: (wi: number, code: string) => string;
  /** per walk, its strategies re-expressed on the reference menu, null when it cannot be (left out of the blend); empty
   *  with one walk */
  aligned: (number[][] | null)[];
  /** the monotone blend of the aligned walks (blendStrategies) — null unless two or more aligned */
  blended: number[][] | null;
}
/**
 * THE BLEND OVER COLLAPSE PLANS, as fastSolve serves it (2026-10-07, every collapse by action class): the first walk's
 * menu is the reference; a walk whose codes are all on it is taken as it is, else re-expressed by class (always by class
 * for dead-money trees, `deadMode`); a walk that cannot be aligned is left out; two or more aligned are blended. Pure.
 */
export function blendWalks(walks: BlendSol[][], deadMode: boolean): BlendOut {
  const ref = walks[0] ?? [];
  const codes = ref.map((x) => x.code);
  const refMenu = ref.map((x) => ({ code: x.code, name: x.name ?? null }));
  const onRef = walks.map((w, wi) => {
    if (wi === 0) return null;
    const c = codesOnRef(refMenu, w.map((x) => ({ code: x.code, name: x.name ?? null })), deadMode);
    return { map: new Map(w.map((y, j) => [y.code, c.codes[j] ?? null])), byClass: c.byClass };
  });
  const codeOn = (wi: number, code: string): string => (wi === 0 ? code : onRef[wi]?.map.get(code) ?? `${code}?`);
  const aligned = walks.length > 1
    ? walks.map((w, wi) => alignStrategy(codes, w.map((x) => ({ code: codeOn(wi, x.code), strategy: x.strategy as number[] }))))
    : [];
  const ok = aligned.filter((a): a is number[][] => !!a);
  return { codes, onRef, codeOn, aligned, blended: ok.length > 1 ? blendStrategies(codes, ok) : null };
}

// ── what is kept ─────────────────────────────────────────────────────────────────────────────────────────────────
/** One menu action of the served mix (the reference walk's node). */
export interface ServedAction { code: string; name: string; betsize: number | null }
/** THE SERVED MIX of one hero decision as the reference walk's trace stores it (`trace.served`). */
export interface ServedMix {
  v: 1;
  /** hero's node: the street (0 flop .. 2 river) and his action number on it (0 = his first) */
  k: number; n: number;
  /** the reference walk's first street (a re-root starts later) */
  first: number;
  /** the plans whose strategies made the mix — the reference first; one entry when not blended */
  plans: (string | null)[];
  blended: boolean;
  /** the reference walk's tree at hero's node */
  solId: string | null;
  menu: ServedAction[];
  /** per menu action, 1326 combos, 4 dp — stored only for a blend (a single tree's are its hero node's in the trace) */
  strategy?: number[][];
}
/** The served mix as the walk reads it: the strategies always there, and where it came from. */
export interface ServedHero extends ServedMix {
  strategy: number[][];
  src: "memory" | "store" | "rebuilt";
  solveRow?: number;
}

const SERVED_MAX = 300;
const served = new Map<string, ServedHero>();
const servedMisses = new Set<string>();
const keyOf = (handKey: string, k: number, n: number) => JSON.stringify([handKey, k, n]);

/** tests: forget every served mix (a restart) */
export function dropServed(): void { served.clear(); servedMisses.clear(); }

function remember(key: string, s: ServedHero): void {
  servedMisses.delete(key);
  served.delete(key);
  served.set(key, s);
  while (served.size > SERVED_MAX) {
    const first = served.keys().next().value;
    if (first === undefined) break;
    served.delete(first);
  }
}

/** One walk as fastSolve holds it after the chain: its plan, the node JSON at hero's decision, its trace. */
export interface ServedWalk { kind: string | null; data: any; trace?: { spec?: { firstStreet?: number }; streets?: { si: number; solId: string | null }[]; nodes?: { si: number; heroNode: boolean }[] } }

/**
 * THE MIX SERVED AT ONE DECISION (fastSolve, after the blend): the reference walk's menu, and per combo the blend over
 * the aligned walks — or the reference walk's own node strategy when nothing was blended. 4 dp. Null without a node.
 */
export function servedMixOf(a: { walks: ServedWalk[]; aligned: ServedWalk[]; blended: number[][] | null; heroAt: { k: number; n: number } }): ServedHero | null {
  const ref = a.walks[0];
  const sols: any[] = ref?.data?.action_solutions ?? [];
  if (!ref || !sols.length) return null;
  const heroNode = [...(ref.trace?.nodes ?? [])].reverse().find((x) => x.heroNode);
  const solId = heroNode ? ref.trace?.streets?.find((s) => s.si === heroNode.si)?.solId ?? null : null;
  const blended = !!a.blended;
  const strategy = blended
    ? a.blended!.map((row) => Array.from(row, r4))
    : sols.map((x) => Array.from((x.strategy ?? []) as ArrayLike<number>, r4));
  return {
    v: 1, k: a.heroAt.k, n: a.heroAt.n, first: ref.trace?.spec?.firstStreet ?? 0,
    plans: blended ? a.aligned.map((w) => w.kind) : [ref.kind], blended, solId: solId != null ? String(solId) : null,
    menu: sols.map((x) => ({
      code: String(x.action?.code ?? x.action?.display_name ?? "?"), name: String(x.action?.display_name ?? "?"),
      betsize: x.action?.betsize != null && x.action.betsize !== "" && Number.isFinite(Number(x.action.betsize)) ? Number(x.action.betsize) : null,
    })),
    strategy, src: "memory",
  };
}

/** What the reference walk's trace stores: the descriptor, and the strategies only for a blend. */
export function servedTraceField(s: ServedHero): ServedMix {
  const { src: _src, solveRow: _row, strategy, ...rest } = s;
  return s.blended ? { ...rest, strategy } : rest;
}

/** Keep the mix served at a decision (this process). */
export function recordServed(handKey: string, s: ServedHero): void {
  if (!handKey) return;
  remember(keyOf(handKey, s.k, s.n), { ...s, src: "memory" });
}

// ── the stored answers (a restart, the offline replays of old rows) ─────────────────────────────────────────────────
type StoredTrace = {
  spec?: { firstStreet?: number; planTag?: string | null; heroSeat?: string; oopPos?: string; midPos?: string; ipPos?: string; streetSeats?: (string | null)[][]; heroDecisionN?: number };
  streets?: { si: number; solId: string | null }[];
  nodes?: { si: number; ti: number; actor: number; heroNode: boolean; actions: { name: string; code: string; betsize: number | null; strategy: number[] }[] }[];
  served?: ServedMix;
};
const heroNodeOf = (t: StoredTrace) => [...(t.nodes ?? [])].reverse().find((x) => x.heroNode) ?? null;

/** Hero's decision a stored trace answered: the street and his action number on it (the descriptor, else the line). */
export function heroAtOfTrace(t: StoredTrace): { k: number; n: number } | null {
  if (t.served?.v === 1) return { k: t.served.k, n: t.served.n };
  const h = heroNodeOf(t);
  if (!h) return null;
  const sp = t.spec ?? {};
  const k = (sp.firstStreet ?? 0) + h.si;
  // a dead-money plan's spec says hero's real action number (aiChain heroDecisionN): its line's count is not it
  if (sp.heroDecisionN != null) return { k, n: sp.heroDecisionN };
  const heroPos = sp.heroSeat === "oop" ? sp.oopPos : sp.heroSeat === "mid" ? sp.midPos : sp.ipPos;
  const seats = sp.streetSeats?.[h.si];
  if (heroPos && seats && seats.length >= h.ti) {
    return { k, n: seats.slice(0, h.ti).filter((p) => p != null && p.toUpperCase() === heroPos.toUpperCase()).length };
  }
  // no seats in the spec: his earlier nodes on the street, by his seat index there
  return { k, n: (t.nodes ?? []).filter((x) => x.si === h.si && x.ti < h.ti && x.actor === h.actor).length };
}

/** A dead-money plan's walks are blended by class always; the stored row does not say so — a plan that is not a ghost /
 *  merge / fold collapse (nor the one tree) is one (deadMoneyCollapse names its plans by the seats dropped). */
const deadPlan = (kind: string | null | undefined) => kind != null && !/^(ghost|merge|fold):/.test(kind) && !/^last-resort/.test(kind);

/** The rows one fastSolve call saved for a decision: same decision key and origin, saved together (one synchronous
 *  loop — milliseconds apart; a seatbelt re-solve of the same decision is seconds later and its own run), each plan
 *  once (a plan seen again starts the next call's run: two calls for one decision can land within the second). */
const RUN_GAP_MS = 1000;
export function runsOf<T extends { id: number; ts: number; origin: string; decisionKey: string | null; plan?: string | null }>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    const cur = out[out.length - 1];
    const last = cur?.[cur.length - 1];
    const planSeen = r.plan !== undefined && !!cur?.some((x) => x.plan === r.plan);
    if (cur && last && last.decisionKey === r.decisionKey && last.origin === r.origin && r.ts - last.ts <= RUN_GAP_MS && !planSeen) cur.push(r);
    else out.push([r]);
  }
  return out;
}

/** The served mix of a stored decision: the trace's own (`served`), else rebuilt from the run's walks. */
export function servedFromRun(run: { id: number; trace: StoredTrace }[]): ServedHero | null {
  const ref = run[0];
  if (!ref) return null;
  const at = heroAtOfTrace(ref.trace);
  const h = heroNodeOf(ref.trace);
  if (!at || !h) return null;
  const solId = ref.trace.streets?.find((s) => s.si === h.si)?.solId ?? null;
  const own = h.actions.map((x) => x.strategy.map(r4));
  const menu = h.actions.map((x) => ({ code: x.code, name: x.name, betsize: x.betsize }));
  const sv = ref.trace.served;
  if (sv?.v === 1) {
    return { ...sv, strategy: sv.blended && sv.strategy ? sv.strategy : own, src: "store", solveRow: ref.id };
  }
  const walks = run.map((r) => ({ kind: r.trace.spec?.planTag ?? null, node: heroNodeOf(r.trace) })).filter((w) => w.node);
  const bw = blendWalks(walks.map((w) => w.node!.actions.map((x) => ({ code: x.code, name: x.name, strategy: x.strategy }))),
    walks.some((w) => deadPlan(w.kind)));
  const blended = !!bw.blended;
  return {
    v: 1, k: at.k, n: at.n, first: ref.trace.spec?.firstStreet ?? 0,
    plans: blended ? walks.filter((_, wi) => bw.aligned[wi]).map((w) => w.kind) : [walks[0]?.kind ?? null], blended,
    solId: solId != null ? String(solId) : null, menu,
    strategy: blended ? bw.blended!.map((row) => row.map(r4)) : own, src: "rebuilt", solveRow: ref.id,
  };
}

function servedFromStore(handKey: string, k: number, n: number): ServedHero | null {
  if (!isDurableKey(handKey)) return null;
  const want = STREETS[k];
  // the warm-up is never served; the live answers before anything else, the newest first
  const rows = solveStore.forHand(handKey).filter((r) => r.ok && r.street === want && r.origin !== "warm");
  const loaded = rows.flatMap((r) => {
    const g = solveStore.get(r.id);
    return g ? [{ id: r.id, ts: r.ts, origin: r.origin, decisionKey: r.decisionKey, plan: ((g.trace as StoredTrace)?.spec?.planTag ?? null) as string | null, trace: g.trace as StoredTrace }] : [];
  });
  const runs = runsOf(loaded).reverse().sort((x, y) => Number(x[0]!.origin !== "live") - Number(y[0]!.origin !== "live"));
  for (const run of runs) {
    const at = heroAtOfTrace(run[0]!.trace);
    if (!at || at.k !== k || at.n !== n) continue;
    const s = servedFromRun(run);
    if (s) return s;
  }
  return null;
}

/** The mix hero was served at his n-th action on street k of the hand: this process's record, else the stored answer
 *  (its `served`, else rebuilt from its walks). Null when neither has it. The store is read once per point. */
export function servedHeroStrategy(handKey: string, k: number, n: number): ServedHero | null {
  const key = keyOf(handKey, k, n);
  const hit = served.get(key);
  if (hit) return hit;
  if (servedMisses.has(key)) return null;
  try {
    const s = servedFromStore(handKey, k, n);
    if (s) remember(key, s);
    else {
      servedMisses.add(key);
      if (servedMisses.size > SERVED_MAX * 2) servedMisses.delete(servedMisses.values().next().value as string);
    }
    return s;
  } catch {
    return null;   // a fallback: a read that fails costs the correction, never the answer
  }
}

/**
 * Hero's action (a walk label: "Check", "Raise(7320)", "AllIn(9280)") on the served menu: the walk's own matcher first
 * (`match`, aiChain.matchWalkAction), else BY CLASS as the blend aligns plans (a wager onto the nearest non-all-in size,
 * an all-in onto the all-in) — the served menu is another plan's tree, with its own pot and stacks. -1 when the menu
 * has nothing of the class.
 */
export function servedActionIndex(label: string, menu: ServedAction[], match: (label: string, sols: any[]) => number): { j: number; byClass: boolean } {
  const sols = menu.map((m) => ({ action: { code: m.code, display_name: m.name, betsize: m.betsize } }));
  const j = match(label, sols);
  if (j >= 0) return { j, byClass: false };
  const w = /^(Bet|Raise|AllIn)\((\d+(?:\.\d+)?)\)$/.exec(label);
  const code = label === "Check" ? "X" : label === "Call" ? "C" : label === "Fold" ? "F" : w ? `R${Number(w[2]) / 100}` : null;
  if (!code) return { j: -1, byClass: false };
  const mine = { code, allIn: w?.[1] === "AllIn" };
  const to = menuByClass(menu.map((m) => menuAction(m.code, m.name)), [mine])[0];
  const k = to == null ? -1 : menu.findIndex((m) => m.code === to);
  return { j: k, byClass: k >= 0 };
}
