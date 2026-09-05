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
  { id: "preflop", label: "Preflop", what: "every decision before the flop: opens, 3-bets, calls, folds", sources: ["exploit-preflop", "hrc-3max", "gtow-charts"] },
  { id: "postflop", label: "Postflop", what: "flop, turn and river play from the range the preflop piece arrives with", sources: ["mes-postflop", "gtow-ai", "gtow-library"] },
  { id: "opponent", label: "Opponent model", what: "what hero assumes the villains do; the MES pieces are best-responses to exactly one of these", sources: ["pool-model", "hrc-3max"] },
  { id: "ground-truth", label: "Ground truth", what: "not a piece: the evidence the pieces are graded against", sources: ["log"] },
] as const;

const PREFLOP: Record<string, PreflopLayer> = {
  exploit: { id: "exploit", label: "MES preflop (pool best-response)", short: "MES pre",
    arrival: "exploit", requiresEnv: "EXPLOIT_CHART", source: "exploit-preflop", builtAgainst: "pool" },
  chart: { id: "chart", label: "GTO preflop (HRC asym charts)", short: "GTO pre",
    arrival: "chart", source: "hrc-3max" },
};
const POSTFLOP: Record<string, PostflopLayer> = {
  mes: { id: "mes", label: "MES postflop (locked solves, refit)", short: "MES post",
    assumesArrival: "exploit", needsMes: true, source: "mes-postflop", builtAgainst: "pool" },
  gto: { id: "gto", label: "GTO postflop (equilibrium / GTOW AI)", short: "GTO post",
    assumesArrival: "any", source: "gtow-ai" },
};
const OPPONENT: Record<string, OpponentLayer> = {
  pool: { id: "pool", label: "Measured pool (pool_model + villain_freqs)", short: "pool", source: "pool-model" },
  gto: { id: "gto", label: "Equilibrium villains (chart ranges)", short: "GTO villains", source: "hrc-3max" },
};

// ---- catalogue ------------------------------------------------------------
export interface StrategyDef {
  id: string; name: string; tagline: string; preflop: string; postflop: string; opponent: string;
  matrixRow: string;   // id in strategy_matrix groups[].rows[]
  recommended?: boolean;
}
// Names are the ones you'll see at the table — deliberately plain.
export const STRATEGIES: StrategyDef[] = [
  { id: "apex", name: "Apex", tagline: "Full pool exploit — MES preflop and postflop",
    preflop: "exploit", postflop: "mes", opponent: "pool", matrixRow: "combined_refit", recommended: true },
  { id: "vanguard", name: "Vanguard", tagline: "Exploit preflop, safe equilibrium postflop",
    preflop: "exploit", postflop: "gto", opponent: "pool", matrixRow: "ex_eq" },
  { id: "bedrock", name: "Bedrock", tagline: "Equilibrium everywhere — the unexploitable floor",
    preflop: "chart", postflop: "gto", opponent: "gto", matrixRow: "eq_eq" },
  // deliberately incoherent — kept to demonstrate the safeguard, never served
  { id: "mirage", name: "Mirage", tagline: "GTO preflop with MES postflop — mis-specified, do not play",
    preflop: "chart", postflop: "mes", opponent: "pool", matrixRow: "combined_refit" },
];

export type StratStatus = "ok" | "misspecified" | "unavailable" | "drift";
export interface StrategyView extends StrategyDef {
  preflopLayer: PreflopLayer; postflopLayer: PostflopLayer; opponentLayer: OpponentLayer;
  status: StratStatus; reasons: string[]; preconditions: { check: string; pass: boolean; detail: string }[];
}

/** Validate every strategy against what's installed and the arrival-range rule. */
export function evaluate(): StrategyView[] {
  const mes = mesPostflopInfo();
  const exploitArmed = !!process.env.EXPLOIT_CHART && existsSync(process.env.EXPLOIT_CHART!);
  // villain drift: does the served MES's stamped pool model match the live one?
  const pool = readJson(join(LIMP, "pool_model_v4.json")) ?? readJson(join(LIMP, "pool_model_v3.json"));
  const poolMtime = (() => { try { return statSync(join(LIMP, "pool_model_v4.json")).mtimeMs; } catch { return null; } })();
  const mesBuilt = mes.meta?.built_at ? Date.parse(String(mes.meta.built_at)) : null;
  const poolDrift = poolMtime != null && mesBuilt != null && poolMtime > mesBuilt;

  return STRATEGIES.map((s) => {
    const pre = PREFLOP[s.preflop]!, post = POSTFLOP[s.postflop]!, opp = OPPONENT[s.opponent]!;
    const pc: { check: string; pass: boolean; detail: string }[] = [];
    const reasons: string[] = [];

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

    // 3. villain drift (warning, not fatal)
    if (post.needsMes && poolDrift) {
      pc.push({ check: "opponent piece unchanged since the MES lock", pass: false, detail: "pool_model_v4.json is newer than the served MES build; re-lock behind it" });
      reasons.push("the live pool model is newer than the MES solve it was locked against — values may have drifted (re-run the batch).");
    }

    let status: StratStatus = "ok";
    if (!arrivalOk || !oppOk) status = "misspecified";
    else if (pc.some((x) => !x.pass && x.check !== "opponent piece unchanged since the MES lock")) status = "unavailable";
    else if (post.needsMes && poolDrift) status = "drift";

    return { ...s, preflopLayer: pre, postflopLayer: post, opponentLayer: opp, status, reasons, preconditions: pc };
  });
}

/** The one strategy a live/answer decision should be tagged with, from its mode
 *  + whether the MES overlay actually answered. Used to label Hands + the log. */
export function strategyIdForAnswer(a: { strategy_mode?: string | null; source?: string | null }): string | null {
  const mode = a.strategy_mode, src = a.source;
  if (src === "mes-postflop" || (mode === "exploit" && src === "pool-exploit-preflop")) return "apex";
  if (mode === "exploit") return "vanguard";
  if (mode === "chart") return "bedrock";
  return null;
}
