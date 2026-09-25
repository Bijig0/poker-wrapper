import type { RequestCounts } from "./requestScope";

/**
 * HOW AN ANSWER WAS PRODUCED — THE CHAIN PATH (2026-09-25, Brady: "an indicator of whether a hand went through the
 * happy path … or if an issue arose making multiple requests / a rebuild was necessary").
 *
 * The happy path of the answer chain: the flop-entering ranges are computed ONCE, from the tree hero's preflop
 * decisions were read on (the preflop pin), and every later decision takes each earlier street's ranges from the
 * hand's ledger — found (a hit) or advanced by the one street that closed since (a resume from hero's last node).
 * Anything else is either a rule Brady set (BY DESIGN — hero left the pick, a collapse plan, a size pinned into a new
 * tree: it costs requests, it is not a fault) or the RECOVERY path doing its job (REBUILT — the ranges were derived
 * again from the capture because what the fast path needed was missing or no longer matched). A tree created again
 * for an unchanged street, or a node fetched twice, is EXTRA REQUESTS; no answer at all is a FAULT.
 *
 * Everything here is pure: fastSolve / aiChain record what happened, this module classifies it, and every surface —
 * the panel's banner, the hand page, the session's Technical tab, the clean rate — is a fold over the same records.
 */

export type Verdict = "clean" | "by-design" | "rebuilt" | "leaked" | "fault";
export const VERDICT_RANK: Record<Verdict, number> = { clean: 0, "by-design": 1, rebuilt: 2, leaked: 3, fault: 4 };
/** by-design costs requests but is the design: it counts as clean (Brady, 2026-09-25) */
export const isClean = (v: Verdict | null | undefined): boolean => v === "clean" || v === "by-design";
export const worst = (vs: (Verdict | null | undefined)[]): Verdict =>
  vs.reduce<Verdict>((w, v) => (v && VERDICT_RANK[v] > VERDICT_RANK[w] ? v : w), "clean");
/** The words a person reads (the panel, the hand page): "leaked" is the ledger's term, "extra requests" the effect. */
export const VERDICT_LABEL: Record<Verdict, string> = {
  clean: "clean", "by-design": "clean (by design)", rebuilt: "rebuilt", leaked: "extra requests", fault: "no answer",
};

/** One thing that was not the happy path, with a stable code to group by (the Technical tab's reasons table). */
export interface PathReason { v: Exclude<Verdict, "clean">; code: string; text: string }

/** Where the flop-entering ranges came from on this decision. */
export interface ArrivalPath {
  /** hit = the hand's arrival memo (computed on an earlier decision); pin = resumed from the preflop pin (the happy
   *  path's first computation); designed = the strategy's own single source (the HU chart, a 3-max chart);
   *  by-design / rebuilt = see Verdict */
  how: "hit" | "pin" | "designed" | "by-design" | "rebuilt";
  /** the piece that produced them: pin-chart6max, pin-gtow-ai-preflop, recon6max, ai-arrival, hu-chart, … */
  producer: string;
  code?: string;
  why?: string | null;
  /** on a hit: how the memo's ranges were produced in the first place */
  first?: Omit<ArrivalPath, "first">;
}

/** One street of one walk (a collapse plan walks its own chain). */
export interface StreetPath {
  street: "flop" | "turn" | "river";
  plan: string | null;
  /** hit = from the hand's closed-street memo; resumed = from hero's last node on it; first = walked for the first
   *  time in this hand; by-design / rebuilt / leaked = walked again, see Verdict */
  how: "hit" | "resumed" | "first" | "by-design" | "rebuilt" | "leaked";
  code?: string;
  why?: string | null;
  /** the tree: from the cache, created (with GTO Wizard's own why), or not touched (a memo hit) */
  tree: "cached" | "created" | "none";
  treeWhy?: string | null;
  /** extra requests on this street that are not about the ranges: a tree created again, a node fetched twice */
  leak?: { code: string; why: string } | null;
  reads?: { cache: number; joined: number; fetched: number } | null;
}

export interface DecisionPath {
  v: 1;
  verdict: Verdict;
  reasons: PathReason[];
  street: string;
  arrival?: ArrivalPath;
  streets: StreetPath[];
  /** preflop: which piece answered, and why when it was not the first choice */
  preflop?: { piece: string; how: "designed" | "by-design" | "rebuilt"; code?: string; why?: string | null };
  /** GTO Wizard requests this call made (services/requestScope) */
  requests?: RequestCounts;
  origin?: string;
}

/** The reasons a path carries, in the order they happened (arrival, preflop, then street by street). */
export function reasonsOf(p: Pick<DecisionPath, "arrival" | "preflop" | "streets">): PathReason[] {
  const out: PathReason[] = [];
  const a = p.arrival;
  if (a && (a.how === "by-design" || a.how === "rebuilt")) {
    out.push({ v: a.how, code: a.code ?? `arrival:${a.producer}`, text: `flop ranges ${a.how === "rebuilt" ? "rebuilt" : "by design"}: ${a.why ?? a.producer}` });
  }
  const pf = p.preflop;
  if (pf && (pf.how === "by-design" || pf.how === "rebuilt")) {
    out.push({ v: pf.how, code: pf.code ?? `preflop:${pf.piece}`, text: `preflop ${pf.how === "rebuilt" ? "fallback" : "by design"}: ${pf.why ?? pf.piece}` });
  }
  for (const s of p.streets) {
    if (s.how === "by-design" || s.how === "rebuilt" || s.how === "leaked") {
      out.push({ v: s.how, code: s.code ?? `street:${s.how}`, text: `${s.street}${s.plan ? ` (${s.plan})` : ""}: ${s.why ?? s.how}` });
    }
    if (s.leak) out.push({ v: "leaked", code: s.leak.code, text: `${s.street}${s.plan ? ` (${s.plan})` : ""}: ${s.leak.why}` });
  }
  return out;
}

/** Classify a path: the verdict is the worst thing that happened on it. */
export function classifyPath(p: Omit<DecisionPath, "verdict" | "reasons" | "v"> & { fault?: PathReason | null }): DecisionPath {
  const reasons = reasonsOf(p);
  if (p.fault) reasons.push(p.fault);
  const { fault: _f, ...rest } = p;
  return { v: 1, ...rest, reasons, verdict: worst(reasons.map((r) => r.v)) };
}

/** A decision with no answer: the refusal as a fault reason, grouped by its fail kind. */
export const faultPath = (street: string, kind: string | null | undefined, reason: string): DecisionPath =>
  classifyPath({ street, streets: [], fault: { v: "fault", code: `fault:${kind || "no-answer"}`, text: reason.slice(0, 300) } });

/** No-answer kinds that say nothing about the chain: hero acted first, the hand ended, the export lagged the buttons. */
export const NEUTRAL_FAIL_KINDS = new Set(["not-heros-turn", "hand-over", "abandoned-stale"]);

/** The first reason worth a person's attention, short — the panel's one line. */
export function headline(p: Pick<DecisionPath, "verdict" | "reasons">): string | null {
  if (isClean(p.verdict)) return null;
  const r = p.reasons.find((x) => x.v === p.verdict) ?? p.reasons[0];
  return r ? r.text.slice(0, 140) : p.verdict;
}

// ── folds over logged decisions ─────────────────────────────────────────────────────────────────────────────────

/** The fields of an answers.sqlite row the folds read. */
export interface PathRow {
  ts: number;
  client_hand_id: string | null;
  wrapper_hand_id?: number | null;
  table_slot?: number | null;
  street: string | null;
  text: string | null;
  fail_kind?: string | null;
  path_verdict?: string | null;
  path?: string | null;
}

const handOf = (r: PathRow): string | null =>
  r.client_hand_id ? String(r.client_hand_id) : r.wrapper_hand_id != null ? `w${r.table_slot ?? ""}:${r.wrapper_hand_id}` : null;
const verdictOf = (r: PathRow): Verdict | null => {
  const v = r.path_verdict as Verdict | null | undefined;
  return v && v in VERDICT_RANK ? v : null;
};
export const parsePath = (r: PathRow): DecisionPath | null => {
  if (!r.path) return null;
  try { return JSON.parse(r.path) as DecisionPath; } catch { return null; }
};

export interface HandVerdict { hand: string; verdict: Verdict; decisions: number; postflop: boolean; firstTs: number; reasons: PathReason[] }

/** Each hand's verdict: the worst of its decisions. Rows logged before the chain path existed carry none and are left out.
 *  `withReasons` = false skips parsing every row's path JSON (the panel's clean count runs on each answer push). */
export function handVerdicts(rows: PathRow[], withReasons = true): HandVerdict[] {
  const by = new Map<string, HandVerdict>();
  for (const r of rows) {
    const v = verdictOf(r);
    const h = handOf(r);
    if (!v || !h) continue;
    const cur = by.get(h) ?? { hand: h, verdict: "clean" as Verdict, decisions: 0, postflop: false, firstTs: r.ts, reasons: [] };
    cur.decisions++;
    if (r.street && r.street !== "preflop") cur.postflop = true;
    if (VERDICT_RANK[v] > VERDICT_RANK[cur.verdict]) cur.verdict = v;
    const p = withReasons ? parsePath(r) : null;
    if (p) for (const x of p.reasons) if (!cur.reasons.some((y) => y.code === x.code)) cur.reasons.push(x);
    by.set(h, cur);
  }
  return [...by.values()].sort((a, b) => a.firstTs - b.firstTs);
}

/**
 * THE CLEAN RATE: of the hands that reached a POSTFLOP decision (the only place the range chain exists — a preflop
 * answer is a chart read), the share whose every decision was clean or by design. Preflop decisions of those hands
 * still count toward the hand's verdict (a chart server that was down, a preflop no-answer).
 */
export function cleanRate(rows: PathRow[]): { hands: number; clean: number; rate: number | null; byVerdict: Record<Verdict, number> } {
  const hv = handVerdicts(rows, false).filter((h) => h.postflop);
  const byVerdict: Record<Verdict, number> = { clean: 0, "by-design": 0, rebuilt: 0, leaked: 0, fault: 0 };
  for (const h of hv) byVerdict[h.verdict]++;
  const clean = byVerdict.clean + byVerdict["by-design"];
  return { hands: hv.length, clean, rate: hv.length ? clean / hv.length : null, byVerdict };
}

export interface TechnicalReport {
  cleanRate: ReturnType<typeof cleanRate>;
  /** every non-clean reason, grouped by code: how often, when first, which hands */
  reasons: { code: string; v: PathReason["v"]; n: number; hands: string[]; firstTs: number; example: string }[];
  /** decisions by verdict, and how the flop ranges were produced */
  decisions: { total: number; byVerdict: Record<Verdict, number>; arrival: Record<string, number>; streets: Record<string, number> };
  /** GTO Wizard requests per postflop hand, from the paths (live decisions only; the warm-up's are in the hand facts) */
  requests: { hands: number; total: number; perHandMedian: number | null; perHandMax: number | null; maxHand: string | null };
  hands: HandVerdict[];
}

export function technicalReport(rows: PathRow[]): TechnicalReport {
  const byVerdict: Record<Verdict, number> = { clean: 0, "by-design": 0, rebuilt: 0, leaked: 0, fault: 0 };
  const arrival: Record<string, number> = {};
  const streets: Record<string, number> = {};
  const reasons = new Map<string, TechnicalReport["reasons"][number]>();
  const reqByHand = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const v = verdictOf(r);
    if (!v) continue;
    total++;
    byVerdict[v]++;
    const p = parsePath(r);
    const h = handOf(r) ?? "?";
    if (!p) continue;
    if (p.arrival) arrival[p.arrival.how] = (arrival[p.arrival.how] ?? 0) + 1;
    for (const s of p.streets) streets[s.how] = (streets[s.how] ?? 0) + 1;
    for (const x of p.reasons) {
      const cur = reasons.get(x.code) ?? { code: x.code, v: x.v, n: 0, hands: [], firstTs: r.ts, example: x.text };
      cur.n++;
      if (!cur.hands.includes(h)) cur.hands.push(h);
      reasons.set(x.code, cur);
    }
    if (p.requests && r.street && r.street !== "preflop") {
      const n = p.requests.tree + p.requests.solution + p.requests.poll + p.requests.library + p.requests.other;
      reqByHand.set(h, (reqByHand.get(h) ?? 0) + n);
    }
  }
  const per = [...reqByHand.entries()].sort((a, b) => a[1] - b[1]);
  const max = per.at(-1) ?? null;
  return {
    cleanRate: cleanRate(rows),
    reasons: [...reasons.values()].sort((a, b) => VERDICT_RANK[b.v] - VERDICT_RANK[a.v] || b.n - a.n),
    decisions: { total, byVerdict, arrival, streets },
    requests: {
      hands: per.length, total: per.reduce((s, x) => s + x[1], 0),
      perHandMedian: per.length ? per[Math.floor((per.length - 1) / 2)]![1] : null,
      perHandMax: max ? max[1] : null, maxHand: max ? max[0] : null,
    },
    hands: handVerdicts(rows),
  };
}
