/**
 * PATCH CHARTS FROM LIVE APPROXIMATIONS (2026-09-22, Brady: "every single time we have an 'approximation' in a live
 * session, it gets top priority queue … backfill from all our previous finished sessions in ignition 200NL 6-max …
 * two charts, one capped to 100bb, the other rounded to 5bb").
 *
 * A patch chart is a 6-max tree solved at ONE table's own per-seat stacks (chartCatalog: `ign200_6max_P_<seats>_o<open>`,
 * e.g. ign200_6max_P_BTN150_BB80_o2 — the first pair was built by hand for hand 489). Every state the live chart walk had
 * to approximate for a STACK reason gets two keys, exactly as that pair was cut:
 *   capped — every seat capped at the 100bb baseline (hero always reloads to 100; a deep folder plays like 100), the
 *            short stacks kept, rounded to 5bb. The chart the picker would reach most often.
 *   exact  — the stacks as they were, capped at the 150bb ceiling and rounded to 5bb.
 * A key whose stacks are all 100 is the even chart, which exists; identical keys collapse to one.
 *
 * Source = the miss queue's open rows for this strategy's charts, REAL hands only (stress runs excluded), so a live
 * session's approximation is here the moment the walk files it — the box queue polls this every minute.
 * Size misses (a raise off the menu) are NOT patch work: a patch chart uses the generator's standard menus, so it
 * would not contain the missing size either.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { missQueue, type MissItem } from "./missQueue";

const SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
const SYNTHETIC = /^(stress-|test|fake)/i;
/** the miss kinds a per-seat-stack chart fixes */
export const PATCH_KINDS = new Set(["short-rung-snapped", "no-limp-uneven", "open-not-in-set", "beyond-ladder"]);
const SOLUTIONS = join(import.meta.dir, "..", "..", "..", "..", "..", "analysis", "pipeline", "solve", "exploit_ui", "solutions");

const r5 = (x: number) => Math.round(x / 5) * 5;
const fmt = (x: number) => String(x).replace(".", "_");

export interface PatchKey {
  id: string; stacks: Record<string, number>; open: number | "limp"; variant: "capped" | "exact";
  /** SIZE PATCH: raise-to sizes ADDED to a menu level ("0" iso in a limp tree, "1" 3-bet, "2" 4-bet, "3" 5-bet) */
  sizesAdd?: Record<string, number[]>;
}
const LEVEL_TAG = ["i", "3b", "4b", "5b"];

/** the two patch keys for one table state (0-2 of them: all-100 keys are the even chart) */
export function patchKeys(site: string, stacksBB: Partial<Record<string, number>>, open: number | "limp",
                          sizesAdd?: Record<string, number[]>): PatchKey[] {
  const out: PatchKey[] = [];
  for (const variant of ["capped", "exact"] as const) {
    // limp trees deeper than 100bb do not fit in HRC's memory with our menus (wizard probe, 2026-09-22), so a limp
    // state's exact key is capped at 100 too — and then collapses into the capped key
    const ceil = variant === "capped" || open === "limp" ? 100 : 150;
    const stacks: Record<string, number> = {};
    for (const s of SEATS) {
      const raw = stacksBB[s];
      stacks[s] = raw == null ? 100 : Math.max(5, r5(Math.min(raw, ceil)));
    }
    const parts = SEATS.filter((s) => stacks[s] !== 100).map((s) => `${s}${stacks[s]}`);
    // an all-100 table is the even chart — unless a size is being added, then it is an EVEN patch with a wider menu
    if (!parts.length && !sizesAdd) continue;
    const sizeTag = sizesAdd ? "_" + Object.entries(sizesAdd).map(([l, v]) => `${LEVEL_TAG[Number(l)] ?? `l${l}`}${v.map(fmt).join("_")}`).join("_") : "";
    const id = `${site}_6max_P_${parts.length ? parts.join("_") : "EVEN"}_o${open === "limp" ? "limp" : fmt(open)}${sizeTag}`;
    if (!out.some((k) => k.id === id)) out.push({ id, stacks, open, variant, ...(sizesAdd ? { sizesAdd } : {}) });
  }
  return out;
}

/** the open size a missed state's tree needs: the open actually played for open-not-in-set, else the chart's own */
function openOf(m: MissItem): number | "limp" | null {
  if (m.kind === "open-not-in-set" && m.want) { const n = Number(String(m.want).replace(/^R/, "")); if (Number.isFinite(n)) return n; }
  const o = /_o(limp|[\d_]+)$/.exec(m.chart)?.[1];
  if (!o) return null;
  return o === "limp" ? "limp" : Number(o.replace("_", "."));
}

export interface PatchJob extends PatchKey {
  hits: number;
  lastSeen: number;
  kinds: string[];
  /** why: the approximation it removes, from one of the hands */
  why: string;
  limp: boolean;
  /** already solved (a solution exists in the catalog) */
  solved: boolean;
}

// ---- SIZE PATCHES (2026-09-22, Brady: "if a chart was hit with an approximation because the chart only contained 2.5x,
// whereas the real game had a 2x, it should add 2x to the menu"). A missing raise size is ADDED to its menu level on a patch
// of the same table — but only where the snap costs something (the measured translation error is under 0.01% of the pot
// within 1.5x): a snap of 1.5-2x; a size more than 2x off where GTO Wizard AI cannot answer instead (a pot with two or more
// limpers); or a size that keeps coming back (RECUR_HITS real hits across tables at one chart/level). An open size off the
// menu is not an added size at all: the open is the tree's own dimension, so the patch is simply a tree with that open.
const FAR_SNAP = 0.4;
const RECUR_HITS = 5;
const logDist = (reason: string) => Number(/log-dist ([\d.]+)/.exec(reason)?.[1] ?? NaN);
const raisesBefore = (line: string) => (line || "").split("-").filter((t) => /^R/.test(t)).length;
const limpsBeforeRaise = (line: string) => { let n = 0; for (const t of (line || "").split("-")) { if (/^R/.test(t)) break; if (t === "C") n++; } return n; };
const wantOf = (m: MissItem) => { const n = Number(String(m.want ?? "").replace(/^R/, "")); return Number.isFinite(n) && n > 0 ? n : null; };

/** the size patch a size miss calls for, or null when the snap is cheap / GTO Wizard AI answers it exactly */
function sizePlan(m: MissItem, recurring: boolean): { open: number | "limp"; sizesAdd?: Record<string, number[]> } | null {
  const want = wantOf(m); const open = openOf(m);
  if (want == null || open == null) return null;
  const far = m.kind === "size-snapped" && logDist(m.reason) > FAR_SNAP;
  const aiCannot = m.kind === "size-off-tree" && open === "limp" && limpsBeforeRaise(m.line) >= 2;
  if (!far && !aiCannot && !recurring) return null;
  const level = raisesBefore(m.line);
  if (level === 0 && open !== "limp") return { open: want };              // an open size: a tree with that open
  return { open, sizesAdd: { [String(level)]: [Math.round(want * 2) / 2] } };
}

/** every patch chart the strategy's live approximations call for, most-hit first */
export function patchJobs(prefix = "ign200_6max_"): PatchJob[] {
  const by = new Map<string, PatchJob>();
  const site = prefix.replace(/_6max_$/, "");
  const realOf = (m: MissItem) => m.refs.filter((r) => !SYNTHETIC.test(String(r.clientHandId ?? "")));
  // recurring sizes: real hits per chart / level / size, across every table that snapped it
  const recur = new Map<string, number>();
  for (const m of missQueue.list("open")) {
    if (!String(m.chart).startsWith(prefix) || (m.kind !== "size-snapped" && m.kind !== "size-off-tree")) continue;
    const w = wantOf(m); if (w == null) continue;
    const k = `${m.chart}|${raisesBefore(m.line)}|${Math.round(w * 2) / 2}`;
    recur.set(k, (recur.get(k) ?? 0) + realOf(m).length);
  }
  const add = (k: PatchKey, m: MissItem, hits: number) => {
    const j = by.get(k.id) ?? { ...k, hits: 0, lastSeen: 0, kinds: [], why: m.reason, limp: k.open === "limp",
      solved: existsSync(join(SOLUTIONS, `${k.id}.json.gz`)) };
    j.hits += hits; j.lastSeen = Math.max(j.lastSeen, m.lastSeen);
    if (!j.kinds.includes(m.kind)) j.kinds.push(m.kind);
    by.set(k.id, j);
  };
  for (const m of missQueue.list("open")) {
    if (!String(m.chart).startsWith(prefix)) continue;
    const real = realOf(m);
    if (!real.length) continue;
    if (m.kind === "size-snapped" || m.kind === "size-off-tree") {
      const w = wantOf(m);
      const recurring = w != null && (recur.get(`${m.chart}|${raisesBefore(m.line)}|${Math.round(w * 2) / 2}`) ?? 0) >= RECUR_HITS;
      const plan = sizePlan(m, recurring);
      if (plan) for (const k of patchKeys(site, m.state?.stacksBB ?? {}, plan.open, plan.sizesAdd)) add(k, m, real.length);
      continue;
    }
    if (!PATCH_KINDS.has(m.kind)) continue;
    const open = openOf(m);
    if (open == null) continue;
    for (const k of patchKeys(site, m.state?.stacksBB ?? {}, open)) {
      add(k, m, real.length);
    }
  }
  return [...by.values()].sort((a, b) => b.hits - a.hits || b.lastSeen - a.lastSeen);
}
