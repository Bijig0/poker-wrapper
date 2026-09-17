/**
 * Strategy catalogue — the single authority on the WHOLE-HAND strategies we can
 * actually play, and the safeguards that stop us playing an incoherent one.
 *
 * A strategy is three pieces: preflop + postflop + opponent model. Each declares what it
 * PROVIDES and what it REQUIRES, and the validator refuses combinations whose
 * requirements aren't met by their partner or by what's installed:
 *
 *   - the MES postflop locks were solved with hero ARRIVING on the exploit
 *     range (exploit_ranges.json). A GTO/chart preflop layer arrives with a
 *     different, stronger range, so MES-postflop behind chart-preflop is
 *     answering a spot hero is never in — flagged `misspecified`, never served.
 *   - MES postflop also assumes villain = the pool model it was locked against;
 *     if the live pool model has drifted, that's a `drift` warning.
 *   - a layer whose data/env isn't present is `unavailable`.
 *
 * `evaluate()` returns, per strategy, a status the UI and the Playthrough picker
 * both honour: only `ok` strategies are selectable; the rest show greyed with
 * the exact reason. Nothing here is a winrate — the numbers come from the
 * strategy matrix (data/strategy_matrix.json); this maps each strategy to its
 * matrix row and to the preconditions that make the number legitimate.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mesPostflopInfo } from "./mesPostflop";
import { chartsLanded } from "./ledger";

const DATA = join(import.meta.dir, "..", "..", "data");
const LIMP = join(DATA, "..", "..", "..", "..", "analysis", "pipeline", "limp_study");
const readJson = (p: string): any | null => { try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; } };

// ---- layers ---------------------------------------------------------------
// arrivalRange: the id (in exploit_ranges / chart terms) of the range hero
//   REACHES a flop with under this preflop layer. postflop layers that were
//   solved for a specific arrival name it in `assumesArrival`.
export interface PreflopLayer {
  id: string; label: string; short: string;
  arrival: "exploit" | "chart";   // which arriving range this produces
  requiresEnv?: string;           // env var that must be set (e.g. EXPLOIT_CHART)
  source: string;                 // registry source id it routes through
  builtAgainst?: "pool";          // opponent model the best-response was computed against
  /** pinned chart set (resolved-charts.json key, e.g. "ign200"): the layer is the
   *  equilibrium of ONE format, and evaluate() checks its re-solved rungs are installed */
  chartSet?: string;
  /** ledger config ids whose charts this layer plays from — for a set that is still
   *  being solved, evaluate() counts how many of its charts are in the catalog and
   *  refuses the strategy until they are all there (services/ledger.ts chartsLanded) */
  chartConfigs?: string[];
  /** seats at the table this layer is solved for (default 3) — a 6-seat set needs a
   *  6-seat chart picker before an answer can route to it */
  seats?: number;
}
export interface PostflopLayer {
  id: string; label: string; short: string;
  assumesArrival: "exploit" | "chart" | "any"; // arrival the solve was conditioned on
  needsMes?: boolean;             // requires the mes_postflop artifact
  source: string;
  builtAgainst?: "pool";          // opponent model the solve was locked against
}
/** The opponent model: what hero ASSUMES villains do. MES pieces are a
 *  best-response to one specific model and are meaningless against another. */
export interface OpponentLayer {
  id: string; label: string; short: string;
  source: string;
}

/** The pieces a whole-hand strategy is assembled from, in the order the hand
 *  is played. Surfaced by the registry so the Pieces page can group sources. */
export const PIECES = [
  { id: "preflop", label: "Preflop", what: "every decision before the flop: opens, 3-bets, calls, folds", sources: ["exploit-preflop", "hrc-3max", "hrc-6max", "gtow-charts"] },
  { id: "postflop", label: "Postflop", what: "flop, turn and river play from the range the preflop piece arrives with", sources: ["mes-postflop", "gtow-ai", "gtow-library"] },
  { id: "opponent", label: "Opponent model", what: "what hero assumes the villains do; the MES pieces are best-responses to exactly one of these", sources: ["pool-model", "hrc-3max", "hrc-6max"] },
  { id: "ground-truth", label: "Ground truth", what: "not a piece: the evidence the pieces are graded against", sources: ["log"] },
] as const;

const PREFLOP: Record<string, PreflopLayer> = {
  // The pool it best-responds to was measured mostly at NL25 Zone; the tree
  // and cell EVs underneath are the NL200-rake HRC equilibrium (no NL25-rake
  // preflop tree exists) — see analysis/pipeline/limp_study/export_exploit_ranges.py.
  exploit: { id: "exploit", label: "MES preflop (pool best-response)", short: "MES pre",
    arrival: "exploit", requiresEnv: "EXPLOIT_CHART", source: "exploit-preflop", builtAgainst: "pool" },
  chart: { id: "chart", label: "GTO preflop (HRC asym charts, rake by stake)", short: "GTO pre",
    arrival: "chart", source: "hrc-3max" },
  // The NL200 3-max equilibrium: HRC charts solved at Ignition's 3-handed NL200 rake
  // (5%, $2 cap = 1bb, no flop no drop — verified against 21k hands 2026-09-12). The
  // v2ci re-solve (full postflop tree, 1h CFR) covers equal stacks 75–150bb and is
  // preferred by the chart picker; other depths fall back to the original grid.
  chartNl200: { id: "chart-nl200", label: "GTO preflop (HRC NL200 3-max equilibrium charts, 5% / cap 1bb)", short: "GTO pre NL200",
    arrival: "chart", source: "hrc-3max", chartSet: "ign200" },
  // The NL200 6-max RING equilibrium, being solved now (ledger proposal sixmax-nl200,
  // approved 2026-09-13): 30 even-stack trees (5 opens x 6 depths) + 36 uneven ones
  // (a 30/50/70bb seat at a 100bb table, every position, the two common opens) at
  // Ignition's SIX-dealt rake — 5%, $4 cap = 2bb, twice the 3-handed cap and more
  // than three times GTO Wizard's NL500 library, which is what answers 6-handed
  // spots today. Nothing serves this set until the charts land AND a 6-seat chart
  // picker exists (hrc3max.ts builds 3-seat canonical states only), so evaluate()
  // holds the strategy `unavailable` and says which of the two is missing.
  chart6maxNl200: { id: "chart-6max-nl200", label: "GTO preflop (HRC NL200 6-max ring equilibrium charts, 5% / cap 2bb)", short: "GTO pre 6-max",
    arrival: "chart", source: "hrc-6max", seats: 6,
    chartConfigs: ["grid-6max-nl200", "grid-6max-nl200-asym"] },
};
const POSTFLOP: Record<string, PostflopLayer> = {
  // locked at the NL25 rake schedule (5%, cap 4bb) behind the NL25 Zone pool ranges
  mes: { id: "mes", label: "MES postflop (locked solves, refit)", short: "MES post",
    assumesArrival: "exploit", needsMes: true, source: "mes-postflop", builtAgainst: "pool" },
  gto: { id: "gto", label: "GTO postflop (equilibrium / GTOW AI)", short: "GTO post",
    assumesArrival: "any", source: "gtow-ai" },
};
const OPPONENT: Record<string, OpponentLayer> = {
  pool: { id: "pool", label: "Measured pool (pool_model + villain_freqs)", short: "pool", source: "pool-model" },
  gto: { id: "gto", label: "Equilibrium villains (chart ranges)", short: "GTO villains", source: "hrc-3max" },
  gto6max: { id: "gto", label: "Equilibrium villains (6-max chart ranges)", short: "GTO villains", source: "hrc-6max" },
};

// ---- catalogue ------------------------------------------------------------
export interface StrategyDef {
  id: string; name: string; tagline: string; preflop: string; postflop: string; opponent: string;
  matrixRow: string;   // id in strategy_matrix groups[].rows[]
  recommended?: boolean;
  /** the format this strategy is built for: ledger format id + the matrix rake column */
  format: string; stake: "nl25" | "nl200";
  /** wrapper formats.json ids the session may be declared in (practice tables always allowed) */
  formats: string[]; defaultFormat: string;
  /** ids this strategy was called before 2026-09-12 (sessions + answers were tagged with them);
   *  "vanguard" (exploit preflop + GTO postflop) and "mirage" (the mis-specified demo) were removed
   *  2026-09-12 — vanguard sessions fold into the exploit strategy, mirage ones become untagged */
  legacyIds?: string[];
}
const PRACTICE = ["ign-practice-ring", "ign-practice-zone"];
// Named by site · stake · game · seats · what it plays. One entry per real, playable
// combination; the ids are stable and the names are what the table, the setup page
// and the dashboard show.
export const STRATEGIES: StrategyDef[] = [
  { id: "ign25-zone-3max-exploit", name: "Ignition 25NL Zone 3-max Exploit",
    tagline: "Pool exploit at every street — MES preflop and MES postflop, best-responses to the measured NL25 Zone pool",
    preflop: "exploit", postflop: "mes", opponent: "pool", matrixRow: "combined_refit", recommended: true,
    format: "ign-zone-3max-nl25", stake: "nl25", formats: ["ign-zone-NL25", ...PRACTICE], defaultFormat: "ign-zone-NL25",
    legacyIds: ["apex", "vanguard"] },
  { id: "ign200-zone-3max-equilibrium", name: "Ignition 200NL Zone 3-handed Equilibrium",
    tagline: "Equilibrium only — the NL200 3-max HRC charts preflop, GTO Wizard AI postflop; no pool model",
    preflop: "chartNl200", postflop: "gto", opponent: "gto", matrixRow: "eq_eq",
    format: "ign-3max-nl200", stake: "nl200", formats: ["ign-zone-NL200", ...PRACTICE], defaultFormat: "ign-zone-NL200",
    legacyIds: ["bedrock"] },
  // Built ahead of the charts (proposal sixmax-nl200, running on 7 HRC boxes since
  // 2026-09-13). Equilibrium end to end: our own 6-max NL200 preflop set at the
  // 2bb cap, GTO Wizard AI for every postflop spot from those arrival ranges.
  // No pool model — the 6-handed pool measurement (pool-model-6max-nl200) is a
  // later part of the same proposal and gets its own, exploit strategy.
  { id: "ign200-ring-6max-equilibrium", name: "Ignition 200NL Ring 6-max Equilibrium",
    tagline: "Equilibrium only — our own NL200 6-max HRC charts preflop (5% / cap 2bb), GTO Wizard AI postflop; no pool model",
    preflop: "chart6maxNl200", postflop: "gto", opponent: "gto6max", matrixRow: "eq_eq_6max",
    format: "ign-6max-nl200", stake: "nl200", formats: ["ign-ring-NL200-6", ...PRACTICE], defaultFormat: "ign-ring-NL200-6" },
];
/** The full-exploit strategy: a hand that got any MES postflop answer proves both layers were live. */
export const FULL_EXPLOIT_ID = "ign25-zone-3max-exploit";
const LEGACY_IDS: Record<string, string> = Object.fromEntries(
  STRATEGIES.flatMap((s) => (s.legacyIds ?? []).map((old) => [old, s.id])));
/** Resolve a strategy id as stored in a session config or answer row (old names included). */
export function canonicalStrategyId(id: string | null | undefined): string | null {
  if (!id) return null;
  return LEGACY_IDS[id] ?? (STRATEGIES.some((s) => s.id === id) ? id : null);
}

/**
 * The preflop SOURCE a strategy reads — the only thing that may decide it.
 *
 * A strategy is its layers (see STRATEGIES): declaring "Ignition 25NL Zone 3-max
 * Exploit" IS declaring the pool best-response preflop piece. There is no second
 * "mode" to set and no environment variable that may pick a different one; the
 * table surfaces never need to know which kind of piece answered, only what it said.
 * EXPLOIT_CHART still gates whether the exploit piece can LOAD (evaluate() reports
 * `unavailable` when it cannot) — it does not choose between pieces.
 */
export function preflopArrivalFor(strategyId: string | null | undefined): "exploit" | "chart" | null {
  const id = canonicalStrategyId(strategyId);
  const def = id ? STRATEGIES.find((x) => x.id === id) : null;
  return def ? (PREFLOP[def.preflop]?.arrival ?? null) : null;
}

export type StratStatus = "ok" | "misspecified" | "unavailable" | "drift";
export interface StrategyView extends StrategyDef {
  preflopLayer: PreflopLayer; postflopLayer: PostflopLayer; opponentLayer: OpponentLayer;
  status: StratStatus; reasons: string[]; preconditions: { check: string; pass: boolean; detail: string }[];
  /** known limits that do NOT block play: accepted trade-offs, with the date they were accepted */
  advisories: string[];
}

// Every preflop piece (grid and exploit alike) is solved at the NL200 rake
// structure (5%, cap 1bb). NL25 rakes 5% cap 4bb. Re-running the exploit
// argmax with the NL25 charges flips ~5-11% of hands per node toward limps and
// folds and leaves ~+0.3 bb/100 of modelled preflop edge; the shipped chart
// earns less than that at NL25. Accepted 2026-09-07 while NL25 is the starter
// stake: the postflop MES carries the edge. Re-derive before moving up.
const PREFLOP_RAKE_ADVISORY = "Preflop piece is solved at the NL200 rake structure (5% / cap 1bb) rather than NL25's (cap 4bb), where its modelled preflop edge is ~0 — a chart tuned at the real rake flips 5-11% of hands per node toward limps and folds. Accepted 2026-09-07 while NL25 was the starter stake; SUPERSEDED 2026-09-14 by the ign25 grid, so this only shows if a launcher arms the old export again.";

/** Validate every strategy against what's installed and the arrival-range rule. */
export function evaluate(): StrategyView[] {
  const mes = mesPostflopInfo();
  const exploitArmed = !!process.env.EXPLOIT_CHART && existsSync(process.env.EXPLOIT_CHART!);
  /** the chart the armed exploit export was fit to — names its rake structure */
  const exploitChart: string | null = exploitArmed ? (readJson(process.env.EXPLOIT_CHART!)?.chart ?? null) : null;
  // villain drift: does the served MES's stamped pool model match the live one?
  // The live one is POOL_MODEL when the launcher names it (the NL25 cutover points
  // it at pool_model_nl25.json) — the same env services/ledger.ts and the Sources
  // cards read, so all three report the model actually in force.
  const poolPath = process.env.POOL_MODEL ?? join(LIMP, "pool_model_v4.json");
  const pool = readJson(poolPath) ?? readJson(join(LIMP, "pool_model_v3.json"));
  const poolMtime = (() => { try { return statSync(poolPath).mtimeMs; } catch { return null; } })();
  const mesBuilt = mes.meta?.built_at ? Date.parse(String(mes.meta.built_at)) : null;
  const poolDrift = poolMtime != null && mesBuilt != null && poolMtime > mesBuilt;

  return STRATEGIES.map((s) => {
    const pre = PREFLOP[s.preflop]!, post = POSTFLOP[s.postflop]!, opp = OPPONENT[s.opponent]!;
    const pc: { check: string; pass: boolean; detail: string }[] = [];
    const reasons: string[] = [];
    /** set when the preflop charts are usable but not all solved yet — an advisory, not a blocker */
    let chartGap: { have: number; want: number } | null = null;

    // 0. opponent coherence: a best-response piece only means something
    //    against the model it was computed for
    const needsPool = [pre.builtAgainst, post.builtAgainst].filter(Boolean) as string[];
    const oppOk = needsPool.every((m) => m === opp.id);
    pc.push({ check: "opponent model matches the best-response pieces",
      pass: oppOk,
      detail: needsPool.length === 0 ? "no piece is a best-response; any opponent model is coherent"
        : `${needsPool.length === 2 ? "both MES pieces were" : "the MES piece was"} locked against the ${needsPool[0]} model; opponent piece is ${opp.short}` });
    if (!oppOk) reasons.push(`the MES pieces are a best-response to the measured pool, but this strategy assumes ${opp.label}. The exploit has nothing to exploit. Not served.`);

    // 1. arrival-range coherence — the load-bearing safeguard
    const arrivalOk = post.assumesArrival === "any" || post.assumesArrival === pre.arrival;
    pc.push({ check: "arrival range matches the postflop solve",
      pass: arrivalOk,
      detail: post.assumesArrival === "any"
        ? "postflop layer is arrival-agnostic (equilibrium)"
        : `postflop solved for the ${post.assumesArrival} arrival range; preflop delivers the ${pre.arrival} range` });
    if (!arrivalOk) reasons.push(`MES postflop was solved for the exploit arrival range; ${pre.short} arrives with a different range, so its flop strategy is answering a spot you never reach. Not served.`);

    // 2. inputs present
    if (pre.requiresEnv) {
      const ok = pre.id === "exploit" ? exploitArmed : true;
      pc.push({ check: `${pre.requiresEnv} armed`, pass: ok, detail: ok ? "set and readable" : "not set — preflop exploit overlay is off" });
      if (!ok) reasons.push(`${pre.requiresEnv} is not armed — the ${pre.short} layer has no data.`);
    }
    if (post.needsMes) {
      const ok = mes.exists && mes.families.length > 0;
      pc.push({ check: "mes_postflop.json loaded", pass: ok, detail: ok ? `${mes.families.reduce((n, f) => n + f.boards.length, 0)} boards` : "missing" });
      if (!ok) reasons.push("the MES postflop artifact is not installed.");
    }
    if (pre.chartSet) {
      // the pinned equilibrium: its re-solved (correct-tree) rungs must be installed on the chart server
      const resolved = readJson(join(DATA, "resolved-charts.json")) as Record<string, number[]> | null;
      const rungs = (resolved?.[pre.chartSet] ?? []).slice().sort((a, b) => a - b);
      const ok = rungs.length > 0;
      pc.push({ check: `${pre.chartSet} re-solved equilibrium charts installed`, pass: ok,
        detail: ok ? `${rungs.length} equal-stack rungs ${rungs[0]}–${rungs[rungs.length - 1]}bb (full postflop tree, 1h CFR); other depths fall back to the original grid`
          : "resolved-charts.json lists none — every answer would come from the original grid (no HU river betting)" });
      if (!ok) reasons.push(`no re-solved ${pre.chartSet} charts are registered — the preflop layer would serve the superseded grid.`);
    }
    if (pre.chartConfigs?.length) {
      // A set still on the boxes. Blocking until the LAST chart lands made the strategy unusable for days while
      // most states already had a chart, so the bar is now "something to answer from": with charts in the catalog
      // the strategy is selectable and the gaps are an advisory, because the picker falls back down its
      // preference list and every fallback is said out loud in the answer's own warning (services/hrc6max.ts).
      const cl = chartsLanded(pre.chartConfigs);
      pc.push({ check: "preflop chart set solved", pass: cl.have > 0,
        detail: cl.want === 0 ? "the ledger expects no charts for these configs — check the config ids"
          : `${cl.have} of ${cl.want} charts in the catalog · ${cl.perConfig.map((p) => `${p.id} ${p.have}/${p.want}`).join(" · ")}` });
      if (cl.have === 0) reasons.push(`the ${pre.short} chart set has not started landing — ${cl.have} of ${cl.want} charts are in the catalog, so there is nothing to answer from.`);
      else if (!cl.complete) chartGap = { have: cl.have, want: cl.want };
    }
    if ((pre.seats ?? 3) !== 3) {
      // hrc3max.ts picks a chart from 3-seat canonical states (one short + two equal
      // deep). A 6-seat set needs its own picker before an answer can reach it —
      // without one, 6-handed preflop spots keep falling to the GTO Wizard NL500
      // library at the wrong rake. The check passes when that module is written.
      const routed = existsSync(join(import.meta.dir, `hrc${pre.seats}max.ts`));
      pc.push({ check: `${pre.seats}-seat preflop chart picker installed`, pass: routed,
        detail: routed ? `services/hrc${pre.seats}max.ts routes ${pre.seats}-handed spots to this set`
          : `services/hrc${pre.seats}max.ts does not exist — hrc3max.ts builds 3-seat canonical states only, so ${pre.seats}-handed spots still answer from the GTO Wizard NL500 library` });
      if (!routed) reasons.push(`no ${pre.seats}-seat chart picker: an answer at the table could not reach this set even once the charts land (ledger step postflop-6max-nl200 cutover).`);
    }

    // 2b. arrival POT: the lock must have been solved at the pot the preflop
    //     piece actually creates (a 2bb open makes a 4bb pot, not the 6bb the
    //     original 3x locks assume). Checked per family shape.
    if (post.needsMes && pre.id === "exploit") {
      const chart = readJson(process.env.EXPLOIT_CHART ?? "") as { choices?: Record<string, Record<string, string>> } | null;
      const dominant = (ctx: string): number | null => {
        const ch = chart?.choices?.[ctx]; if (!ch) return null;
        const w: Record<string, number> = {};
        for (const [h, a] of Object.entries(ch)) if (a.startsWith("Raise ")) w[a] = (w[a] ?? 0) + (h.length === 2 ? 6 : h.endsWith("s") ? 4 : 12);
        const top = Object.entries(w).sort((a, b) => b[1] - a[1])[0];
        return top ? Number(top[0].slice(6)) : null;
      };
      const shapes = [
        { label: "SB open bvb, BB calls", ctx: "sb_bvb", heroPos: "SB", pot: (o: number) => 2 * o },
        { label: "BTN open, SB folds, BB calls", ctx: "btn_root", heroPos: "BTN", pot: (o: number) => 2 * o + 0.5 },
      ];
      for (const sh of shapes) {
        const o = dominant(sh.ctx); if (o == null) continue;
        const want = sh.pot(o);
        const fams = mes.families.filter((f) => f.heroPos === sh.heroPos);
        const near = fams.map((f) => ({ id: f.id, pot: f.pot / 100 })).sort((a, b) => Math.abs(a.pot - want) - Math.abs(b.pot - want))[0];
        const ok = !!near && Math.abs(near.pot - want) / want <= 0.15;
        pc.push({ check: `lock pot matches the ${sh.label} arrival`, pass: ok,
          detail: `preflop piece opens ${o}bb → ${want}bb pot; ${near ? `nearest lock ${near.id} at ${near.pot}bb` : "no lock for this shape"}` });
        if (!ok) reasons.push(`${sh.label}: the preflop piece opens to ${o}bb (pot ${want}bb) but the postflop lock was solved at ${near?.pot ?? "?"}bb — served as an approximation until the pot-${want} re-lock lands.`);
      }
    }

    // 3. villain drift (warning, not fatal)
    if (post.needsMes && poolDrift) {
      pc.push({ check: "opponent piece unchanged since the MES lock", pass: false, detail: "pool_model_v4.json is newer than the served MES build; re-lock behind it" });
      reasons.push("the live pool model is newer than the MES solve it was locked against — values may have drifted (re-run the batch).");
    }

    let status: StratStatus = "ok";
    if (!arrivalOk || !oppOk) status = "misspecified";
    else if (pc.some((x) => !x.pass && x.check !== "opponent piece unchanged since the MES lock" && !x.check.startsWith("lock pot matches"))) status = "unavailable";
    else if (post.needsMes && (poolDrift || pc.some((x) => !x.pass && x.check.startsWith("lock pot matches")))) status = "drift";

    // the NL200-rake advisory only applies where an NL200-solved piece is played at NL25
    // The advisory belongs to the ARMED FILE, not to the stake: since the NL25
    // cutover (2026-09-14) the exploit layer is fit to ign25_3maxasym2ci at the
    // real 4bb cap, so a card that still claimed "solved at the NL200 rake"
    // would be the lie. It comes back by itself if a launcher re-arms the old
    // export — the file says which chart it was fit to.
    const advisories = s.stake === "nl25" && !(pre.id === "exploit" && String(exploitChart ?? "").startsWith("ign25"))
      ? [PREFLOP_RAKE_ADVISORY] : [];
    if (chartGap) {
      advisories.push(
        `INCOMPLETE SET: ${chartGap.have} of ${chartGap.want} preflop charts have landed. A state whose own tree is not solved yet is answered from the nearest chart that is (same depth, next open size; an uneven state from the even chart), and the answer says which one it used. The states still missing are the limp trees and the deepest rungs.`);
      advisories.push(
        "STILL REFINING: these are first-pass charts. The second pass re-solves every tree with four times the samples and REPLACES them under the same ids, so answers here will shift slightly — most at the deep 3-bet and 4-bet nodes, where the first pass is 2-3x noisier than our 3-max charts.");
    }
    if (pre.id === "chart-6max-nl200") {
      advisories.push(
        "NO POOL MODEL: equilibrium end to end. The 6-handed pool measurement and the locked continuation charts are a later part of the same proposal, so nothing here exploits how the Ignition 6-max pool actually plays.");
      advisories.push(
        "MULTIWAY POSTFLOP: GTO Wizard AI solves heads-up only, so a flop with three or more players has NO answer under this strategy (no library fallback).");
      advisories.push(
        "RANGE SHORTCUT IN USE (2026-09-17): the HRC 6-max trees cap callers - two cold-callers after an open, one caller of a 3-bet, two limpers - so a third caller, a second caller of a 3-bet or a third limper has NO branch in any chart. Rather than re-solve the 100bb rung wider (~3 fleet-days, and HRC may refuse the bigger trees), the postflop range walk BORROWS that seat's calling range from the neighbouring node with one earlier caller folded. The borrowed range is somewhat too wide; pot, stacks and board stay exact. Every affected answer carries 'RANGE SHORTCUT' in its warning. What it buys is small: of 38 such misses in the fake-table test only 6 were heads-up at the flop (the rest were multiway, which the heads-up AI cannot solve anyway), so ~0.6% of postflop spots come back, plus correct preflop range context for a future multiway solver. Hero's own third-call decisions (0.08% of preflop decisions) still have no chart answer. Exact fix = wider trees (genSixMaxPlan flats [0,3,2,1] / [3,3,2,1]); pilot D100_o2_5 first.");
    }
    return { ...s, preflopLayer: pre, postflopLayer: post, opponentLayer: opp, status, reasons, preconditions: pc, advisories };
  });
}

/** The one strategy a live/answer decision should be tagged with, from its mode
 *  + whether the MES overlay actually answered. Used to label Hands + the log. */
export function strategyIdForAnswer(a: { strategy_mode?: string | null; source?: string | null; bb_cents?: number | null; table_seats?: number | null }): string | null {
  const mode = a.strategy_mode, src = a.source;
  if (src === "mes-postflop" || (mode === "exploit" && src === "pool-exploit-preflop")) return FULL_EXPLOIT_ID;
  // exploit mode without an MES answer on the hand is still the exploit session (declared strategy wins anyway)
  if (mode === "exploit") return FULL_EXPLOIT_ID;
  // chart mode is only an equilibrium strategy when the table WAS NL200, and which
  // one depends on how many seats were dealt (3-handed Zone vs the 6-max ring); the
  // session's declared strategy (sessionsStore) overrides this heuristic anyway
  if (mode === "chart") {
    if (a.bb_cents !== 200) return null;
    return (a.table_seats ?? 3) > 3 ? "ign200-ring-6max-equilibrium" : "ign200-zone-3max-equilibrium";
  }
  return null;
}
