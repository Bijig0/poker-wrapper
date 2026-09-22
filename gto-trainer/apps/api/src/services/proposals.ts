import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, loadLedger, expectedChartIds, isBoxGrid, BOX_GRID_KINDS, DATA_DIR, MES_HANDOFF, LIMP, type EvaluatedConfig } from "./ledger";
import { runbookFor, hrcJobsFor, type Runbook } from "./runbook";
import { getCatalog } from "./chartCatalog";
import { jobs } from "./jobs";
import { chartStates, runEstimate, type ChartState } from "./chartProgress";

/**
 * PROPOSALS — the run at the level Brady reads: WHAT is being worked on,
 * not how. One proposal = one run, in parts; each part says its INPUT,
 * its WORK (one line per solve, with status), its OUTPUT (a named set and
 * what is in it) and its CHECK. Machines, scripts, paths and ids stay in the
 * operator detail (runbook.ts). Nothing starts until the proposal is
 * approved; "run everything" queues every step as a chain that waits for
 * its inputs.
 */

export interface Work { n: number; what: string; how: string; minutes: number; status: "done" | "planned" | "blocked" | "running" | "queued" | "failed"; ref?: string; data?: any; /** charts of this line already done (per-chart count, for the totals) */ doneCharts?: number; live?: { job: number; lane: string; status: string; started: number | null; ended: number | null; phase: string } }
export interface Part {
  title: string; input: string[]; how: string[]; work: Work[]; output: { name: string; items: string[] }; check: string[]; blocked: string[];
  numbers: { solves: number; done: number; wallMinutes: number; eur: number; text: string }; steps: string[];
}
export interface Proposal {
  id: string; run: string; why: string; format: string; approved: { at: string } | null; parts: Part[];
  state: "draft" | "approved" | "running" | "done" | "attention";
  totals: { solves: number; done: number; wallMinutes: number; eur: number; text: string };
  activity: { config: string; label: string; job: number; status: string; since: number | null }[];
  canRunAll: boolean; details: Runbook[];
}

// the MES spots in words; the open size is read off the spec's flop pot (SB vs BB: pot = 2 × open; BTN vs BB: + the SB's 0.5)
const MES_SPOTS = [
  { id: "M1_heroSB_bvb_cbet", what: (pot: number) => `SB opens ${pot / 2}bb, BB calls — hero is the SB, out of position` },
  { id: "M2_heroBTN_srp_vs_BB", what: (pot: number) => `BTN opens ${(pot - 0.5) / 2}bb, BB calls — hero is the BTN, in position` },
  { id: "M1_heroSB_bvb_cbet_p4", what: (pot: number) => `SB opens ${pot / 2}bb, BB calls — hero is the SB, out of position` },
  { id: "M2_heroBTN_srp_vs_BB_p4", what: (pot: number) => `BTN opens ${(pot - 0.5) / 2}bb, BB calls — hero is the BTN, in position` },
];

const minsStr = (m: number) => (m >= 48 * 60 ? `${(m / 1440).toFixed(m >= 14400 ? 0 : 1)} days` : m >= 60 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)} h` : `${Math.round(m)} min`);

export function proposals(): Proposal[] {
  const L = loadLedger();
  const ev = evaluate();
  const byId = new Map(ev.configs.map((c) => [c.id, c]));
  let catalogIds = new Set<string>();
  try { catalogIds = new Set((getCatalog().entries as any[]).map((e) => String(e.id))); } catch { /* none */ }
  const jobList = jobs.list(200);
  const liveJob = (cfg: string) => jobList.find((x) => x.config === cfg && (x.status === "queued" || x.status === "running")) ?? null;
  /** the most recent job for a config (any status) + its last meaningful log line = the phase shown live */
  const liveOf = (cfg: string) => {
    // several boxes on one step: one line naming every box and what it is refining
    const lives = jobList.filter((x) => x.config === cfg && (x.status === "queued" || x.status === "running"));
    if (lives.length > 1) {
      const parts = lives.map((x) => { const t = jobs.logTail(x.id, 400); const m = [...t.matchAll(/refining (\S+) for/g)].pop(); return `${x.lane.split(":").pop()}: ${m ? `refining ${m[1]}` : x.status}`; });
      return { job: lives[0]!.id, lane: `hrc-box:${lives.map((x) => x.lane.split(":").pop()).join("+")}`, status: lives.some((x) => x.status === "running") ? "running" : "queued", started: Math.min(...lives.map((x) => x.started ?? Date.now())), ended: null, phase: parts.join(" · ").slice(0, 220) };
    }
    const j = liveJob(cfg) ?? jobList.find((x) => x.config === cfg) ?? null;
    if (!j) return undefined;
    const tail = jobs.logTail(j.id, 40).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !/^\$ /.test(l) && !/^\(cwd /.test(l));
    const interesting = tail.filter((l) => /box:|parity|ship|started on|pulled|parsed|PULL|PARSE|refining|FAIL|exit|done:|waiting/i.test(l));
    const phase = (interesting[interesting.length - 1] ?? tail[tail.length - 1] ?? "").replace(/^\[[\d:]+\] /, "").slice(0, 160);
    return { job: j.id, lane: j.lane, status: j.status, started: j.started, ended: j.ended, phase };
  };

  return ((L as any).proposals ?? []).map((P: any): Proposal => {
    const allCfgs: EvaluatedConfig[] = [];
    const parts: Part[] = (P.parts ?? []).map((pp: any): Part => {
      const cfgs = (pp.steps as string[]).map((id) => byId.get(id)).filter((c): c is EvaluatedConfig => !!c);
      allCfgs.push(...cfgs);
      const fmt = L.formats.find((f) => f.id === cfgs[0]?.format);
      const work: Work[] = [];
      const blocked: string[] = [];
      const measured: { label: string; est: ReturnType<typeof runEstimate> }[] = [];
      let n = 1;
      for (const c of cfgs) {
        const lj = liveJob(c.id);
        const lastJob = jobList.find((x) => x.config === c.id) ?? null;
        const live = lj ? (lj.status as "running" | "queued") : (lastJob && lastJob.status === "failed" && c.effective !== "done" ? ("failed" as const) : null);
        const lv = liveOf(c.id);
        if (c.work && c.work.length) {
          // hand-written lines (uneven-stack batches, the 4-handed pieces): status from the config
          let from = 0;
          const allIds = expectedChartIds(c, fmt);
          const allStates: ChartState[] = allIds.length ? chartStates(c, allIds) : [];
          const stateOf = new Map(allStates.map((x) => [x.id, x]));
          for (const w of c.work) {
            // a batch of solves (uneven-stack states, 6-max trees): its own chart ids — done in the catalog, solving on a box, queued
            const ids = w.solves ? allIds.slice(from, from + w.solves) : [];
            const st = ids.map((id) => stateOf.get(id)!).filter(Boolean);
            const done = st.filter((x) => x.state === "done").length, solved = st.filter((x) => x.state === "solved").length, running = st.filter((x) => x.state === "running");
            const short = (id: string) => id.replace(/^ign\d+_(6max|3max\w*|4max\w*)_/, "");
            const progress = ids.length && done < ids.length && (done || solved || running.length)
              ? ` · ${done} of ${ids.length} done${solved ? `, ${solved} solved on the boxes (pulling)` : ""}${running.length ? ` · solving now: ${running.map((r) => `${short(r.id)} on ${r.box}${r.sinceMin != null ? ` (${r.sinceMin} min)` : ""}`).join(", ")}` : ""}` : "";
            const batchStatus = ids.length ? (done === ids.length ? "done" : c.effective === "blocked" ? "blocked" : running.length ? "running" : live ? "queued" : "planned") : (c.effective === "done" ? "done" : c.effective === "blocked" ? "blocked" : live ?? "planned");
            work.push({ n: n++, what: `${w.what}${progress}`, how: w.how, minutes: w.minutes, ref: ids.length ? ids.join(" ") : (w.solves && w.solves > 1 ? Array(w.solves).fill("·").join(" ") : undefined), status: batchStatus, doneCharts: ids.length ? done : undefined,
            data: c.kind === "preflop-grid-asym" ? { kind: "asym", config: c.id, from, to: from + (w.solves ?? 0) } : c.kind === "opponent-model" ? { kind: "pool", config: c.id, file: c.produces[0] ? join(LIMP, c.produces[0]) : undefined } : c.kind === "exploit-export" ? { kind: "exploit", config: c.id, file: c.produces[0] ? join(LIMP, c.produces[0]) : undefined } : ids.length ? { kind: "charts", config: c.id, ids } : { kind: "none", config: c.id },
            ...(running.length ? { live: { job: liveJob(c.id)?.id ?? 0, lane: `hrc-box:${[...new Set(running.map((r) => r.box))].join("+")}`, status: "running", started: null, ended: null, phase: running.map((r) => `${r.box}: ${short(r.id)}${r.phase ? ` · ${r.phase}` : ""}${r.sinceMin != null ? ` · ${r.sinceMin} min` : ""}`).join(" · ").slice(0, 240) } } : {}) }); from += w.solves ?? 0; }
          if (allIds.length && (isBoxGrid(c) || c.kind === "locked-root" || c.kind === "preflop-grid-asym")) measured.push({ label: c.label, est: runEstimate(c, allStates, Number((c as any).lanes ?? (L as any).machines?.[c.runner] ?? 1)) });
          if (c.effective === "blocked" && c.blockedWhy) blocked.push(c.blockedWhy);
        } else if (c.kind === "preflop-grid" || c.kind === "locked-root") {
          const t = c.tree ? L.trees[c.tree] : null;
          if (!fmt || !t) continue;
          const H = hrcJobsFor(c, fmt, t);
          const rungs = (c.depths && c.depths.length) ? c.depths : fmt.depths;
          // per chart: done in the catalog, solved on a box (pulling), solving now (which box, how long), queued
          const hStates = chartStates(c, H.jobs.map((j) => j.id)); const hState = new Map(hStates.map((x) => [x.id, x]));
          const shortId = (id: string) => id.replace(/^ign\d+_(6max|3max\w*|4max\w*)_/, "");
          const liveFor = (ids: string[]) => { const r = ids.map((id) => hState.get(id)!).filter((x) => x && x.state === "running"); return r.length ? { job: liveJob(c.id)?.id ?? 0, lane: `hrc-box:${[...new Set(r.map((x) => x.box))].join("+")}`, status: "running", started: null, ended: null, phase: r.map((x) => `${x.box}: ${shortId(x.id)}${x.phase ? ` · ${x.phase}` : ""}${x.sinceMin != null ? ` · ${x.sinceMin} min` : ""}`).join(" · ").slice(0, 240) } : undefined; };
          if (c.kind === "locked-root" || c.kind === "preflop-grid") measured.push({ label: c.label, est: runEstimate(c, hStates, Number((c as any).lanes ?? (L as any).machines?.[c.runner] ?? 1)) });
          if (c.kind === "locked-root" && rungs.length > 1) {
            // many rungs: one line per rung, not one per lock
            const locksTxt = (c.locks ?? []).map((l) => (l.size === "limp" ? `${l.pos} limp` : `${l.pos} ${l.size}bb`)).join(", ");
            for (const D of rungs) {
              const ids = H.jobs.filter((j) => j.id.includes(`_D${String(D).replace(".", "_")}_`)).map((j) => j.id);
              const sts = ids.map((id) => hState.get(id)!).filter(Boolean);
              const done = sts.filter((x) => x.state === "done").length, solved = sts.filter((x) => x.state === "solved").length, running = sts.filter((x) => x.state === "running");
              const progress = done < ids.length && (done || solved || running.length) ? ` · ${done} of ${ids.length} done${solved ? `, ${solved} solved on the boxes (pulling)` : ""}${running.length ? ` · solving now: ${running.map((r) => `${shortId(r.id)} on ${r.box}${r.sinceMin != null ? ` (${r.sinceMin} min)` : ""}`).join(", ")}` : ""}` : done === ids.length && ids.length ? "" : "";
              work.push({ n: n++, ref: ids.join(" "), minutes: c.cost.minPerJob * ids.length, doneCharts: done, data: { kind: "lockrung", config: c.id, depth: D, locks: c.locks ?? [] }, what: `the ${ids.length} continuation charts at ${D}bb (${locksTxt})${progress}`,
                how: `HRC, each with the opener's root fixed to the pool's measured range, re-cut on the ${D}bb chart's ranking; everything below in equilibrium`,
                status: ids.length && done === ids.length ? "done" : c.effective === "blocked" ? "blocked" : running.length ? "running" : live ? "queued" : "planned", ...(liveFor(ids) ? { live: liveFor(ids) } : {}) });
            }
            if (c.effective === "blocked" && c.blockedWhy) blocked.push(c.blockedWhy);
            else if (c.effective === "blocked") blocked.push(`the ${c.cost.jobs} continuation charts wait on the same solver feature as the first run (the root lock)`);
            continue;
          }
          for (const j of H.jobs) {
            const lk = (c as any).locks?.find((l: any) => j.id.endsWith(l.size === "limp" ? `_${l.pos}limp` : `_${l.pos}${String(l.size).replace(".", "_")}x`));
            const limp = lk?.size === "limp";
            work.push({ n: n++, ref: j.id, minutes: c.cost.minPerJob, data: { kind: "chart", config: c.id, id: j.id, seats: fmt.seats, lock: lk ?? null, poolFile: c.env?.POOL_MODEL },
              what: lk ? (limp ? `continuation chart: the ${lk.pos} limps with the pool's limping range — every node below solved (our iso-raise, the over-limp / check, the pool's answer, the rest)` : `continuation chart: ${lk.pos} opens ${lk.size}bb with the pool's range — every node below solved (our 3-bet, the call, the 4-bet, the jam)`) : `the equilibrium chart at ${j.stacks.split("/")[0]}bb${fmt.seats === 4 ? " (4-handed)" : ""} — every position, every size in the tree`,
              how: lk ? (limp ? `HRC, with the ${lk.pos}'s root fixed to the pool's measured limp (${lk.pos === "BTN" ? "4.2%" : "9.2%"} of hands, the best hands it does not open with); everything below in equilibrium` : `HRC, with the ${lk.pos}'s root fixed to the pool's measured opening range at ${lk.size}bb (one measured width — the size changes the pot and the tree below, not the range); everything below in equilibrium`) : "HRC solves the whole 3-handed game from the format alone — both players perfect, NL25 rake in the tree, no pool data",
              status: catalogIds.has(j.id) ? "done" : c.effective === "blocked" ? "blocked" : hState.get(j.id)?.state === "running" ? "running" : live ?? "planned", ...(liveFor([j.id]) ? { live: liveFor([j.id]) } : {}) });
          }
          if (c.effective === "blocked" && c.blockedWhy) blocked.push(c.blockedWhy);
          else if (c.kind === "locked-root" && c.effective === "blocked") blocked.push(`the ${c.cost.jobs} continuation charts wait on a solver feature we still have to build (fixing the opponent's opening range at the root before solving); everything else in this run can go ahead without them`);
        } else if (c.kind === "opponent-model") {
          work.push({ n: n++, minutes: c.cost.minPerJob, data: { kind: "pool", config: c.id, file: join(LIMP, c.produces[0] ?? "pool_model_v4.json") }, what: "the pool model — how often the pool opens, flats, 3-bets and folds at every node, at which sizes, from our 7,898 Zone decisions — and hero's postflop EV per hand class against those ranges",
            how: "measured from the hand histories; the pool's range at a node = the chart's hand ranking cut at the measured frequency (we rarely see its cards). Then 11 matchup families (BTN open vs BB flat, BB flat vs BTN open, called 3-bet pots, …) solved range-vs-range in GTO Wizard AI over 14 flops each, giving the per-hand postflop EV the exploit calculation prices with", status: c.effective === "done" ? "done" : live ?? "planned" });
        } else if (c.kind === "exploit-export") {
          work.push({ n: n++, minutes: c.cost.minPerJob, data: { kind: "exploit", config: c.id, file: join(LIMP, c.produces[0] ?? "exploit_ranges.json") }, what: "our exploit answer at hero's 5 first decisions: BTN open, SB vs open, SB vs BTN fold, BB vs open, BB vs SB",
            how: "a calculation, not a solve: every hand class priced against the pool model, best action kept; thin samples shrunk toward caution first; then the winrate ladder re-run", status: c.effective === "done" ? "done" : live ?? "planned" });
        } else if (c.kind === "cutover") {
          work.push({ n: n++, minutes: c.cost.minPerJob, data: { kind: "none", config: c.id }, what: "switch the study tool to the new sets", how: "by hand: point the API at the new preflop and postflop files and restart it", status: c.effective === "done" ? "done" : "planned" });
        } else if (c.kind === "acceptance") {
          work.push({ n: n++, minutes: c.cost.minPerJob, data: { kind: "chart", config: c.id, id: "ign200_3maxasym2ci_D100_s100_eq_hrc2", seats: 3, lock: null },
            what: "the Zenbook's 3-max 100bb NL200 chart, re-solved on a cloud box with the identical config",
            how: "HRC on the box: auto-solve + 60 min Run-Nash refinement, full postflop play; parity-checked against the reference settings first; then diffed against the Zenbook chart",
            status: c.effective === "done" ? "done" : live ?? "planned" });
        } else if (c.kind === "mes-lock") {
          const tag = c.env?.FLEET_TAG ?? c.id.replace(/^mes-/, "");
          for (const f of MES_SPOTS) {
            let boards: string[] = [], pot = 0;
            try { const sp = JSON.parse(readFileSync(join(MES_HANDOFF, `${f.id}.json`), "utf-8")); boards = sp.boards ?? []; pot = (sp.pot ?? 0) / 100; } catch { /* none */ }
            const done = boards.filter((b) => existsSync(join(MES_HANDOFF, `runs_${tag}`, `${f.id}_${b}.locked.json`))).length;
            work.push({ n: n++, ref: boards.join(" "), minutes: Math.ceil(boards.length * c.cost.minPerJob / 4), data: { kind: "mes", config: c.id, family: f.id, tag, suffix: c.env?.SPEC_SUFFIX ?? "" }, what: `${f.what(pot)} · ${boards.length} flops${done ? ` (${done} done)` : ""}`,
              how: `per flop: equilibrium of the flop tree, then the pool's measured frequencies locked on every villain node and hero re-solved against them · ${c.cost.minPerJob} min per flop, ${boards.length} flops spread over 4 boxes`,
              status: boards.length && done === boards.length ? "done" : live ?? "planned" });
          }
        }
      }
      for (const w of work) { if (w.live || (w.ref && w.ref.includes("ign"))) continue; const cid = (w.data && (w.data.config as string)) || null; if (cid) { const l = liveOf(cid); if (l) w.live = l; } }
      const solves = cfgs.reduce((s, c) => s + (["preflop-grid", "preflop-grid-asym", ...BOX_GRID_KINDS, "locked-root", "mes-lock", "acceptance"].includes(c.kind) ? c.cost.jobs : 0), 0);
      // per chart, not per line: a line of six trees with two finished counts two
      const doneSolves = work.reduce((s, w) => s + (w.doneCharts != null ? w.doneCharts : w.status === "done" ? (w.ref && w.ref.includes(" ") ? w.ref.split(" ").length : 1) : 0), 0);
      // measured pace beats the ledger's guess once a chart of the run has finished
      const measuredLeft = new Map(measured.filter((m) => m.est.leftMinutes != null).map((m) => [m.label, m.est.leftMinutes!]));
      const wallMinutes = cfgs.reduce((s, c) => s + (c.effective === "done" ? 0 : measuredLeft.has(c.label) ? measuredLeft.get(c.label)! : c.estimate.wallMinutes), 0);
      const eurPart = Math.round(cfgs.reduce((s, c) => s + (c.effective === "done" ? 0 : c.estimate.eur), 0) * 100) / 100;
      // collated: "6 HRC solves × 75 min = 7.5 h + 15 min of calculation"
      const groups: string[] = [];
      const hrcC = cfgs.filter((c) => c.runner === "hrc-zenbook" || c.runner === "hrc-box"); const hrcLanes = Math.max(1, ...hrcC.map((c) => Number(c.lanes ?? (L as any).machines?.[c.runner] ?? 1)));
      if (hrcC.length) groups.push(`${hrcC.reduce((s, c) => s + c.cost.jobs, 0)} HRC solves × ${hrcC[0]!.cost.minPerJob} min = ${minsStr(hrcC.reduce((s, c) => s + c.cost.jobs * c.cost.minPerJob, 0))} of machine time, ${minsStr(hrcC.reduce((s, c) => s + c.estimate.wallMinutes, 0))} on ${hrcLanes} HRC machine${hrcLanes > 1 ? "s side by side" : ""}`);
      const fleetC = cfgs.filter((c) => c.runner === "fleet"); for (const c of fleetC) groups.push(`${c.cost.jobs} flops × ${c.cost.minPerJob} min = ${minsStr(c.cost.jobs * c.cost.minPerJob)} of solving, ${minsStr(c.estimate.wallMinutes)} on 4 boxes side by side, about €${c.estimate.eur}`);
      const calcC = cfgs.filter((c) => c.runner === "scripts"); if (calcC.length) groups.push(`${minsStr(calcC.reduce((s, c) => s + c.estimate.wallMinutes, 0))} of calculation`);
      const manC = cfgs.filter((c) => c.runner === "manual"); if (manC.length) groups.push(`${minsStr(manC.reduce((s, c) => s + c.estimate.wallMinutes, 0))} by hand`);
      for (const m of measured) if (m.est.total - m.est.done - m.est.solved > 0 && (m.est.done || m.est.solved || m.est.running)) groups.push(`${m.label.split(" · ")[0]}: ${m.est.text}`);
      return {
        title: pp.title, input: pp.input ?? [], how: pp.how ?? [], work, output: pp.output ?? { name: "", items: [] }, check: pp.check ?? [], blocked, steps: pp.steps,
        numbers: { solves, done: doneSolves, wallMinutes, eur: eurPart, text: `${groups.join(" + ")} → about ${minsStr(wallMinutes)} for this part` },
      };
    });
    const fmt = L.formats.find((f) => f.id === allCfgs[0]?.format);
    const format = fmt ? `${fmt.label}${fmt.blinds ? ` · ${fmt.blinds}` : ""} · ${fmt.rake ? `rake ${Math.round(fmt.rake.pct * 100)}% capped at ${fmt.rake.capBb}bb` : "rake as solved"} · ${fmt.depths.length ? `${fmt.depths.join(" / ")}bb stacks` : "any depth"}` : "?";
    const wall = parts.reduce((s, p) => s + p.numbers.wallMinutes, 0), eur = Math.round(parts.reduce((s, p) => s + p.numbers.eur, 0) * 100) / 100;
    const solves = parts.reduce((s, p) => s + p.numbers.solves, 0), done = parts.reduce((s, p) => s + p.numbers.done, 0);
    const activity = allCfgs.map((c) => ({ c, j: liveJob(c.id) })).filter((x) => x.j).map(({ c, j }) => ({ config: c.id, label: c.label, job: j!.id, status: j!.status, since: j!.started ?? j!.created }));
    const anyLive = allCfgs.some((c) => liveJob(c.id));
    const anyFailed = allCfgs.some((c) => { const j = jobList.find((x) => x.config === c.id); return j && j.status === "failed" && c.effective !== "done"; });
    const allDone = allCfgs.length > 0 && allCfgs.every((c) => c.effective === "done");
    const state: Proposal["state"] = allDone ? "done" : anyLive ? "running" : anyFailed ? "attention" : P.approved ? "approved" : "draft";
    return {
      id: P.id, run: P.run, why: P.why, format, approved: P.approved ?? null, parts, state,
      totals: { solves, done, wallMinutes: wall, eur, text: `${done} of ${solves} solves done · about ${minsStr(wall)} left · ${eur ? `about €${eur}` : "€0"}` },
      activity,
      canRunAll: !!P.approved && allCfgs.some((c) => c.effective !== "done" && c.effective !== "blocked" && c.runner !== "manual" && !liveJob(c.id)),
      details: allCfgs.map((c) => runbookFor(c.id)!).filter(Boolean),
    };
  });
}

export function approve(id: string, on: boolean): { ok: boolean; error?: string } {
  const p = join(DATA_DIR, "ledger.json");
  const L = JSON.parse(readFileSync(p, "utf-8"));
  const P = (L.proposals ?? []).find((x: any) => x.id === id);
  if (!P) return { ok: false, error: `no proposal ${id}` };
  P.approved = on ? { at: new Date().toISOString() } : null;
  writeFileSync(p, JSON.stringify(L, null, 2) + "\n");
  loadLedger();
  if (on) { const r = runAll(id); return { ok: true, ...(r as any) }; }
  return { ok: true };
}

/** Queue every step that can run, in order, as a chain: each waits for its inputs (the previous step's output) before it starts. */
export function runAll(id: string): { ok: boolean; error?: string; queued: { config: string; job?: number; skipped?: string }[] } {
  const P = proposals().find((x) => x.id === id);
  if (!P) return { ok: false, error: `no proposal ${id}`, queued: [] };
  if (!P.approved) return { ok: false, error: "the proposal is not approved — press Approve first", queued: [] };
  const ev = evaluate();
  const queued: { config: string; job?: number; skipped?: string }[] = [];
  for (const id of P.parts.flatMap((p) => p.steps)) {
    const c = ev.configs.find((x) => x.id === id);
    if (!c) continue;
    if (c.effective === "done") { queued.push({ config: id, skipped: "already done" }); continue; }
    if (c.effective === "blocked") { queued.push({ config: id, skipped: "blocked" }); continue; }
    if (c.runner === "manual") { queued.push({ config: id, skipped: "by hand — see the operator detail" }); continue; }
    if (P.activity.some((a) => a.config === id)) { queued.push({ config: id, skipped: "already queued" }); continue; }
    // a config may pin its own box fan-out (LedgerConfig.boxes) — the chain gate is kept either way
    const r = jobs.enqueue(id, { chain: true, ...((c as { boxes?: string[] }).boxes?.length ? { boxes: (c as { boxes?: string[] }).boxes } : {}) });
    queued.push(r.ok ? { config: id, job: r.job.id } : { config: id, skipped: r.error });
  }
  return { ok: true, queued };
}
