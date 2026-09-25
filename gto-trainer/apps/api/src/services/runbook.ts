import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, loadLedger, sixMaxChartIds, sixMaxAsym, DATA_DIR, LIMP, MES_HANDOFF, HRC_API, REPO, type EvaluatedConfig, type Evaluation, type LedgerFormat } from "./ledger";
import { recipeFor, sixMaxPlan, PY, BUN, BASH, type Step } from "./jobs";

/**
 * The RUNBOOK — for a config (or a whole plan) the exact work, spelled out
 * before anything runs: which solver on which machine, the precise commands
 * with cwd + env, every input with its fingerprint, every output path, what
 * "done" means, what to check afterwards, and what blocks it. Everything is
 * derived from data/ledger.json + the recipes in jobs.ts, so the page and the
 * runner can never disagree.
 */

export interface RbStep { n: number; title: string; how: "command" | "hrc" | "fleet" | "manual" | "blocked"; cmd?: string; cwd?: string; env?: Record<string, string>; detail: string[] }
export interface Runbook {
  id: string; label: string; kind: string; effective: string; runner: string; where: string; note?: string;
  estimate: { minutes: number; wallMinutes: number; eur: number; text: string };
  format: { id: string; label: string; site: string; seats: number; stake: string; blinds?: string; rake: string; depths: string } | null;
  tree: { id: string; label: string; lines: string[] } | null;
  inputs: { id: string; label: string; effective: string; artifact: { path: string; exists: boolean; sha256: string | null; mtime: string | null } | null }[];
  produces: { key: string; path: string; exists: boolean; detail: string }[];
  steps: RbStep[]; doneWhen: string[]; verify: string[]; blockers: string[];
  runnable: boolean; whyNotRunnable: string | null;
}

const RC = "C:\\Users\\Brady\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Rclone.Rclone_Microsoft.Winget.Source_8wekyb3d8bbwe\\rclone-v1.74.4-windows-amd64\\rclone.exe";
const CREDS = join(process.env.USERPROFILE ?? "C:\\Users\\Brady", ".config", "poker-solve", "credentials.env");
const HRC_RUNNER = "C:\\Users\\Brady\\Desktop\\HRC Runner.cmd";
const DEV_API = join(REPO, ".claude", "dev-api.cmd");

const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
const cmdStr = (cmd: string[]) => cmd.map(q).join(" ");
const rel = (p: string) => p.replace(/^C:\\Users\\Brady\\poker\\/i, "").replace(/^C:\\Users\\Brady\\poker\//i, "");
const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString().slice(0, 16).replace("T", " "));
const minsStr = (m: number) => (m >= 60 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)} h` : `${Math.round(m)} min`);

function stepOf(n: number, s: Step, detail: string[]): RbStep {
  return { n, title: s.label, how: "command", cmd: cmdStr(s.cmd), cwd: rel(s.cwd), env: s.env && Object.keys(s.env).length ? s.env : undefined, detail };
}

/** The HRC jobs a grid / locked-root config expands to — the same expansion scripts/ledgerPlan.ts writes. */
export function hrcJobsFor(c: EvaluatedConfig, fmt: LedgerFormat, tree: any) {
  const num = (n: number | string) => String(n).replace(".", "_");
  const menu = (xs: (number | string)[]) => xs.map((x) => (typeof x === "number" ? `${x}bb` : x)).join(", ");
  const site = `ign${String(fmt.stake).replace(/^NL/i, "")}`;
  const seats = (fmt.seats ?? 3) === 4 ? "4max" : "3max";
  const gen = c.kind === "locked-root" ? `${seats}lock` : seats === "4max" ? "4max" : "3maxasym2ci";
  const depths: number[] = (c.depths && c.depths.length) ? c.depths : fmt.depths.length ? fmt.depths : [100];
  const locks: { pos: string; size: number | "limp"; rangeKey: string }[] = c.kind === "locked-root" ? ((c as any).locks ?? []) : [null as any];
  const out: { id: string; stacks: string; rake: string; sizes: string; lock: string | null; doneIf: string }[] = [];
  for (const D of depths) for (const lk of locks) {
    const id = `${site}_${gen}_D${num(D)}_s${num(D)}_eq${lk ? (lk.size === "limp" ? `_${lk.pos}limp` : `_${lk.pos}${num(lk.size)}x`) : ""}`;
    out.push({ id, stacks: `${D}/${D}/${D}bb`, rake: `${Math.round((fmt.rake?.pct ?? 0) * 100)}% cap ${fmt.rake?.capBb}bb`,
      sizes: `opens ${menu(tree.opens)} · 3-bets ${menu(tree.threeBets)} · 4-bets ${menu(tree.fourBets)} · flats ${JSON.stringify(tree.flats)}${tree.limps ? " · limps" : ""}`,
      lock: lk ? (lk.size === "limp" ? `${lk.pos} limps with pool range "${lk.rangeKey}"` : `${lk.pos} opens exactly ${lk.size}bb with pool range "${lk.rangeKey}"`) + " (the villain root is fixed, every node below is solved)" : null,
      doneIf: `hrc-api/solves/threemax_grid/${id}.charts.json` });
  }
  return { site, gen, jobs: out };
}

function readSpec(name: string): any | null { try { return JSON.parse(readFileSync(join(MES_HANDOFF, name), "utf-8")); } catch { return null; } }

/** `ev`: the caller's evaluate() — a page listing many runbooks evaluates once, not once per runbook. */
export function runbookFor(id: string, ev: Evaluation = evaluate()): Runbook | null {
  const c = ev.configs.find((x) => x.id === id);
  if (!c) return null;
  const L = loadLedger();
  const fmt = L.formats.find((f) => f.id === c.format) ?? null;
  const tree = c.tree ? L.trees[c.tree] : null;
  const byId = new Map(ev.configs.map((x) => [x.id, x]));
  const rec = recipeFor(c);
  const env = c.env ?? {};
  const steps: RbStep[] = [];
  const doneWhen: string[] = [];
  const verify: string[] = [];
  const blockers: string[] = [];
  let where = "";

  const inputs = c.inputs.map((inId) => {
    const x = byId.get(inId);
    const fp = x?.artifactFp ?? null;
    return { id: inId, label: x?.label ?? inId, effective: x?.effective ?? "missing", artifact: fp ? { path: rel(fp.path), exists: fp.exists, sha256: fp.sha256, mtime: iso(fp.mtimeMs) } : null };
  });
  const notReady = inputs.filter((i) => i.effective !== "done");

  switch (c.kind) {
    case "preflop-grid":
    case "locked-root": {
      where = "HRC on this machine (the Zenbook), driven by hrc-api/scripts/threeMaxGrid.ts through the UIA driver; queued by HRC Runner";
      const planDir = join(HRC_API, "solves", "threemax_asym", "ledger", c.id);
      const H = fmt && tree ? hrcJobsFor(c, fmt, tree) : null;
      let n = 1;
      steps.push({ n: n++, title: "Write the HRC plan + runner queue from the ledger", how: "command",
        cmd: cmdStr([BUN, "run", join(HRC_API, "scripts", "ledgerPlan.ts"), c.id, planDir]), cwd: rel(HRC_API),
        detail: [`writes ${rel(planDir)}\\plan.json (one threeMaxGrid job per rung${c.kind === "locked-root" ? " × lock" : ""}) and queue.json in HRC Runner's format`,
          `rake comes from the format (${fmt?.rake ? `${Math.round(fmt.rake.pct * 100)}% cap ${fmt.rake.capBb}bb` : "none!"}), sizes from the tree "${tree?.label ?? c.tree}", depths ${fmt?.depths.join(", ") ?? "?"}bb — nothing is typed by hand`] });
      if (H) steps.push({ n: n++, title: `Solve ${H.jobs.length} job(s) in HRC`, how: c.kind === "locked-root" ? "blocked" : "hrc",
        cmd: cmdStr(["cmd", "/c", "start", "", HRC_RUNNER, join(planDir, "queue.json")]),
        detail: [
          `HRC Runner runs, per job: bun run scripts/threeMaxGrid.ts ${rel(planDir)}\\plan.json --out solves/threemax_grid (solve cap 5400 s ≈ 75 min each, serial)`,
          ...H.jobs.map((j) => `job ${j.id} · stacks ${j.stacks} · rake ${j.rake} · ${j.sizes}${j.lock ? ` · LOCK: ${j.lock}` : ""} · done when ${j.doneIf} exists`),
          "CoinPoker must be closed the whole time: the client detects hrc.exe and quits (and HRC's licence seats are all on this machine)",
        ] });
      steps.push({ n: n++, title: "Catalog pickup", how: "manual", detail: [
        `the chart server on :8777 (hrc-charts, launch.json) indexes hrc-api/solves/threemax_grid/*.charts.json; the ledger sees the config as done when the catalog lists charts with prefix ${c.produces.join(", ")}`,
        "if the count does not move after the solve: restart hrc-charts (:8777) and reload /api/ledger",
      ] });
      doneWhen.push(`the :8777 catalog lists ${H?.jobs.length ?? "?"} chart(s) with prefix ${c.produces.map((p) => p.replace("charts:", "")).join(", ")} (${H?.jobs.map((j) => j.id).join(", ") ?? ""})`);
      verify.push("open /sources/pieces/hrc-3max → the new chart id is listed; open a Playthrough preflop spot on it and check the open/3-bet menus match the tree");
      if (c.kind === "locked-root") {
        blockers.push("threeMaxGrid.ts has NO lock step. Needed: after the tree is built and before the solve, fix the villain's root strategy at the locked position — open exactly the locked size with the pool-model range named by rangeKey (pool_model_nl25.json → ranges[rangeKey]), fold the rest — via HRC's node lock in the UIA driver; then solve and export <id>.charts.json with the lock recorded. Until that exists the plan can be written but the solve cannot run.");
      } else if (c.kind === "preflop-grid" && c.status !== "done") {
        verify.push("run the winrate ladder on the new chart (exploit-export recipe) before extending to more rungs");
      }
      break;
    }
    case "preflop-grid-hu":
    case "preflop-grid-6max": {
      // the 6-seat trees: even grid (open × depth) and / or uneven states (one short seat), one plan per config,
      // written by poker-zenbook/hrc-api/scripts/genSixMaxPlan.ts from the config's env (SITES · DEPTHS · OPENS · ASYM)
      const ids = sixMaxChartIds(c, fmt);
      const asym = sixMaxAsym(c);
      const { planDir } = sixMaxPlan(c);
      const winBoxes: { label: string; host: string }[] = (L as any).boxes?.["hrc-box"] ?? [];
      const linBoxes: { label: string; host: string }[] = (L as any).boxes?.["hrc-linux"] ?? [];
      const boxes = [...winBoxes, ...linBoxes];
      const onBoxes = c.runner === "hrc-box";
      where = onBoxes
        ? `HRC on ${boxes.length} machines side by side — ${winBoxes.map((b) => b.label).join(", ")} (Windows: the Vultr boxes plus this Zenbook as host "local", boxJob.ts) and ${linBoxes.map((b) => b.label).join(", ")} (the Hetzner Linux boxes, linuxShardJob.ts → the box keeper) — each solving one shard of the same plan through threeMaxGrid.ts (6-seat mapping UTG/HJ/CO/BTN/SB/BB)`
        : "HRC on this machine (the Zenbook), driven by poker-zenbook/hrc-api/scripts/threeMaxGrid.ts through the UIA driver (6-seat mapping UTG/HJ/CO/BTN/SB/BB); queued by HRC Runner";
      const depths: number[] = env.DEPTHS ? env.DEPTHS.split(",").map(Number) : (c.depths && c.depths.length) ? c.depths : fmt?.depths ?? [];
      const opens = (env.OPENS ?? "2.5,3,2,3.5,limp").split(",").map((o) => (o.trim() === "limp" ? "limp tree" : `${o.trim()}x`)).join(" / ");
      const shape = asym
        ? `uneven states: a ${asym.deep}bb table with one seat short at ${asym.shorts.join(" / ")}bb, the short seat in each of ${asym.seats.join(" / ")}, opens ${asym.opens.map((o) => (o === "limp" ? "limp tree" : `${o}x`)).join(" / ")}${env.GRID === "off" ? "" : " (plus the even grid)"}`
        : `depths ${depths.join(", ")}bb · opens ${opens}`;
      let n = 1;
      const genStep = rec?.steps[0];
      steps.push({ n: n++, title: "Write the 6-max plan + runner queue", how: "command", cmd: genStep ? cmdStr(genStep.cmd) : undefined, cwd: genStep ? rel(genStep.cwd) : undefined,
        detail: [`writes ${rel(planDir)}\\plan_6max.json (${ids.length} threeMaxGrid jobs, one per tree, most useful first) and queue_6max.json for HRC Runner (a pilot row, then one row per band)`,
          `rake ${fmt?.rake ? `${Math.round(fmt.rake.pct * 100)}% cap ${fmt.rake.capBb}bb` : "none!"} · ${shape} · 3-bets 3x / 3.5x / 4.2x / 5x the open at 75bb+, 3x / 3.6x + jam at 40-70bb, 2.6x + jam at ≤30bb · 4-bets 2.2x / 2.7x the median 3-bet + jam at 100bb+, 2.3x + jam at 60-99bb, jam only below · sizes above 40% of stack dropped · flats [0,2,1,1], limp tree [2,2,1,1] + SB complete · refine 60/40/20 min by depth · full postflop play in raised pots`,
          "the plan is generated from the ledger's format (rake) and this config's env; set LEAN=1 in the env to halve the menus if the pilot runs too long"] });
      if (onBoxes) {
        const solve = rec?.steps[1];
        steps.push({ n: n++, title: `Solve ${ids.length} tree(s) on the HRC boxes`, how: "hrc", cmd: solve ? cmdStr(solve.cmd) : undefined, cwd: solve ? rel(solve.cwd) : undefined, detail: [
          `one job per machine, shard i/${boxes.length} of the plan each — Windows (${winBoxes.map((b) => b.label).join(", ")}): parity guard against the reference settings → ship the shard → HRC solves it (wizard auto-solve, fixed-sample Run-Nash refinement, Complete Export) → pull → parse into the catalog; a box joining late takes the tail (--order reverse)`,
          `Linux (${linBoxes.map((b) => b.label).join(", ")}): the shard is shipped to /root/hrc-api/solves/sixmax_grid/${c.id}/ and the ledger's hrc-linux entry pointed at it, so the box keeper owns the runner (relaunch on death, HRC recycle on a hang) across API restarts; the job pulls each finished zip and parses it here every 5 min`,
          "PILOT FIRST: run the first tree alone on one Windows box (Run… → boxes: hrc-1) and one Linux box (boxes: hrc-l1) and read both wall times before the fan-out; the Windows parity guard was written against the 3-seat reference — a refusal (exit 3) on a 6-seat tree means the reference settings need a 6-max twin, not that the tree is wrong; the Linux driver opens a 3-max template hand — its first 6-seat tree proves the wizard takes six stacks",
          ...ids.map((id) => `tree ${id} · done when ${rel(planDir)}\\${id}.charts.json.gz exists`),
        ] });
      } else {
        steps.push({ n: n++, title: `Solve ${ids.length} tree(s) in HRC`, how: "hrc",
          cmd: cmdStr(["cmd", "/c", "start", "", HRC_RUNNER, join(planDir, "queue_6max.json")]),
          detail: [
            `HRC Runner runs, per row: bun run scripts/threeMaxGrid.ts ${rel(planDir)}\\plan_6max.json --out ${rel(planDir)} --clean --filter <the row's trees> (each tree: wizard auto-solve, then a fixed-sample Run-Nash refinement, then Complete Export); resumable — a tree whose charts.json.gz exists is skipped`,
            "PILOT FIRST: the queue's first row is the single first tree; read its time in runner.log before letting the bands run",
            ...ids.map((id) => `tree ${id} · done when ${rel(planDir)}\\${id}.charts.json.gz exists`),
            "CoinPoker must be closed the whole time (it quits when it sees hrc.exe); keep the machine unlocked and hands off while a tree runs",
          ] });
      }
      steps.push({ n: n++, title: "Catalog pickup", how: "manual", detail: [
        `each finished tree is converted into a study-UI solution by analysis/pipeline/solve/hrc_to_preflop.py; the :8777 catalog lists it by id (prefix ${c.produces.map((p) => p.replace("charts:", "")).join(", ")}) — the config is done only when EVERY id is there; restart hrc-charts if the count does not move`,
      ] });
      doneWhen.push(`the :8777 catalog lists all ${ids.length} chart(s): ${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", …" : ""}`);
      verify.push("pilot: root node has 6 players, UTG acts first, the open size in the export equals the tree's; a hand mixing two actions shows equal EVs (the refinement did its job)");
      verify.push("compare the 100bb 2.5x UTG/BTN opening ranges with GTO Wizard's 6-max NL500 charts — same shape; tighter flats and more 3-bet-or-fold explained by the 2bb cap");
      if (asym) verify.push("an uneven state against the even tree at the short depth: the short seat's jam/fold mix moves the same way, the deep seats stay close to the 100bb even tree");
      break;
    }
    case "opponent-model": {
      if (!rec) { where = c.runner; steps.push({ n: 1, title: "no recipe yet", how: "blocked", detail: [c.blockedWhy ?? "this config has no runnable recipe"] }); if (c.blockedWhy) blockers.push(c.blockedWhy); break; }
      where = "python on this machine (scripts lane, serial)";
      const suffix = env.OUT_SUFFIX ?? "";
      const chart = env.CHART_ID ?? "ign200_3maxasym_D100_s100_eq";
      const r = rec!;
      steps.push(stepOf(1, r.steps[0]!, [
        `reads the chart "${chart}" from the :8777 catalog and the measured 3-max decisions (the Zone hand corpus, 7,898 decisions)`,
        `writes limp_study/pool_model${suffix}.json (ranges = chart union at the measured width, per node) and limp_study/pool_ev_tables${suffix}.json`,
      ]));
      if (r.steps[1]) steps.push(stepOf(2, r.steps[1]!, ["villain_freqs.json: every street|facing context's action frequencies, measured from the hands — chart-independent"]));
      else steps.push({ n: 2, title: "villain_freqs.json is reused", how: "manual", detail: ["it is measured from the hand corpus, not from a chart, so a new chart does not change it; the fleet ships the existing file"] });
      doneWhen.push(`limp_study/pool_model${suffix}.json exists and its "chart" field is ${chart}`);
      verify.push(`open /sources/pieces/pool-model — decisions count unchanged, chart = ${chart}`);
      break;
    }
    case "exploit-export": {
      if (!rec) { where = c.runner; steps.push({ n: 1, title: "no recipe yet", how: "blocked", detail: [c.blockedWhy ?? "this config has no runnable recipe"] }); if (c.blockedWhy) blockers.push(c.blockedWhy); break; }
      where = "python on this machine (scripts lane, serial)";
      const suffix = env.OUT_SUFFIX ?? "";
      const chart = env.CHART_ID ?? "ign200_3maxasym_D100_s100_eq";
      const r = rec!;
      steps.push(stepOf(1, r.steps[0]!, [
        `best-responds the chart "${chart}" to pool_model${suffix}.json at 5 first-decision nodes (btn_root, sb_vs_open, sb_bvb, bb_vs_open, bb_vs_sb); thin-sample response frequencies are shrunk by 1.5 SE first`,
        `writes limp_study/exploit_ranges${suffix}.json: choices per node + the range sets the MES families need (btn_open, btn_open_2x, sb_open_bvb, sb_open_bvb_2x, …)`,
      ]));
      steps.push(stepOf(2, r.steps[1]!, ["prices the corpus under the exploit vs the chart → data/winrate_ladder.json (the ladder rows on Sources → Strategies)"]));
      steps.push(stepOf(3, r.steps[2]!, ["recomputes data/strategy_matrix.json (Edge on the Pieces cards)"]));
      doneWhen.push(`limp_study/exploit_ranges${suffix}.json exists with chart = ${chart} and 5 nodes`);
      verify.push("winrate ladder: the exploit row must beat the equilibrium row at the same rake; if not, the fit is noise — do not proceed to MES");
      verify.push("/sources/pieces/exploit-preflop → detail: 5 nodes listed, chart id shown");
      break;
    }
    case "mes-lock": {
      if (!rec) { where = c.runner; steps.push({ n: 1, title: "no recipe yet", how: "blocked", detail: [c.blockedWhy ?? "this config has no runnable recipe"] }); if (c.blockedWhy) blockers.push(c.blockedWhy); break; }
      where = "Hetzner fleet (4 × cpx62, nbg1) driven from this machine over ssh; results archived to R2 then pulled here";
      const tag = env.FLEET_TAG ?? c.id.replace(/^mes-/, "");
      const suffix = env.SPEC_SUFFIX ?? `_${tag}`;
      const exploit = env.EXPLOIT_RANGES ?? join(LIMP, "exploit_ranges.json");
      const pool = env.POOL_MODEL ?? join(LIMP, "pool_model_v4.json");
      const fams = [
        { id: "M1_heroSB_bvb_cbet", hero: "SB (OOP, raiser) · exploit range sb_open_bvb", villain: "BB flat · pool range bb_flat_vs_sb" },
        { id: "M2_heroBTN_srp_vs_BB", hero: "BTN (IP, raiser) · exploit range btn_open", villain: "BB flat · pool range bb_flat_vs_btn" },
        { id: "M1_heroSB_bvb_cbet_p4", hero: "SB (OOP, 2bb open) · exploit range sb_open_bvb_2x", villain: "BB flat · pool range bb_flat_vs_sb" },
        { id: "M2_heroBTN_srp_vs_BB_p4", hero: "BTN (IP, 2bb open) · exploit range btn_open_2x", villain: "BB flat · pool range bb_flat_vs_btn" },
      ].map((f) => { const s = readSpec(`${f.id}.json`); return { ...f, pot: s ? `${s.pot / 100}bb` : "?", stack: s ? `${s.eff_stack / 100}bb` : "?", rake: s ? `${s.rake_rate * 100}% cap ${s.rake_cap / 100}bb` : "?", boards: s?.boards ?? [] }; });
      const nBoards = fams.reduce((s, f) => s + f.boards.length, 0);
      const r = rec!;
      const F = (i: number) => r.steps[i]!;
      steps.push(stepOf(1, F(0), [
        `embeds hero's arrival range from ${rel(exploit)} and villain's calling range from ${rel(pool)} into 4 family specs (<family>${suffix}.json) + 4 shards each (boards split over the boxes)`,
        ...fams.map((f) => `${f.id}: hero ${f.hero} · villain ${f.villain} · pot ${f.pot}, stack ${f.stack}, rake ${f.rake} · ${f.boards.length} boards: ${f.boards.join(" ")}`),
        `tree per board: ${tree ? `flop ${tree.flopBets.join("/")}, turn ${tree.turnBets.join("/")}, river ${tree.riverBets.join("/")}, raise ${tree.raise}, accuracy ${tree.accuracy}` : "mes-flop"} — the same menus as the served generation`,
      ]));
      steps.push(stepOf(2, F(1), ["tars solve/compare + solve/vendor (the Rust solver), villain_freqs.json, the batch scripts and the new shard specs; uploads to R2 mes_handoff/" + tag + "_bundle/bundle.tgz (boxes pull from R2 — the laptop's upload is ~40 KB/s behind the VPN)"]));
      steps.push(stepOf(3, F(2), [`creates mesfleet-${tag}-0..3 (cpx62, ubuntu-24.04, nbg1) with the RW token from ~/.config/poker-solve/credentials.env; writes mes_handoff/fleet_ips_${tag}.json; idempotent (existing names are reused)`, "COSTS MONEY from this step on: ~€0.09 per board-solve, boxes are deleted by the finish step after R2 verification"]));
      steps.push(stepOf(4, F(3), [
        "per box: cloud-init → build-essential + rustup → pull the bundle → disable unattended-upgrades (it rebooted a fleet mid-batch, twice) → 24 GB swap → cargo build driver/exploitsolve/extract",
        `then box N runs: run_batch_linux.py --spec M2_heroBTN_srp_vs_BB${suffix}.shardN.json --threads 16 --tilt --keep-trees, chained with M1, M2_p4, M1_p4 shard N (eq solve + tilt lock per board ≈ 18 min → ~${Math.round((nBoards / 4) * 18 / 60 * 10) / 10} h per box)`,
        `logs: mes_handoff/runs/box_${tag}_N.log here, runs/batch.log on the box`,
      ]));
      steps.push(stepOf(5, F(4), [
        "waits for ALL_DONE on every box, extracts turn files, rclone-copies locks/turns/eq/trees to R2 mes_handoff/refit_fleet_" + tag + "/<box>/, verifies 5 artifacts per board, then DELETES the box by name (a failed verify keeps it — check the Hetzner console)",
        `pulls the jsons to mes_handoff/runs_${tag}/, copies them into runs/ (the served mirror) and data/mes_turn/, then SPEC_SUFFIX=${suffix} build_mes_study.py → data/mes_postflop.json stamped with ${rel(exploit)} + ${rel(pool)}, mes_reach_value.py, strategy_matrix.py`,
        "this step runs for hours; cancelling the job stops the watcher, NOT the boxes — finish can be re-run, it is idempotent",
      ]));
      doneWhen.push(`data/mes_postflop.json families[].inputs.exploit_ranges.sha256 equals the sha of ${rel(exploit)} (the Sources MES card's drift check goes green)`);
      doneWhen.push(`${nBoards} *.locked.json in mes_handoff/runs_${tag}/ and 0 Hetzner servers left`);
      verify.push("/sources/pieces/mes-postflop → inputs stamp = the NL25 files, 56 boards; open one spot in the Playthrough and press Study Answer");
      verify.push("strategy matrix: combined_refit row re-priced; compare with the previous +31.2 / +26.8 / +23.5");
      break;
    }
    case "cutover": {
      where = "by hand on this machine — edits + one restart";
      const items = [
        `${rel(DEV_API)}: set EXPLOIT_CHART to limp_study\\exploit_ranges_nl25.json (today it arms exploit_ranges.json)`,
        "scripts\\start_gtow_ai.ps1: the same EXPLOIT_CHART line (it arms the API when started from there)",
        "the API's pool-model readers use the POOL_MODEL env (services/ledger.ts, routes/sources.ts) — set POOL_MODEL to limp_study\\pool_model_nl25.json in the same two launchers",
        "restart the API (bun --watch does not re-read env): close the dev-api window, run Desktop\\Study Dashboard.cmd",
        "then in the ledger: mark this config done; the exploit-nl200fit / mes-refit2 rows become the previous generation",
      ];
      items.forEach((d, i) => steps.push({ n: i + 1, title: d.split(":")[0]!.slice(0, 60), how: "manual", detail: [d] }));
      doneWhen.push("/sources/pieces/exploit-preflop shows file = exploit_ranges_nl25.json and chart = ign25_3maxasym2ci_D100_s100_eq");
      verify.push("play one hand in the study wrapper: the preflop answer's 'ranges from' says the NL25 chart; the postflop answer's MES stamp is the NL25 layer");
      break;
    }
    default: {
      where = c.runner;
      if (rec) rec.steps.forEach((s, i) => steps.push(stepOf(i + 1, s, [])));
    }
  }

  const produces = c.producesFound.map((p) => ({ key: p.key, path: p.key.startsWith("charts:") ? ":8777 catalog" : rel(p.key.startsWith("mes_") ? join(DATA_DIR, p.key) : join(LIMP, p.key)), exists: p.found, detail: p.detail }));
  const runnable = !!rec && c.kind !== "locked-root" && notReady.length === 0 && c.effective !== "done";
  const whyNotRunnable = c.effective === "done" ? "already done" : !rec ? "run by hand from the steps above" : c.kind === "locked-root" ? blockers[0] ?? "blocked" : notReady.length ? `waiting on ${notReady.map((i) => i.label).join(", ")}` : null;
  const est = c.estimate;
  return {
    id: c.id, label: c.label, kind: c.kind, effective: c.effective, runner: c.runner, where, note: c.note,
    estimate: { ...est, text: `${minsStr(est.wallMinutes)} wall-clock${c.runner === "fleet" ? ` (${minsStr(est.minutes)} of box time on 4 boxes)` : ""}${est.eur ? ` · €${est.eur}` : ""}` },
    format: fmt ? { id: fmt.id, label: fmt.label, site: fmt.site, seats: fmt.seats, stake: fmt.stake, blinds: fmt.blinds, rake: fmt.rake ? `${Math.round(fmt.rake.pct * 100)}% · cap ${fmt.rake.capBb}bb` : "as solved", depths: fmt.depths.length ? fmt.depths.map((d) => `${d}bb`).join(", ") : "any" } : null,
    tree: tree ? { id: c.tree!, label: tree.label, lines: tree.opens ? [`opens ${tree.opens.join(" / ")}${tree.opens.every((x: any) => typeof x === "number") ? "bb" : ""}`, `3-bets ${tree.threeBets.join(" / ")}${tree.threeBets.every((x: any) => typeof x === "number") ? "bb" : ""}`, `4-bets ${tree.fourBets.join(" / ")}`, `flats ${JSON.stringify(tree.flats)}${tree.limps ? " · limps allowed" : ""}`] : [`flop ${tree.flopBets.join("/")}`, `turn ${tree.turnBets.join("/")}`, `river ${tree.riverBets.join("/")}`, `raise ${tree.raise}`, `accuracy ${tree.accuracy}`] } : null,
    inputs, produces, steps, doneWhen, verify, blockers: [...blockers, ...c.staleWhy.map((w) => `stale: ${w}`)], runnable, whyNotRunnable,
  };
}

function exeCheck(label: string, path: string, detail: string) { const ok = existsSync(path); return { label, ok, detail: ok ? detail : `${detail} — NOT FOUND at ${path}` }; }
function processRunning(image: string): boolean | null {
  try { const r = Bun.spawnSync(["tasklist", "/FI", `IMAGENAME eq ${image}`, "/NH"], { stdout: "pipe", stderr: "pipe" }); return new TextDecoder().decode(r.stdout).toLowerCase().includes(image.toLowerCase()); } catch { return null; }
}

export function planRunbook(planId: string) {
  const ev = evaluate();
  const p = ev.plans.find((x) => x.id === planId);
  if (!p) return null;
  const par = p.parallel ?? [];
  const inPar = new Set(par.flat());
  const order: string[][] = [];
  for (const s of p.steps) { if (inPar.has(s.id)) { const g = par.find((x) => x.includes(s.id))!; if (!order.some((o) => o === g)) order.push(g); } else order.push([s.id]); }
  const steps = p.steps.map((s) => runbookFor(s.id, ev)!).filter(Boolean);
  const needsHrc = steps.some((s) => s.runner === "hrc-zenbook" && s.effective !== "done");
  const needsFleet = steps.some((s) => s.runner === "fleet" && s.effective !== "done");
  const coin = processRunning("CoinPoker.exe"), hrc = processRunning("hrc.exe");
  const preflight = [
    exeCheck("python 3.12", PY, "runs the pipeline scripts"),
    exeCheck("bun", BUN, "runs ledgerPlan.ts and the API"),
    ...(needsHrc ? [
      exeCheck("HRC Runner", HRC_RUNNER, "queues HRC solves on this machine"),
      { label: "hrc-charts catalog (:8777)", ok: Object.keys(ev.artifacts).some((k) => k.startsWith("charts:")), detail: "the chart server that indexes the solves — the ledger reads 'done' from it" },
      { label: "CoinPoker closed", ok: coin === false, detail: coin ? "CoinPoker is RUNNING — it kills HRC (hrc.exe) on sight; close it before solving" : coin === null ? "could not check" : "not running" },
      { label: "HRC running", ok: hrc === true, detail: hrc ? "hrc.exe is up" : "hrc.exe not running — HRC Runner will need it open" },
    ] : []),
    ...(needsFleet ? [
      exeCheck("git bash", BASH, "runs fleet_ledger.sh"),
      exeCheck("Hetzner + R2 credentials", CREDS, "HCLOUD_TOKEN_RW for the boxes, rclone.conf for R2"),
      exeCheck("rclone", RC, "archives the results to R2 and pulls them back"),
      { label: "ssh key for the boxes", ok: existsSync(join(process.env.USERPROFILE ?? "C:\\Users\\Brady", ".ssh", "id_ed25519")) || existsSync(join(process.env.USERPROFILE ?? "C:\\Users\\Brady", ".ssh", "id_rsa")), detail: "the key registered on Hetzner (ids 118165797 / 118171598)" },
    ] : []),
  ];
  return {
    plan: { id: p.id, label: p.label, why: p.why, totalWallMinutes: p.totalWallMinutes, totalEur: p.totalEur, remaining: p.remaining, next: p.next, total: p.steps.length },
    order, preflight, steps,
    money: steps.filter((s) => s.estimate.eur && s.effective !== "done").map((s) => ({ id: s.id, label: s.label, eur: s.estimate.eur })),
  };
}
